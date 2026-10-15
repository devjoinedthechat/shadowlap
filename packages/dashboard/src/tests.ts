import { normalizeAddArgs, normalizeAddCommand, volatileValues, type CallKind, type DivergenceReport, type Normalizer, type RunRecord, type Store, type TestFailure, type TestResult, type TestSession, type VolatileValues } from '@shadowlap/engine';

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
}

export interface TestsSessionView {
  id: string;
  /** As typed: `shadowlap test goldens/*`. */
  command: string;
  revision: string | null;
  startedAt: number;
  endedAt: number | null;
  passed: number;
  failed: number;
  upstreamRequests: number;
  actor: string | null;
}

/** The verdict of the last session: the banner at the top of the screen. */
export interface TestsVerdict {
  state: 'failing' | 'passing';
  failing: number;
  /** `refund-in-limit diverged at call 1`, or `All 4 goldens pass`. */
  title: string;
  first: { golden: string; name: string; reason: string; runId: string | null } | null;
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
  /** The value that changes every run, and the normalizer that masks it, when that is what diverged. */
  volatile: { path: string; looks: string; op: 'changed' | 'added'; normalizer: Normalizer; args: string[]; command: string } | null;
  /** The normalizer alone makes the replay match: add it and re-run, rather than update. */
  normalizerFixes: boolean;
  /** Arguments for the CLI (after `shadowlap`): re-run this golden, update it. */
  rerun: string[];
  update: string[];
  /**
   * Add normalizer and re-run, as the commands to run in order: a `normalize add` for each value that
   * changes every run, then `test` on the golden. Null when no such value diverged.
   */
  normalizeAndTest: string[][] | null;
  /** Find the commit: from the last revision where it passed to the one where it failed (null: HEAD). */
  bisect: { good: string; bad: string | null; args: string[] } | null;
  /** What Find the commit found, once it has run since this failure. */
  found: FoundCommit | null;
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
  bisect: { good: string; bad: string | null; args: string[] } | null;
  found: FoundCommit | null;
}

export interface TestsView {
  /** No goldens: the empty state, with the pack command. */
  empty: boolean;
  goldens: number;
  /** Null until a session has run. */
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

function sessionView(s: TestSession): TestsSessionView {
  return { id: s.sessionId, command: s.command.join(' '), revision: s.revision, startedAt: s.startedAt, endedAt: s.endedAt, passed: s.passed, failed: s.failed, upstreamRequests: s.upstreamRequests, actor: s.actor };
}

/** What volatileValues() made of a stored divergence: judged on all its changes when it was recorded. */
function volatileOf(r: TestResult, d: DivergenceReport): VolatileValues {
  return r.data?.divergence?.volatile ?? volatileValues(d);
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
      if (v) return `diverged at call ${d.callNo} · ${v.path} looks like ${v.looks}`;
      const path = d.diff?.[0]?.path;
      return path ? `diverged at call ${d.callNo} · ${path}` : `diverged at call ${d.callNo} (${d.type === 'new_call' ? `new call ${d.name}` : d.type === 'beyond_recording' ? 'more calls than recorded' : `${d.kind} ${d.name}`})`;
    }
    return r.reason ?? 'failed';
  }
  const parts: string[] = [];
  if (data.updated) parts.push('updated');
  const n = data.checks?.length ?? 0;
  if (data.attempts) {
    parts.push(`${data.attempts.passed} of ${data.attempts.total} attempts passed ${n === 2 ? 'both checks' : n ? plural(n, 'check') : ''}`.trim());
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

/** `normalize add` for each value that changes every run, then `test` on the golden; null when there is none. */
function normalizeSteps(volatile: VolatileValues, golden: string): string[][] | null {
  // A value the recording never had can't be masked into a match: that golden needs updating as well.
  const changed = volatile.values.filter((v) => v.op === 'changed');
  const values = changed.length ? changed : volatile.values;
  return values.length ? [...values.map((v) => normalizeAddArgs(v.normalizer)), ['test', golden]] : null;
}

function bisectFor(golden: string, history: readonly TestResult[], failed: TestResult): { good: string; bad: string | null; args: string[] } | null {
  // The newest result that passed before this failure, at another revision: one tested as committed
  // when there is one, since uncommitted changes are not part of what bisect checks out.
  const passed = history.filter((r) => r.ok && r.at < failed.at && r.revision && committed(r.revision) !== committed(failed.revision));
  const good = passed.find((r) => !r.revision!.endsWith('+dirty')) ?? passed[0];
  const goodRev = committed(good?.revision ?? null);
  if (!goodRev) return null;
  const bad = failed.revision && !failed.revision.endsWith('+dirty') ? failed.revision : null;
  return { good: goodRev, bad, args: ['bisect', golden, '--good', goodRev, ...(bad ? ['--bad', bad] : [])] };
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

/** Everything the Tests screen shows. */
export function testsView(store: Store, goldens: readonly GoldenSource[], options: TestsOptions = {}): TestsView {
  const folder = options.folder ?? 'goldens';
  const sessions = store.listTestSessions({ limit: 500, finished: true });
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
    const bisect = bisectFor(row.path, store.listTestResults({ golden: row.path, limit: 1000 }), latest);
    const seen = commits.get(row.path);
    const found = seen && seen.at >= latest.at ? seen : null;
    const d = latest.failure === 'diverged' ? divergenceOf(latest) : null;
    if (d) {
      const volatile = volatileOf(latest, d);
      const v = volatile.values[0];
      divergences.push({
        golden: row.path,
        name: row.name,
        runId: row.runId,
        callNo: d.callNo,
        kind: d.kind,
        callName: d.name,
        text: `✗ ${row.name}: ${latest.reason ?? `diverged at call ${d.callNo}`}\n${(latest.data?.divergence?.text ?? '').split('\n').map((l) => `    ${l}`).join('\n')}`,
        volatile: v ? { ...v, args: normalizeAddArgs(v.normalizer), command: normalizeAddCommand(v.normalizer) } : null,
        normalizerFixes: volatile.explainsAll,
        rerun: ['test', row.path],
        update: ['test', row.path, '--update'],
        normalizeAndTest: normalizeSteps(volatile, row.path),
        bisect,
        found,
      });
    } else {
      failures.push({ golden: row.path, name: row.name, runId: row.runId, failure: latest.failure ?? 'error', reason: latest.reason ?? 'failed', checks: latest.data?.checks ?? null, details: latest.data?.details ?? null, bisect, found });
    }
  }

  let verdict: TestsVerdict | null = null;
  if (last) {
    const inSession = store.listTestResults({ sessionId: last.sessionId, limit: 100_000 }).sort((a, b) => a.at - b.at);
    const failed = inSession.filter((r) => !r.ok);
    const first = failed[0] ?? null;
    const total = last.passed + last.failed;
    verdict = {
      state: last.failed ? 'failing' : 'passing',
      failing: last.failed,
      title: first ? `${nameOf(first.golden, folder)} ${shortReason(first)}` : total === 1 ? 'The golden passes' : `All ${total} goldens pass`,
      first: first ? { golden: first.golden, name: nameOf(first.golden, folder), reason: first.reason ?? 'failed', runId: runIfKept(store, first.runId) } : null,
      session: sessionView(last),
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

/** The latest result of each golden, as of a time, of the goldens given (default: every one tested). */
function latestResults(store: Store, options: { goldens?: readonly string[]; until?: number } = {}): Map<string, TestResult> {
  const keep = options.goldens ? new Set(options.goldens) : null;
  return new Map(store.latestTestResults(options.until !== undefined ? { until: options.until } : {}).filter((r) => !keep || keep.has(r.golden)).map((r) => [r.golden, r]));
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
  /** When the tests last ran (the last session's end), or null. */
  lastRunAt: number | null;
  /** The same a week earlier, for the change against last week; null without history that old. */
  lastWeek: { passing: number; total: number } | null;
}

/** The Overview's Tests passing tile. `goldens` (the packs on disk) limits it to goldens that still exist. */
export function testsSummary(store: Store, options: { goldens?: readonly string[]; now?: number } = {}): TestsSummary {
  const now = options.now ?? Date.now();
  const latest = latestResults(store, options.goldens ? { goldens: options.goldens } : {});
  const total = options.goldens ? options.goldens.length : latest.size;
  const passing = [...latest.values()].filter((r) => r.ok).length;
  const failing = latest.size - passing;
  const session = store.listTestSessions({ limit: 1, finished: true })[0] ?? null;
  const weekAgo = latestResults(store, { ...(options.goldens ? { goldens: options.goldens } : {}), until: now - 7 * 24 * 60 * 60 * 1000 });
  return {
    empty: total === 0,
    total,
    passing,
    failing,
    untested: Math.max(0, total - latest.size),
    line: total === 0 ? 'no goldens yet' : failing ? `${plural(failing, 'regression')} caught` : 'no regressions',
    lastRunAt: session ? (session.endedAt ?? session.startedAt) : null,
    lastWeek: weekAgo.size ? { passing: [...weekAgo.values()].filter((r) => r.ok).length, total: weekAgo.size } : null,
  };
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

/** Goldens failing now, newest failure first: Needs a look's failing tests. */
export function failingTests(store: Store, options: { goldens?: readonly string[]; folder?: string } = {}): FailingTest[] {
  const folder = options.folder ?? 'goldens';
  return [...latestResults(store, options.goldens ? { goldens: options.goldens } : {}).values()]
    .filter((r) => !r.ok)
    .sort((a, b) => b.at - a.at)
    .map((r) => {
      const runId = runIfKept(store, r.runId);
      return { golden: r.golden, title: `A test failed: ${nameOf(r.golden, folder)}`, line: resultLine(r, []), failure: r.failure ?? 'error', runId, href: runId ? `#/run/${runId}` : '#/tests', at: r.at };
    });
}

/** What the run page's diverged-test banner offers for a replay `shadowlap test` made. */
export interface TestRunBanner {
  golden: string;
  session: string;
  /** The value that changes every run, with the normalizer that masks it, when that is what diverged. */
  volatile: DivergenceView['volatile'];
  /** The normalizer alone makes the replay match: Add normalizer, then re-run the golden. */
  normalizerFixes: boolean;
  /** Arguments for the CLI: re-run the golden (after adding the normalizer), or update it. */
  rerun: string[];
  update: string[];
  /** Add normalizer and re-run, as the commands to run in order; null when no value that changes every run diverged. */
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
  const found = volatileValues(run.divergence);
  const v = found.values[0];
  return {
    golden: test.golden,
    session: test.session,
    volatile: v ? { ...v, args: normalizeAddArgs(v.normalizer), command: normalizeAddCommand(v.normalizer) } : null,
    normalizerFixes: found.explainsAll,
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
  /** The command for `good` and `bad` (after `shadowlap`), or null until a good commit is known. */
  args: string[] | null;
}

const clean = (rev: string | null): rev is string => !!rev && !rev.endsWith('+dirty');

function runFailed(run: RunRecord): boolean {
  return run.status === 'failed' || run.status === 'crashed' || !!run.meta?.checks?.some((c) => !c.ok);
}

/**
 * Find the commit that broke a run. A replay made by `shadowlap test` bisects its golden, which
 * replays offline; any other run is bisected as it is. `before` limits the good commits to runs
 * started before it (the calendar passes the first day picked); `goldens`, the packs on disk, makes a
 * replay of a golden that is gone a run like any other.
 */
export function bisectChoices(store: Store, runId: string, options: { before?: number; goldens?: readonly GoldenSource[] } = {}): BisectChoices | null {
  const run = store.getRun(runId);
  if (!run) return null;
  const golden = run.meta?.test?.golden ?? null;
  const ofGolden = golden !== null && (!options.goldens || options.goldens.some((g) => g.path === golden));
  const before = options.before ?? run.startedAt;
  const own = committed(run.codeVersion);
  let revisions: BisectChoices['revisions'];
  if (ofGolden) {
    const at = new Map<string, { rev: string; at: number; runs: number; failed: number }>();
    for (const r of store.listTestResults({ golden: golden!, limit: 10_000 })) {
      if (r.at >= before || !clean(r.revision) || r.revision === own) continue;
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
  // A test replay failed when its golden did in that session (a golden that may fork diverges by design).
  const result = ofGolden ? store.listTestResults({ sessionId: run.meta!.test!.session, golden: golden!, limit: 1 })[0] : undefined;
  const failed = result ? !result.ok : runFailed(run) || (ofGolden && !!run.divergence);
  const fork = !ofGolden && failed;
  // A run that passed is the good end itself; bisect then looks up to HEAD.
  const good = failed ? (revisions.find((r) => r.failed < r.runs)?.rev ?? null) : clean(run.codeVersion) ? run.codeVersion : null;
  const bad = failed && clean(run.codeVersion) ? run.codeVersion : null;
  const ref = target.kind === 'golden' ? target.golden : target.runId;
  return { target, failed, good, bad, revisions: revisions.slice(0, 30), fork, args: good ? ['bisect', ref, '--good', good, ...(bad ? ['--bad', bad] : []), ...(fork ? ['--fork'] : [])] : null };
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
 * `normalize add` for each, then `test` on the golden. `path` picks one value when several diverged.
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
    volatile = volatileValues(run.divergence!);
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
    volatile = { values: [one], explainsAll: false };
  }
  const steps = normalizeSteps(volatile, golden);
  if (!steps) return { error: `${golden} diverged on more than values that change every run: if the change was intended, update the golden` };
  return { title: 'Adding a normalizer', steps, ...(runId ? { runId } : {}) };
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
    return { title: 'Finding the commit', args: ['bisect', golden, '--good', good, ...(bad ? ['--bad', bad] : [])] };
  }
  const choices = typeof req.runId === 'string' && /^[0-9A-Z]{26}$/.test(req.runId) ? bisectChoices(store, req.runId, { goldens }) : null;
  if (!choices) return { error: 'no such run' };
  const ref = choices.target.kind === 'golden' ? choices.target.golden : choices.target.runId;
  const upTo = bad ?? choices.bad;
  if (upTo === good) return { error: `${good} is where it fails: choose an earlier commit where it still worked` };
  return { title: 'Finding the commit', args: ['bisect', ref, '--good', good, ...(upTo ? ['--bad', upTo] : []), ...(choices.fork ? ['--fork'] : [])], runId: req.runId as string };
}
