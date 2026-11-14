import { ACTIONS, attemptsOf, judgedUnder as underChecks, goldensPassed, checkStatus, describeGate, fixOfRun, formatTally, GATE_MAX_ATTEMPTS, gateSentence, gateOdds, gateOf, isObject, JUDGE_KEYS, judgeTarget, plural, maskedChange, testResultVerdict, normalizeAddArgs, normalizeAddCommand, pulledRun, sameRule, recorderGone, volatileValues, type Gate, type GateResult, type InjectionEntry, type InjectionGateData, type JudgeProvider, type Normalizer, type RunRecord, type StoreOf, type StoredCheck, type Tally, type TestFailure, type TestResult, type TestSession, type VolatileValues } from '@shadowlap/engine';
import { clean, GOLDEN_HISTORY, revisionsBefore, startFromPasses, type KnownResults } from './bisect-start.js';
import { chaosMatrices, liveChaosSession, presetsSummary, type PresetsSummary } from './chaos.js';
import { historyCells, liveSessionFields, type HistoryCell, type RevisionFact, type SessionFollowing } from './tests-history.js';
import { evidenceWords, type EvidenceWords } from './tests-evidence.js';
import { addedTimes, changedReason, checksChanged, checksNow, goldenChecks, heldVerdict, type ChangedCheck, type GoldenCheck } from './tests-checks.js';
import { causeOf, divergenceOf, rulesToAdd, storedVolatile, volatileOf } from './tests-normalize.js';
import type { NextStep } from './next-step.js';
import { gateLine, gateRuleOf } from './verdict.js';
import { links } from './links.js';
import { bisectAnswers, bisectBlock, committed, standingAnswer, type BisectMiss, type FoundCommit } from './tests-bisect.js';
import { shortReason } from './tests-why.js';

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
  /** That injection gate, as parsed with its defaults (the CLI's goldenMode): Tests shows it among the golden's checks. */
  injectionGate?: InjectionEntry | null;
  /** The models of its judge checks, which a golden that forks asks live. */
  judges?: string[];
  /** Why the pack can't be read, when it can't. */
  error?: string | null;
  /** Set where the config's tests couldn't be read (a file mid-edit): `checks` is then empty for want of a read, so nothing says they changed since (`checksNow`). */
  checksUnread?: boolean;
}

/** How a golden came out: passed, failed, or inconclusive (its gate ran out of attempts between its bounds, or a check couldn't be judged). */
export type GoldenVerdict = 'passed' | 'failed' | 'inconclusive';

export { shortReason };
export { runTestsJob, updateGoldensJob } from './tests-run.js';

/** A result's verdict: as kept, or for one kept before verdicts were, as its `ok` says (the engine's, which Training's tasks read too). */
export const verdictOfResult: (r: Pick<TestResult, 'ok' | 'failure' | 'data'>) => GoldenVerdict = testResultVerdict;

/** A golden's gate as the config gives it, in the words Settings previews it in: what each extreme takes is Settings → Gates', where its rule under Tests' table leads. */
export interface GateView {
  gate: Gate;
  /** The gate's rule: `tells 90%+ from 70%- at <= 5% risk, up to 40 attempts`. */
  description: string;
}

/**
 * What a gate decided about a golden's last result, for the interval bar (the Wilson range against
 * `bad` and `good`), the evidence line (`evidence.scores` after each attempt, between `upper` and
 * `lower`) and Run more attempts.
 */
export type GateResultView = GateResult & {
  /** `18 of 20 passed · rate >= 0.70 (95%) · pass^5 0.55`. */
  tally: string;
  /**
   * The rule it was decided by, said once under the table for every golden it decided (decision 9):
   * `gate: tells 90%+ from 70%- at <= 5% risk, up to 20 attempts`; null for a clean replay, which its
   * one attempt settled.
   */
  rule?: string | null;
  /** USD an attempt cost on average, to estimate what more attempts would; null when nothing was spent or it wasn't kept. */
  perAttempt: number | null;
  /** Run more attempts, for an inconclusive verdict; null otherwise. */
  more: MoreAttempts | null;
  /** Its evidence in words, as the row under it says why it stopped (tests-evidence.ts); null for a clean replay. */
  words?: EvidenceWords | null;
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

export type { FollowedGolden, HistoryCell, HistoryDrop, RevisionFact, SessionFollowing } from './tests-history.js';

export type { ChangedCheck, GoldenCheck } from './tests-checks.js';
/** Whether a result was judged by the checks a golden has now: the engine's rule, under the name this module's callers use. */
export { underChecks };

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
  /** The checks its last result failed or couldn't decide that its checks no longer hold, when that result failed or was undecided by them (tests-checks.ts); null for none. */
  changed: ChangedCheck[] | null;
  /** It has an injection test, which runs live, so CI needs the providers' keys for it whatever its mode. */
  injection: boolean;
  history: HistoryCell[];
  /** `verdict` tells inconclusive apart (`result` reads it as `fail`); `gate`, what its gate decided, for a golden with one; `injection`, its injection gate's result. */
  last: { result: 'pass' | 'fail' | null; verdict: GoldenVerdict | null; failure: TestFailure | null; line: string; at: number | null; updated: boolean; gate: GateResultView | null; injection?: InjectionGateData | null };
  /** The run a row opens: its latest replay when the store still has it, else the recording. */
  runId: string | null;
  error: string | null;
  /**
   * Its error-path presets (`test --chaos`) as their last session left them, or null when none ran:
   * a golden whose presets ran has been tested, though its replay may not have been.
   */
  presets?: PresetsSummary | null;
}

/**
 * A commit Find breaking commit's dialog offers as one where the golden still worked: a revision it was
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
  /** Its attempts there, passes of all, when it ran several: the dialog says `failed 4 of 8`. */
  rate?: Tally | null;
}

/** A commit Find breaking commit's dialog offers that the golden was never tested at, with its subject. */
export type UntestedCommit = { rev: string; subject: string };

/** A golden whose last replay diverged, as the CLI prints it, with what each button runs. */
export interface DivergenceView {
  golden: string;
  name: string;
  runId: string | null;
  callNo: number;
  kind: string;
  callName: string;
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
  /** Add normalizer and update for several goldens: the `normalize add` it runs for this one first, none when it masks none of its values (tests-normalize.ts). */
  newRules?: string[][];
  /** Find breaking commit: from the last revision where it passed under today's checks to the one where it failed (null: HEAD). */
  bisect: BisectRange | null;
  /** What Find breaking commit found, kept until the golden passes again. */
  found: FoundCommit | null;
  /** Find breaking commit ran since and named no first bad commit (it already failed at the good one, say): why, until it passes again or finds one. */
  missed: BisectMiss | null;
  /** Commits to offer as good ones when Find breaking commit asks, newest first. */
  revisions: BisectRevision[];
  /** With no range to search, commits of this checkout before the one it failed at that it was never tested at: the route asks git (commits-here.ts `commitsBefore`). */
  untested?: UntestedCommit[];
  /** Why its pack can't be read, or null: such a golden can't be bisected. */
  unreadable: string | null;
}

/** Find breaking commit for a golden: the command, and whether its replays cost tokens. */
export interface BisectRange {
  good: string;
  bad: string | null;
  args: string[];
  /** The golden may fork, so each replay runs live from where it diverges: the search costs tokens. */
  live: boolean;
}

/** A golden that failed for another reason: a check, an exit, no calls. */
export interface FailureView {
  golden: string;
  name: string;
  runId: string | null;
  failure: TestFailure;
  reason: string;
  /** Its checks as the result kept them, each with its status (passed, failed, inconclusive, not-applicable) since results had one. */
  checks: StoredCheck[] | null;
  /**
   * A live call: the connections the network guard blocked during the failing replay (`host:port`).
   * They bypassed Shadowlap, so CI, replaying offline, refused them. Null when it blocked none.
   */
  blocked: string[] | null;
  bisect: BisectRange | null;
  found: FoundCommit | null;
  missed: BisectMiss | null;
  revisions: BisectRevision[];
  untested?: UntestedCommit[];
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
  /** What its gate decided; null when a check couldn't be judged, or its injection gate showed too little to say, instead. */
  gate: GateResultView | null;
  /** `injection` when its injection gate is what is inconclusive. */
  failure?: TestFailure | null;
  /** A judge check its last result couldn't decide for want of a verdict it could use, and what settles it; null for any other reason. */
  judge?: UnjudgedCheck | null;
}

/**
 * A judge check a golden's last result couldn't decide, and what settles it. A golden that replays
 * offline can't ask the judge, so when what its pack holds is why (`held`), Update golden (`update`,
 * the arguments of `test <golden> --update`) asks it once, live, and keeps its verdict in the pack. A
 * golden that forks asks its judges live, and what it lacked was a key for the judge's provider where
 * the test ran (`keys`, the variables that key is read from). Neither when the result says another reason.
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
  /**
   * What its pack holds for the check, as `why` says: no verdict (`none`); one given to an older form
   * of the judge's request, which a replay no longer sends (`older`); or one given on other material
   * than the replay reads now (`material`), as a value that changes every run does, which a normalizer
   * fixes for good, or a rule or the agent changed since. Null for another reason, which an update
   * can't settle.
   */
  held: 'none' | 'older' | 'material' | null;
  /** For `material`, where it differs, in the CLI's words: `it read "…" where it now reads "…"`. */
  changed: string | null;
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
  /** Goldens whose last result diverged: Update goldens lists them. */
  diverged: string[];
  /**
   * A test session running now, wherever it was started: a terminal, another dashboard, or a job of
   * this one. The actions that replay or rewrite the goldens wait for it, as the server does.
   */
  running: TestsSessionView | null;
  /**
   * Where the session running now is with each golden it runs: its result once kept, else running,
   * between its turns, or queued; `whole` when it runs every golden, so the verdict follows it.
   */
  following?: SessionFollowing | null;
  /**
   * Error-path presets on goldens (`test --chaos`) running now, wherever they were started: they
   * replay the goldens' packs, so the same actions wait for them too, as the server does.
   */
  chaosRunning: { id: string; command: string; startedAt: number } | null;
  /** Each of `revisions` as git has it, its commit's subject and its author where names show: the route asks git beside the server. */
  revisionFacts?: RevisionFact[];
  /** The session the verdict names tested a clean commit, and the working tree has changed since: the route asks git. */
  older?: boolean;
  /** Each golden that didn't pass, by its path, with the step it leads with, as its replay's page leads: the route asks beside the server (next-step.ts `goldenSteps`). */
  steps?: Record<string, NextStep>;
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
    /** Update goldens, or null when none diverged. */
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
export const unreadable = (g: GoldenSource): string | null => (optionLike(g.path) ? OPTION_LIKE : (g.error ?? null));

/** A word as a shell reads it: a plain path stays as it is; a pattern (`goldens/*`), which the CLI expands itself, and a path with a space are quoted. */
const ciWord = (s: string) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export function nameOf(path: string, folder: string): string {
  return path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path;
}

/**
 * A session as the screen shows it. Its totals are written when it ends; one that hasn't (it is
 * running, or its process was killed) counts the results it has, as every other count here does.
 */
function sessionView(store: StoreOf<'tests'>, s: TestSession): TestsSessionView {
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
function lastActive(store: StoreOf<'tests'>, s: TestSession): number {
  return s.endedAt ?? store.listTestResults({ sessionId: s.sessionId, limit: 1 })[0]?.at ?? s.startedAt;
}

/**
 * Whether a session that hasn't ended is running now: the process the store names for it is still
 * there (on this machine; elsewhere, it was heard from lately), as for a run still recording. One
 * whose process was killed, or that names none, did not finish.
 */
function sessionLive(store: StoreOf<'tests'>, s: TestSession): boolean {
  if (s.endedAt !== null) return false;
  const owner = store.testSessionOwner(s.sessionId);
  return owner !== null && !recorderGone(owner, lastActive(store, s));
}

/**
 * The newest test session running now, wherever it was started (a terminal, another dashboard, a
 * job), or null: while one runs, the jobs that replay or rewrite the goldens wait for it.
 */
export function liveTestSession(store: StoreOf<'tests'>): TestSession | null {
  for (const s of store.listTestSessions({ limit: 20 })) if (s.endedAt === null && sessionLive(store, s)) return s;
  return null;
}

/** The first value a view shows, with the command that adds its normalizer. */
function shownValue(values: VolatileValues): DivergenceView['volatile'] {
  const v = values.values[0];
  return v ? { ...v, args: normalizeAddArgs(v.normalizer), command: normalizeAddCommand(v.normalizer) } : null;
}

/**
 * The verdict's reason after the name: `shortReason`'s, but for a failed check its gate decided
 * (`failed its gate`, `failed against its own history`), one over several attempts (`failed its
 * check`), a failed injection gate (`failed its injection gate`), and a judge check a replay couldn't
 * judge offline.
 */
function leadReason(r: TestResult, checks: readonly string[] | null): string {
  const gate = r.data?.gate;
  const gated = r.failure === 'check' && gate && gate.decision !== 'continue' ? (gate.kind === 'baseline' ? 'failed against its own history' : 'failed its gate') : null;
  // A golden whose checks changed since: its base, as the failed check's own words no longer apply.
  if (checks && checksChanged(r, checks)) return changedReason(r, gated);
  if (gated || (r.failure === 'check' && (r.data?.attempts?.total ?? 1) > 1)) return gated ?? 'failed its check';
  if (r.failure === 'injection' && r.data?.injection?.verdict === 'failed') return 'failed its injection gate';
  return unjudgedOffline(r) ? 'inconclusive: its judge check wasn’t judged offline' : shortReason(r);
}

/** The verdict's line: the tally first wherever a golden leads or one wasn't tested, then the golden that leads and what wasn't tested; else that they all pass ("All 1 goldens pass" isn't English). */
function verdictTitle(c: { first: TestResult | null; goldens: readonly GoldenSource[]; passing: number; total: number; notRun: number; presetsOnly: number }, folder: string): string {
  if (!c.first && !c.notRun && !c.presetsOnly) return c.total === 1 ? 'The golden passes' : `All ${c.total} goldens pass`;
  const goldens = (n: number) => `${n} golden${n === 1 ? '' : 's'}`;
  const parts = [goldensPassed(c.passing, c.total), c.first ? `${nameOf(c.first.golden, folder)} ${leadReason(c.first, checksNow(c.goldens.find((g) => g.path === c.first!.golden)))}` : '', c.notRun ? `${goldens(c.notRun)} not tested yet` : '', c.presetsOnly ? `${goldens(c.presetsOnly)} tested only by ${c.presetsOnly === 1 ? 'its' : 'their'} error-path presets` : ''];
  return parts.filter(Boolean).join(' · ');
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

/** Whether a result's line is its gate's verdict: a gate an attempt a check could not decide stopped decided nothing, and the result's reason says why. */
const decidedByGate = (r: TestResult): boolean => !!r.data?.gate && r.data.gate.decision !== 'continue' && (r.ok || r.failure === 'inconclusive' || r.failure === 'check' || r.failure === 'exit');

/**
 * The line under a golden's last result: what it did, or why it failed; `normalizers` are the
 * config's now. A gated golden's is its tally and Wilson bound (and its baseline), the verdict word
 * beside it and the gate's rule said once under the table (decision 9).
 */
export function resultLine(r: TestResult, checks: readonly string[], normalizers: readonly Normalizer[] = []): string {
  const data = r.data ?? {};
  if (decidedByGate(r)) return gateLine(data.gate!, { word: false });
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

export const modeOf = (g: GoldenSource) =>
  g.mode === 'fork' && g.gate
    ? { label: g.gate.kind === 'sprt' ? 'fork · gate' : 'fork · history', hint: `allowed to fork; passes on its checks, decided by its gate: ${describeGate(g.gate)}` }
    : g.mode === 'fork'
      ? { label: g.repeat > 1 ? `fork ×${g.repeat}` : 'fork', hint: `allowed to fork; passes on its checks${g.repeat > 1 ? `, ${g.passes} of ${g.repeat} attempts` : ''}` }
      : { label: 'replay', hint: 'must send exactly the requests it recorded' };

/** A golden's gate in the words Settings previews it in, with what it costs at the extremes. */
function gateView(gate: Gate | null | undefined): GateView | null {
  if (!gate) return null;
  return { gate, description: describeGate(gate) };
}

export { gatePreview, PREVIEW_HISTORY, type GatePreview } from './tests-gate.js';

/**
 * What a result's gate decided, as the screen shows it: the tally, what an attempt cost, and for an
 * inconclusive one, Run more attempts with twice the limit. Null when it decided nothing: an attempt
 * a check could not decide stopped it first (a result kept before test left such a gate out keeps
 * one still going, which no verdict word names).
 */
export function gateResultView(r: TestResult, golden: string): GateResultView | null {
  const g = r.data?.gate;
  if (!g || g.decision === 'continue') return null;
  // What this session's own attempts cost, the agent's calls and its judges' alike (a forked attempt
  // asks its judges live where it passed its other checks): carried-over ones were paid for before.
  const agent = r.data?.spent;
  const judges = r.data?.judge?.spent;
  const spent = typeof agent === 'number' ? agent + (typeof judges === 'number' ? judges : 0) : undefined;
  const own = r.data?.attempts?.total ?? g.attempts;
  const perAttempt = typeof spent === 'number' && spent > 0 && own > 0 ? spent / own : null;
  return { ...g, tally: formatTally(g), rule: gateRuleOf(g), perAttempt, more: moreAttempts(g, golden, perAttempt), words: evidenceWords(g, r.data?.mode === 'replay' ? null : (r.data?.divergence?.callNo ?? null)) };
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

const runIfKept = (store: StoreOf<'recording'>, runId: string | null) => (runId && store.getRun(runId) ? runId : null);

/**
 * The judge check an inconclusive result couldn't decide for want of a verdict it could use, and what
 * settles it: for a golden that replays offline and replayed clean, Update golden, which asks the judge
 * once and keeps its verdict in the pack, when what the pack holds is why; for a golden that forks,
 * the key it lacked, when that is why. Null when no judge check is what kept it undecided.
 */
function unjudgedCheck(path: string, mode: 'replay' | 'fork', r: TestResult): UnjudgedCheck | null {
  const c = (r.data?.checks ?? []).find((x) => checkStatus(x) === 'inconclusive' && x.judge);
  if (!c?.judge) return null;
  const provider = judgeTarget(c.judge.model)?.provider ?? null;
  const why = c.detail ?? 'not judged';
  const { held, changed } = heldVerdict(why);
  // Offline, nothing could ask the judge; --update asks it live, once, and keeps the verdict, for a replay
  // that ran clean. It settles nothing else: a model no provider serves, material that couldn't be made.
  const update = mode === 'replay' && held && !r.data?.divergence && !optionLike(path) ? ['test', path, '--update'] : null;
  const keys = mode === 'fork' && provider && /\bno key for\b/.test(why) ? JUDGE_KEYS[provider] : null;
  return { name: c.judge.name, label: c.label, model: c.judge.model, provider, why, held, changed, update, keys };
}

/** What the network guard prints when it blocks a connection, Node's and Python's alike, and the error it raises. */
const GUARD_BLOCKED = /blocked (?:an )?outbound connection to (\S+?)(?=:\s|\s\(SHADOWLAP_GUARD)/g;

/**
 * The connections the network guard blocked during a replay (`host:port`): the agent went to a host
 * directly, past Shadowlap, and a test, replaying offline, refuses that. The run keeps what the guard
 * reported; an agent that dies at once can exit before its report lands, so what it printed counts
 * too. An agent that catches the refusal can still pass, and the screen says so all the same.
 */
function blockedTargets(store: StoreOf<'recording'>, r: TestResult): string[] {
  const out = new Set<string>();
  const hosts = r.runId ? store.getRun(r.runId)?.meta?.notRecorded?.hosts : undefined;
  if (Array.isArray(hosts)) for (const h of hosts) if (h?.action === 'blocked' && typeof h.target === 'string') out.add(h.target);
  for (const text of [r.data?.output, r.data?.details]) if (typeof text === 'string') for (const m of text.matchAll(GUARD_BLOCKED)) out.add(m[1]!);
  return [...out].slice(0, 5);
}

const blockedWords = (blocked: readonly string[]) => `blocked connection to ${blocked.join(', ')}`;

/** A result's line, saying first when the guard blocked a connection the replay made past Shadowlap. */
function lineOf(store: StoreOf<'recording'>, r: TestResult, checks: readonly string[], normalizers: readonly Normalizer[] = []): string {
  const blocked = blockedTargets(store, r);
  const line = resultLine(r, checks, normalizers);
  return blocked.length ? `${blockedWords(blocked)} · ${line}` : line;
}

/** A history cell's hover note: why it failed, or a connection the guard blocked in a replay that passed. */
function cellNote(store: StoreOf<'recording'>, r: TestResult, checks: readonly string[], normalizers: readonly Normalizer[] = []): string | null {
  if (!r.ok) return lineOf(store, r, checks, normalizers);
  const blocked = blockedTargets(store, r);
  return blocked.length ? blockedWords(blocked) : null;
}

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

/**
 * Find breaking commit for a failing golden, from the newest result that passed before the failure at
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

/** How many commits Find breaking commit's dialog offers at most. */
const DIALOG_REVISIONS = 12;

/**
 * The commits a golden was tested at before it failed, newest first, for Find breaking commit's dialog to
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
    .map(({ r, rev }) => ({ rev, at: r.at, result: r.ok ? 'pass' : 'fail', verdict: verdictOfResult(r), sameChecks: underChecks(r, checks), rate: attemptsOf(r) }));
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
function testSessions(store: StoreOf<'tests'>, goldens: readonly GoldenSource[], max: number): SessionsRead {
  const { sessions, whole } = fullSessions(store, goldens);
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

/**
 * The sessions with a result or running now, newest first (`sessions`), and of them those that ran
 * every golden tested before they started (`whole`; every session while none did): testSessions.
 */
function fullSessions(store: StoreOf<'tests'>, goldens: readonly GoldenSource[]): { sessions: TestSession[]; whole: TestSession[] } {
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
  const whole = sessions.filter(full);
  return { sessions, whole: whole.length ? whole : sessions };
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
export function testsView(store: StoreOf<'recording' | 'activity' | 'tests' | 'chaos' | 'readModels'>, goldens: readonly GoldenSource[], options: TestsOptions = {}): TestsView {
  const folder = options.folder ?? 'goldens';
  const rules = options.normalizers ?? [];
  const sessionsView = testSessions(store, goldens, options.revisions ?? 6);
  const { revisions } = sessionsView;
  // Only what the page shows is read: each golden's newest result, and the results of the sessions
  // the history's columns are made of.
  const latestOf = new Map(store.latestTestResults().map((r) => [r.golden, r]));
  const presetsOf = new Map<string, PresetsSummary | null>();
  for (const m of chaosMatrices(store)) if (m.golden && !presetsOf.has(m.golden)) presetsOf.set(m.golden, presetsSummary(m, (id) => store.getRun(id) !== null));
  const history = byGolden(sessionsView.results);
  const columns = new Set(revisions);
  const sessionIds = new Set(sessionsView.columnOf.keys());
  const columnOf = (x: TestResult) => (sessionsView.columnOf.has(x.sessionId) ? sessionsView.columnOf.get(x.sessionId) : columnOfRevision(x.revision, columns));
  const added = addedTimes(store);

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
      checkResults: goldenChecks(store, g.checks, latest, (label) => added(g.path, label)),
      changed: checksChanged(latest, checksNow(g)),
      injection: !!g.injection,
      history: historyCells(store, list, revisions, { columnOf, columns: sessionIds, note: (r) => cellNote(store, r, g.checks, rules), runId: (r) => runIfKept(store, r.runId) }),
      // A pack that can't be read says so over the result it had before, which no test can repeat.
      last: latest
        ? { result: latest.ok ? 'pass' : 'fail', verdict: verdictOfResult(latest), failure: latest.failure, line: error ? `can't be read: ${error}` : latest.ok || !latest.data?.updated ? lineOf(store, latest, g.checks, rules) : `updated${latest.revision ? ` at ${latest.revision}` : ''}, then ${lineOf(store, latest, g.checks, rules)}`, at: latest.at, updated: !!latest.data?.updated, gate: gateResultView(latest, g.path), injection: latest.data?.injection ?? null }
        : { result: null, verdict: null, failure: null, line: error ? `can't be read: ${error}` : presetsOf.get(g.path) ? `${presetsOf.get(g.path)!.line} · replay not tested yet` : 'not run yet', at: null, updated: false, gate: null },
      runId: runIfKept(store, latest?.runId ?? null) ?? sourceRun,
      error,
      presets: presetsOf.get(g.path) ?? null,
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
      inconclusive.push({ golden: row.path, name: row.name, runId: row.runId, reason: gate ? gateVerdictLine(gate) : (latest.reason ?? 'inconclusive'), checks: latest.data?.checks ?? null, gate: gate ? row.last.gate : null, failure: latest.failure, judge: gate ? null : unjudgedCheck(row.path, row.mode, latest) });
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
        volatile: shownValue(volatile),
        normalizerFixes: volatile.explainsAll,
        maybeReal: volatile.values.some((v) => !v.certain),
        rerun: ['test', row.path],
        update: ['test', row.path, '--update'],
        normalizeAndTest: normalizeSteps(volatile, row.path),
        rulesAdded: volatile.values.length > 0 && volatile.values.every((v) => rules.some((n) => sameRule(n, v.normalizer))),
        newRules: rulesToAdd(volatile, rules).map((rule) => normalizeAddArgs(rule)),
        bisect,
        found,
        missed,
        revisions: revisionsToOffer,
        unreadable: row.error,
      });
    } else {
      const blocked = blockedTargets(store, latest);
      failures.push({ golden: row.path, name: row.name, runId: row.runId, failure: latest.failure ?? 'error', reason: latest.reason ?? 'failed', checks: latest.data?.checks ?? null, blocked: blocked.length ? blocked : null, bisect, found, missed, revisions: revisionsToOffer, unreadable: row.error });
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
    // A golden whose presets ran has been tested, its replay not yet: never "not run yet".
    const presetsOnly = rows.filter((r) => r.last.result === null && !r.error && r.presets).length;
    const notRun = untested - presetsOnly;
    verdict = {
      state: failed.length ? 'failing' : unsure.length ? 'inconclusive' : 'passing',
      failing: failed.length,
      inconclusive: unsure.length,
      passing,
      untested,
      title: verdictTitle({ first, goldens, passing, total, notRun, presetsOnly }, folder),
      first: first ? { golden: first.golden, name: nameOf(first.golden, folder), reason: first.reason ?? 'failed', runId: runIfKept(store, first.runId) } : null,
      session: sessionView(store, shown),
      since: lastResults.filter((r) => r.sessionId !== shown.sessionId && r.at > shown.startedAt).map((r) => ({ golden: r.golden, name: nameOf(r.golden, folder), ok: r.ok, verdict: verdictOfResult(r), revision: r.revision, at: r.at })),
    };
  }

  const diverged = divergences.map((d) => d.golden);
  const patterns = testPatterns(goldens, folder);
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
    ...liveSessionFields(store, liveTestSession(store), goldens.map((g) => g.path), { view: (s) => sessionView(store, s), asks: asksForAll }),
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
function latestResults(store: StoreOf<'tests'>, goldens: GoldenList, until?: number): Map<string, TestResult> {
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
export function testsSummary(store: StoreOf<'tests'>, options: { goldens: GoldenList; now?: number; weekStart?: number }): TestsSummary {
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
 * the goldens on disk, each by its newest result as Tests shows it (passing, failed, inconclusive,
 * or not run yet), how many passed when this week started, and when the tests last ran. Null when
 * there are no goldens yet.
 */
export function overviewTests(store: StoreOf<'tests'>, asOf: { now: number; weekStart: number }, options: { goldens: GoldenList }): { goldens: number; passing: number; inconclusive: number; untested: number; lastWeek: number | null; regressions: number; lastRunAt: number | null } | null {
  const s = testsSummary(store, { goldens: options.goldens, now: asOf.now, weekStart: asOf.weekStart });
  if (s.empty) return null;
  return { goldens: s.total, passing: s.passing, inconclusive: s.inconclusive, untested: s.untested, lastWeek: s.lastWeek ? s.lastWeek.passing : null, regressions: s.failing, lastRunAt: s.lastRunAt };
}

export interface FailingTest {
  golden: string;
  /** For Needs a look: `A golden failed: refund-in-limit`, or `A golden is inconclusive: refund-over-limit`. */
  title: string;
  /** Failed, or inconclusive: Needs a look lists both, told apart. */
  verdict: 'failed' | 'inconclusive';
  /**
   * Why: `diverged at call 1 · $.metadata.user_id looks like a UUID`; a gate's verdict as every page
   * says it, `failed · 4 of 8 · rate <= 0.78 (95%)`, its rule apart (`rule`).
   */
  line: string;
  /** The rule of the gate that decided it, for the line's hover; null when no gate did. */
  rule: string | null;
  failure: TestFailure;
  runId: string | null;
  /** Where its line goes: the fix its failing run belongs to, else the failing run, else the Tests screen. */
  href: string;
  /** What the line's word says it leads to (Needs a look's "Fix →", "Run more →"): see `failingNext`. */
  next: 'fix' | 'open' | 'run-more' | 'run-again' | 'update' | 'run-tests';
  /** The fix that holds the failing run, when one does. */
  fixId: string | null;
  at: number;
}

/**
 * What a failing test leads to, so the word before its arrow says where it goes: the fix its failing
 * run belongs to (`fix`), else the run (`open`). An inconclusive golden goes to its report on Tests,
 * named by what settles it, as the design's Needs a look names it: more attempts when its gate ran
 * out of them (`run-more`); running it again when its injection test showed too little to say, once
 * what kept it from saying is settled, as its report says (`run-again`); updating the golden when it
 * replays offline and a judge check had no verdict to judge from, which asks the judge once and keeps
 * its verdict (`update`, `unjudgedOffline`). Any other reason is opened (`open`): a judge that lacked
 * a key on a golden that forks, a check that couldn't be decided for another reason.
 */
function failingNext(r: TestResult, o: { fixId: string | null; mode: GoldenSource['mode'] | null; checks: readonly string[] | null }): FailingTest['next'] {
  if (o.checks && checksChanged(r, o.checks)) return 'run-tests';
  if (verdictOfResult(r) !== 'inconclusive') return o.fixId ? 'fix' : 'open';
  if (gateResultView(r, r.golden)?.more) return 'run-more';
  if (r.failure === 'injection') return 'run-again';
  return o.mode === 'replay' && unjudgedOffline(r) ? 'update' : 'open';
}

/**
 * A result inconclusive because a judge check had no verdict, on a replay that stayed clean, and not
 * because a gate ran out of attempts between its bounds. Updating the golden (`test <golden>
 * --update`, which Tests offers then) settles it: it asks the judge once, live, and keeps the
 * verdict in the pack. Not an injection test that showed too little to say, which an update doesn't
 * settle, nor a golden whose path the CLI would read as an option.
 */
export function unjudgedOffline(r: TestResult): boolean {
  if (r.failure !== 'inconclusive' || r.data?.gate?.decision === 'inconclusive' || r.data?.divergence || optionLike(r.golden)) return false;
  return (r.data?.checks ?? []).some((c) => checkStatus(c) === 'inconclusive' && !!c.judge);
}

/** Goldens on disk failing now, newest failure first: Needs a look's failing tests. */
export function failingTests(store: StoreOf<'recording' | 'fixes' | 'tests'>, options: { goldens: GoldenList; folder?: string; normalizers?: readonly Normalizer[] }): FailingTest[] {
  const folder = options.folder ?? 'goldens';
  const sources = new Map(options.goldens.filter((g): g is GoldenSource => typeof g !== 'string').map((g) => [g.path, g]));
  return [...latestResults(store, options.goldens).values()]
    .filter((r) => !r.ok)
    .sort((a, b) => b.at - a.at)
    .map((r) => {
      const runId = runIfKept(store, r.runId);
      const verdict = verdictOfResult(r) === 'inconclusive' ? 'inconclusive' : 'failed';
      const fixId = verdict === 'failed' && runId ? (fixOfRun(store, runId)?.fixId ?? null) : null;
      const next = failingNext(r, { fixId, mode: sources.get(r.golden)?.mode ?? null, checks: checksNow(sources.get(r.golden)) });
      const href = fixId ? links.fixes(fixId) : verdict === 'inconclusive' ? links.tests() : runId ? links.run(runId) : links.tests();
      // A gate's verdict says its word, tally and bound; the rule goes on the line's hover.
      const gate = decidedByGate(r) ? r.data!.gate! : null;
      const line = gate ? gateLine(gate) : lineOf(store, r, sources.get(r.golden)?.checks ?? [], options.normalizers ?? []);
      return { golden: r.golden, title: `${verdict === 'inconclusive' ? 'A golden is inconclusive' : 'A golden failed'}: ${nameOf(r.golden, folder)}`, verdict, line, rule: gateRuleOf(gate), failure: r.failure ?? 'error', runId, href, next, fixId, at: r.at };
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

/** The test a run says it was made by, read only as text: a pack can carry anything. */
export const testOf = (run: RunRecord) => (typeof run.meta?.test?.golden === 'string' && typeof run.meta.test.session === 'string' ? run.meta.test : null);

/**
 * For a run made by `shadowlap test` whose golden failed because it diverged: its golden and the
 * actions on it. Null for any other run, a replay of a golden that may fork (it diverges by design)
 * included. `normalizers` are the rules in the config now.
 */
export function testRunBanner(store: StoreOf<'recording' | 'tests'>, runId: string, options: { normalizers?: readonly Normalizer[] } = {}): TestRunBanner | null {
  const run = store.getRun(runId);
  const test = run && testOf(run);
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

// ---- Find breaking commit, from a run: the run page's fork menu and the calendar's failed days ----

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
  /** Why Find breaking commit can't start from this run, for the disabled action's hover; null when it can. */
  unavailable: string | null;
  /** `unavailable` sends you to Tests, which finds the commit from the golden or says what settles it: the toast offers Open Tests. */
  onTests?: true;
  /**
   * It failed at a commit with no parent in the project's checkout (its first, or the oldest a
   * shallow clone has): there is nothing before it to search, as `unavailable` says. Set by
   * `choicesInCheckout`, which asks the project's git; absent otherwise.
   */
  first?: true;
  /** The command for `good` and `bad` (after `shadowlap`), or null until a good commit is known or when unavailable. */
  args: string[] | null;
}


const exitFailed = (run: RunRecord) => run.status === 'failed' || run.status === 'crashed';

/** A check of the run's own that failed: one that could not be decided (inconclusive) is no failure. */
const checkFailed = (run: RunRecord) => Array.isArray(run.meta?.checks) && run.meta.checks.some((c) => checkStatus(c) === 'failed');

function runFailed(run: RunRecord): boolean {
  return exitFailed(run) || checkFailed(run);
}

/**
 * Find breaking commit for a run. A replay made by `shadowlap test` of a golden on disk bisects the
 * golden, which replays offline; any other run is bisected as it is. `goldens` are the packs on disk
 * (`projectGoldens`), with the checks the config gives each; `before` limits the good commits to runs
 * started before it (the calendar passes the first day picked).
 */
export function bisectChoices(store: StoreOf<'recording' | 'fixes' | 'tests'>, runId: string, options: { goldens: readonly GoldenSource[]; before?: number; known?: KnownResults }): BisectChoices | null {
  const run = store.getRun(runId);
  if (!run) return null;
  const golden = testOf(run)?.golden ?? null;
  // As listed: a pack in the goldens folder, or one the config names under `tests` (its checks too).
  const source = golden !== null ? (options.goldens.find((g) => g.path === golden) ?? null) : null;
  // Only a golden whose pack can be read, by a path that reads as no option, is bisected as one.
  const ofGolden = !!source && !unreadable(source);
  const before = options.before ?? run.startedAt;
  const own = committed(run.codeVersion);
  // A test replay failed when its golden did in that session (a golden that may fork diverges by design).
  const result = !ofGolden ? undefined : options.known ? (options.known.result ?? undefined) : store.listTestResults({ sessionId: run.meta!.test!.session, golden: golden!, limit: 1 })[0];
  // Its golden came out inconclusive there: neither passed nor failed, so no failure to find.
  const unsure = result !== undefined && verdictOfResult(result) === 'inconclusive';
  // A run in a fix as failing its check (blame found it so, or a repair or verify did), though it
  // exited 0 with no check of its own failed: that check is the one it failed.
  const blamed = !ofGolden && !runFailed(run) ? blamedCheck(store, run) : null;
  const failed = result ? verdictOfResult(result) === 'failed' : runFailed(run) || (ofGolden && !!run.divergence) || blamed !== null;
  // A run that failed nothing, with a check of its own that could not be decided: neither passed nor
  // failed, as a golden that came out inconclusive is, so there is no failure to find either.
  const undecided = !result && !failed && Array.isArray(run.meta?.checks) ? run.meta.checks.find((c) => checkStatus(c) === 'inconclusive') : undefined;
  const between = { before, own, recording: result?.goldenRunId ?? null };
  const history = ofGolden && !options.known ? store.listTestResults({ golden: golden!, limit: GOLDEN_HISTORY }) : [];
  const goodOfGolden = !ofGolden ? null : startFromPasses(options.known?.passes ?? history.filter((r) => r.ok && underChecks(r, source.checks)), between);
  const revisions: BisectChoices['revisions'] = ofGolden
    ? revisionsBefore(history, between, verdictOfResult)
    : store
        .runRevisions({ argv: run.command.argv, before, limit: 100 })
        .filter((r) => clean(r.revision) && r.revision !== own)
        .map((r) => ({ rev: r.revision, at: r.lastAt, runs: r.runs, failed: r.failed }));
  const target: BisectChoices['target'] = ofGolden ? { kind: 'golden', golden: golden! } : { kind: 'run', runId: run.runId };
  const fork = !ofGolden && failed;
  // The check a forked replay is judged by: the run's own `--expect` when a check of it failed, else
  // the one blame found it failing. A golden's checks come from the config, as the CLI finds them.
  const expect = fork ? (checkFailed(run) && isObject(run.meta?.expect) ? run.meta.expect : blamed) : null;
  // A run that passed is the good end itself; bisect then looks up to HEAD. One that failed only
  // blame's check leaves the good one to be chosen: how other runs exited says nothing about it.
  const good = !failed ? (clean(run.codeVersion) ? run.codeVersion : null) : ofGolden ? goodOfGolden : blamed !== null ? null : (revisions.find((r) => r.failed < r.runs)?.rev ?? null);
  const bad = failed && clean(run.codeVersion) ? run.codeVersion : null;
  const block = bisectBlock(run, { golden: ofGolden ? golden : null, cut: ofGolden && run.status === 'crashed' && !result, unsure, undecided: undecided?.label ?? null, unjudged: fork && !exitFailed(run) && !source?.checks.length && !expect });
  const unavailable = block?.reason ?? null;
  const ref = target.kind === 'golden' ? target.golden : target.runId;
  return {
    target,
    failed,
    good,
    bad,
    revisions: revisions.slice(0, 30),
    expect,
    fork,
    live: fork || (ofGolden && source.mode === 'fork'),
    unavailable,
    ...(block?.onTests ? { onTests: true as const } : {}),
    args: good && !unavailable ? bisectArgs(ref, good, bad, fork, expect) : null,
  };
}

/**
 * The check blame found a run failing: that of the fix it fails in (the `--expect` the first blame of
 * that failure was given). Null when the run fails in no fix, or its fix judges by the exit status alone.
 */
function blamedCheck(store: StoreOf<'fixes'>, run: RunRecord): Record<string, unknown> | null {
  const check = fixOfRun(store, run.runId)?.check.expect;
  return isObject(check) && Object.keys(check).length ? check : null;
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
export function knownGolden(goldens: readonly GoldenSource[], raw: unknown): string | null {
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
 * Add normalizer and re-run: for a golden whose last replay diverged on values that change every run
 * (`golden`), or for a test replay that did (`runId`, the diverged-test banner on its page), a
 * `normalize add` for each, then `test` on the golden, or `test --update` when the rules alone can't
 * make it match (see `normalizeSteps`). `path` picks one value when several diverged.
 */
export function normalizeAndTestJob(store: StoreOf<'recording' | 'tests'>, goldens: readonly GoldenSource[], req: Record<string, unknown>): TestsJob {
  let golden: string | null;
  let volatile: VolatileValues | null;
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
  return { title: volatile.coversAll ? ACTIONS.addNormalizerAndRerun.doing : ACTIONS.addNormalizerAndUpdate.doing, steps, ...(runId ? { runId } : {}) };
}

/**
 * Find breaking commit: for a golden (`golden`, from the Tests screen) or a run (`runId`, from its page or
 * the calendar), from `good` up to `bad` (default: where it failed, else HEAD, which is also where
 * it stops when `here` says this checkout lacks the commit it failed at). A replay of a golden on
 * disk bisects the golden; a run that failed on its own replays with `--fork`, judged by the check it
 * failed when one is known (`BisectChoices.expect`): its own `--expect`, or the one blame found it failing.
 */
export function bisectJob(store: StoreOf<'recording' | 'fixes' | 'tests'>, goldens: readonly GoldenSource[], req: Record<string, unknown>, options: { here?: (revs: string[]) => ReadonlySet<string> | null } = {}): TestsJob {
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
    return { title: ACTIONS.findBreakingCommit.doing, args: ['bisect', golden, '--good', good, ...(bad ? ['--bad', bad] : [])] };
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
  return { title: choices.failed ? ACTIONS.findBreakingCommit.doing : ACTIONS.findChangingCommit.doing, args: bisectArgs(ref, good, upTo, choices.fork, choices.expect ?? null), runId: req.runId as string };
}
