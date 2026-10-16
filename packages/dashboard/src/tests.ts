import { fixOfRun, hasRecordedCommand, normalizeAddArgs, normalizeAddCommand, recorderGone, volatileValues, type CallKind, type DivergenceReport, type Normalizer, type RunRecord, type Store, type TestFailure, type TestResult, type TestSession, type VolatileValues } from '@shadowlap/engine';

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
  /** Its checks, as the CLI labels them. */
  checks: string[];
  /** Why the pack can't be read, when it can't. */
  error?: string | null;
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
  passed: number;
  failed: number;
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
  state: 'failing' | 'passing';
  /** Goldens whose last result failed. */
  failing: number;
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
  /** Null: it wasn't a golden yet, or wasn't tested at that revision. */
  result: 'pass' | 'fail' | null;
  /** Why it failed, for the hover. */
  note: string | null;
  /** `test --update` re-recorded it there (the ring). */
  updated: boolean;
  runId: string | null;
  at: number | null;
}

export interface GoldenRow {
  path: string;
  /** The path without the goldens folder: `refund-flow`. */
  name: string;
  /** Where it came from: a run in this store, or a pack made elsewhere. */
  source: { kind: 'run'; runId: string } | { kind: 'pack'; packedAt: number | null };
  mode: 'replay' | 'fork';
  /** `replay`, or `fork ×5`. */
  modeLabel: string;
  /** What the mode means, for the hover. */
  modeHint: string;
  checks: string[];
  history: HistoryCell[];
  last: { result: 'pass' | 'fail' | null; failure: TestFailure | null; line: string; at: number | null; updated: boolean };
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

/** What Find the commit said when it named no first bad commit: why, and between which commits it looked. */
export interface BisectMiss {
  why: string;
  good: string | null;
  bad: string | null;
  at: number;
}

/**
 * A commit Find the commit's dialog offers as one where the golden still worked: a revision it was
 * tested at before it failed, and how it did there.
 */
export interface BisectRevision {
  rev: string;
  at: number;
  result: 'pass' | 'fail';
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
  checks: Array<{ ok: boolean; label: string; detail: string | null }> | null;
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
  /** Goldens whose last result diverged: Update goldens… lists them. */
  diverged: string[];
  commands: {
    /** Copy CI command. */
    ci: string;
    /** The In CI panel's command, with the job summary. */
    inCi: string;
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

/** A word as a shell reads it: `goldens/*` stays as it is, a path with a space is quoted. */
const shellWord = (s: string) => (/^[A-Za-z0-9_./*:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

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
  if (s.endedAt === null) {
    const results = store.listTestResults({ sessionId: s.sessionId, limit: 100_000 });
    passed = results.filter((r) => r.ok).length;
    failed = results.length - passed;
  }
  return { id: s.sessionId, command: s.command.join(' '), revision: s.revision, startedAt: s.startedAt, endedAt: s.endedAt, passed, failed, upstreamRequests: s.upstreamRequests, actor: s.actor, interrupted: s.interrupted, live: sessionLive(store, s) };
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

/** Why a result failed, in a few words: `diverged at call 1`, `check failed: send_email called 0 times`. */
export function shortReason(r: TestResult): string {
  if (r.ok) return 'passed';
  const reason = r.reason ?? 'failed';
  if (r.failure === 'diverged') {
    const d = r.data?.divergence;
    return d ? `diverged at call ${d.callNo}` : reason.replace(/\s*\(.*\)$/, '');
  }
  if (r.failure === 'check') return reason.replace(/, but .*$/, '');
  if (r.failure === 'exit') return /exited with code \d+/.exec(reason)?.[0] ?? reason.replace(/^the agent /, '');
  if (r.failure === 'no-calls') return 'made no calls';
  return `couldn't run: ${reason}`;
}

/** The line under a golden's last result: what it did, or why it failed. */
export function resultLine(r: TestResult, checks: readonly string[]): string {
  const data = r.data ?? {};
  if (!r.ok) {
    if (r.failure === 'diverged') {
      const d = divergenceOf(r);
      if (!d) return r.reason ?? 'diverged';
      const v = volatileOf(r, d).values[0];
      if (v) return `diverged at call ${d.callNo} · ${v.path} ${v.certain ? `looks like ${v.looks}` : 'changed, an id that may be a real change'}`;
      const path = d.diff?.[0]?.path;
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
  if (data.attempts) {
    parts.push(`${data.attempts.passed} of ${data.attempts.total} attempts passed ${n === 1 ? 'the check' : n === 2 ? 'both checks' : n ? `all ${n} checks` : ''}`.trim());
  } else if (data.divergence) {
    parts.push(`forked at call ${data.divergence.callNo}`);
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
  g.mode === 'fork'
    ? { label: g.repeat > 1 ? `fork ×${g.repeat}` : 'fork', hint: `allowed to fork; passes on its checks${g.repeat > 1 ? `, ${g.passes} of ${g.repeat} attempts` : ''}` }
    : { label: 'replay', hint: 'must send exactly the requests it recorded' };

const runIfKept = (store: Store, runId: string | null) => (runId && store.getRun(runId) ? runId : null);

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
function lineOf(store: Store, r: TestResult, checks: readonly string[]): string {
  const blocked = blockedTargets(store, r);
  const line = resultLine(r, checks);
  return blocked.length ? `${blockedWords(blocked)} · ${line}` : line;
}

/** A history cell's hover note: why it failed, or a connection the guard blocked in a replay that passed. */
function cellNote(store: Store, r: TestResult, checks: readonly string[]): string | null {
  if (!r.ok) return lineOf(store, r, checks);
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
    .map(({ r, rev }) => ({ rev, at: r.at, result: r.ok ? 'pass' : 'fail', sameChecks: underChecks(r, checks) }));
}

/** What Find the commit last said about each golden: a first bad commit, or none and why (the `bisect.found` and `bisect.none` activity events). */
type BisectAnswer = { found: FoundCommit; missed: null } | { found: null; missed: BisectMiss };

function bisectAnswers(store: Store): Map<string, BisectAnswer> {
  const out = new Map<string, BisectAnswer>();
  // Newest first: the first answer for a golden is its latest.
  for (const e of store.listEvents({ kinds: ['bisect.found', 'bisect.none'], limit: 500 })) {
    if (!e.ref || out.has(e.ref)) continue;
    if (e.kind === 'bisect.none') {
      const d = (e.data ?? {}) as { why?: unknown; good?: unknown; bad?: unknown };
      out.set(e.ref, { found: null, missed: { why: String(d.why ?? 'no first bad commit'), good: typeof d.good === 'string' ? d.good : null, bad: typeof d.bad === 'string' ? d.bad : null, at: e.at } });
      continue;
    }
    const d = e.data as { first?: { rev?: unknown; subject?: unknown; author?: unknown; date?: unknown }; why?: unknown; untested?: unknown; replays?: unknown; tokens?: unknown } | null;
    if (typeof d?.first?.rev !== 'string') continue;
    const untested = Array.isArray(d.untested) ? d.untested.filter((x): x is string => typeof x === 'string') : [];
    out.set(e.ref, { found: { rev: d.first.rev, subject: String(d.first.subject ?? ''), author: String(d.first.author ?? ''), date: String(d.first.date ?? ''), why: String(d.why ?? ''), untested, replays: Number(d.replays ?? 0), tokens: Number(d.tokens ?? 0), at: e.at }, missed: null });
  }
  return out;
}

/**
 * What Find the commit said about a failing golden, while it still stands: until the golden passes
 * again (a pass since means the failure it answered is over), or a newer search answers instead.
 */
function standingAnswer(answer: BisectAnswer | undefined, history: readonly TestResult[]): BisectAnswer | null {
  if (!answer) return null;
  const at = answer.found?.at ?? answer.missed!.at;
  return history.some((r) => r.ok && r.at > at) ? null : answer;
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
const columnOf = (revision: string | null, columns: ReadonlySet<string | null>): string | null | undefined => (columns.has(revision) ? revision : columns.has(committed(revision)) ? committed(revision) : undefined);

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
  const results = store.listTestResults({ sessionIds: all.map((s) => s.sessionId), limit: 100_000 });
  const ran = new Map<string, Set<string>>();
  for (const r of results) {
    let set = ran.get(r.sessionId);
    if (!set) ran.set(r.sessionId, (set = new Set()));
    set.add(r.golden);
  }
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
      source: recorded && !recorded.meta?.imported ? { kind: 'run', runId: recorded.runId } : { kind: 'pack', packedAt: g.packedAt },
      mode: g.mode,
      modeLabel: mode.label,
      modeHint: mode.hint,
      checks: g.checks,
      history: revisions.map((rev) => {
        // Its own column's sessions, and a session that ran only some goldens there, or on that
        // commit with changes on top (Add normalizer and re-run), where no column is its own.
        const here = list.filter((x) => (sessionsView.columnOf.has(x.sessionId) ? sessionsView.columnOf.get(x.sessionId) : columnOf(x.revision, columns)) === rev);
        // The newest result there, ringed when any session there updated it: a run after the update keeps the ring.
        const r = here[0] ?? null;
        return { revision: rev, tested: r?.revision ?? null, result: r ? (r.ok ? 'pass' : 'fail') : null, note: r ? cellNote(store, r, g.checks) : null, updated: here.some((x) => !!x.data?.updated), runId: r ? runIfKept(store, r.runId) : null, at: r?.at ?? null };
      }),
      last: latest
        ? { result: latest.ok ? 'pass' : 'fail', failure: latest.failure, line: lineOf(store, latest, g.checks), at: latest.at, updated: !!latest.data?.updated }
        : { result: null, failure: null, line: error ? `can't be read: ${error}` : 'not run yet', at: null, updated: false },
      runId: runIfKept(store, latest?.runId ?? null) ?? sourceRun,
      error,
    };
  });

  const divergences: DivergenceView[] = [];
  const failures: FailureView[] = [];
  const answers = bisectAnswers(store);
  for (const row of rows) {
    const latest = latestOf.get(row.path);
    if (!latest || latest.ok) continue;
    const past = store.listTestResults({ golden: row.path, limit: 1000 });
    // A pack that can't be read can't be bisected either.
    const bisect = row.error ? null : bisectFor(row.path, past, latest, row.mode === 'fork', row.checks);
    const answer = standingAnswer(answers.get(row.path), past);
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
    const failed = lastResults.filter((r) => !r.ok);
    const first = failed[0] ?? null;
    const total = goldens.length;
    const passing = lastResults.length - failed.length;
    const untested = total - lastResults.length;
    verdict = {
      state: failed.length ? 'failing' : 'passing',
      failing: failed.length,
      passing,
      untested,
      // One golden: "All 1 goldens pass" isn't English.
      title: first ? `${nameOf(first.golden, folder)} ${shortReason(first)}` : untested ? `${passing} of ${total} goldens pass, ${untested} not run yet` : total === 1 ? 'The golden passes' : `All ${total} goldens pass`,
      first: first ? { golden: first.golden, name: nameOf(first.golden, folder), reason: first.reason ?? 'failed', runId: runIfKept(store, first.runId) } : null,
      session: sessionView(store, shown),
      since: lastResults.filter((r) => r.sessionId !== shown.sessionId && r.at > shown.startedAt).map((r) => ({ golden: r.golden, name: nameOf(r.golden, folder), ok: r.ok, revision: r.revision, at: r.at })),
    };
  }

  const diverged = divergences.map((d) => d.golden);
  const patterns = testPatterns(goldens, folder);
  return {
    empty: goldens.length === 0,
    goldens: goldens.length,
    verdict,
    revisions,
    rows,
    divergences,
    failures,
    diverged,
    commands: {
      ci: `shadowlap test ${patterns.map(shellWord).join(' ')} --junit report.xml`,
      inCi: `shadowlap test ${patterns.map(shellWord).join(' ')} --junit report.xml --markdown "$GITHUB_STEP_SUMMARY"`,
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
  const failing = latest.size - passing;
  const session = store.listTestSessions({ limit: 1, withResults: true })[0] ?? null;
  const weekAgo = latestResults(store, options.goldens, options.weekStart ?? now - 7 * 24 * 60 * 60 * 1000);
  return {
    empty: total === 0,
    total,
    passing,
    failing,
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
export function overviewTests(store: Store, asOf: { now: number; weekStart: number }, options: { goldens: GoldenList }): { goldens: number; passing: number; lastWeek: number | null; regressions: number; lastRunAt: number | null } | null {
  const s = testsSummary(store, { goldens: options.goldens, now: asOf.now, weekStart: asOf.weekStart });
  if (s.empty) return null;
  return { goldens: s.total, passing: s.passing, lastWeek: s.lastWeek ? s.lastWeek.passing : null, regressions: s.failing, lastRunAt: s.lastRunAt };
}

export interface FailingTest {
  golden: string;
  /** For Needs a look: `A test failed: refund-in-limit`. */
  title: string;
  /** Why: `diverged at call 1 · $.metadata.user_id looks like a UUID`. */
  line: string;
  failure: TestFailure;
  runId: string | null;
  /** Where Fix → goes: the failing run, else the Tests screen. */
  href: string;
  at: number;
}

/** Goldens on disk failing now, newest failure first: Needs a look's failing tests. */
export function failingTests(store: Store, options: { goldens: GoldenList; folder?: string }): FailingTest[] {
  const folder = options.folder ?? 'goldens';
  const checksOf = new Map(options.goldens.filter((g): g is GoldenSource => typeof g !== 'string').map((g) => [g.path, g.checks]));
  return [...latestResults(store, options.goldens).values()]
    .filter((r) => !r.ok)
    .sort((a, b) => b.at - a.at)
    .map((r) => {
      const runId = runIfKept(store, r.runId);
      return { golden: r.golden, title: `A test failed: ${nameOf(r.golden, folder)}`, line: lineOf(store, r, checksOf.get(r.golden) ?? []), failure: r.failure ?? 'error', runId, href: runId ? `#/run/${runId}` : '#/tests', at: r.at };
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
  const kept = result.runId === run.runId ? result.data?.divergence?.volatile : undefined;
  const found = kept ? storedVolatile(kept) : volatileValues(run.divergence);
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
  };
}

// ---- Find the commit, from a run: the run page's fork menu and the calendar's failed days ----

export interface BisectChoices {
  /** What bisect replays: the golden a test replay came from, which replays offline, or the run itself. */
  target: { kind: 'golden'; golden: string } | { kind: 'run'; runId: string };
  /**
   * The run failed: bisect looks for where it started failing, from a good commit up to its own.
   * Otherwise it passed, and bisect looks for the first commit after its own that changes what it does.
   */
  failed: boolean;
  /** A commit where it still worked, to offer first: the newest revision before it where its golden, or a run of its command, passed. */
  good: string | null;
  /** Where it fails: the run's own revision for a failed run (null: HEAD, as for one made with uncommitted changes). */
  bad: string | null;
  /**
   * Revisions to choose a good one from, newest first: where its golden or its command ran before it,
   * and how those runs went; `subject` is the commit's, once the project's git was asked (commits-here.ts).
   */
  revisions: Array<{ rev: string; at: number; runs: number; failed: number; subject?: string | null }>;
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

function runFailed(run: RunRecord): boolean {
  return exitFailed(run) || !!run.meta?.checks?.some((c) => !c.ok);
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
  // A run in a fix as failing its check (blame found it so, or a repair or verify did), though it
  // exited 0 with no check of its own failed: that check is the one it failed.
  const blamed = !ofGolden && !runFailed(run) ? blamedCheck(store, run) : null;
  const failed = result ? !result.ok : runFailed(run) || (ofGolden && !!run.divergence) || blamed !== null;
  let revisions: BisectChoices['revisions'];
  let sameRecording: string | null = null;
  let passedHere: string | null = null;
  if (ofGolden) {
    const at = new Map<string, { rev: string; at: number; runs: number; failed: number }>();
    for (const r of store.listTestResults({ golden: golden!, limit: 10_000 })) {
      if (r.at >= before || !clean(r.revision) || r.revision === own) continue;
      // Newest first: the first pass of the recording this replay failed on, under the checks the
      // golden has now, is the one to offer: an earlier recording of the golden (before an update), or
      // a pass under other checks, may be a commit where it already fails.
      const counts = r.ok && underChecks(r, source!.checks);
      if (!sameRecording && counts && result?.goldenRunId && r.goldenRunId === result.goldenRunId) sameRecording = r.revision;
      if (!passedHere && counts) passedHere = r.revision;
      const row = at.get(r.revision) ?? { rev: r.revision, at: r.at, runs: 0, failed: 0 };
      row.runs++;
      if (!r.ok) row.failed++;
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
  const expect = fork ? (run.meta?.checks?.some((c) => !c.ok) && plainObject(run.meta.expect) ? run.meta.expect : blamed) : null;
  // A run that passed is the good end itself; bisect then looks up to HEAD. One that failed only
  // blame's check leaves the good one to be chosen: how other runs exited says nothing about it.
  const good = !failed ? (clean(run.codeVersion) ? run.codeVersion : null) : ofGolden ? (sameRecording ?? passedHere) : blamed !== null ? null : (revisions.find((r) => r.failed < r.runs)?.rev ?? null);
  const bad = failed && clean(run.codeVersion) ? run.codeVersion : null;
  let unavailable: string | null = null;
  if (run.status === 'running') unavailable = 'this run is still recording';
  // A test replay a signal cut short has no result: it says nothing about its golden either way.
  else if (ofGolden && run.status === 'crashed' && !result) unavailable = `this replay was cut short, so it says nothing about ${golden}: find the commit from the golden on Tests`;
  else if (!ofGolden && !hasRecordedCommand(run)) unavailable = `this run was imported from a capture, so there is no command to run at each commit: replay it once with your agent (shadowlap replay ${run.runId} -- <command>) and find the commit from that run`;
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

/** Run tests: every golden (`test goldens/*` and any kept elsewhere), or the one `golden` names. */
export function runTestsJob(goldens: readonly GoldenSource[], req: Record<string, unknown>, options: TestsOptions = {}): TestsJob {
  if (req.golden !== undefined) {
    const golden = knownGolden(goldens, req.golden);
    return golden ? { title: 'Running the tests', args: ['test', golden] } : { error: 'no such golden: name one of the packs in the goldens folder or under "tests" in the config' };
  }
  if (!goldens.length) return { error: `no goldens yet: pack a run you consider correct into ${options.folder ?? 'goldens'}/ first` };
  return { title: 'Running the tests', args: ['test', ...testPatterns(goldens, options.folder)] };
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
