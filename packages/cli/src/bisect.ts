import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { formatDuration, formatUsd, hasRecordedCommand, packRun, plain, recordEvent, resolveAuthor, Store, unpackRun, type Palette, type RunRecord } from '@shadowlap/engine';
import { specFor, type TestSpec } from './checks.js';
import { defaultDbPath, loadConfig, loadTests } from './config.js';
import { importGolden, testRecording } from './golden-test.js';
import { goldenName } from './goldens.js';
import { type GuardMode } from './run-agent.js';
import { openStore, type GlobalOpts } from './shared.js';
import { shortId } from './ui.js';

/**
 * `shadowlap bisect`: the commit that broke a golden or a run. The recording is replayed at commits
 * between one where it passed and one where it fails, halving the range each time, each commit
 * checked out in a temporary git worktree where the agent runs with its recorded command. A replay
 * fails when it diverges, an outcome check fails or the agent exits non-zero, as under `shadowlap
 * test`. Replays are offline, so finding the commit costs no tokens.
 *
 * The recording, its checks and the normalizers come from the working tree as it is now; only the
 * agent's code changes from commit to commit. History is followed by first parents, so a merged
 * branch counts as its merge commit.
 */

export class BisectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BisectError';
  }
}

export interface BisectInput {
  opts: GlobalOpts;
  /** A golden (a pack directory) or a run id. */
  target: string;
  good: string;
  bad: string;
  /** The checks a replay must pass; undefined takes the golden's from the config. */
  spec?: TestSpec | null | undefined;
  /** Let each replay diverge and run live from the fork, so only the exit status and the checks decide. */
  fork?: boolean;
  /** A shell command run in each worktree before its replay. */
  build: string | null;
  /** Where the recorded command runs: a directory inside the repository. */
  cwd: string;
  timeoutMs: number | null;
  guard: GuardMode;
  log: (line: string) => void;
  /** The project, for the config and the store (default: the current directory). */
  projectDir?: string;
}

export interface BisectCommit {
  rev: string;
  short: string;
  subject: string;
  author: string;
  /** Author date, ISO 8601. */
  date: string;
}

export interface BisectStep {
  rev: string;
  short: string;
  subject: string;
  ok: boolean;
  /** The commit could not be tested (it would not check out, or `--build` failed), so it says nothing either way. */
  skipped: boolean;
  /** What the replay did: `replayed clean`, `diverged at call 1 (api POST /v1/messages) · $.metadata.user_id`. */
  result: string;
  seconds: number;
}

export interface BisectReport {
  outcome: 'found' | 'passes-at-bad' | 'fails-at-good' | 'untestable' | 'stopped';
  target: { kind: 'golden' | 'run'; name: string; runId: string };
  good: BisectCommit;
  bad: BisectCommit;
  /** Commits after the good one, up to and including the bad one. */
  commits: number;
  /** Every replay, in the order they ran. */
  steps: BisectStep[];
  /** The first commit where it fails, and why. */
  first: (BisectCommit & { why: string }) | null;
  /** Commits just before it that could not be tested: the first bad one may be among them. */
  untested: BisectCommit[];
  /** Why there is no answer, when there is none. */
  why: string | null;
  replays: number;
  /** Tokens sent and received by live model calls: 0 for a golden that replays offline. */
  tokens: number;
  upstreamRequests: number;
  /** USD, for live model calls. */
  spent: number;
  seconds: number;
}

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString();

function gitOk(cwd: string, args: string[]): boolean {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function commitInfo(root: string, rev: string): BisectCommit {
  const [full, short, subject, author, date] = git(root, ['show', '-s', '--format=%H%x00%h%x00%s%x00%an%x00%aI', rev]).trim().split('\0');
  return { rev: full!, short: short!, subject: subject ?? '', author: author ?? '', date: date ?? '' };
}

function resolveRev(root: string, rev: string, flag: string): string {
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).trim();
  } catch {
    throw new BisectError(`${flag} ${rev} is not a commit in this repository`);
  }
}

/** Creates `.shadowlap/` with a .gitignore of its own, so worktrees inside it never show in `git status`. */
function scratchDir(projectDir: string): string {
  const dir = join(projectDir, '.shadowlap');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(dir, '.gitignore'), '*\n', { mode: 0o600, flag: 'wx' });
  } catch {
    // already there
  }
  const bisect = join(dir, 'bisect');
  mkdirSync(bisect, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(bisect, 'run-'));
}

/**
 * The recorded command, pointed into a worktree. An absolute path inside the repository becomes the
 * worktree's copy, except an executable the worktree doesn't have (a virtualenv's python, which is
 * installed rather than committed). A relative executable only the working tree has
 * (`.venv/bin/python`, `node_modules/.bin/tsx`) runs from there.
 */
export function mapArgv(argv: readonly string[], m: { root: string; worktree: string; cwd: string; worktreeCwd: string }): string[] {
  return argv.map((a, i) => {
    if (isAbsolute(a)) {
      const rel = relative(m.root, a);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) return a;
      const mapped = join(m.worktree, rel);
      return i === 0 && !existsSync(mapped) ? a : mapped;
    }
    if (i === 0 && /[\\/]/.test(a) && !existsSync(join(m.worktreeCwd, a)) && existsSync(join(m.cwd, a))) return join(m.cwd, a);
    return a;
  });
}

/** The recording to bisect, copied into a store of its own: replays at old commits never touch the project's. */
function loadTarget(input: BisectInput, projectDir: string, store: Store): { run: RunRecord; kind: 'golden' | 'run'; name: string; golden: string | null } {
  const dir = resolve(projectDir, input.target);
  if (existsSync(join(dir, 'run.json')) && statSync(dir).isDirectory()) {
    const golden = goldenName(input.target, projectDir);
    return { run: importGolden(store, dir), kind: 'golden', name: golden, golden };
  }
  const project = openStore(input.opts);
  const scratch = mkdtempSync(join(tmpdir(), 'shadowlap-bisect-'));
  try {
    const found = project.findRun(input.target);
    if (!found) throw new BisectError(`${input.target} is neither a golden (a directory with a run.json) nor a run in ${input.opts.db ?? defaultDbPath(projectDir)}`);
    packRun(project, found.runId, scratch);
    unpackRun(store, scratch);
    return { run: store.getRun(found.runId)!, kind: 'run', name: shortId(found.runId), golden: found.meta?.test?.golden ?? null };
  } finally {
    project.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** What a replay did, in one line. */
function describeResult(o: Awaited<ReturnType<typeof testRecording>>): string {
  const s = o.shown.ended.summary;
  if (!o.failure) {
    const checks = o.shown.checks?.length ?? 0;
    return s.divergence ? `forked at call ${s.divergence.callNo}, ${checks} check${checks === 1 ? '' : 's'} passed` : checks ? `replayed clean · ${checks} check${checks === 1 ? '' : 's'} passed` : 'replayed clean';
  }
  const d = s.divergence;
  const path = d?.diff?.[0]?.path;
  return o.kind === 'diverged' && path ? `${o.failure.message} · ${path}` : o.failure.message;
}

export async function runBisect(input: BisectInput): Promise<BisectReport> {
  const started = Date.now();
  const projectDir = input.projectDir ?? process.cwd();
  let root: string;
  try {
    root = git(input.cwd, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    throw new BisectError('shadowlap bisect checks out commits, so it has to run inside the git repository that holds the agent');
  }
  const inRepo = relative(root, input.cwd);
  if (inRepo.startsWith('..') || isAbsolute(inRepo)) throw new BisectError(`the working directory ${input.cwd} is not inside the repository at ${root}`);
  let goodRev = resolveRev(root, input.good, '--good');
  const badRev = resolveRev(root, input.bad, '--bad');
  if (goodRev === badRev) throw new BisectError('--good and --bad are the same commit: there is nothing between them to search');
  let fromBase: string | null = null;
  if (!gitOk(root, ['merge-base', '--is-ancestor', goodRev, badRev])) {
    if (gitOk(root, ['merge-base', '--is-ancestor', badRev, goodRev])) throw new BisectError(`--good ${input.good} comes after --bad ${input.bad}: the good commit has to come first`);
    // A good commit on another branch: search from where the two histories meet, which is checked like any good commit.
    let base = '';
    try {
      base = git(root, ['merge-base', goodRev, badRev]).trim();
    } catch {
      // no common history
    }
    if (!base) throw new BisectError(`--good ${input.good} and --bad ${input.bad} have no history in common`);
    fromBase = `--good ${input.good} is not an ancestor of --bad ${input.bad}: searching from where their histories meet`;
    goodRev = base;
  }
  const commits = git(root, ['rev-list', '--first-parent', '--reverse', `${goodRev}..${badRev}`]).split('\n').filter(Boolean);
  if (commits.at(-1) !== badRev) commits.push(badRev);
  const good = commitInfo(root, goodRev);
  const bad = commitInfo(root, badRev);

  const config = loadConfig(projectDir);
  const store = Store.open(':memory:');
  let target: ReturnType<typeof loadTarget>;
  try {
    target = loadTarget(input, projectDir, store);
  } catch (err) {
    store.close();
    throw err instanceof BisectError ? err : new BisectError((err as Error).message);
  }
  if (!hasRecordedCommand(target.run)) {
    store.close();
    throw new BisectError(`${target.name} was imported from a capture and has no command to run at each commit. Replay it once with your agent (shadowlap replay <run> -- <command>) and bisect that run`);
  }
  const fromConfig = target.golden ? specFor(loadTests(projectDir), resolve(projectDir, target.golden), projectDir) : null;
  // Checks given on the command line judge the replay as it is: offline, so a divergence fails it,
  // unless --fork lets it go live from the fork and leaves the verdict to the checks.
  const given = input.spec === undefined ? fromConfig : input.spec ? { ...input.spec, fork: false } : null;
  const spec: TestSpec | null = input.fork ? { ...(given ?? { repeat: 1, passes: 1, tools: [] }), fork: true } : given;

  const report: BisectReport = { outcome: 'stopped', target: { kind: target.kind, name: target.name, runId: target.run.runId }, good, bad, commits: commits.length, steps: [], first: null, untested: [], why: null, replays: 0, tokens: 0, upstreamRequests: 0, spent: 0, seconds: 0 };
  if (fromBase) input.log(`  ${fromBase}, ${good.short}`);
  input.log(`▸ ${target.name} · good ${good.short} · bad ${bad.short} · ${commits.length} commit${commits.length === 1 ? '' : 's'} apart`);
  if (input.bad === 'HEAD' && git(root, ['status', '--porcelain', '--untracked-files=no']).trim()) input.log('  uncommitted changes are not part of it: each replay runs a commit as committed');

  const base = scratchDir(projectDir);
  let stopped = false;
  const onSignal = () => {
    stopped = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  /** Replays the recording at one commit, in a worktree that is removed afterwards. */
  const probe = async (rev: string): Promise<BisectStep> => {
    const t0 = Date.now();
    const info = commitInfo(root, rev);
    const worktree = join(base, info.short);
    let step: BisectStep;
    try {
      git(root, ['worktree', 'add', '--detach', '--force', worktree, rev]);
      const worktreeCwd = join(worktree, inRepo);
      let built = true;
      let buildTail = '';
      if (input.build) {
        const b = spawnSync(input.build, { cwd: worktreeCwd, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        built = b.status === 0;
        buildTail = `${b.stdout ?? ''}${b.stderr ?? ''}`.trim().split('\n').slice(-3).join(' · ');
      }
      if (!built) {
        step = { rev, short: info.short, subject: info.subject, ok: false, skipped: true, result: `could not be built: ${buildTail}`, seconds: (Date.now() - t0) / 1000 };
      } else {
        const argv = mapArgv(target.run.command.argv, { root, worktree, cwd: input.cwd, worktreeCwd });
        const outcome = await testRecording(target.run, spec, { store, config, cwd: worktreeCwd, writes: 'block', guard: input.guard, online: false, argv, timeoutMs: input.timeoutMs });
        report.replays += outcome.attempts.length;
        for (const a of outcome.attempts) {
          const s = a.ended.summary;
          report.upstreamRequests += s.upstreamRequests;
          report.spent += s.cost.spent;
          for (const c of store.getCalls(s.runId)) {
            const u = c.kind === 'api' && c.origin === 'live' ? c.end?.meta.usage : undefined;
            if (u) report.tokens += u.inputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0) + u.outputTokens;
          }
        }
        step = { rev, short: info.short, subject: info.subject, ok: !outcome.failure, skipped: false, result: describeResult(outcome), seconds: (Date.now() - t0) / 1000 };
      }
    } catch (err) {
      step = { rev, short: info.short, subject: info.subject, ok: false, skipped: true, result: `could not be checked out: ${(err as { stderr?: Buffer }).stderr?.toString().trim() || (err as Error).message}`, seconds: (Date.now() - t0) / 1000 };
    } finally {
      if (!gitOk(root, ['worktree', 'remove', '--force', worktree])) {
        rmSync(worktree, { recursive: true, force: true });
        gitOk(root, ['worktree', 'prune']);
      }
    }
    report.steps.push(step);
    input.log(`  replay at ${step.short}  ${step.ok ? step.result : step.skipped ? `– skipped: ${step.result}` : `✗ ${step.result}`}`);
    return step;
  };

  try {
    // A replay cut short by Ctrl-C is no evidence either way, so nothing is concluded from it.
    const atBad = await probe(badRev);
    if (stopped) return report;
    if (atBad.skipped) {
      report.outcome = 'untestable';
      report.why = `${bad.short} ${atBad.result}`;
      return report;
    }
    if (atBad.ok) {
      report.outcome = 'passes-at-bad';
      report.why = `it passes at ${bad.short}, so there is nothing to find`;
      return report;
    }
    const atGood = await probe(goodRev);
    if (stopped) return report;
    if (atGood.skipped) {
      report.outcome = 'untestable';
      report.why = `${good.short} ${atGood.result}`;
      return report;
    }
    if (!atGood.ok) {
      report.outcome = 'fails-at-good';
      report.why = `it already fails at ${good.short}: ${atGood.result}. Give an older --good, or, when the agent can't start in a fresh checkout, --build with what it needs`;
      return report;
    }
    // Halving the range; a commit that can't be tested is skipped, and the nearest other one tried.
    let lo = -1;
    let hi = commits.length - 1;
    let why = atBad.result;
    const skipped = new Set<number>();
    for (;;) {
      const mid = (lo + hi) >> 1;
      let pick = -1;
      for (let i = lo + 1; i < hi; i++) if (!skipped.has(i) && (pick < 0 || Math.abs(i - mid) < Math.abs(pick - mid))) pick = i;
      if (pick < 0) break;
      const step = await probe(commits[pick]!);
      if (stopped) return report;
      if (step.skipped) skipped.add(pick);
      else if (step.ok) lo = pick;
      else {
        hi = pick;
        why = step.result;
      }
    }
    report.outcome = 'found';
    report.first = { ...commitInfo(root, commits[hi]!), why };
    report.untested = [...skipped].filter((i) => i > lo && i < hi).sort((a, b) => a - b).map((i) => commitInfo(root, commits[i]!));
    return report;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    rmSync(base, { recursive: true, force: true });
    gitOk(root, ['worktree', 'prune']);
    store.close();
    report.seconds = (Date.now() - started) / 1000;
    if (stopped && report.outcome === 'stopped') report.why = 'interrupted';
    if (report.outcome === 'found') record(input, projectDir, report);
  }
}

/** Logs the find in the project's activity. */
function record(input: BisectInput, projectDir: string, report: BisectReport): void {
  let store: Store | null = null;
  try {
    store = openStore(input.opts);
    const first = report.first!;
    recordEvent(store, {
      kind: 'bisect.found',
      actor: resolveAuthor({ cwd: projectDir }),
      ...(report.target.kind === 'run' ? { runId: report.target.runId } : {}),
      ref: report.target.name,
      data: { good: report.good.short, bad: report.bad.short, first: { rev: first.short, subject: first.subject, author: first.author, date: first.date }, why: first.why, untested: report.untested.map((c) => c.short), replays: report.replays, tokens: report.tokens, upstreamRequests: report.upstreamRequests },
    });
  } catch {
    // the find is printed either way
  } finally {
    store?.close();
  }
}

/** The result as the terminal shows it. */
export function formatBisect(r: BisectReport, p: Palette = plain): string {
  const cost = `${r.replays} replay${r.replays === 1 ? '' : 's'} · ${r.tokens.toLocaleString('en-US')} tokens · ${r.upstreamRequests} upstream request${r.upstreamRequests === 1 ? '' : 's'}${r.spent > 0 ? ` · ${formatUsd(r.spent)}` : ''} · ${formatDuration(r.seconds * 1000)}`;
  if (r.outcome !== 'found' || !r.first) return `${p.red('✗')} no first bad commit: ${r.why ?? r.outcome}\n  ${p.dim(cost)}`;
  const f = r.first;
  const unsure = r.untested.length ? `\n  ${p.yellow(`or one just before it, which could not be tested: ${r.untested.map((c) => `${c.short} (${c.subject})`).join(', ')}`)}` : '';
  return `${p.green('✓')} first bad commit ${f.short} · ${f.subject} · ${f.author} · ${f.date.slice(0, 10)}\n  ${f.why} · ${p.dim(cost)}${unsure}`;
}
