import { attemptsOf, attemptsToFail, attemptsToPass, BASELINE_DEFAULTS, BLAME_DEFAULTS, checkStatus, commandIsImported, describeGate, fixOfRun, formatPassK, formatTally, GATE_MAX_ATTEMPTS, gateSentence, gateOdds, gateOddsAt, gateOf, hasRecordedCommand, JUDGE_KEYS, judgeTarget, parseGate, passesPerFailure, runsRed, SPRT_DEFAULTS, importedCommandSource, maskedChange, testResultVerdict, normalizeAddArgs, normalizeAddCommand, pulledRun, recorderGone, volatileValues, withoutCommand, type CallKind, type CheckStatus, type DivergenceReport, type Gate, type GateResult, type InjectionGateData, type JudgeProvider, type Normalizer, type RunRecord, type Store, type StoredCheck, type Tally, type TestFailure, type TestResult, type TestSession, type VolatileValues } from '@shadowlap/engine';
import { liveChaosSession } from './chaos.js';

/**
 * The read model behind the Tests screen (and its numbers on the Overview and in Needs a look): the
 * store's test history (each `shadowlap test` session and each golden's result in it) joined with
 * the goldens on disk. Plain functions, store in, JSON out; the goldens come from the caller, which
 * reads the project folder and its config (`listGoldens` in the CLI).
 */

/** A golden on disk: what `listGoldens` in the CLI's goldens.ts returns for each pack. */
export interface GoldenSource {
  /** The pack folder relative to the project: `goldens/refund-flow`. Also its name in the history. */
  path: string;
  /** The recording it replays (the last run in its run.json), or null when the pack can't be read. */
  runId: string | null;
  /** When it was packed. */
  packedAt: number | null;
  /** From the config's `tests`: `replay` must send the requests it recorded; `fork` may diverge and passes on its checks. */
  mode: 'replay' | 'fork';
  repeat: number;
  passes: number;
  /** Its gate under `tests`, when it has one: then the gate decides how many attempts run, not `repeat` and `passes`. */
  gate?: Gate | null;
  /** Its checks, as the CLI labels them. */
  checks: string[];
  /** Its tests entry gives it an injection test, which `shadowlap test` runs live from each planted payload. */
  injection?: boolean;
  /** Why the pack can't be read, when it can't. */
  error?: string | null;
}

/** How a golden came out: passed, failed, or inconclusive (its gate ran out of attempts between its bounds, or a check couldn't be judged). */
export type GoldenVerdict = 'passed' | 'failed' | 'inconclusive';

/** A result's verdict: as kept, or for one kept before verdicts were, as its `ok` says (the engine's, which Training's tasks read too). */
export const verdictOfResult: (r: Pick<TestResult, 'ok' | 'failure' | 'data'>) => GoldenVerdict = testResultVerdict;

/** A golden's gate as the config gives it, in the words Settings previews it in. */
export interface GateView {
  gate: Gate;
  /** The gate's rule: `tells 90%+ from 70%- at <= 5% risk, up to 40 attempts`. */
  description: string;
  /** An SPRT gate: the attempts an agent that always passes needs (12 at 0.9, 0.7, 0.05), and one that always fails (3). Null for history. */
  toPass: number | null;
  toFail: number | null;
}

/**
 * What a gate decided about a golden's last result, for the interval bar (the Wilson range against
 * `bad` and `good`), the evidence line (`evidence.scores` after each attempt, between `upper` and
 * `lower`) and Run more attempts.
 */
export type GateResultView = GateResult & {
  /** `18 of 20 passed · rate >= 0.70 (95%) · pass^5 0.55`. */
  tally: string;
  /** USD an attempt cost on average, to estimate what more attempts would; null when nothing was spent or it wasn't kept. */
  perAttempt: number | null;
  /** Run more attempts, for an inconclusive verdict; null otherwise. */
  more: MoreAttempts | null;
};

/**
 * Run more attempts: the `test` job that continues an inconclusive gate (`--continue`) to twice its
 * limit, carrying its attempts over, and what that would take, estimated from the attempts so far.
 */
export interface MoreAttempts {
  /** The `test` job's arguments, after `shadowlap`: `test <golden> --max-attempts 160 --continue`. */
  args: string[];
  /** The job request that runs it: `{ golden, maxAttempts, continue: true }`. */
  job: { golden: string; maxAttempts: number; continue: true };
  /** The limit it continues to, and the most attempts that adds. */
  attempts: number;
  most: number;
  /** The attempts it adds on average, for an agent that passes as often as it has so far, and how often it then decides. */
  expected: number;
  settles: number;
  /** USD that would cost at the attempts' average so far; null when nothing was spent or it wasn't kept. */
  cost: number | null;
}

export interface TestsOptions {
  /** How many recent revisions the history shows (default 6). */
  revisions?: number;
  /** The project's goldens folder, for names and commands (default `goldens`). */
  folder?: string;
  /** The normalizers in the project's config now: a divergence whose rules are all there needs only a re-run. */
  normalizers?: readonly Normalizer[];
}

export interface TestsSessionView {
  id: string;
  /** As typed: `shadowlap test goldens/*`. */
  command: string;
  revision: string | null;
  startedAt: number;
  /** Null while it runs, or when its process was killed before it could end it: then the counts are of the results it has. */
  endedAt: number | null;
  /** Its goldens by how they came out: an inconclusive one is neither passed nor failed. */
  passed: number;
  failed: number;
  inconclusive: number;
  upstreamRequests: number;
  actor: string | null;
  /** A signal stopped it: the goldens after the one it was replaying didn't run. */
  interrupted: boolean;
  /**
   * It hasn't ended and its process is still there: it is running now, from this dashboard, another
   * one or a terminal. False for one that ended, or whose process is gone (it did not finish).
   */
  live: boolean;
}

/** A golden's result since the session the verdict's line shows, from a session that ran only some goldens. */
export interface SinceResult {
  golden: string;
  name: string;
  ok: boolean;
  /** How it came out, inconclusive told apart (`ok` reads it as not passing). */
  verdict: GoldenVerdict;
  revision: string | null;
  at: number;
}

/**
 * The banner at the top of the screen: how each golden on disk stands, by its last result (a session
 * may run only some of them, as Add normalizer and re-run does), with the line of the newest session
 * that ran them all (or one running now): its command, revision, time, its own passed and failed
 * counts and upstream requests. What ran since in sessions that ran only some goldens is `since`.
 */
export interface TestsVerdict {
  /** `failing` when a golden failed; else `inconclusive` when one is; else `passing`. */
  state: 'failing' | 'inconclusive' | 'passing';
  /** Goldens whose last result failed. */
  failing: number;
  /** Goldens whose last result is inconclusive: counted apart, neither passing nor failing. */
  inconclusive: number;
  /** Goldens whose last result passed. */
  passing: number;
  /** Goldens that have not run yet. */
  untested: number;
  /** `refund-in-limit diverged at call 1` (the first failing golden, in the table's order), `All 4 goldens pass`, or `3 of 4 goldens pass, 1 not run yet`. */
  title: string;
  first: { golden: string; name: string; reason: string; runId: string | null } | null;
  /**
   * The newest session that ran every golden tested before it (a full run, as CI's), or one running
   * now that names them all; without one, the newest session with a result. Its counts are its own.
   */
  session: TestsSessionView;
  /** Goldens run again since that session by sessions that ran only some, each by its newest result, in the table's order. */
  since: SinceResult[];
}

/** A golden at one revision: a cell of its history. */
export interface HistoryCell {
  revision: string | null;
  /**
   * Where the result shown was tested: the column's revision, or, for a golden run again on its own
   * (Add normalizer and re-run, Run tests on it) with changes on top, `<revision>+dirty`.
   */
  tested: string | null;
  /** Null: it wasn't a golden yet, or wasn't tested at that revision. An inconclusive result reads as `fail`: it didn't pass. */
  result: 'pass' | 'fail' | null;
  /** How it came out there, inconclusive told apart; null as for `result`. */
  verdict: GoldenVerdict | null;
  /** Its attempts there, passes of attempts: the pass rate a cell is shaded by. Null as for `result`, or when it couldn't run. */
  rate: Tally | null;
  /** Its gate against history failed there: a drop from its baseline (a ring). */
  dropped: boolean;
  /** Why it failed, for the hover. */
  note: string | null;
  /** `test --update` re-recorded it there (the ring). */
  updated: boolean;
  runId: string | null;
  at: number | null;
}

/**
 * One of a golden's checks, with how its last result came out on it: what the table marks it by
 * (✓ passed, ✗ failed, ? inconclusive, – not applicable, and no mark without one).
 */
export interface GoldenCheck {
  /** As the CLI labels it. */
  label: string;
  /**
   * Its status in the last result, in the attempt that result shows; null when the golden hasn't run
   * yet, or when its last result didn't judge this check (it ran under other checks, or couldn't run).
   */
  status: CheckStatus | null;
  /** The result's words for it: what it found when it failed, why it couldn't be decided or didn't apply. */
  detail: string | null;
  /** A judge check: its reason for the verdict, and where the verdict came from (the recording, or the judge asked live). */
  reason: string | null;
  source: 'recording' | 'live' | null;
  /**
   * A golden run more than once in its last result: of the attempts that judged this check, how many
   * passed it. Null for one attempt, or when an attempt's run is no longer in the store.
   */
  attempts: { passed: number; of: number } | null;
}

export interface GoldenRow {
  path: string;
  /** The path without the goldens folder: `refund-flow`. */
  name: string;
  /**
   * Where it came from: a run in this store (one recorded here, or a teammate's pulled from the team
   * store, which reads as their recording), or a pack made elsewhere.
   */
  source: { kind: 'run'; runId: string } | { kind: 'pack'; packedAt: number | null };
  mode: 'replay' | 'fork';
  /** `replay`, `fork ×5`, or with a gate `fork · gate` or `fork · history`. */
  modeLabel: string;
  /** What the mode means, for the hover. */
  modeHint: string;
  /** Its gate under `tests`, or null. */
  gate: GateView | null;
  checks: string[];
  /** Each of `checks`, in their order, with how its last result came out on it. */
  checkResults: GoldenCheck[];
  /** It has an injection test, which runs live, so CI needs the providers' keys for it whatever its mode. */
  injection: boolean;
  history: HistoryCell[];
  /** `verdict` tells inconclusive apart (`result` reads it as `fail`); `gate`, what its gate decided, for a golden with one; `injection`, its injection gate's result. */
  last: { result: 'pass' | 'fail' | null; verdict: GoldenVerdict | null; failure: TestFailure | null; line: string; at: number | null; updated: boolean; gate: GateResultView | null; injection?: InjectionGateData | null };
  /** The run a row opens: its latest replay when the store still has it, else the recording. */
  runId: string | null;
  error: string | null;
}

/** The first bad commit `shadowlap bisect` found for a golden: the card above its buttons. */
export interface FoundCommit {
  rev: string;
  subject: string;
  author: string;
  date: string;
  /** Why it fails there. */
  why: string;
  /** Commits just before it that could not be tested: the first bad one may be among them. */
  untested: string[];
  replays: number;
  tokens: number;
  at: number;
}

/** What Find the commit said when it named no first bad commit: why, between which commits it looked, and how it came out. */
export interface BisectMiss {
  why: string;
  good: string | null;
  bad: string | null;
  /**
   * `fails-at-good`: it already failed at the good commit, so an older one is asked for.
   * `passes-at-bad`: it passed at the commit it fails at, as committed, so the failure is in changes
   * not committed there, or doesn't happen every time; no other good commit helps. `untestable`: a
   * commit could not be checked out or built. Null for an answer kept before outcomes were.
   */
  outcome: 'fails-at-good' | 'passes-at-bad' | 'untestable' | null;
  at: number;
}

/**
 * A commit Find the commit's dialog offers as one where the golden still worked: a revision it was
 * tested at before it failed, and how it did there.
 */
export interface BisectRevision {
  rev: string;
  at: number;
  /** An inconclusive result reads as `fail`: it didn't pass. */
  result: 'pass' | 'fail';
  /** How it did there, inconclusive told apart: the dialog never says it failed where it was inconclusive. */
  verdict: GoldenVerdict;
  /** Tested under the checks the golden has now: a pass under other checks may be a commit where it already fails them. */
  sameChecks: boolean;
  /** The commit's subject, when the project's git has the commit (added by the route). */
  subject?: string | null;
}

/** A golden whose last replay diverged, as the CLI prints it, with what each button runs. */
export interface DivergenceView {
  golden: string;
  name: string;
  runId: string | null;
  callNo: number;
  kind: string;
  callName: string;
  /** The report as `shadowlap test` printed it. */
  text: string;
  /**
   * The value that changes every run, and the normalizer that masks it, when that is what diverged.
   * `certain` false: an id that may be a real change (another customer, another order), not known to
   * change every run.
   */
  volatile: { path: string; looks: string; op: 'changed' | 'added'; certain: boolean; normalizer: Normalizer; args: string[]; command: string } | null;
  /**
   * Values that surely change every run are all that diverged: Add normalizer and re-run is the fix,
   * and the screen leads with it. When false, the golden needs updating (the request carries a field
   * the recording never had, or more changed), or an id may be a real change.
   */
  normalizerFixes: boolean;
  /**
   * An id that may be a real change diverged: the screen says so, and offers Update golden and Add
   * normalizer side by side, leading with neither. Only the person knows whether that id is made anew
   * on every run, and a normalizer would hide a real change from every later test.
   */
  maybeReal: boolean;
  /** Arguments for the CLI (after `shadowlap`): re-run this golden, update it. */
  rerun: string[];
  update: string[];
  /**
   * Add normalizer and re-run, as the commands to run in order: a `normalize add` for each value that
   * changes every run, then `test` on the golden; when `normalizerFixes` is false, `test --update`
   * instead, which re-records it live (an update, to confirm as Update golden does). Null when no
   * such value diverged.
   */
  normalizeAndTest: string[][] | null;
  /**
   * Every rule Add normalizer would add is in the config already (added since this replay, for this
   * golden or another): what is left is to run it again, or to update it when the rules alone can't
   * make it match.
   */
  rulesAdded: boolean;
  /** Find the commit: from the last revision where it passed under today's checks to the one where it failed (null: HEAD). */
  bisect: BisectRange | null;
  /** What Find the commit found, kept until the golden passes again. */
  found: FoundCommit | null;
  /** Find the commit ran since and named no first bad commit (it already failed at the good one, say): why, until it passes again or finds one. */
  missed: BisectMiss | null;
  /** Commits to offer as good ones when Find the commit asks, newest first. */
  revisions: BisectRevision[];
  /** Why its pack can't be read, or null: such a golden can't be bisected. */
  unreadable: string | null;
}

/** Find the commit for a golden: the command, and whether its replays cost tokens. */
export interface BisectRange {
  good: string;
  bad: string | null;
  args: string[];
  /** The golden may fork, so each replay runs live from where it diverges: the search costs tokens. */
  live: boolean;
}

/** A golden that failed for another reason: a check, an exit, no calls. As `test --markdown` prints it. */
export interface FailureView {
  golden: string;
  name: string;
  runId: string | null;
  failure: TestFailure;
  reason: string;
  /** Its checks as the result kept them, each with its status (passed, failed, inconclusive, not-applicable) since results had one. */
  checks: StoredCheck[] | null;
  details: string | null;
  /** The last lines the agent printed, as `test --markdown` shows them; null when none were kept. */
  output: string | null;
  /**
   * A live call: the connections the network guard blocked during the failing replay (`host:port`).
   * They bypassed Shadowlap, so CI, replaying offline, refused them. Null when it blocked none.
   */
  blocked: string[] | null;
  bisect: BisectRange | null;
  found: FoundCommit | null;
  missed: BisectMiss | null;
  revisions: BisectRevision[];
  unreadable: string | null;
}

/** A golden whose last result is inconclusive: why, what its gate saw, and how to settle it. */
export interface InconclusiveView {
  golden: string;
  name: string;
  runId: string | null;
  reason: string;
  /** Its checks as the result kept them, each with its status (passed, failed, inconclusive, not-applicable) since results had one. */
  checks: StoredCheck[] | null;
  details: string | null;
  /** What its gate decided; null when a check couldn't be judged, or its injection gate showed too little to say, instead. */
  gate: GateResultView | null;
  /** `injection` when its injection gate is what is inconclusive. */
  failure?: TestFailure | null;
  /** A judge check its last result couldn't decide for want of a verdict, and what settles it; null for any other reason. */
  judge?: UnjudgedCheck | null;
}

/**
 * A judge check a golden's last result couldn't decide, and what settles it. A golden that replays
 * offline can't ask the judge, so Update golden (`update`, the arguments of `test <golden> --update`)
 * asks it once, live, and keeps its verdict in the pack. A golden that forks asks its judges live,
 * and what it lacked was a key for the judge's provider where the test ran (`keys`, the variables
 * that key is read from). Neither when the result says another reason.
 */
export interface UnjudgedCheck {
  /** The check's name in the config, and its label. */
  name: string;
  label: string;
  /** The judge's model, and the provider it is asked through when its name says. */
  model: string;
  provider: JudgeProvider | null;
  /** Why it wasn't judged, as the result kept it. */
  why: string;
  update: string[] | null;
  keys: readonly string[] | null;
}

export interface TestsView {
  /** No goldens: the empty state, with the pack command. */
  empty: boolean;
  goldens: number;
  /** Null until one of the goldens has run. */
  verdict: TestsVerdict | null;
  /** The history's columns, oldest first. */
  revisions: Array<string | null>;
  rows: GoldenRow[];
  divergences: DivergenceView[];
  failures: FailureView[];
  /** Goldens whose last result is inconclusive, apart from the failures: Run more attempts settles a gate's. */
  inconclusive: InconclusiveView[];
  /** Goldens whose last result diverged: Update goldens… lists them. */
  diverged: string[];
  /**
   * A test session running now, wherever it was started: a terminal, another dashboard, or a job of
   * this one. The actions that replay or rewrite the goldens wait for it, as the server does.
   */
  running: TestsSessionView | null;
  /**
   * Error-path presets on goldens (`test --chaos`) running now, wherever they were started: they
   * replay the goldens' packs, so the same actions wait for them too, as the server does.
   */
  chaosRunning: { id: string; command: string; startedAt: number } | null;
  commands: {
    /**
     * The In CI panel's one command, as docs/gating.md writes it: every golden, its pattern quoted for
     * the CLI to expand, with a JUnit report, the job summary and the GitHub annotations.
     */
    ci: string;
    /** Add a golden. */
    pack: string;
    /** Run tests, as arguments: the CLI expands the pattern itself. */
    run: string[];
    /** Update goldens…, or null when none diverged. */
    updateAll: string[] | null;
  };
  /** Recordings in `__recordings__/` belong to the pytest and Vitest plugins. */
  note: string;
}

const RECORDINGS_NOTE = 'Recordings that pytest and Vitest keep in __recordings__/ run under their own test runner, not here.';

/**
 * A golden whose path starts with `-` (a key under the config's `tests`) would reach the CLI as an
 * option, so no command is ever built with it: it is listed as one that can't be read.
 */
export const optionLike = (path: string): boolean => path.startsWith('-');
const OPTION_LIKE = 'its path starts with "-", which the CLI would read as an option: rename it under "tests" in shadowlap.config.json';

/**
 * What `shadowlap test` is given to run every golden: the goldens folder's pattern, which the CLI
 * expands itself without a shell, and each golden kept elsewhere (a pack the config's `tests` names)
 * by its path. A path that would read as an option is left out.
 */
export function testPatterns(goldens: readonly GoldenSource[], folder = 'goldens'): string[] {
  const inFolder = (path: string) => path.startsWith(`${folder}/`) && !path.slice(folder.length + 1).includes('/');
  const elsewhere = goldens.filter((g) => !inFolder(g.path) && !optionLike(g.path)).map((g) => g.path);
  return [...(goldens.some((g) => inFolder(g.path)) || !elsewhere.length ? [`${folder}/*`] : []), ...elsewhere];
}

/** Why a golden can't be read: a path that would read as an option (whatever is there), or its pack. */
const unreadable = (g: GoldenSource): string | null => (optionLike(g.path) ? OPTION_LIKE : (g.error ?? null));

/** A word as a shell reads it: a plain path stays as it is; a pattern (`goldens/*`), which the CLI expands itself, and a path with a space are quoted. */
const ciWord = (s: string) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

function nameOf(path: string, folder: string): string {
  return path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path;
}

/**
 * A session as the screen shows it. Its totals are written when it ends; one that hasn't (it is
 * running, or its process was killed) counts the results it has, as every other count here does.
 */
function sessionView(store: Store, s: TestSession): TestsSessionView {
  let { passed, failed } = s;
  let inconclusive = 0;
  // By each result's verdict: an inconclusive golden counts apart, whatever its session's
  // `--inconclusive` let CI do with it (a session from before verdicts counted it by that).
  const results = store.listTestResults({ sessionId: s.sessionId, limit: 100_000 });
  if (results.length || s.endedAt === null) {
    passed = results.filter((r) => verdictOfResult(r) === 'passed').length;
    inconclusive = results.filter((r) => verdictOfResult(r) === 'inconclusive').length;
    failed = results.length - passed - inconclusive;
  }
  return { id: s.sessionId, command: s.command.join(' '), revision: s.revision, startedAt: s.startedAt, endedAt: s.endedAt, passed, failed, inconclusive, upstreamRequests: s.upstreamRequests, actor: s.actor, interrupted: s.interrupted, live: sessionLive(store, s) };
}

/** When a session last did something: its end, or its newest result while it has none. */
function lastActive(store: Store, s: TestSession): number {
  return s.endedAt ?? store.listTestResults({ sessionId: s.sessionId, limit: 1 })[0]?.at ?? s.startedAt;
}

/**
 * Whether a session that hasn't ended is running now: the process the store names for it is still
 * there (on this machine; elsewhere, it was heard from lately), as for a run still recording. One
 * whose process was killed, or that names none, did not finish.
 */
function sessionLive(store: Store, s: TestSession): boolean {
  if (s.endedAt !== null) return false;
  const owner = store.testSessionOwner(s.sessionId);
  return owner !== null && !recorderGone(owner, lastActive(store, s));
}

/**
 * The newest test session running now, wherever it was started (a terminal, another dashboard, a
 * job), or null: while one runs, the jobs that replay or rewrite the goldens wait for it.
 */
export function liveTestSession(store: Store): TestSession | null {
  for (const s of store.listTestSessions({ limit: 20 })) if (s.endedAt === null && sessionLive(store, s)) return s;
  return null;
}

/** What volatileValues() made of a stored divergence: judged on all its changes when it was recorded. */
function volatileOf(r: TestResult, d: DivergenceReport): VolatileValues {
  const kept = r.data?.divergence?.volatile;
  return kept ? storedVolatile(kept) : volatileValues(d);
}

/** Stored values, with what a result kept before ids were told apart read as it was meant then. */
function storedVolatile(kept: NonNullable<NonNullable<NonNullable<TestResult['data']>['divergence']>['volatile']>): VolatileValues {
  return { values: kept.values.map((v) => ({ ...v, certain: v.certain ?? true })), explainsAll: kept.explainsAll, coversAll: kept.coversAll ?? kept.explainsAll };
}

/** Whether two normalizers are the same rule: the same fields, whatever their order. */
function sameRule(a: Normalizer, b: Normalizer): boolean {
  return a.kind === b.kind && a.name === b.name && a.path === b.path && a.pattern === b.pattern && a.replace === b.replace;
}

/** The first value a view shows, with the command that adds its normalizer. */
function shownValue(values: VolatileValues): DivergenceView['volatile'] {
  const v = values.values[0];
  return v ? { ...v, args: normalizeAddArgs(v.normalizer), command: normalizeAddCommand(v.normalizer) } : null;
}

function divergenceOf(r: TestResult): DivergenceReport | null {
  const d = r.data?.divergence;
  if (!d) return null;
  const report: DivergenceReport = { type: d.type as DivergenceReport['type'], callNo: d.callNo, kind: d.kind as CallKind, name: d.name, replayedBefore: d.replayedBefore };
  if (d.diff) report.diff = d.diff as NonNullable<DivergenceReport['diff']>;
  if (d.hints) report.hints = d.hints;
  return report;
}

/** Why a result failed, in a few words: `diverged at call 1`, `check failed: send_email called 0 times`, `inconclusive after 40 attempts`. */
export function shortReason(r: TestResult): string {
  if (r.ok) return 'passed';
  // Its gate ran out of attempts; else a check could not be judged (which stops a gate before it decides), or its injection gate showed too little.
  if (verdictOfResult(r) === 'inconclusive') return r.data?.gate?.decision === 'inconclusive' ? `inconclusive after ${r.data.gate.attempts} attempts` : r.failure === 'injection' ? 'inconclusive: its injection test showed too little to say' : 'inconclusive: a check could not be judged';
  const reason = r.reason ?? 'failed';
  if (r.failure === 'diverged') {
    const d = r.data?.divergence;
    return d ? `diverged at call ${d.callNo}` : reason.replace(/\s*\(.*\)$/, '');
  }
  if (r.failure === 'check') return reason.replace(/, but .*$/, '');
  if (r.failure === 'exit') return /exited with code \d+/.exec(reason)?.[0] ?? reason.replace(/^the agent /, '');
  if (r.failure === 'no-calls') return 'made no calls';
  // Its injection gate: what obeyed, without the limit and the proof the reason goes on with.
  if (r.failure === 'injection') return reason.replace(/ \(at most[^)]*\).*$/, '');
  return `couldn't run: ${reason}`;
}

/**
 * The change that made a stored divergence diverge: the first one the normalizers in force did not
 * mask, as the CLI kept it (`cause`); for a result kept before it did, the first one `normalizers`
 * (the config's now) leave unmasked. The report lists the masked changes too.
 */
function causeOf(r: TestResult, d: DivergenceReport, normalizers: readonly Normalizer[]): string | null {
  const kept = r.data?.divergence?.cause;
  if (kept !== undefined) return kept;
  return (d.diff ?? []).find((e) => !maskedChange(e, normalizers, d))?.path ?? null;
}

/**
 * A kept gate result's verdict line, in the words every report says it now (the verdict word, the
 * tally, the Wilson bound, the rule), whatever words the result was kept in; the kept sentence when
 * its figures can't be read.
 */
export function gateVerdictLine(g: GateResult): string {
  try {
    return gateSentence(gateOf(g), g);
  } catch {
    return g.sentence;
  }
}

/** The line under a golden's last result: what it did, or why it failed; `normalizers` are the config's now. */
export function resultLine(r: TestResult, checks: readonly string[], normalizers: readonly Normalizer[] = []): string {
  const data = r.data ?? {};
  // A gate's verdict is its verdict line, passed, failed or inconclusive, with pass^k beside it; a gate
  // an attempt a check could not decide stopped decided nothing, and the result's reason says why.
  if (data.gate && data.gate.decision !== 'continue' && (r.ok || r.failure === 'inconclusive' || r.failure === 'check' || r.failure === 'exit')) return [gateVerdictLine(data.gate), formatPassK(data.gate)].filter(Boolean).join(' · ');
  if (!r.ok) {
    if (r.failure === 'diverged') {
      const d = divergenceOf(r);
      if (!d) return r.reason ?? 'diverged';
      // Stopped before its recording did: no request changed, and its reason says how far it got.
      if (d.type === 'ended_early') return r.reason ?? `ended early at call ${d.callNo} (${d.kind} ${d.name})`;
      const v = volatileOf(r, d).values[0];
      if (v) return `diverged at call ${d.callNo} · ${v.path} ${v.certain ? `looks like ${v.looks}` : 'changed, an id that may be a real change'}`;
      const path = causeOf(r, d, normalizers);
      return path ? `diverged at call ${d.callNo} · ${path}` : `diverged at call ${d.callNo} (${d.type === 'new_call' ? `new call ${d.name}` : d.type === 'beyond_recording' ? 'more calls than recorded' : `${d.kind} ${d.name}`})`;
    }
    return r.reason ?? 'failed';
  }
  const parts: string[] = [];
  const n = data.checks?.length ?? 0;
  // Re-recorded by `test --update`, and replaced because its checks passed: where, and that they did.
  if (data.updated) {
    parts.push(`updated${r.revision ? ` at ${r.revision}` : ''}`);
    parts.push(n ? `${n === 1 ? 'check' : 'checks'} passed` : data.calls ? `${data.calls.replayed}/${data.calls.total} replayed` : 'exited 0');
    return parts.join(' · ');
  }
  // Every result keeps its attempts now; one attempt reads as the replay it was. One a check could
  // not decide, after the count was met, is counted apart: it neither passed nor failed.
  if (data.attempts && data.attempts.total > 1) {
    parts.push(`${data.attempts.passed} of ${data.attempts.total} attempts passed ${n === 1 ? 'the check' : n === 2 ? 'both checks' : n ? `all ${n} checks` : ''}`.trim());
    if (data.attempts.inconclusive) parts.push(`${data.attempts.inconclusive} inconclusive`);
  } else if (data.divergence) {
    parts.push(`${data.divergence.type === 'ended_early' ? 'ended early' : 'forked'} at call ${data.divergence.callNo}`);
    if (n) parts.push(`${plural(n, 'check')} passed`);
  } else {
    if (data.calls) parts.push(`${data.calls.replayed}/${data.calls.total} replayed`);
    if (n) parts.push(`${n === 1 ? 'check' : 'checks'} passed`);
  }
  // A golden that budgets tokens or cost shows what it came to.
  if (data.inputTokens !== undefined && checks.some((c) => /token|cost/.test(c))) parts.push(`${data.inputTokens.toLocaleString('en-US')} input tokens`);
  return parts.join(' · ') || 'passed';
}

const modeOf = (g: GoldenSource) =>
  g.mode === 'fork' && g.gate
    ? { label: g.gate.kind === 'sprt' ? 'fork · gate' : 'fork · history', hint: `allowed to fork; passes on its checks, decided by its gate: ${describeGate(g.gate)}` }
    : g.mode === 'fork'
      ? { label: g.repeat > 1 ? `fork ×${g.repeat}` : 'fork', hint: `allowed to fork; passes on its checks${g.repeat > 1 ? `, ${g.passes} of ${g.repeat} attempts` : ''}` }
      : { label: 'replay', hint: 'must send exactly the requests it recorded' };

/** A golden's gate in the words Settings previews it in, with what it costs at the extremes. */
function gateView(gate: Gate | null | undefined): GateView | null {
  if (!gate) return null;
  return { gate, description: describeGate(gate), toPass: gate.kind === 'sprt' ? attemptsToPass(gate) : null, toFail: gate.kind === 'sprt' ? attemptsToFail(gate) : null };
}

/** What a gate would do, before it is saved: Settings → CI's preview of the gate's figures. */
export interface GatePreview {
  gate: Gate;
  /** The gate's rule: `tells 90%+ from 70%- at <= 5% risk, up to 80 attempts`. */
  description: string;
  /** An SPRT gate: the attempts an agent that always passes needs (12 at 0.9, 0.7, 0.05), one that always fails (3), and the passes that make up for a failure (about 4.4). Null for history. */
  toPass: number | null;
  toFail: number | null;
  passesPerFailure: number | null;
  /**
   * The exact odds of each verdict, and attempts on average, for agents that pass at these rates.
   * A gate against history is figured against `history`, a baseline it says (47 of 50 unless the
   * query names one): the chance it fails, by the pass rate now, is its power to catch a drop.
   */
  odds: Array<{ rate: number; pass: number; fail: number; inconclusive: number; attempts: number }>;
  /** A gate against history: the baseline its odds are figured against. Null for an SPRT gate. */
  history: { passes: number; attempts: number } | null;
  /** With 100 forked goldens of an agent that passes 95% of the time, how often a CI run goes red for nothing, under `--inconclusive fail` and `warn`. */
  ci: { goldens: number; rate: number; red: number; redWarn: number };
  /** What `{}` and `{ "baseline": "history" }` stand for in a golden's gate, and blame's own figures. */
  defaults: { sprt: Omit<Gate & { kind: 'sprt' }, 'kind'>; baseline: Omit<Gate & { kind: 'baseline' }, 'kind'>; blame: Omit<Gate & { kind: 'sprt' }, 'kind'> };
}

const PREVIEW_RATES = [0.99, 0.95, 0.9, 0.8, 0.7, 0.5];
/** A history gate's preview by the pass rate now, against its baseline: unchanged, then by how far it dropped. */
const HISTORY_RATES = [0.95, 0.9, 0.85, 0.75, 0.6, 0.5, 0.2];
/** The baseline a history gate's preview is figured against when the query names none: a golden that passed 47 of its last 50 attempts. */
export const PREVIEW_HISTORY = { passes: 47, attempts: 50 } as const;

/** `47/50`: a baseline's passes and attempts, as the preview's `history` query value gives them. */
function historyQuery(raw: string | null): { passes: number; attempts: number } {
  if (raw === null || raw === '') return { ...PREVIEW_HISTORY };
  const m = /^(\d{1,6})\/(\d{1,6})$/.exec(raw);
  const passes = m ? Number(m[1]) : NaN;
  const attempts = m ? Number(m[2]) : NaN;
  if (!m || attempts < 1 || passes > attempts) throw new Error('history must be passes/attempts, such as 47/50');
  return { passes, attempts };
}

/**
 * A gate's preview from its figures as a page sends them (query values, all optional): `good`,
 * `bad`, `risk`, `max`, or `baseline=history` with `drop`, `risk`, `window`, `min`, `max` and the
 * baseline to figure it against, `history=47/50`. Throws with the config's own message for a gate it
 * would refuse.
 */
export function gatePreview(query: { get(name: string): string | null }): GatePreview {
  const json: Record<string, unknown> = {};
  for (const key of ['baseline', 'good', 'bad', 'risk', 'max', 'drop', 'window', 'min']) {
    const raw = query.get(key);
    if (raw === null || raw === '') continue;
    json[key] = key === 'baseline' ? raw : Number(raw);
  }
  const gate = parseGate(json, 'gate');
  const history = gate.kind === 'baseline' ? historyQuery(query.get('history')) : null;
  const odds = gateOddsAt(gate, gate.kind === 'sprt' ? PREVIEW_RATES : HISTORY_RATES, history);
  // A healthy agent's CI: the baseline it is figured against is its own rate, for a gate against history.
  const healthy = gate.kind === 'sprt' ? odds.find((o) => o.rate === 0.95)! : gateOdds(gate, 0.95, { passes: 95, attempts: 100 });
  return {
    gate,
    description: describeGate(gate),
    toPass: gate.kind === 'sprt' ? attemptsToPass(gate) : null,
    toFail: gate.kind === 'sprt' ? attemptsToFail(gate) : null,
    passesPerFailure: gate.kind === 'sprt' ? passesPerFailure(gate) : null,
    odds: odds.map((o) => ({ rate: o.rate, pass: o.pass, fail: o.fail, inconclusive: o.inconclusive, attempts: o.attempts })),
    history,
    ci: { goldens: 100, rate: 0.95, red: runsRed(healthy, 100, 'fail'), redWarn: runsRed(healthy, 100, 'warn') },
    defaults: { sprt: { ...SPRT_DEFAULTS }, baseline: { ...BASELINE_DEFAULTS }, blame: { ...BLAME_DEFAULTS } },
  };
}

/**
 * What a result's gate decided, as the screen shows it: the tally, what an attempt cost, and for an
 * inconclusive one, Run more attempts with twice the limit. Null when it decided nothing: an attempt
 * a check could not decide stopped it first (a result kept before test left such a gate out keeps
 * one still going, which no verdict word names).
 */
export function gateResultView(r: TestResult, golden: string): GateResultView | null {
  const g = r.data?.gate;
  if (!g || g.decision === 'continue') return null;
  // What this session's own attempts cost, the agent's calls and its judges' alike (each forked
  // attempt asks its judges live): carried-over ones were paid for before.
  const agent = r.data?.spent;
  const judges = r.data?.judge?.spent;
  const spent = typeof agent === 'number' ? agent + (typeof judges === 'number' ? judges : 0) : undefined;
  const own = r.data?.attempts?.total ?? g.attempts;
  const perAttempt = typeof spent === 'number' && spent > 0 && own > 0 ? spent / own : null;
  return { ...g, tally: formatTally(g), perAttempt, more: moreAttempts(g, golden, perAttempt) };
}

/**
 * Run more attempts for an inconclusive gate: continue it to twice its limit, carrying its attempts
 * over, with what that adds on average for an agent that passes as often as it has so far (an exact
 * walk from where it stopped, under the raised limit).
 */
function moreAttempts(g: GateResult, golden: string, perAttempt: number | null): MoreAttempts | null {
  if (g.decision !== 'inconclusive' || g.clean || optionLike(golden) || g.attempts < 1) return null;
  const limit = g.max;
  const raised = Math.min(GATE_MAX_ATTEMPTS, limit * 2);
  if (raised <= g.attempts) return null;
  const gate = { ...gateOf(g), max: raised };
  const history = g.evidence?.kind === 'baseline' ? g.evidence.history : null;
  const odds = gateOdds(gate, g.passes / g.attempts, history, { passes: g.passes, attempts: g.attempts });
  const expected = Math.max(0, odds.attempts - g.attempts);
  return {
    args: ['test', golden, '--max-attempts', String(raised), '--continue'],
    job: { golden, maxAttempts: raised, continue: true },
    attempts: raised,
    most: raised - g.attempts,
    expected,
    settles: odds.pass + odds.fail,
    cost: perAttempt === null ? null : perAttempt * expected,
  };
}

const runIfKept = (store: Store, runId: string | null) => (runId && store.getRun(runId) ? runId : null);

/**
 * For a result of more than one attempt: of the attempts that judged each check (it passed, failed or
 * couldn't be decided there), how many passed it, by label. Each attempt's run keeps its checks. Null
 * for a single attempt, or when a run is gone: a tally missing an attempt would claim too much.
 */
function checkTallies(store: Store, r: TestResult): Map<string, { passed: number; of: number }> | null {
  const runs = r.data?.attempts?.runs ?? [];
  if (runs.length < 2) return null;
  const out = new Map<string, { passed: number; of: number }>();
  for (const id of runs) {
    const run = store.getRun(id);
    if (!run) return null;
    const seen = new Set<string>();
    for (const c of run.meta?.checks ?? []) {
      // A label once per attempt; a check that did not apply there says nothing either way.
      if (seen.has(c.label)) continue;
      seen.add(c.label);
      const status = checkStatus(c);
      if (status === 'not-applicable') continue;
      const t = out.get(c.label) ?? { passed: 0, of: 0 };
      t.of++;
      if (status === 'passed') t.passed++;
      out.set(c.label, t);
    }
  }
  return out;
}

/**
 * A golden's checks with how its last result came out on each: the status the attempt it shows kept
 * for it (the CLI judges a diverged replay's checks too, and fails what it didn't do), and over
 * several attempts, how many passed it. A check the result didn't judge (added since, or a golden that
 * couldn't run) has no status, as none has before the golden's first result.
 */
function goldenChecks(store: Store, labels: readonly string[], r: TestResult | null): GoldenCheck[] {
  const kept = r?.data?.checks ?? [];
  const used = new Set<number>();
  const tallies = r && labels.length ? checkTallies(store, r) : null;
  return labels.map((label) => {
    const i = kept.findIndex((c, j) => !used.has(j) && c.label === label);
    if (i < 0) return { label, status: null, detail: null, reason: null, source: null, attempts: null };
    used.add(i);
    const c = kept[i]!;
    const tally = tallies?.get(label);
    return { label, status: checkStatus(c), detail: c.detail ?? null, reason: c.reason ?? null, source: c.source ?? null, attempts: tally && tally.of > 1 ? tally : null };
  });
}

/**
 * The judge check an inconclusive result couldn't decide for want of a verdict, and what settles it:
 * for a golden that replays offline and replayed clean, Update golden, which asks the judge once and
 * keeps its verdict in the pack; for a golden that forks, the key it lacked, when that is why. Null
 * when no judge check is what kept it undecided.
 */
function unjudgedCheck(path: string, mode: 'replay' | 'fork', r: TestResult): UnjudgedCheck | null {
  const c = (r.data?.checks ?? []).find((x) => checkStatus(x) === 'inconclusive' && x.judge);
  if (!c?.judge) return null;
  const provider = judgeTarget(c.judge.model)?.provider ?? null;
  const why = c.detail ?? 'not judged';
  // Offline, nothing could ask the judge; --update asks it live, once, and keeps the verdict, for a replay that ran clean.
  const update = mode === 'replay' && !r.data?.divergence && !optionLike(path) ? ['test', path, '--update'] : null;
  const keys = mode === 'fork' && provider && /\bno key for\b/.test(why) ? JUDGE_KEYS[provider] : null;
  return { name: c.judge.name, label: c.label, model: c.judge.model, provider, why, update, keys };
}

/** What the network guard prints when it blocks a connection, Node's and Python's alike, and the error it raises. */
const GUARD_BLOCKED = /blocked (?:an )?outbound connection to (\S+?)(?=:\s|\s\(SHADOWLAP_GUARD)/g;

/**
 * The connections the network guard blocked during a replay (`host:port`): the agent went to a host
 * directly, past Shadowlap, and a test, replaying offline, refuses that. The run keeps what the guard
 * reported; an agent that dies at once can exit before its report lands, so what it printed counts
 * too. An agent that catches the refusal can still pass, and the screen says so all the same.
 */
function blockedTargets(store: Store, r: TestResult): string[] {
  const out = new Set<string>();
  const hosts = r.runId ? store.getRun(r.runId)?.meta?.notRecorded?.hosts : undefined;
  if (Array.isArray(hosts)) for (const h of hosts) if (h?.action === 'blocked' && typeof h.target === 'string') out.add(h.target);
  for (const text of [r.data?.output, r.data?.details]) if (typeof text === 'string') for (const m of text.matchAll(GUARD_BLOCKED)) out.add(m[1]!);
  return [...out].slice(0, 5);
}

const blockedWords = (blocked: readonly string[]) => `blocked connection to ${blocked.join(', ')}`;

/** A result's line, saying first when the guard blocked a connection the replay made past Shadowlap. */
function lineOf(store: Store, r: TestResult, checks: readonly string[], normalizers: readonly Normalizer[] = []): string {
  const blocked = blockedTargets(store, r);
  const line = resultLine(r, checks, normalizers);
  return blocked.length ? `${blockedWords(blocked)} · ${line}` : line;
}

/** A history cell's hover note: why it failed, or a connection the guard blocked in a replay that passed. */
function cellNote(store: Store, r: TestResult, checks: readonly string[], normalizers: readonly Normalizer[] = []): string | null {
  if (!r.ok) return lineOf(store, r, checks, normalizers);
  const blocked = blockedTargets(store, r);
  return blocked.length ? blockedWords(blocked) : null;
}

/** A committed revision to bisect from: `abc1234+dirty` was tested with changes on top of abc1234. */
const committed = (rev: string | null) => (rev ? rev.replace(/\+dirty$/, '') : null);

/**
 * `normalize add` for each value listed, then `test` on the golden; null when there is none. When
 * the rules alone can't make the replay match, the golden is updated after them: a value the
 * recording never had can't be masked into a match, and neither can a change of another kind. The
 * rules still matter then, or the run after the update diverges again. An id that may be a real
 * change gets its rule too: running this is the person saying it changes every run.
 */
function normalizeSteps(volatile: VolatileValues, golden: string): string[][] | null {
  if (!volatile.values.length) return null;
  return [...volatile.values.map((v) => normalizeAddArgs(v.normalizer)), volatile.coversAll ? ['test', golden] : ['test', golden, '--update']];
}

/** The checks a result was judged by, as their labels in order: none when it ran without any. */
const labelsOf = (r: TestResult): string[] => (r.data?.checks ?? []).map((c) => c.label).sort();

/** Whether a result was judged by the checks a golden has now (`now`, as the CLI labels them). */
export function underChecks(r: TestResult, now: readonly string[]): boolean {
  const had = labelsOf(r);
  const want = [...now].sort();
  return had.length === want.length && had.every((label, i) => label === want[i]);
}

/**
 * Find the commit for a failing golden, from the newest result that passed before the failure at
 * another revision, under the checks the golden has now: a pass under other checks (one added since,
 * say) may be a commit where it already fails them, and bisect would find nothing. Best is a pass of
 * the recording that fails now, tested as committed: a pass of an earlier recording of the golden
 * (before an update) may be a commit where this one already fails, and uncommitted changes are not
 * part of what bisect checks out.
 */
function bisectFor(golden: string, history: readonly TestResult[], failed: TestResult, live: boolean, checks: readonly string[]): BisectRange | null {
  const passed = history.filter((r) => r.ok && r.at < failed.at && r.revision && committed(r.revision) !== committed(failed.revision) && underChecks(r, checks));
  const rank = (r: TestResult) => (failed.goldenRunId && r.goldenRunId === failed.goldenRunId ? 0 : 2) + (r.revision!.endsWith('+dirty') ? 1 : 0);
  // Newest first, so the first of the best rank is the newest of it.
  const good = passed.reduce<TestResult | null>((best, r) => (!best || rank(r) < rank(best) ? r : best), null);
  const goodRev = committed(good?.revision ?? null);
  if (!goodRev) return null;
  const bad = failed.revision && !failed.revision.endsWith('+dirty') ? failed.revision : null;
  return { good: goodRev, bad, args: ['bisect', golden, '--good', goodRev, ...(bad ? ['--bad', bad] : [])], live };
}

/** How many commits Find the commit's dialog offers at most. */
const DIALOG_REVISIONS = 12;

/**
 * The commits a golden was tested at before it failed, newest first, for Find the commit's dialog to
 * offer as good ones: each as committed (bisect checks out commits), with how it did there (its
 * newest result, a committed one before one with changes on top) and whether under today's checks.
 */
function bisectRevisions(history: readonly TestResult[], failed: TestResult, checks: readonly string[]): BisectRevision[] {
  const out = new Map<string, { r: TestResult; rev: string }>();
  for (const r of history) {
    const rev = committed(r.revision);
    if (!rev || r.at >= failed.at || rev === committed(failed.revision)) continue;
    const seen = out.get(rev);
    // Newest first: keep the first, unless it had changes on top and this one is the commit itself.
    if (!seen || (seen.r.revision !== rev && r.revision === rev)) out.set(rev, { r, rev });
  }
  return [...out.values()]
    .sort((a, b) => b.r.at - a.r.at)
    .slice(0, DIALOG_REVISIONS)
    .map(({ r, rev }) => ({ rev, at: r.at, result: r.ok ? 'pass' : 'fail', verdict: verdictOfResult(r), sameChecks: underChecks(r, checks) }));
}

/** What Find the commit said about a golden: a first bad commit, or none and why (the `bisect.found` and `bisect.none` activity events). */
type BisectAnswer = { found: FoundCommit; missed: null } | { found: null; missed: BisectMiss };

/**
 * One answer, with the failure it answered: the golden's newest result when the search started, as
 * `shadowlap bisect` records it (`answered`), or null for an answer kept before it did.
 */
interface AnswerEvent {
  answer: BisectAnswer;
  at: number;
  answered: { at: number; ok: boolean } | null;
}

const MISS_OUTCOMES = new Set(['fails-at-good', 'passes-at-bad', 'untestable']);

/** Every answer Find the commit gave, by golden, newest first. */
function bisectAnswers(store: Store): Map<string, AnswerEvent[]> {
  const out = new Map<string, AnswerEvent[]>();
  for (const e of store.listEvents({ kinds: ['bisect.found', 'bisect.none'], limit: 500 })) {
    if (!e.ref) continue;
    const raw = (e.data ?? {}) as { answered?: { at?: unknown; ok?: unknown } | null };
    const answered = raw.answered && typeof raw.answered.at === 'number' && typeof raw.answered.ok === 'boolean' ? { at: raw.answered.at, ok: raw.answered.ok } : null;
    let answer: BisectAnswer;
    if (e.kind === 'bisect.none') {
      const d = (e.data ?? {}) as { why?: unknown; good?: unknown; bad?: unknown; outcome?: unknown };
      const outcome = typeof d.outcome === 'string' && MISS_OUTCOMES.has(d.outcome) ? (d.outcome as BisectMiss['outcome']) : null;
      answer = { found: null, missed: { why: String(d.why ?? 'no first bad commit'), good: typeof d.good === 'string' ? d.good : null, bad: typeof d.bad === 'string' ? d.bad : null, outcome, at: e.at } };
    } else {
      const d = e.data as { first?: { rev?: unknown; subject?: unknown; author?: unknown; date?: unknown }; why?: unknown; untested?: unknown; replays?: unknown; tokens?: unknown } | null;
      if (typeof d?.first?.rev !== 'string') continue;
      const untested = Array.isArray(d.untested) ? d.untested.filter((x): x is string => typeof x === 'string') : [];
      answer = { found: { rev: d.first.rev, subject: String(d.first.subject ?? ''), author: String(d.first.author ?? ''), date: String(d.first.date ?? ''), why: String(d.why ?? ''), untested, replays: Number(d.replays ?? 0), tokens: Number(d.tokens ?? 0), at: e.at }, missed: null };
    }
    const list = out.get(e.ref);
    if (list) list.push({ answer, at: e.at, answered });
    else out.set(e.ref, [{ answer, at: e.at, answered }]);
  }
  return out;
}

/** Two names of one commit: a short sha and a longer one, or the same. */
const sameCommit = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/**
 * What Find the commit said about the failure a golden shows, newest first: an answer stands only
 * for the failures since the golden last passed, and only when it answered one of them. One given
 * while the golden passed (a search from an old replay's page, or one still running when a session
 * passed it) is about a failure that is over, however it fails next. A search that found it passing
 * at the commit it fails at (`passes-at-bad`) stands only while it fails at that commit: once the
 * failure is committed, there is a commit to find again.
 */
function standingAnswer(answers: readonly AnswerEvent[] | undefined, history: readonly TestResult[], latest: TestResult): BisectAnswer | null {
  if (!answers?.length) return null;
  // Newest first: the failures since the newest pass, the oldest of them where this streak began.
  const pass = history.findIndex((r) => r.ok);
  const began = (pass < 0 ? history : history.slice(0, pass)).at(-1)?.at;
  if (began === undefined) return null;
  const failsAt = committed(latest.revision);
  for (const a of answers) {
    if (a.answered ? a.answered.ok || a.answered.at < began : a.at < began) continue;
    const m = a.answer.missed;
    if (m?.outcome === 'passes-at-bad' && m.bad && failsAt && !sameCommit(m.bad, failsAt)) continue;
    return a.answer;
  }
  return null;
}

/** How many of the newest sessions the history and the verdict's line are read from. */
const SESSION_WINDOW = 200;

/** A pattern among `test`'s arguments as a regular expression: `*` and `?` within one folder name, as the CLI expands them. */
function globRe(pattern: string): RegExp {
  const body = [...pattern].map((c) => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('');
  return new RegExp(`^${body}$`);
}

/**
 * Whether a session's command asks for every golden in `need`: each named, or matched by a pattern
 * (`goldens/*`, which the CLI expands). What a session asked to run, whether or not it got through
 * them (one stopped by a signal), and what one running now will run.
 */
export function asksForAll(command: readonly string[], need: readonly string[]): boolean {
  const args = command.slice(command.indexOf('test') + 1).map((a) => a.replace(/^\.\//, '').replace(/\/+$/, ''));
  const patterns = args.filter((a) => /[*?]/.test(a)).map(globRe);
  const named = new Set(args);
  return need.every((p) => named.has(p) || patterns.some((re) => re.test(p)));
}

/** Where a result shows in the history: a column of its own revision, or, run again with changes on top, the column of the commit under them. */
const columnOfRevision = (revision: string | null, columns: ReadonlySet<string | null>): string | null | undefined => (columns.has(revision) ? revision : columns.has(committed(revision)) ? committed(revision) : undefined);

/** The sessions the screen reads: the history's columns, the results they show, and the session the verdict's line names. */
interface SessionsRead {
  /** The history's columns, oldest first. */
  revisions: Array<string | null>;
  /** The results of every session read, newest first. */
  results: TestResult[];
  /** The column each session that ran every golden fills, by its id; a session that ran only some fills none of its own. */
  columnOf: Map<string, string | null>;
  shown: TestSession | null;
}

/**
 * Tells the sessions that ran every golden from those that ran some. A full session (CI's, Run
 * tests) asked for each golden on disk that had been tested before it started (`goldens/*`, or each
 * by name), or ran each of them; a golden packed since can't count against it. The history's columns
 * are the revisions of the newest full sessions, so Add normalizer and re-run or Update golden,
 * which run one golden, add no column of dashes for the others: their result shows in the column of
 * its revision, or of the commit under it when they ran with changes on top. The verdict's line
 * names the newest full session, with its own counts and command, also one stopped by a signal or
 * running now. Without any full session, every session counts as one.
 */
function testSessions(store: Store, goldens: readonly GoldenSource[], max: number): SessionsRead {
  const all = store.listTestSessions({ limit: SESSION_WINDOW });
  // Which goldens each session ran, without reading their results: only the shown columns' are read.
  const ran = store.testSessionGoldens(all.map((s) => s.sessionId));
  // A session counts once it has a result, or while it runs: one stopped before its first golden ended says nothing.
  const sessions = all.filter((s) => ran.has(s.sessionId) || sessionLive(store, s));
  const firstAt = store.firstTestResultAt();
  const readable = goldens.filter((g) => !unreadable(g)).map((g) => g.path);
  const full = (s: TestSession): boolean => {
    const need = readable.filter((p) => (firstAt.get(p) ?? Infinity) < s.startedAt);
    if (asksForAll(s.command, need)) return true;
    const got = ran.get(s.sessionId) ?? new Set<string>();
    return need.every((p) => got.has(p));
  };
  let whole = sessions.filter(full);
  if (!whole.length) whole = sessions;
  const revisions: Array<string | null> = [];
  for (const s of whole) {
    if (!revisions.includes(s.revision)) revisions.push(s.revision);
    if (revisions.length >= max) break;
  }
  revisions.reverse();
  const columnOf = new Map(whole.filter((s) => revisions.includes(s.revision)).map((s) => [s.sessionId, s.revision] as const));
  // The results the history shows: those of the sessions that fill its columns, and of sessions that
  // ran some goldens at a column's revision (or on its commit with changes on top).
  const columns = new Set(revisions);
  const shownIn = sessions.filter((s) => columnOf.has(s.sessionId) || columnOfRevision(s.revision, columns) !== undefined);
  const results = store.listTestResults({ sessionIds: shownIn.map((s) => s.sessionId), limit: 100_000 });
  return { revisions, results, columnOf, shown: whole[0] ?? store.listTestSessions({ limit: 1, withResults: true })[0] ?? null };
}

/** Results newest first, grouped by golden. */
function byGolden(results: readonly TestResult[]): Map<string, TestResult[]> {
  const out = new Map<string, TestResult[]>();
  for (const r of results) {
    const list = out.get(r.golden);
    if (list) list.push(r);
    else out.set(r.golden, [r]);
  }
  return out;
}

/**
 * Everything the Tests screen shows. A result is recorded once a golden's replays finish, so every
 * count here takes the results of every session, one still running (or whose process was killed)
 * included; only a session's own totals wait for its end.
 */
export function testsView(store: Store, goldens: readonly GoldenSource[], options: TestsOptions = {}): TestsView {
  const folder = options.folder ?? 'goldens';
  const rules = options.normalizers ?? [];
  const sessionsView = testSessions(store, goldens, options.revisions ?? 6);
  const { revisions } = sessionsView;
  // Only what the page shows is read: each golden's newest result, and the results of the sessions
  // the history's columns are made of.
  const latestOf = new Map(store.latestTestResults().map((r) => [r.golden, r]));
  const history = byGolden(sessionsView.results);
  const columns = new Set(revisions);

  const rows: GoldenRow[] = goldens.map((g) => {
    const list = history.get(g.path) ?? [];
    const latest = latestOf.get(g.path) ?? null;
    const sourceRun = runIfKept(store, g.runId);
    const recorded = sourceRun ? store.getRun(sourceRun) : null;
    const mode = modeOf(g);
    const error = unreadable(g);
    return {
      path: g.path,
      name: nameOf(g.path, folder),
      source: recorded && (!recorded.meta?.imported || pulledRun(recorded)) ? { kind: 'run', runId: recorded.runId } : { kind: 'pack', packedAt: g.packedAt },
      mode: g.mode,
      modeLabel: mode.label,
      modeHint: mode.hint,
      gate: gateView(g.gate),
      checks: g.checks,
      checkResults: goldenChecks(store, g.checks, latest),
      injection: !!g.injection,
      history: revisions.map((rev) => {
        // Its own column's sessions, and a session that ran only some goldens there, or on that
        // commit with changes on top (Add normalizer and re-run), where no column is its own.
        const here = list.filter((x) => (sessionsView.columnOf.has(x.sessionId) ? sessionsView.columnOf.get(x.sessionId) : columnOfRevision(x.revision, columns)) === rev);
        // The newest result there, ringed when any session there updated it: a run after the update keeps the ring.
        const r = here[0] ?? null;
        return {
          revision: rev,
          tested: r?.revision ?? null,
          result: r ? (r.ok ? 'pass' : 'fail') : null,
          verdict: r ? verdictOfResult(r) : null,
          rate: r ? attemptsOf(r) : null,
          dropped: !!r && r.data?.gate?.kind === 'baseline' && r.data.gate.decision === 'fail',
          note: r ? cellNote(store, r, g.checks, rules) : null,
          updated: here.some((x) => !!x.data?.updated),
          runId: r ? runIfKept(store, r.runId) : null,
          at: r?.at ?? null,
        };
      }),
      last: latest
        ? { result: latest.ok ? 'pass' : 'fail', verdict: verdictOfResult(latest), failure: latest.failure, line: latest.ok || !latest.data?.updated ? lineOf(store, latest, g.checks, rules) : `updated${latest.revision ? ` at ${latest.revision}` : ''}, then ${lineOf(store, latest, g.checks, rules)}`, at: latest.at, updated: !!latest.data?.updated, gate: gateResultView(latest, g.path), injection: latest.data?.injection ?? null }
        : { result: null, verdict: null, failure: null, line: error ? `can't be read: ${error}` : 'not run yet', at: null, updated: false, gate: null },
      runId: runIfKept(store, latest?.runId ?? null) ?? sourceRun,
      error,
    };
  });

  const divergences: DivergenceView[] = [];
  const failures: FailureView[] = [];
  const inconclusive: InconclusiveView[] = [];
  const answers = bisectAnswers(store);
  for (const row of rows) {
    const latest = latestOf.get(row.path);
    if (!latest || latest.ok) continue;
    // Neither passed nor failed: nothing to bisect or fix, only attempts to add.
    if (verdictOfResult(latest) === 'inconclusive') {
      // Its gate ran out of attempts between its bounds; or a check, or its injection gate, is what is
      // inconclusive (an attempt a check could not decide stopped its gate, which decided nothing).
      const gate = latest.data?.gate?.decision === 'inconclusive' ? latest.data.gate : null;
      inconclusive.push({ golden: row.path, name: row.name, runId: row.runId, reason: gate ? gateVerdictLine(gate) : (latest.reason ?? 'inconclusive'), checks: latest.data?.checks ?? null, details: latest.data?.details ?? null, gate: gate ? row.last.gate : null, failure: latest.failure, judge: gate ? null : unjudgedCheck(row.path, row.mode, latest) });
      continue;
    }
    const past = store.listTestResults({ golden: row.path, limit: 1000 });
    // A pack that can't be read can't be bisected either.
    const bisect = row.error ? null : bisectFor(row.path, past, latest, row.mode === 'fork', row.checks);
    const answer = standingAnswer(answers.get(row.path), past, latest);
    const found = answer?.found ?? null;
    const missed = answer?.missed ?? null;
    const revisionsToOffer = row.error ? [] : bisectRevisions(past, latest, row.checks);
    const d = latest.failure === 'diverged' ? divergenceOf(latest) : null;
    if (d) {
      const volatile = volatileOf(latest, d);
      divergences.push({
        golden: row.path,
        name: row.name,
        runId: row.runId,
        callNo: d.callNo,
        kind: d.kind,
        callName: d.name,
        text: `✗ ${row.name}: ${latest.reason ?? `diverged at call ${d.callNo}`}\n${(latest.data?.divergence?.text ?? '').split('\n').map((l) => `    ${l}`).join('\n')}`,
        volatile: shownValue(volatile),
        normalizerFixes: volatile.explainsAll,
        maybeReal: volatile.values.some((v) => !v.certain),
        rerun: ['test', row.path],
        update: ['test', row.path, '--update'],
        normalizeAndTest: normalizeSteps(volatile, row.path),
        rulesAdded: volatile.values.length > 0 && volatile.values.every((v) => (options.normalizers ?? []).some((n) => sameRule(n, v.normalizer))),
        bisect,
        found,
        missed,
        revisions: revisionsToOffer,
        unreadable: row.error,
      });
    } else {
      const blocked = blockedTargets(store, latest);
      failures.push({ golden: row.path, name: row.name, runId: row.runId, failure: latest.failure ?? 'error', reason: latest.reason ?? 'failed', checks: latest.data?.checks ?? null, details: latest.data?.details ?? null, output: latest.data?.output ?? null, blocked: blocked.length ? blocked : null, bisect, found, missed, revisions: revisionsToOffer, unreadable: row.error });
    }
  }

  // The verdict counts every golden on disk by its last result, whichever session that came from: a
  // session that ran one golden says nothing about the others. Its line is a session's own: the
  // newest that ran them all (or runs them now), with what ran since in sessions that ran some.
  let verdict: TestsVerdict | null = null;
  const lastResults = goldens.map((g) => latestOf.get(g.path)).filter((r): r is TestResult => r !== undefined);
  const shown = sessionsView.shown;
  if (shown && lastResults.length) {
    const failed = lastResults.filter((r) => verdictOfResult(r) === 'failed');
    const unsure = lastResults.filter((r) => verdictOfResult(r) === 'inconclusive');
    // The title names the first failure, else the first inconclusive one.
    const first = failed[0] ?? unsure[0] ?? null;
    const total = goldens.length;
    const passing = lastResults.length - failed.length - unsure.length;
    const untested = total - lastResults.length;
    verdict = {
      state: failed.length ? 'failing' : unsure.length ? 'inconclusive' : 'passing',
      failing: failed.length,
      inconclusive: unsure.length,
      passing,
      untested,
      // One golden: "All 1 goldens pass" isn't English.
      title: first ? `${nameOf(first.golden, folder)} ${shortReason(first)}` : untested ? `${passing} of ${total} goldens pass, ${untested} not run yet` : total === 1 ? 'The golden passes' : `All ${total} goldens pass`,
      first: first ? { golden: first.golden, name: nameOf(first.golden, folder), reason: first.reason ?? 'failed', runId: runIfKept(store, first.runId) } : null,
      session: sessionView(store, shown),
      since: lastResults.filter((r) => r.sessionId !== shown.sessionId && r.at > shown.startedAt).map((r) => ({ golden: r.golden, name: nameOf(r.golden, folder), ok: r.ok, verdict: verdictOfResult(r), revision: r.revision, at: r.at })),
    };
  }

  const diverged = divergences.map((d) => d.golden);
  const patterns = testPatterns(goldens, folder);
  const live = liveTestSession(store);
  const presets = liveChaosSession(store);
  return {
    empty: goldens.length === 0,
    goldens: goldens.length,
    verdict,
    revisions,
    rows,
    divergences,
    failures,
    inconclusive,
    diverged,
    running: live ? sessionView(store, live) : null,
    chaosRunning: presets ? { id: presets.sessionId, command: presets.command.join(' '), startedAt: presets.startedAt } : null,
    commands: {
      ci: `shadowlap test ${patterns.map(ciWord).join(' ')} --junit report.xml --markdown "$GITHUB_STEP_SUMMARY" --annotations`,
      pack: `shadowlap pack <run> ${folder}/<name>`,
      run: ['test', ...patterns],
      updateAll: diverged.length ? ['test', ...diverged, '--update'] : null,
    },
    note: RECORDINGS_NOTE,
  };
}

/**
 * The goldens on disk, as `projectGoldens` lists them or by their paths. Required wherever results
 * are counted: the history keeps the results of goldens since deleted or renamed, and those must not
 * count as passing or as regressions forever.
 */
export type GoldenList = ReadonlyArray<string | GoldenSource>;

const pathOf = (g: string | GoldenSource) => (typeof g === 'string' ? g : g.path);

/** The latest result of each golden given, as of a time. */
function latestResults(store: Store, goldens: GoldenList, until?: number): Map<string, TestResult> {
  const keep = new Set(goldens.map(pathOf));
  return new Map(store.latestTestResults(until !== undefined ? { until } : {}).filter((r) => keep.has(r.golden)).map((r) => [r.golden, r]));
}

export interface TestsSummary {
  /** No goldens at all: "—, no goldens yet". */
  empty: boolean;
  total: number;
  passing: number;
  /** Goldens whose last result failed: the regressions caught. */
  failing: number;
  /** Goldens whose last result is inconclusive, counted apart from both. */
  inconclusive: number;
  /** Goldens never tested yet. */
  untested: number;
  /** `2 regressions caught`, `no regressions`, or `no goldens yet`. */
  line: string;
  /** When the tests last ran (the end of the newest session with a result, or its newest result while it runs), or null. */
  lastRunAt: number | null;
  /** The same a week earlier, for the change against last week; null without history that old. */
  lastWeek: { passing: number; total: number } | null;
}

/**
 * The Overview's Tests passing tile, over `goldens`, the packs on disk (`projectGoldens`); `weekStart`
 * is when the comparison with last week is made (default: 7 days before `now`).
 */
export function testsSummary(store: Store, options: { goldens: GoldenList; now?: number; weekStart?: number }): TestsSummary {
  const now = options.now ?? Date.now();
  const latest = latestResults(store, options.goldens);
  const total = new Set(options.goldens.map(pathOf)).size;
  const passing = [...latest.values()].filter((r) => r.ok).length;
  const inconclusive = [...latest.values()].filter((r) => verdictOfResult(r) === 'inconclusive').length;
  const failing = latest.size - passing - inconclusive;
  const session = store.listTestSessions({ limit: 1, withResults: true })[0] ?? null;
  const weekAgo = latestResults(store, options.goldens, options.weekStart ?? now - 7 * 24 * 60 * 60 * 1000);
  return {
    empty: total === 0,
    total,
    passing,
    failing,
    inconclusive,
    untested: Math.max(0, total - latest.size),
    line: total === 0 ? 'no goldens yet' : failing ? `${plural(failing, 'regression')} caught` : 'no regressions',
    lastRunAt: session ? lastActive(store, session) : null,
    lastWeek: weekAgo.size ? { passing: [...weekAgo.values()].filter((r) => r.ok).length, total: weekAgo.size } : null,
  };
}

/**
 * The Tests passing number of the Overview's outcome strip, in the shape its `tests` hook takes:
 * goldens with a result, how many pass, how many passed when this week started, the regressions
 * caught, and when the tests last ran. Null when there are no goldens yet.
 */
export function overviewTests(store: Store, asOf: { now: number; weekStart: number }, options: { goldens: GoldenList }): { goldens: number; passing: number; inconclusive: number; lastWeek: number | null; regressions: number; lastRunAt: number | null } | null {
  const s = testsSummary(store, { goldens: options.goldens, now: asOf.now, weekStart: asOf.weekStart });
  if (s.empty) return null;
  return { goldens: s.total, passing: s.passing, inconclusive: s.inconclusive, lastWeek: s.lastWeek ? s.lastWeek.passing : null, regressions: s.failing, lastRunAt: s.lastRunAt };
}

export interface FailingTest {
  golden: string;
  /** For Needs a look: `A test failed: refund-in-limit`, or `A test is inconclusive: refund-over-limit`. */
  title: string;
  /** Failed, or inconclusive: Needs a look lists both, told apart. */
  verdict: 'failed' | 'inconclusive';
  /** Why: `diverged at call 1 · $.metadata.user_id looks like a UUID`. */
  line: string;
  failure: TestFailure;
  runId: string | null;
  /** Where Fix → goes: the failing run, else the Tests screen. */
  href: string;
  at: number;
}

/** Goldens on disk failing now, newest failure first: Needs a look's failing tests. */
export function failingTests(store: Store, options: { goldens: GoldenList; folder?: string; normalizers?: readonly Normalizer[] }): FailingTest[] {
  const folder = options.folder ?? 'goldens';
  const checksOf = new Map(options.goldens.filter((g): g is GoldenSource => typeof g !== 'string').map((g) => [g.path, g.checks]));
  return [...latestResults(store, options.goldens).values()]
    .filter((r) => !r.ok)
    .sort((a, b) => b.at - a.at)
    .map((r) => {
      const runId = runIfKept(store, r.runId);
      const verdict = verdictOfResult(r) === 'inconclusive' ? 'inconclusive' : 'failed';
      return { golden: r.golden, title: `${verdict === 'inconclusive' ? 'A test is inconclusive' : 'A test failed'}: ${nameOf(r.golden, folder)}`, verdict, line: lineOf(store, r, checksOf.get(r.golden) ?? [], options.normalizers ?? []), failure: r.failure ?? 'error', runId, href: verdict === 'inconclusive' ? '#/tests' : runId ? `#/run/${runId}` : '#/tests', at: r.at };
    });
}

/** What the run page's diverged-test banner offers for a replay `shadowlap test` made. */
export interface TestRunBanner {
  golden: string;
  session: string;
  /** The value that changes every run, with the normalizer that masks it, when that is what diverged. */
  volatile: DivergenceView['volatile'];
  /** Values that surely change every run are all that diverged: Add normalizer, then re-run the golden. */
  normalizerFixes: boolean;
  /** An id that may be a real change diverged: offer Update golden and Add normalizer alike (see DivergenceView). */
  maybeReal: boolean;
  /** Every value that changes every run in the divergence, with the normalizer for each. */
  values: VolatileValues;
  /** Arguments for the CLI: re-run the golden (after adding the normalizer), or update it. */
  rerun: string[];
  update: string[];
  /**
   * Add normalizer and re-run, as the commands to run in order, ending in `test --update` when
   * `normalizerFixes` is false (as on the Tests screen); null when no value that changes every run diverged.
   */
  normalizeAndTest: string[][] | null;
  /**
   * Every rule Add normalizer would add is in the config's normalizers now (as `normalizers` gives
   * them): what is left is to run the golden again, or to update it when the rules alone can't make
   * it match. As on the Tests screen, where the button becomes Re-run.
   */
  rulesAdded: boolean;
  /**
   * The change that made it diverge: the first the rules in force didn't mask, as the CLI kept it
   * with the golden's result (or, for a result kept before it did, as `normalizers` leave it). The
   * run's divergence lists the masked changes too. Null when nothing says.
   */
  cause: string | null;
}

/**
 * For a run made by `shadowlap test` whose golden failed because it diverged: its golden and the
 * actions on it. Null for any other run, a replay of a golden that may fork (it diverges by design)
 * included. `normalizers` are the rules in the config now.
 */
export function testRunBanner(store: Store, runId: string, options: { normalizers?: readonly Normalizer[] } = {}): TestRunBanner | null {
  const run = store.getRun(runId);
  const test = run?.meta?.test;
  if (!run || !test || !run.divergence) return null;
  const result = store.listTestResults({ sessionId: test.session, golden: test.golden, limit: 1 })[0];
  if (result?.failure !== 'diverged') return null;
  // As judged when it ran, under the normalizers in force then; judged again for older history.
  const ownResult = result.runId === run.runId;
  const kept = ownResult ? result.data?.divergence?.volatile : undefined;
  const found = kept ? storedVolatile(kept) : volatileValues(run.divergence);
  const keptCause = ownResult ? result.data?.divergence?.cause : undefined;
  const d = run.divergence;
  const cause = keptCause !== undefined ? keptCause : options.normalizers?.length && d.type === 'request_changed' ? ((d.diff ?? []).find((e) => !maskedChange(e, options.normalizers!, d))?.path ?? null) : null;
  return {
    golden: test.golden,
    session: test.session,
    volatile: shownValue(found),
    normalizerFixes: found.explainsAll,
    maybeReal: found.values.some((v) => !v.certain),
    values: found,
    rerun: ['test', test.golden],
    update: ['test', test.golden, '--update'],
    normalizeAndTest: normalizeSteps(found, test.golden),
    rulesAdded: found.values.length > 0 && found.values.every((v) => (options.normalizers ?? []).some((n) => sameRule(n, v.normalizer))),
    cause,
  };
}

// ---- Find the commit, from a run: the run page's fork menu and the calendar's failed days ----

export interface BisectChoices {
  /** What bisect replays: the golden a test replay came from, which replays offline, or the run itself. */
  target: { kind: 'golden'; golden: string } | { kind: 'run'; runId: string };
  /**
   * The run failed: bisect looks for where it started failing, from a good commit up to its own.
   * Otherwise it passed, and bisect looks for the first commit after its own that changes what it does;
   * or it is inconclusive, neither passed nor failed, and `unavailable` says so.
   */
  failed: boolean;
  /** A commit where it still worked, to offer first: the newest revision before it where its golden, or a run of its command, passed. */
  good: string | null;
  /** Where it fails: the run's own revision for a failed run (null: HEAD, as for one made with uncommitted changes). */
  bad: string | null;
  /**
   * Revisions to choose a good one from, newest first: where its golden or its command ran before it,
   * and how those runs went: `failed`, and for a golden's results `inconclusive`, counted apart, an
   * inconclusive result being neither passed nor failed; `subject` is the commit's, once the
   * project's git was asked (commits-here.ts).
   */
  revisions: Array<{ rev: string; at: number; runs: number; failed: number; inconclusive?: number; subject?: string | null }>;
  /**
   * The check bisect judges each replay by (`--expect`), for a run blame found failing it: the check
   * of the fix it fails in. A run that exited 0 and kept no failed check of its own failed only that
   * one, so without it bisect would look for where a passing run changes. Null (or absent) otherwise.
   */
  expect?: Record<string, unknown> | null;
  /**
   * A run that failed on its own (an exit status, a crash, a check) rather than by diverging: each
   * replay at an older commit runs live from where its requests differ, so the outcome decides. That
   * part costs tokens.
   */
  fork: boolean;
  /** Replays run live from where they diverge (`fork`, or a golden that may fork): the search costs tokens. */
  live: boolean;
  /** Why Find the commit can't start from this run, for the disabled action's hover; null when it can. */
  unavailable: string | null;
  /** The command for `good` and `bad` (after `shadowlap`), or null until a good commit is known or when unavailable. */
  args: string[] | null;
}

const clean = (rev: string | null): rev is string => !!rev && !rev.endsWith('+dirty');

const exitFailed = (run: RunRecord) => run.status === 'failed' || run.status === 'crashed';

/** A check of the run's own that failed: one that could not be decided (inconclusive) is no failure. */
const checkFailed = (run: RunRecord) => !!run.meta?.checks?.some((c) => checkStatus(c) === 'failed');

function runFailed(run: RunRecord): boolean {
  return exitFailed(run) || checkFailed(run);
}

/**
 * Find the commit that broke a run. A replay made by `shadowlap test` of a golden on disk bisects the
 * golden, which replays offline; any other run is bisected as it is. `goldens` are the packs on disk
 * (`projectGoldens`), with the checks the config gives each; `before` limits the good commits to runs
 * started before it (the calendar passes the first day picked).
 */
export function bisectChoices(store: Store, runId: string, options: { goldens: readonly GoldenSource[]; before?: number }): BisectChoices | null {
  const run = store.getRun(runId);
  if (!run) return null;
  const golden = run.meta?.test?.golden ?? null;
  // As listed: a pack in the goldens folder, or one the config names under `tests` (its checks too).
  const source = golden !== null ? (options.goldens.find((g) => g.path === golden) ?? null) : null;
  // Only a golden whose pack can be read, by a path that reads as no option, is bisected as one.
  const ofGolden = !!source && !unreadable(source);
  const before = options.before ?? run.startedAt;
  const own = committed(run.codeVersion);
  // A test replay failed when its golden did in that session (a golden that may fork diverges by design).
  const result = ofGolden ? store.listTestResults({ sessionId: run.meta!.test!.session, golden: golden!, limit: 1 })[0] : undefined;
  // Its golden came out inconclusive there: neither passed nor failed, so no failure to find.
  const unsure = result !== undefined && verdictOfResult(result) === 'inconclusive';
  // A run in a fix as failing its check (blame found it so, or a repair or verify did), though it
  // exited 0 with no check of its own failed: that check is the one it failed.
  const blamed = !ofGolden && !runFailed(run) ? blamedCheck(store, run) : null;
  const failed = result ? verdictOfResult(result) === 'failed' : runFailed(run) || (ofGolden && !!run.divergence) || blamed !== null;
  // A run that failed nothing, with a check of its own that could not be decided: neither passed nor
  // failed, as a golden that came out inconclusive is, so there is no failure to find either.
  const undecided = !result && !failed ? (run.meta?.checks ?? []).find((c) => checkStatus(c) === 'inconclusive') : undefined;
  let revisions: BisectChoices['revisions'];
  let sameRecording: string | null = null;
  let passedHere: string | null = null;
  if (ofGolden) {
    const at = new Map<string, { rev: string; at: number; runs: number; failed: number; inconclusive: number }>();
    for (const r of store.listTestResults({ golden: golden!, limit: 10_000 })) {
      if (r.at >= before || !clean(r.revision) || r.revision === own) continue;
      // Newest first: the first pass of the recording this replay failed on, under the checks the
      // golden has now, is the one to offer: an earlier recording of the golden (before an update), or
      // a pass under other checks, may be a commit where it already fails.
      const counts = r.ok && underChecks(r, source!.checks);
      if (!sameRecording && counts && result?.goldenRunId && r.goldenRunId === result.goldenRunId) sameRecording = r.revision;
      if (!passedHere && counts) passedHere = r.revision;
      const row = at.get(r.revision) ?? { rev: r.revision, at: r.at, runs: 0, failed: 0, inconclusive: 0 };
      row.runs++;
      const verdict = verdictOfResult(r);
      if (verdict === 'failed') row.failed++;
      else if (verdict === 'inconclusive') row.inconclusive++;
      row.at = Math.max(row.at, r.at);
      at.set(r.revision, row);
    }
    revisions = [...at.values()].sort((a, b) => b.at - a.at);
  } else {
    revisions = store
      .runRevisions({ argv: run.command.argv, before, limit: 100 })
      .filter((r) => clean(r.revision) && r.revision !== own)
      .map((r) => ({ rev: r.revision, at: r.lastAt, runs: r.runs, failed: r.failed }));
  }
  const target: BisectChoices['target'] = ofGolden ? { kind: 'golden', golden: golden! } : { kind: 'run', runId: run.runId };
  const fork = !ofGolden && failed;
  // The check a forked replay is judged by: the run's own `--expect` when a check of it failed, else
  // the one blame found it failing. A golden's checks come from the config, as the CLI finds them.
  const expect = fork ? (checkFailed(run) && plainObject(run.meta?.expect) ? run.meta.expect : blamed) : null;
  // A run that passed is the good end itself; bisect then looks up to HEAD. One that failed only
  // blame's check leaves the good one to be chosen: how other runs exited says nothing about it.
  const good = !failed ? (clean(run.codeVersion) ? run.codeVersion : null) : ofGolden ? (sameRecording ?? passedHere) : blamed !== null ? null : (revisions.find((r) => r.failed < r.runs)?.rev ?? null);
  const bad = failed && clean(run.codeVersion) ? run.codeVersion : null;
  let unavailable: string | null = null;
  if (run.status === 'running') unavailable = 'this run is still recording';
  // A test replay a signal cut short has no result: it says nothing about its golden either way.
  else if (ofGolden && run.status === 'crashed' && !result) unavailable = `this replay was cut short, so it says nothing about ${golden}: find the commit from the golden on Tests`;
  else if (unsure) unavailable = `${golden} came out inconclusive in this replay's session, neither passed nor failed, so there is no failure to find the commit of: Tests says what settles it`;
  else if (undecided) unavailable = `this run is inconclusive, neither passed nor failed: a check could not be decided (${undecided.label}), so there is no failure to find the commit of`;
  else if (!ofGolden && !hasRecordedCommand(run)) unavailable = `this run ${withoutCommand(run)}, so there is no command to run at each commit: replay it once with your agent (shadowlap replay ${run.runId} -- <command>) and find the commit from that run`;
  // Someone else chose its command, and bisect would run it at every commit: the CLI asks first, which a job can't.
  else if (!ofGolden && commandIsImported(run)) unavailable = `this run came from ${importedCommandSource(run)}: bisect would run its command at every commit. Replay it with your own command first (shadowlap replay ${run.runId} -- <command>), and find the commit from that run`;
  // Replayed with --fork, only the exit status and the checks decide; the CLI takes the checks of the
  // golden it was a replay of from the config, and has none otherwise.
  else if (fork && !exitFailed(run) && !source?.checks.length && !expect) unavailable = `this run failed a check that bisect can't know: give it on the command line, shadowlap bisect ${run.runId} --good <commit> --expect '<checks>' --fork`;
  const ref = target.kind === 'golden' ? target.golden : target.runId;
  return {
    target,
    failed,
    good,
    bad,
    revisions: revisions.slice(0, 30),
    expect,
    fork,
    live: fork || (ofGolden && source!.mode === 'fork'),
    unavailable,
    args: good && !unavailable ? bisectArgs(ref, good, bad, fork, expect) : null,
  };
}

const plainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The check blame found a run failing: that of the fix it fails in (the `--expect` the first blame of
 * that failure was given). Null when the run fails in no fix, or its fix judges by the exit status alone.
 */
function blamedCheck(store: Store, run: RunRecord): Record<string, unknown> | null {
  const check = fixOfRun(store, run.runId)?.check.expect;
  return plainObject(check) && Object.keys(check).length ? check : null;
}

/** `bisect` for a target between two commits: forked and judged by a check when the run failed on its own. */
export function bisectArgs(ref: string, good: string, bad: string | null, fork: boolean, expect: Record<string, unknown> | null): string[] {
  return ['bisect', ref, '--good', good, ...(bad ? ['--bad', bad] : []), ...(expect ? ['--expect', JSON.stringify(expect)] : []), ...(fork ? ['--fork'] : [])];
}

// ---- jobs: what the Tests actions run ----

/**
 * A Tests action as a dashboard job: CLI arguments (after `shadowlap`) built from checked fields,
 * or why it can't run. The request comes from the browser and is not trusted: a golden must be one
 * of the packs on disk, a normalizer comes from the divergence the store kept, a revision has to look
 * like one. `steps` run one after the other, each only when the one before it succeeded.
 */
export type TestsJob = { title: string; args: string[]; runId?: string } | { title: string; steps: string[][]; runId?: string } | { error: string };

/** The golden a request names, as listed on disk, or null; never a path the CLI would read as an option. */
function knownGolden(goldens: readonly GoldenSource[], raw: unknown): string | null {
  const path = typeof raw === 'string' ? (goldens.find((g) => g.path === raw)?.path ?? null) : null;
  return path !== null && !optionLike(path) ? path : null;
}

/** A sha, a tag or a branch, possibly with `~n` or `^`; never an option or a range. A tested `+dirty` revision is its commit. */
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/~^-]{0,199}$/;
export function checkedRevision(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const rev = raw.trim().replace(/\+dirty$/, '');
  return REVISION.test(rev) && !rev.includes('..') ? rev : null;
}

/**
 * Run tests: every golden (`test goldens/*` and any kept elsewhere), or the one `golden` names.
 * `maxAttempts` is Run more attempts: each gate's limit raised for this session only (`--max-attempts`).
 */
export function runTestsJob(goldens: readonly GoldenSource[], req: Record<string, unknown>, options: TestsOptions = {}): TestsJob {
  let more: string[] = [];
  if (req.maxAttempts !== undefined) {
    const n = req.maxAttempts;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > GATE_MAX_ATTEMPTS) return { error: `maxAttempts is a whole number from 1 to ${GATE_MAX_ATTEMPTS}` };
    more = ['--max-attempts', String(n)];
  }
  // Run more attempts carries an inconclusive gate's attempts over rather than starting again.
  if (req.continue !== undefined) {
    if (typeof req.continue !== 'boolean') return { error: 'continue is true or false' };
    if (req.continue) more.push('--continue');
  }
  if (req.golden !== undefined) {
    const golden = knownGolden(goldens, req.golden);
    return golden ? { title: more.length ? 'Running more attempts' : 'Running the tests', args: ['test', golden, ...more] } : { error: 'no such golden: name one of the packs in the goldens folder or under "tests" in the config' };
  }
  if (!goldens.length) return { error: `no goldens yet: pack a run you consider correct into ${options.folder ?? 'goldens'}/ first` };
  return { title: 'Running the tests', args: ['test', ...testPatterns(goldens, options.folder), ...more] };
}

/** Update golden, or Update goldens… for several: each re-recorded live with writes stubbed, and replaced only when its checks pass. */
export function updateGoldensJob(goldens: readonly GoldenSource[], req: Record<string, unknown>): TestsJob {
  const raw = Array.isArray(req.goldens) ? req.goldens : req.golden !== undefined ? [req.golden] : [];
  if (!raw.length || raw.length > 500) return { error: 'name the goldens to update' };
  const paths: string[] = [];
  for (const r of raw) {
    const golden = knownGolden(goldens, r);
    if (!golden) return { error: `no such golden: ${typeof r === 'string' ? r : 'a name that is not text'}` };
    if (!paths.includes(golden)) paths.push(golden);
  }
  return { title: paths.length === 1 ? 'Updating a golden' : 'Updating goldens', args: ['test', ...paths, '--update'] };
}

/**
 * Add normalizer and re-run: for a golden whose last replay diverged on values that change every run
 * (`golden`), or for a test replay that did (`runId`, the diverged-test banner on its page), a
 * `normalize add` for each, then `test` on the golden, or `test --update` when the rules alone can't
 * make it match (see `normalizeSteps`). `path` picks one value when several diverged.
 */
export function normalizeAndTestJob(store: Store, goldens: readonly GoldenSource[], req: Record<string, unknown>): TestsJob {
  let golden: string | null;
  let volatile: VolatileValues | null = null;
  let runId: string | undefined;
  if (req.runId !== undefined) {
    const run = typeof req.runId === 'string' && /^[0-9A-Z]{26}$/.test(req.runId) ? store.getRun(req.runId) : null;
    const banner = run ? testRunBanner(store, run.runId) : null;
    if (!run || !banner) return { error: 'that run is not a replay of a golden that diverged' };
    golden = knownGolden(goldens, banner.golden);
    if (!golden) return { error: `${banner.golden} is no longer a golden on disk` };
    volatile = banner.values;
    runId = run.runId;
  } else {
    golden = knownGolden(goldens, req.golden);
    if (!golden) return { error: 'no such golden: name one of the packs in the goldens folder or under "tests" in the config' };
    const latest = store.listTestResults({ golden, limit: 1 })[0];
    const d = latest && latest.failure === 'diverged' ? divergenceOf(latest) : null;
    if (!latest || !d) return { error: `${golden} did not diverge the last time it ran` };
    volatile = volatileOf(latest, d);
    if (latest.runId && store.getRun(latest.runId)) runId = latest.runId;
  }
  if (req.path !== undefined) {
    const one = volatile.values.find((v) => v.path === req.path);
    if (!one) return { error: 'no value that changes every run diverged at that path' };
    // Its rule alone makes the replay match only when it was all that diverged.
    const alone = volatile.values.length === 1;
    volatile = { values: [one], explainsAll: volatile.explainsAll && alone, coversAll: volatile.coversAll && alone };
  }
  const steps = normalizeSteps(volatile, golden);
  if (!steps) return { error: `${golden} diverged on more than values that change every run: if the change was intended, update the golden` };
  return { title: volatile.coversAll ? 'Adding a normalizer' : 'Adding a normalizer and updating the golden', steps, ...(runId ? { runId } : {}) };
}

/**
 * Find the commit: for a golden (`golden`, from the Tests screen) or a run (`runId`, from its page or
 * the calendar), from `good` up to `bad` (default: where it failed, else HEAD, which is also where
 * it stops when `here` says this checkout lacks the commit it failed at). A replay of a golden on
 * disk bisects the golden; a run that failed on its own replays with `--fork`, judged by the check it
 * failed when one is known (`BisectChoices.expect`): its own `--expect`, or the one blame found it failing.
 */
export function bisectJob(store: Store, goldens: readonly GoldenSource[], req: Record<string, unknown>, options: { here?: (revs: string[]) => ReadonlySet<string> | null } = {}): TestsJob {
  const good = checkedRevision(req.good);
  if (!good) return { error: 'name a commit where it still worked' };
  let bad: string | null = null;
  if (req.bad !== undefined && req.bad !== null && req.bad !== '') {
    bad = checkedRevision(req.bad);
    if (!bad) return { error: 'that is not a commit' };
  }
  if (req.runId === undefined) {
    const golden = knownGolden(goldens, req.golden);
    if (!golden) return { error: 'no such golden: name one of the packs in the goldens folder or under "tests" in the config' };
    const source = goldens.find((g) => g.path === golden);
    const error = source ? unreadable(source) : null;
    if (error) return { error: `${golden} can't be read: ${error}` };
    return { title: 'Finding the commit', args: ['bisect', golden, '--good', good, ...(bad ? ['--bad', bad] : [])] };
  }
  const choices = typeof req.runId === 'string' && /^[0-9A-Z]{26}$/.test(req.runId) ? bisectChoices(store, req.runId, { goldens }) : null;
  if (!choices) return { error: 'no such run' };
  if (choices.unavailable) return { error: choices.unavailable };
  const ref = choices.target.kind === 'golden' ? choices.target.golden : choices.target.runId;
  let upTo = bad ?? choices.bad;
  // A run that failed at a commit this checkout doesn't have (a teammate's, pulled): up to HEAD, as
  // with no commit named. `here` asks the project's git; when it can't say, the commit stays.
  if (!bad && upTo && options.here?.([upTo])?.has(upTo) === false) upTo = null;
  if (upTo === good) return { error: `${good} is where it fails: choose an earlier commit where it still worked` };
  // A run blame found failing a check, or one whose own --expect failed: each replay is judged by it.
  return { title: 'Finding the commit', args: bisectArgs(ref, good, upTo, choices.fork, choices.expect ?? null), runId: req.runId as string };
}
