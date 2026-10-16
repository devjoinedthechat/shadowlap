import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { formatDuration, formatUsd, hasRecordedCommand, packRun, plain, recordEvent, resolveAuthor, Store, unpackRun, type Palette, type RunRecord } from '@shadowlap/engine';
import { specFor, type TestSpec } from './checks.js';
import { defaultDbPath, loadConfig, loadTests } from './config.js';
import { importGolden, ReplayInterrupted, testRecording, tokensOf } from './golden-test.js';
import { goldenName, scratchDir } from './goldens.js';
import { type GuardMode } from './run-agent.js';
import { physicalPath, realPath } from './real-path.js';
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
  // A revision that starts with "-" would reach git as an option.
  if (!rev || rev.startsWith('-')) throw new BisectError(`${flag} ${rev} is not a commit in this repository`);
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).trim();
  } catch {
    throw new BisectError(`${flag} ${rev} is not a commit in this repository`);
  }
}

/**
 * The recorded command, pointed into a worktree. An absolute path inside the repository becomes the
 * worktree's copy, except an executable the worktree doesn't have (a virtualenv's python, which is
 * installed rather than committed); a path that reaches the repository through a symbolic link
 * counts as inside it. A relative executable only the working tree has (`.venv/bin/python`,
 * `node_modules/.bin/tsx`) runs from there.
 */
export function mapArgv(argv: readonly string[], m: { root: string; worktree: string; cwd: string; worktreeCwd: string }): string[] {
  const root = physicalPath(m.root);
  return argv.map((a, i) => {
    if (isAbsolute(a)) {
      // The folders it is in, resolved; a link that is the file itself stays as it is.
      const rel = relative(root, join(physicalPath(dirname(a)), basename(a)));
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return a;
      const mapped = join(m.worktree, rel);
      return i === 0 && !existsSync(mapped) ? a : mapped;
    }
    if (i === 0 && /[\\/]/.test(a) && !existsSync(join(m.worktreeCwd, a)) && existsSync(join(m.cwd, a))) return join(m.cwd, a);
    return a;
  });
}

/**
 * Gives a worktree the installed packages of the working tree it was made from, so the agent can run
 * at an old commit without installing anything: each entry of `from/node_modules` is linked into
 * `to/node_modules`, except a package linked from this repository itself (a workspace package),
 * which is linked to the worktree's own copy, so it runs as it was at that commit. Returns the
 * entries linked; nothing when there is no node_modules, or the commit has one of its own.
 */
export function linkDependencies(root: string, from: string, to: string, worktree: string): number {
  const src = join(from, 'node_modules');
  const dst = join(to, 'node_modules');
  if (!existsSync(src) || existsSync(dst)) return 0;
  const link = (target: string, path: string) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : undefined);
  let linked = 0;
  const one = (entry: string, path: string) => {
    let target = entry;
    try {
      if (lstatSync(entry).isSymbolicLink()) {
        const real = realPath(entry);
        const rel = relative(root, real);
        // In this repository and not an installed package: the commit's own copy.
        if (rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(/[\\/]/).includes('node_modules')) target = join(worktree, rel);
      }
      link(target, path);
      linked++;
    } catch {
      // a dangling link, or one that can't be made: that package is missing at this commit
    }
  };
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    if (name.startsWith('@') && statSync(join(src, name)).isDirectory() && !lstatSync(join(src, name)).isSymbolicLink()) {
      mkdirSync(join(dst, name), { recursive: true });
      for (const sub of readdirSync(join(src, name))) one(join(src, name, sub), join(dst, name, sub));
    } else {
      one(join(src, name), join(dst, name));
    }
  }
  return linked;
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
    // Its recording isn't whole yet: replaying the part that is would answer for a run that never was.
    if (found.status === 'running') throw new BisectError(`${shortId(found.runId)} is still recording: find the commit once it has ended`);
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
  // Compared as git sees them, with symbolic links resolved.
  const cwd = physicalPath(input.cwd);
  let root: string;
  try {
    root = physicalPath(git(cwd, ['rev-parse', '--show-toplevel']).trim());
  } catch {
    throw new BisectError('shadowlap bisect checks out commits, so it has to run inside the git repository that holds the agent');
  }
  const inRepo = relative(root, cwd);
  if (inRepo === '..' || inRepo.startsWith(`..${sep}`) || isAbsolute(inRepo)) throw new BisectError(`the working directory ${input.cwd} is not inside the repository at ${root}`);
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

  const base = scratchDir(projectDir, 'bisect');
  let stopped = false;
  const onSignal = () => {
    stopped = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  /**
   * Replays the recording at one commit, in a worktree that is removed afterwards. A commit that
   * won't check out or build is skipped; an error that isn't about the commit (the sidecar couldn't
   * start, say) ends the bisect with it, rather than being taken for the commit's verdict.
   */
  let announced = false;
  const probe = async (rev: string): Promise<BisectStep> => {
    const t0 = Date.now();
    const info = commitInfo(root, rev);
    const worktree = join(base, info.short);
    const done = (ok: boolean, skipped: boolean, result: string): BisectStep => {
      const step: BisectStep = { rev, short: info.short, subject: info.subject, ok, skipped, result, seconds: (Date.now() - t0) / 1000 };
      report.steps.push(step);
      input.log(`  replay at ${step.short}  ${ok ? result : skipped ? `– skipped: ${result}` : `✗ ${result}`}`);
      return step;
    };
    try {
      try {
        git(root, ['worktree', 'add', '--detach', '--force', worktree, rev]);
      } catch (err) {
        return done(false, true, `could not be checked out: ${(err as { stderr?: Buffer }).stderr?.toString().trim() || (err as Error).message}`);
      }
      const worktreeCwd = join(worktree, inRepo);
      // Without a build step, the working tree's packages serve every commit, this repository's own
      // from the commit itself. A build step installs what it needs, so nothing is linked for it.
      if (!input.build) {
        const linked = linkDependencies(root, root, worktree, worktree) + (inRepo ? linkDependencies(root, cwd, worktreeCwd, worktree) : 0);
        if (linked && !announced) {
          announced = true;
          input.log('  node_modules is linked from your working tree, with this repository\'s own packages as they were at each commit; give --build to install them per commit instead');
        }
      }
      if (input.build) {
        const b = spawnSync(input.build, { cwd: worktreeCwd, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        if (b.status !== 0) return done(false, true, `could not be built: ${`${b.stdout ?? ''}${b.stderr ?? ''}`.trim().split('\n').slice(-3).join(' · ') || `${input.build} exited ${b.status ?? b.signal}`}`);
      }
      const argv = mapArgv(target.run.command.argv, { root, worktree, cwd, worktreeCwd });
      let outcome: Awaited<ReturnType<typeof testRecording>>;
      try {
        outcome = await testRecording(target.run, spec, { store, config, cwd: worktreeCwd, writes: 'block', guard: input.guard, online: false, argv, timeoutMs: input.timeoutMs, stopped: () => stopped });
      } catch (err) {
        if (err instanceof ReplayInterrupted) return done(false, true, 'interrupted');
        throw new BisectError(`the replay at ${info.short} could not run: ${(err as Error).message}`);
      }
      report.replays += outcome.attempts.length;
      for (const a of outcome.attempts) {
        const s = a.ended.summary;
        report.upstreamRequests += s.upstreamRequests;
        report.spent += s.cost.spent;
        report.tokens += tokensOf(store.getCalls(s.runId), { live: true, output: true });
      }
      // A replay a signal cut short says nothing about the commit.
      if (outcome.interrupted) return done(false, true, 'interrupted');
      return done(!outcome.failure, false, describeResult(outcome));
    } finally {
      if (!gitOk(root, ['worktree', 'remove', '--force', worktree])) {
        rmSync(worktree, { recursive: true, force: true });
        gitOk(root, ['worktree', 'prune']);
      }
    }
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
    // An answer either way, but not a search cut short: the Tests screen shows it above the golden's buttons.
    if (report.outcome !== 'stopped') record(input, projectDir, report);
  }
}

/**
 * Logs the answer in the project's activity: the first bad commit (`bisect.found`), or why there is
 * none between the commits given (`bisect.none`: it passes at the bad one, it already fails at the
 * good one, or one of them can't be tested), so the next search can start from another commit.
 */
function record(input: BisectInput, projectDir: string, report: BisectReport): void {
  let store: Store | null = null;
  try {
    store = openStore(input.opts);
    const where = { actor: resolveAuthor({ cwd: projectDir }), ...(report.target.kind === 'run' ? { runId: report.target.runId } : {}), ref: report.target.name };
    const first = report.first;
    if (report.outcome === 'found' && first) {
      recordEvent(store, {
        kind: 'bisect.found',
        ...where,
        // `commit` and `subject` are what the activity feed shows; `first` is what the Tests screen does.
        data: { commit: first.short, subject: first.subject, good: report.good.short, bad: report.bad.short, first: { rev: first.short, subject: first.subject, author: first.author, date: first.date }, why: first.why, untested: report.untested.map((c) => c.short), replays: report.replays, tokens: report.tokens, upstreamRequests: report.upstreamRequests },
      });
    } else {
      // Why, without the advice for the command line: Tests offers an older commit itself.
      const atGood = report.steps.find((s) => s.rev === report.good.rev);
      const why = report.outcome === 'fails-at-good' && atGood ? `it already fails at ${report.good.short}: ${atGood.result}` : (report.why ?? report.outcome);
      recordEvent(store, { kind: 'bisect.none', ...where, data: { outcome: report.outcome, why, good: report.good.short, bad: report.bad.short, replays: report.replays, tokens: report.tokens } });
    }
  } catch {
    // the answer is printed either way
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
