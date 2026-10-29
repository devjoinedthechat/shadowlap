import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { applyEdit, messageOf, commitTitle, eachRun, estimateCost, packRun, releaseLock, REPAIR_FILE_LIMIT, repairMarkdown, repairPatchProblem, takeLock, type HeldLock, type Price, type RepairCandidate, type RepairReport, type RepairTarget, type RunRecord, type SourceFile, type SprtGate, type VerifyRole, lostWhere } from '@shadowlap/engine';
import { type AttemptSettings, type AttemptTarget } from './attempts.js';
import { loadConfig } from './config.js';
import { fileInside, readInside, removeCandidateTrees, writeInside } from './repair-tree.js';
import { CLAUDE_CODE_TURNS, DEFAULT_ANTHROPIC_REPAIRER, REPAIRER_ANSWER_TOKENS, type Repairer } from './repairer.js';
import { physicalPath } from './real-path.js';
import { openStore, type GlobalOpts } from './shared.js';
import { shortId } from './ui.js';

/**
 * What `shadowlap repair` is given and what it hands over: its settings and outputs, the folder's
 * repair lock and the journal of an older repair's edits, the project's files a fix may rewrite,
 * what asking the repairer may cost, and the hand-over of an accepted fix: a directory with the
 * patch and the report, then, on request, the change applied, committed to a branch, and opened as
 * a pull request. The repair itself, its steps from blame to verify, is repair-run.ts's.
 */

export interface RepairSettings extends AttemptSettings {
  /** The verify gate: the gate each run is decided by (stats.ts), or, when it is null, a fixed count: a run passes at `needed` of `attempts`. */
  attempts: number;
  needed: number;
  gate: SprtGate | null;
  /** Runs verified at once, and attempts of a blame probe at once. */
  concurrency: number;
  /** Candidates to ask the repairer for. */
  candidates: number;
  /** A model to rescue with when resampling the recorded one does not. */
  stronger: string | null;
  /** Blame only model calls made in this scope: the agent's, not a simulated user's. */
  scope?: string | null;
  /** Request fields blame's probes set from the probed call on, such as a temperature that lets them sample. */
  rescueFields?: Record<string, unknown>;
  /** The largest growth in input tokens per run a fix may cause, as a fraction. */
  maxGrowth: number;
  /** A shell command that builds the agent after its source changes. */
  build: string | null;
  repairer: Repairer;
  /** Whether a repairer was configured at all; without one, only fixes that need no model are tried. */
  repairerConfigured?: boolean;
  /** How long the repairer has to answer (`--repairer-timeout`, `repair.timeout`); 10 minutes when absent. */
  repairerTimeoutMs?: number;
}

export interface RepairOutputs {
  /** Leave the accepted change in the working tree. */
  apply: boolean;
  /** Commit the accepted change to a new branch, without checking it out. */
  branch: string | null;
  /** Push the branch and open a pull request with `gh`. */
  pr: boolean;
  /** Where the recordings of the fixed runs go in the project, for `shadowlap test`. */
  goldens: string | null;
}

export interface RepairInput {
  opts: GlobalOpts;
  targets: AttemptTarget[];
  holdout: AttemptTarget[];
  good: AttemptTarget[];
  heldOutAutomatically: boolean;
  settings: RepairSettings;
  outputs: RepairOutputs;
  log: (line: string) => void;
}

/** Repair could not start; the message says why. */
export class RepairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepairError';
  }
}

/**
 * The repair ran, and handing it over (`--apply`, `--branch`, `--pr`) failed part way. Its directory,
 * patch and report.json are written, and `report` says what was handed over before the failure, so
 * the repair and its verdict are still kept.
 */
export class HandOverError extends RepairError {
  constructor(
    message: string,
    readonly report: RepairReport,
  ) {
    super(message);
    this.name = 'HandOverError';
  }
}

const journalPath = (cwd: string) => join(cwd, '.shadowlap', 'repair-journal.json');

/**
 * The characters one token of the repairer's prompt is taken to hold when what asking it could cost is
 * worked out: fewer than tokenizers fit into a token of English (about 4), so its tokens are counted
 * high, and so is the cost, which is what a budget is checked against.
 */
export const PROMPT_CHARS_PER_TOKEN = 3;

/** The answers asking the repairer may take: Claude Code's two turns, else one. */
export const repairerTurns = (r: Pick<Repairer, 'provider'>) => (r.provider === 'claude-code' ? CLAUDE_CODE_TURNS : 1);

/**
 * The most asking the repairer could cost, before it is asked: its prompt, counted high, and the
 * longest answer it may give, at its model's price (Claude Code's own default is priced as
 * Shadowlap's, DEFAULT_ANTHROPIC_REPAIRER), for each of its turns: Claude Code's second reads the
 * prompt again with the first answer, and gives an answer of its own. Null for a model with no
 * price, which no budget can count beforehand: its reported cost, when it has one, is counted once
 * it answers.
 */
export function repairerMost(r: Pick<Repairer, 'provider' | 'model'>, prompt: { system: string; user: string }, prices?: Record<string, Price>): number | null {
  const model = r.model || (r.provider === 'claude-code' ? DEFAULT_ANTHROPIC_REPAIRER : null);
  const turns = repairerTurns(r);
  const promptTokens = Math.ceil((prompt.system.length + prompt.user.length) / PROMPT_CHARS_PER_TOKEN);
  return estimateCost(model, { inputTokens: turns * promptTokens + (turns - 1) * REPAIRER_ANSWER_TOKENS, outputTokens: turns * REPAIRER_ANSWER_TOKENS }, prices);
}

/** Puts back whatever an interrupted repair left in the working tree. Returns the files it restored. */
export function recoverWorkingTree(cwd: string): string[] {
  const path = journalPath(cwd);
  if (!existsSync(path)) return [];
  const journal = JSON.parse(readFileSync(path, 'utf8')) as { files: Array<{ path: string; original: string; patched: string }> };
  const restored: string[] = [];
  for (const f of journal.files) {
    const now = existsSync(f.path) ? readFileSync(f.path, 'utf8') : null;
    // Only undo our own edit: a file someone changed since is theirs now.
    if (now === Buffer.from(f.patched, 'base64').toString('utf8')) {
      writeFileSync(f.path, Buffer.from(f.original, 'base64'));
      restored.push(f.path);
    }
  }
  rmSync(path, { force: true });
  return restored;
}

/**
 * Starts a repair in `cwd`: takes `.shadowlap/repair.lock` (the engine's lock file), held until the
 * repair ends, then cleans up after one that died: the worktrees it verified candidates in, and the
 * working tree an older Shadowlap, which tried candidates in place, may have left edited (its
 * journal). One repair runs in a folder at a time, as `--apply` writes the working tree, so what is
 * found here is never a running repair's: the repair that left it died, and the lock of a process
 * that died is taken over at once. A repair runs for minutes, so a lock whose holder this machine
 * can't check (one in a container or on another machine that shares the folder) is never taken over
 * by its age: it waits until someone deletes it. Throws when another repair runs here.
 */
export function startRepair(cwd: string): { lock: HeldLock; restored: string[] } {
  mkdirSync(join(cwd, '.shadowlap'), { recursive: true, mode: 0o700 });
  const path = join(cwd, '.shadowlap', 'repair.lock');
  const lock = takeLock(path, { wait: 0, mode: 0o600, ageOut: false, busy: () => new RepairError(`another shadowlap repair is running in this folder: wait for it to end (if none is running, delete ${path})`) });
  try {
    removeCandidateTrees(cwd);
    return { lock, restored: recoverWorkingTree(cwd) };
  } catch (err) {
    releaseLock(lock);
    throw err;
  }
}

export function gitRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    throw new RepairError('shadowlap repair edits the agent\'s source, so it has to run inside the git repository that holds it');
  }
}

/**
 * Where `--goldens` puts recordings in the repository, for a commit to `--branch`: the folder, from
 * the one repair runs in, relative to the repository's root. A folder outside it can't be committed.
 */
export function goldensInRepo(root: string, cwd: string, goldens: string): string {
  // Compared as the system names both: git gives the root's long name on Windows, where the folder
  // repair runs in may have been reached by a short one (C:\Users\RUNNER~1).
  const rel = relative(physicalPath(root), physicalPath(resolve(cwd, goldens)));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new RepairError(`--goldens ${goldens} is outside the repository, so its recordings can't be committed to a branch: give a folder inside it`);
  return rel;
}

const git = (root: string, args: string[], o: { input?: string; env?: NodeJS.ProcessEnv } = {}) =>
  execFileSync('git', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...(o.input !== undefined ? { input: o.input } : {}), ...(o.env ? { env: o.env } : {}) }).toString();

/**
 * The project's text files: tracked, and untracked but not ignored. A link is read as the file it
 * ends at, under that file's own path, and only when that file is in the repository too (fileInside):
 * a rewrite is only ever written to a file of the repository's, never through a link to another.
 */
export function projectFiles(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  const seen = new Set<string>();
  const real = physicalPath(root);
  for (const listed of git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0')) {
    if (!listed) continue;
    // A committed recording (a golden, or __recordings__/) holds copies of the prompts, not their source.
    if (/(^|\/)blobs\/[0-9a-f]{64}$/.test(listed)) continue;
    const path = fileInside(real, listed);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    try {
      if (statSync(join(real, path)).size > REPAIR_FILE_LIMIT) continue;
      const content = readInside(real, path);
      if (!content.includes('\u0000')) out.push({ path, content });
    } catch {
      // deleted in the working tree, or unreadable
    }
  }
  return out;
}

/** Runs `--build`'s command in `cwd`: whether it passed, and the last lines it printed. */
export function runBuild(cmd: string, cwd: string): { ok: boolean; tail: string } {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-5).join('\n');
  return { ok: r.status === 0, tail };
}

/**
 * Writes what a repair produced: always a directory with the report (JSON and Markdown) and, for a
 * fix, the patch and a recording of every fixed run; then, on request, the change applied to the
 * working tree, committed to a branch, and opened as a pull request. When one of those requests
 * fails, report.json is still written and a HandOverError carries the report as far as it got.
 * Called holding the folder's repair lock.
 */
export function handOver(report: RepairReport, input: Pick<RepairInput, 'opts' | 'outputs' | 'settings' | 'log'>): RepairReport {
  const cwd = process.cwd();
  const root = gitRoot(cwd);
  const id = `repair-${Date.now().toString(36)}`;
  const dir = join(cwd, '.shadowlap', 'repairs', id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = report.output;
  // Paths in the report are relative to the folder repair ran in, with forward slashes on every
  // system: the report is kept in the store, which other machines read.
  const rel = (f: string) => relative(cwd, f).split(sep).join('/');
  out.dir = rel(dir);
  const accepted = report.candidates.find((c) => c.id === report.accepted) ?? null;

  // Verify replayed the working tree; a branch is HEAD with the fix. Tracked changes not committed are
  // in what was verified and not in what is committed: the report, the commit and the pull request say so.
  if (accepted && report.patch && input.outputs.branch) {
    const uncommitted = uncommittedFiles(root);
    if (uncommitted.length) {
      report.uncommitted = uncommitted;
      const named = uncommitted.length > 3 ? `${uncommitted.slice(0, 3).join(', ')} and ${uncommitted.length - 3} more` : uncommitted.join(', ');
      report.warnings.push(`the working tree has uncommitted changes to ${named}, which verify replayed and the branch ${input.outputs.branch} does not hold: it is HEAD with the fix. Commit them and repair again, or check that the branch passes without them`);
    }
  }

  if (accepted && report.patch) {
    writeFileSync(join(dir, 'fix.patch'), report.patch);
    out.patch = rel(join(dir, 'fix.patch'));
    // A recording of each fixed failing run, made by the fixed code: replayed by `shadowlap test`, it
    // fails the build if the fix is ever undone.
    const store = openStore(input.opts);
    const config = loadConfig(cwd);
    try {
      for (const run of accepted.verify?.runs ?? []) {
        if (run.role === 'good' || run.verdict !== 'pass') continue;
        const passing = run.attempts.find((a) => a.passed);
        if (!passing) continue;
        const target = join(dir, 'goldens', shortId(run.runId));
        packRun(store, passing.runId, target, { redact: config.redact });
        out.goldens.push(rel(target));
      }
    } finally {
      store.close();
    }
  }

  const md = repairMarkdown(report);
  writeFileSync(join(dir, 'report.md'), md);
  out.report = rel(join(dir, 'report.md'));

  let failed: RepairError | null = null;
  if (accepted && report.patch) {
    // `--goldens`, from the folder repair runs in, so an absolute path is that path.
    const goldens = input.outputs.goldens;
    const goldensDir = goldens ? resolve(cwd, goldens) : null;
    try {
      if (input.outputs.apply) {
        applyAccepted(report, root);
        out.applied = true;
        if (goldensDir) {
          try {
            for (const g of out.goldens) cpSync(join(cwd, g), join(goldensDir, basename(g)), { recursive: true });
          } catch (err) {
            throw new RepairError(`the fix is in the working tree, but copying its recordings to ${goldens!} failed: ${messageOf(err)}`);
          }
        }
        if (input.settings.build) {
          const b = runBuild(input.settings.build, cwd);
          if (!b.ok) report.warnings.push(`${input.settings.build} failed after the fix was applied: ${b.tail}`);
        }
      }
      if (input.outputs.branch) {
        const inRepo = goldens ? goldensInRepo(root, cwd, goldens) : null;
        out.branch = commitBranch(root, input.outputs.branch, accepted, inRepo !== null ? out.goldens.map((g) => ({ from: join(cwd, g), to: join(inRepo, basename(g)) })) : [], commitMessage(report, accepted), dir);
        input.log(`  committed to ${out.branch}`);
        if (input.outputs.pr) out.pr = openPullRequest(root, out.branch, commitTitle(accepted), join(dir, 'report.md'));
      }
    } catch (err) {
      // Whatever stopped it, the repair ran and its verdict stands: it is kept, with where the hand-over stopped.
      failed = err instanceof RepairError ? err : new RepairError(messageOf(err));
      report.warnings.push(`handing the fix over stopped: ${failed.message}`);
    }
  }
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  if (failed) throw new HandOverError(failed.message, report);
  return report;
}

/**
 * Puts the accepted candidate in the working tree: the only change a repair makes there, after every
 * candidate was verified in a worktree of its own. Its patch is checked first to be that candidate's
 * rewrite and nothing more (`repairPatchProblem`, as `shadowlap fix apply` checks a patch from the
 * store), and its text to be where it was found; otherwise nothing is written and it says why.
 */
export function applyAccepted(report: Pick<RepairReport, 'patch' | 'candidates' | 'accepted' | 'output'>, root: string): void {
  const accepted = report.candidates.find((c) => c.id === report.accepted);
  if (!accepted || !report.patch) throw new RepairError('there is no accepted candidate to apply');
  const problem = repairPatchProblem(report);
  if (problem) throw new RepairError(`the patch is not the accepted candidate's change (${problem}), so nothing was applied`);
  // The working tree's own file, never one a link in it names: a link would take the fix outside the repository.
  const real = physicalPath(root);
  let now: string;
  try {
    now = readInside(real, accepted.file);
  } catch (err) {
    throw new RepairError(`${accepted.file} can't be written as the repository's own file (${messageOf(err)}); apply ${report.output.patch ?? 'the patch'} by hand`);
  }
  if (now.slice(accepted.offset, accepted.offset + accepted.before.length) !== accepted.before) throw new RepairError(`${accepted.file} changed during the repair; apply ${report.output.patch ?? 'the patch'} by hand`);
  writeInside(real, accepted.file, applyEdit(now, { offset: accepted.offset, text: accepted.before }, accepted.after));
}

function commitMessage(r: RepairReport, c: RepairCandidate): string {
  const v = c.verify;
  const count = (role: VerifyRole) => v?.runs.filter((x) => x.role === role) ?? [];
  const pass = (role: VerifyRole) => count(role).filter((x) => x.verdict === 'pass').length;
  const lines = [commitTitle(c), ''];
  if (c.why.trim()) lines.push(c.why.trim(), '');
  lines.push(`The failing runs were lost ${r.targets.filter((t) => t.callNo !== null).map((t) => `${lostWhere(t.callNo!, t.range)} of ${shortId(t.runId)}`).join('; ')}.`);
  if (v) lines.push(`Verified by replaying them under the change: fixes ${pass('target')} of ${count('target').length} target and ${pass('holdout')} of ${count('holdout').length} held-out failing runs, keeps ${pass('good')} of ${count('good').length} good runs, ${eachRun(v)}.`);
  if (r.uncommitted?.length) lines.push('', `The runs were replayed on a working tree with uncommitted changes to ${r.uncommitted.join(', ')}, which this commit does not hold: it is HEAD with the fix alone.`);
  return lines.join('\n') + '\n';
}

/** Tracked files whose working-tree content differs from HEAD's, staged or not, relative to the repository's root. */
function uncommittedFiles(root: string): string[] {
  try {
    return git(root, ['diff', '--name-only', '-z', 'HEAD', '--']).split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

/** A commit on a new branch with the fix, made without checking anything out: HEAD and the working tree stay as they are. */
function commitBranch(root: string, name: string, c: RepairCandidate, extra: Array<{ from: string; to: string }>, message: string, scratch: string): string {
  try {
    git(root, ['check-ref-format', '--branch', name]);
  } catch {
    throw new RepairError(`"${name}" is not a valid branch name`);
  }
  let exists = true;
  try {
    git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
  } catch {
    exists = false;
  }
  if (exists) throw new RepairError(`a branch named ${name} already exists`);
  let head: string;
  try {
    head = git(root, ['show', `HEAD:${c.file}`]);
  } catch {
    throw new RepairError(`${c.file} is not committed, so there is nothing to branch from; commit it, or apply the patch`);
  }
  // Where the working tree had it, when HEAD's file is the same there; otherwise the one place HEAD has it.
  let at = head.slice(c.offset, c.offset + c.before.length) === c.before ? c.offset : head.indexOf(c.before);
  if (at !== c.offset && (at < 0 || head.indexOf(c.before, at + 1) >= 0)) throw new RepairError(`${c.file} at HEAD does not hold the text the fix replaces exactly once; commit your changes to it first, or apply the patch`);
  at = Math.max(at, 0);
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
  git(root, ['read-tree', 'HEAD'], { env });
  const mode = git(root, ['ls-tree', 'HEAD', '--', c.file]).split(/\s+/)[0] || '100644';
  const blob = git(root, ['hash-object', '-w', '--stdin'], { input: applyEdit(head, { offset: at, text: c.before }, c.after) }).trim();
  git(root, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${c.file}`], { env });
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
  for (const x of extra) {
    for (const f of files(x.from)) {
      const b = git(root, ['hash-object', '-w', f]).trim();
      const to = `${x.to}/${relative(x.from, f)}`.split(/[\\/]+/).join('/');
      git(root, ['update-index', '--add', '--cacheinfo', `100644,${b},${to}`], { env });
    }
  }
  const tree = git(root, ['write-tree'], { env }).trim();
  const commit = git(root, ['commit-tree', tree, '-p', 'HEAD', '-F', '-'], { input: message }).trim();
  git(root, ['update-ref', `refs/heads/${name}`, commit, '']);
  rmSync(join(scratch, 'index'), { force: true });
  return name;
}

function openPullRequest(root: string, branch: string, title: string, body: string): string {
  const base = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (base === 'HEAD') throw new RepairError('HEAD is detached, so there is no branch to open the pull request against');
  try {
    git(root, ['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
  } catch (err) {
    throw new RepairError(`git push origin ${branch} failed: ${(err as { stderr?: Buffer }).stderr?.toString().trim() ?? messageOf(err)}`);
  }
  const r = spawnSync('gh', ['pr', 'create', '--head', branch, '--base', base, '--title', title, '--body-file', body], { cwd: root, encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new RepairError(`gh pr create failed: ${(r.stderr || r.error?.message || '').trim()}; the branch ${branch} is pushed, so it can be opened by hand`);
  return r.stdout.trim().split('\n').at(-1) ?? '';
}

/** Splits failing runs into the ones the repairer sees and the ones held out from it: every other run, oldest first. */
export function splitHoldout<T extends { parent: RunRecord }>(runs: T[]): { targets: T[]; holdout: T[] } {
  const sorted = [...runs].sort((a, b) => a.parent.startedAt - b.parent.startedAt || a.parent.runId.localeCompare(b.parent.runId));
  return { targets: sorted.filter((_, i) => i % 2 === 0), holdout: sorted.filter((_, i) => i % 2 === 1) };
}

/**
 * Why a repair had no rescue to learn from. When blame found, for every run it searched, that no
 * answer of the model's lost it (every attempt met a write's recorded error again, or the attempts
 * that passed answered as the recording did), it says that, as the fix's Blame step does: neither
 * a prompt fix nor a stronger model can help. When no run could be searched at all (each passed its
 * check when replayed, say), why not. When every search its first probe couldn't tell, that blame
 * did not settle it, which is no finding that nothing rescues a run. Otherwise, that nothing rescued
 * a run, and what to try.
 */
export function noDiagnosisWhy(blamed: ReadonlyArray<{ target: RepairTarget; notTheAnswer: string | null }>, stronger: string | null): string {
  const unrescued = blamed.filter((b) => b.target.outcome === 'unrescuable');
  const found = unrescued.map((b) => b.notTheAnswer);
  if (unrescued.length && found.every((f): f is string => f !== null)) {
    const said = new Set(found).size === 1 ? found[0]! : unrescued.map((b, i) => `${shortId(b.target.runId)}: ${found[i]!}`).join('; ');
    return `${said}: no answer of the model's lost ${unrescued.length === 1 ? 'the run' : 'these runs'}; look at the tools, the harness or the command`;
  }
  // A search that stopped part way (runRepair reports the repair as stopped) learned nothing either way.
  const searched = blamed.some((b) => b.target.outcome === 'unrescuable');
  const note = blamed.find((b) => b.target.note)?.target.note;
  if (!searched && note) return `no failing run could be blamed: ${note}`;
  if (unrescued.length && unrescued.every((b) => b.target.unsettled)) {
    const one = unrescued.length === 1;
    return `blame did not settle where ${one ? 'the failing run was' : 'the failing runs were'} lost: its first probe could not tell whether resampling rescues ${one ? 'it' : 'them'}, so there is no passing path to learn from yet; shadowlap blame ${unrescued.map((b) => shortId(b.target.runId)).join(' ')} says what settles it`;
  }
  return stronger
    ? `neither resampling nor ${stronger} rescued any failing run, so there is no passing path to learn from: the cause is likely in the code or the tools`
    : 'resampling rescued no failing run, so there is no passing path to learn from; try a stronger model with --stronger <model>, or look at the code and the tools';
}

/**
 * Why a candidate was rejected for its footprint: `input tokens per run grow 30%, more than
 * --max-growth 25%`. Both as precise as they need to be, so a limit given as 0.5 reads 0.5%, and a
 * growth past it never reads as no more than it.
 */
export function growthReason(growth: number, maxGrowth: number, from?: string): string {
  const limit = +(maxGrowth * 100).toFixed(4);
  const whole = Math.round(growth * 100);
  return `input tokens per run grow ${whole > limit ? whole : +(growth * 100).toFixed(2)}%${from ? ` ${from}` : ''}, more than --max-growth ${limit}%`;
}
