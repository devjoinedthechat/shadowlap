import { hasRecordedCommand, normalizeAddArgs, normalizeAddCommand, volatileValues, type CallKind, type DivergenceReport, type Normalizer, type RunRecord, type Store, type TestFailure, type TestResult, type TestSession, type VolatileValues } from '@shadowlap/engine';

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
}

/**
 * The banner at the top of the screen: how each golden on disk did the last time it ran (a session
 * may run only some of them, as Run tests on one golden does), with the newest session's command,
 * revision, time and upstream requests.
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
  /** The newest session with a result. */
  session: TestsSessionView;
}

/** A golden at one revision: a cell of its history. */
export interface HistoryCell {
  revision: string | null;
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
  /** Find the commit: from the last revision where it passed to the one where it failed (null: HEAD). */
  bisect: BisectRange | null;
  /** What Find the commit found, once it has run since this failure. */
  found: FoundCommit | null;
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
  bisect: BisectRange | null;
  found: FoundCommit | null;
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
 * What `shadowlap test` is given to run every golden: the goldens folder's pattern, which the CLI
 * expands itself, and each golden kept elsewhere (a pack the config's `tests` names) by its path.
 */
export function testPatterns(goldens: readonly GoldenSource[], folder = 'goldens'): string[] {
  const inFolder = (path: string) => path.startsWith(`${folder}/`) && !path.slice(folder.length + 1).includes('/');
  const elsewhere = goldens.filter((g) => !inFolder(g.path)).map((g) => g.path);
  return [...(goldens.some((g) => inFolder(g.path)) || !elsewhere.length ? [`${folder}/*`] : []), ...elsewhere];
}

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
  return { id: s.sessionId, command: s.command.join(' '), revision: s.revision, startedAt: s.startedAt, endedAt: s.endedAt, passed, failed, upstreamRequests: s.upstreamRequests, actor: s.actor, interrupted: s.interrupted };
}

/** When a session last did something: its end, or its newest result while it has none. */
function lastActive(store: Store, s: TestSession): number {
  return s.endedAt ?? store.listTestResults({ sessionId: s.sessionId, limit: 1 })[0]?.at ?? s.startedAt;
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
  if (data.updated) parts.push('updated');
  const n = data.checks?.length ?? 0;
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

/**
 * Find the commit for a failing golden, from the newest result that passed before the failure at
 * another revision. Best is a pass of the recording that fails now, tested as committed: a pass of
 * an earlier recording of the golden (before an update) may be a commit where this one already
 * fails, and uncommitted changes are not part of what bisect checks out.
 */
function bisectFor(golden: string, history: readonly TestResult[], failed: TestResult, live: boolean): BisectRange | null {
  const passed = history.filter((r) => r.ok && r.at < failed.at && r.revision && committed(r.revision) !== committed(failed.revision));
  const rank = (r: TestResult) => (failed.goldenRunId && r.goldenRunId === failed.goldenRunId ? 0 : 2) + (r.revision!.endsWith('+dirty') ? 1 : 0);
  // Newest first, so the first of the best rank is the newest of it.
  const good = passed.reduce<TestResult | null>((best, r) => (!best || rank(r) < rank(best) ? r : best), null);
  const goodRev = committed(good?.revision ?? null);
  if (!goodRev) return null;
  const bad = failed.revision && !failed.revision.endsWith('+dirty') ? failed.revision : null;
  return { good: goodRev, bad, args: ['bisect', golden, '--good', goodRev, ...(bad ? ['--bad', bad] : [])], live };
}

/** The newest first bad commit bisect found for each golden (from the `bisect.found` activity events). */
function foundCommits(store: Store): Map<string, FoundCommit> {
  const out = new Map<string, FoundCommit>();
  for (const e of store.listEvents({ kinds: ['bisect.found'], limit: 500 })) {
    const d = e.data as { first?: { rev?: unknown; subject?: unknown; author?: unknown; date?: unknown }; why?: unknown; untested?: unknown; replays?: unknown; tokens?: unknown } | null;
    if (!e.ref || out.has(e.ref) || typeof d?.first?.rev !== 'string') continue;
    const untested = Array.isArray(d.untested) ? d.untested.filter((x): x is string => typeof x === 'string') : [];
    out.set(e.ref, { rev: d.first.rev, subject: String(d.first.subject ?? ''), author: String(d.first.author ?? ''), date: String(d.first.date ?? ''), why: String(d.why ?? ''), untested, replays: Number(d.replays ?? 0), tokens: Number(d.tokens ?? 0), at: e.at });
  }
  return out;
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
  const sessions = store.listTestSessions({ limit: 500, withResults: true });
  const last = sessions[0] ?? null;

  // Columns: the revisions of the most recent sessions, oldest first.
  const revisions: Array<string | null> = [];
  for (const s of sessions) {
    if (!revisions.includes(s.revision)) revisions.push(s.revision);
    if (revisions.length >= (options.revisions ?? 6)) break;
  }
  revisions.reverse();
  // Only what the page shows is read: each golden's newest result, and the results of the sessions
  // at the revisions it has columns for.
  const latestOf = new Map(store.latestTestResults().map((r) => [r.golden, r]));
  const history = byGolden(store.listTestResults({ sessionIds: sessions.filter((s) => revisions.includes(s.revision)).map((s) => s.sessionId), limit: 100_000 }));

  const rows: GoldenRow[] = goldens.map((g) => {
    const list = history.get(g.path) ?? [];
    const latest = latestOf.get(g.path) ?? null;
    const sourceRun = runIfKept(store, g.runId);
    const recorded = sourceRun ? store.getRun(sourceRun) : null;
    const mode = modeOf(g);
    return {
      path: g.path,
      name: nameOf(g.path, folder),
      source: recorded && !recorded.meta?.imported ? { kind: 'run', runId: recorded.runId } : { kind: 'pack', packedAt: g.packedAt },
      mode: g.mode,
      modeLabel: mode.label,
      modeHint: mode.hint,
      checks: g.checks,
      history: revisions.map((rev) => {
        const r = list.find((x) => x.revision === rev) ?? null;
        return { revision: rev, result: r ? (r.ok ? 'pass' : 'fail') : null, note: r && !r.ok ? resultLine(r, g.checks) : null, updated: !!r?.data?.updated, runId: r ? runIfKept(store, r.runId) : null, at: r?.at ?? null };
      }),
      last: latest
        ? { result: latest.ok ? 'pass' : 'fail', failure: latest.failure, line: resultLine(latest, g.checks), at: latest.at, updated: !!latest.data?.updated }
        : { result: null, failure: null, line: g.error ? `can't be read: ${g.error}` : 'not run yet', at: null, updated: false },
      runId: runIfKept(store, latest?.runId ?? null) ?? sourceRun,
      error: g.error ?? null,
    };
  });

  const divergences: DivergenceView[] = [];
  const failures: FailureView[] = [];
  const commits = foundCommits(store);
  for (const row of rows) {
    const latest = latestOf.get(row.path);
    if (!latest || latest.ok) continue;
    // A pack that can't be read can't be bisected either.
    const bisect = row.error ? null : bisectFor(row.path, store.listTestResults({ golden: row.path, limit: 1000 }), latest, row.mode === 'fork');
    const seen = commits.get(row.path);
    const found = seen && seen.at >= latest.at ? seen : null;
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
      });
    } else {
      failures.push({ golden: row.path, name: row.name, runId: row.runId, failure: latest.failure ?? 'error', reason: latest.reason ?? 'failed', checks: latest.data?.checks ?? null, details: latest.data?.details ?? null, output: latest.data?.output ?? null, bisect, found });
    }
  }

  // The verdict counts every golden on disk by its last result, whichever session that came from: a
  // session that ran one golden says nothing about the others.
  let verdict: TestsVerdict | null = null;
  const lastResults = goldens.map((g) => latestOf.get(g.path)).filter((r): r is TestResult => r !== undefined);
  if (last && lastResults.length) {
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
      session: sessionView(store, last),
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
      return { golden: r.golden, title: `A test failed: ${nameOf(r.golden, folder)}`, line: resultLine(r, checksOf.get(r.golden) ?? []), failure: r.failure ?? 'error', runId, href: runId ? `#/run/${runId}` : '#/tests', at: r.at };
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
}

/**
 * For a run made by `shadowlap test` whose golden failed because it diverged: its golden and the
 * actions on it. Null for any other run, a replay of a golden that may fork (it diverges by design)
 * included.
 */
export function testRunBanner(store: Store, runId: string): TestRunBanner | null {
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
  /** Revisions to choose a good one from, newest first: where its golden or its command ran before it, and how those runs went. */
  revisions: Array<{ rev: string; at: number; runs: number; failed: number }>;
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
  // Only a golden whose pack can be read is bisected as one.
  const ofGolden = !!source && !source.error;
  const before = options.before ?? run.startedAt;
  const own = committed(run.codeVersion);
  // A test replay failed when its golden did in that session (a golden that may fork diverges by design).
  const result = ofGolden ? store.listTestResults({ sessionId: run.meta!.test!.session, golden: golden!, limit: 1 })[0] : undefined;
  const failed = result ? !result.ok : runFailed(run) || (ofGolden && !!run.divergence);
  let revisions: BisectChoices['revisions'];
  let sameRecording: string | null = null;
  if (ofGolden) {
    const at = new Map<string, { rev: string; at: number; runs: number; failed: number }>();
    for (const r of store.listTestResults({ golden: golden!, limit: 10_000 })) {
      if (r.at >= before || !clean(r.revision) || r.revision === own) continue;
      // Newest first: the first pass of the recording this replay failed on is the one to offer, as an
      // earlier recording of the golden (before an update) may already fail where it passed.
      if (!sameRecording && r.ok && result?.goldenRunId && r.goldenRunId === result.goldenRunId) sameRecording = r.revision;
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
  // A run that passed is the good end itself; bisect then looks up to HEAD.
  const good = failed ? (sameRecording ?? revisions.find((r) => r.failed < r.runs)?.rev ?? null) : clean(run.codeVersion) ? run.codeVersion : null;
  const bad = failed && clean(run.codeVersion) ? run.codeVersion : null;
  let unavailable: string | null = null;
  if (run.status === 'running') unavailable = 'this run is still recording';
  // A test replay a signal cut short has no result: it says nothing about its golden either way.
  else if (ofGolden && run.status === 'crashed' && !result) unavailable = `this replay was cut short, so it says nothing about ${golden}: find the commit from the golden on Tests`;
  else if (!ofGolden && !hasRecordedCommand(run)) unavailable = `this run was imported from a capture, so there is no command to run at each commit: replay it once with your agent (shadowlap replay ${run.runId} -- <command>) and find the commit from that run`;
  // Replayed with --fork, only the exit status and the checks decide; the CLI takes the checks of the
  // golden it was a replay of from the config, and has none otherwise.
  else if (fork && !exitFailed(run) && !source?.checks.length) unavailable = `this run failed a check that bisect can't know: give it on the command line, shadowlap bisect ${run.runId} --good <commit> --expect '<checks>' --fork`;
  const ref = target.kind === 'golden' ? target.golden : target.runId;
  return {
    target,
    failed,
    good,
    bad,
    revisions: revisions.slice(0, 30),
    fork,
    live: fork || (ofGolden && source!.mode === 'fork'),
    unavailable,
    args: good && !unavailable ? ['bisect', ref, '--good', good, ...(bad ? ['--bad', bad] : []), ...(fork ? ['--fork'] : [])] : null,
  };
}

// ---- jobs: what the Tests actions run ----

/**
 * A Tests action as a dashboard job: CLI arguments (after `shadowlap`) built from checked fields,
 * or why it can't run. The request comes from the browser and is not trusted: a golden must be one
 * of the packs on disk, a normalizer comes from the divergence the store kept, a revision has to look
 * like one. `steps` run one after the other, each only when the one before it succeeded.
 */
export type TestsJob = { title: string; args: string[]; runId?: string } | { title: string; steps: string[][]; runId?: string } | { error: string };

/** The golden a request names, as listed on disk, or null. */
function knownGolden(goldens: readonly GoldenSource[], raw: unknown): string | null {
  return typeof raw === 'string' ? (goldens.find((g) => g.path === raw)?.path ?? null) : null;
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
 * the calendar), from `good` up to `bad` (default: where it failed, else HEAD). A replay of a golden
 * on disk bisects the golden; a run that failed on its own replays with `--fork`.
 */
export function bisectJob(store: Store, goldens: readonly GoldenSource[], req: Record<string, unknown>): TestsJob {
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
    const error = goldens.find((g) => g.path === golden)?.error;
    if (error) return { error: `${golden} can't be read: ${error}` };
    return { title: 'Finding the commit', args: ['bisect', golden, '--good', good, ...(bad ? ['--bad', bad] : [])] };
  }
  const choices = typeof req.runId === 'string' && /^[0-9A-Z]{26}$/.test(req.runId) ? bisectChoices(store, req.runId, { goldens }) : null;
  if (!choices) return { error: 'no such run' };
  if (choices.unavailable) return { error: choices.unavailable };
  const ref = choices.target.kind === 'golden' ? choices.target.golden : choices.target.runId;
  const upTo = bad ?? choices.bad;
  if (upTo === good) return { error: `${good} is where it fails: choose an earlier commit where it still worked` };
  return { title: 'Finding the commit', args: ['bisect', ref, '--good', good, ...(upTo ? ['--bad', upTo] : []), ...(choices.fork ? ['--fork'] : [])], runId: req.runId as string };
}
