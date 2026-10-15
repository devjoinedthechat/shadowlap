import { normalizeAddArgs, normalizeAddCommand, volatileValues, type CallKind, type DivergenceReport, type Normalizer, type Store, type TestFailure, type TestResult, type TestSession } from '@shadowlap/engine';

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

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

function nameOf(path: string, folder: string): string {
  return path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path;
}

function sessionView(s: TestSession): TestsSessionView {
  return { id: s.sessionId, command: s.command.join(' '), revision: s.revision, startedAt: s.startedAt, endedAt: s.endedAt, passed: s.passed, failed: s.failed, upstreamRequests: s.upstreamRequests, actor: s.actor };
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
      const v = volatileValues(d).values[0];
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

function bisectFor(golden: string, history: readonly TestResult[], failed: TestResult): { good: string; bad: string | null; args: string[] } | null {
  // The newest result that passed before this failure, at another revision.
  const good = history.find((r) => r.ok && r.at < failed.at && r.revision && committed(r.revision) !== committed(failed.revision));
  const goodRev = committed(good?.revision ?? null);
  if (!goodRev) return null;
  const bad = failed.revision && !failed.revision.endsWith('+dirty') ? failed.revision : null;
  return { good: goodRev, bad, args: ['bisect', golden, '--good', goodRev, ...(bad ? ['--bad', bad] : [])] };
}

/** The newest first bad commit bisect found for each golden (from the `bisect.found` activity events). */
function foundCommits(store: Store): Map<string, FoundCommit> {
  const out = new Map<string, FoundCommit>();
  for (const e of store.listEvents({ kinds: ['bisect.found'], limit: 500 })) {
    const d = e.data as { first?: { rev?: unknown; subject?: unknown; author?: unknown; date?: unknown }; why?: unknown; replays?: unknown; tokens?: unknown } | null;
    if (!e.ref || out.has(e.ref) || typeof d?.first?.rev !== 'string') continue;
    out.set(e.ref, { rev: d.first.rev, subject: String(d.first.subject ?? ''), author: String(d.first.author ?? ''), date: String(d.first.date ?? ''), why: String(d.why ?? ''), replays: Number(d.replays ?? 0), tokens: Number(d.tokens ?? 0), at: e.at });
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
  const results = store.listTestResults({ limit: 20_000 });
  const history = byGolden(results);
  const last = sessions[0] ?? null;

  // Columns: the revisions of the most recent sessions, oldest first.
  const revisions: Array<string | null> = [];
  for (const s of sessions) {
    if (!revisions.includes(s.revision)) revisions.push(s.revision);
    if (revisions.length >= (options.revisions ?? 6)) break;
  }
  revisions.reverse();

  const rows: GoldenRow[] = goldens.map((g) => {
    const list = history.get(g.path) ?? [];
    const latest = list[0] ?? null;
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
    const latest = history.get(row.path)?.[0];
    if (!latest || latest.ok) continue;
    const bisect = bisectFor(row.path, history.get(row.path) ?? [], latest);
    const seen = commits.get(row.path);
    const found = seen && seen.at >= latest.at ? seen : null;
    const d = latest.failure === 'diverged' ? divergenceOf(latest) : null;
    if (d) {
      const volatile = volatileValues(d);
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
        bisect,
        found,
      });
    } else {
      failures.push({ golden: row.path, name: row.name, runId: row.runId, failure: latest.failure ?? 'error', reason: latest.reason ?? 'failed', checks: latest.data?.checks ?? null, details: latest.data?.details ?? null, bisect, found });
    }
  }

  let verdict: TestsVerdict | null = null;
  if (last) {
    const inSession = results.filter((r) => r.sessionId === last.sessionId).sort((a, b) => a.at - b.at);
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
      ci: `shadowlap test ${folder}/* --junit report.xml`,
      inCi: `shadowlap test ${folder}/* --junit report.xml --markdown "$GITHUB_STEP_SUMMARY"`,
      pack: `shadowlap pack <run> ${folder}/<name>`,
      run: ['test', `${folder}/*`],
      updateAll: diverged.length ? ['test', ...diverged, '--update'] : null,
    },
    note: RECORDINGS_NOTE,
  };
}

/** The latest result of each golden, as of a time. */
function latestResults(store: Store, options: { goldens?: readonly string[]; until?: number } = {}): Map<string, TestResult> {
  const out = new Map<string, TestResult>();
  for (const r of store.listTestResults({ limit: 20_000 })) {
    if (options.until !== undefined && r.at > options.until) continue;
    if (options.goldens && !options.goldens.includes(r.golden)) continue;
    if (!out.has(r.golden)) out.set(r.golden, r);
  }
  return out;
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
}

/** For a run made by `shadowlap test` that diverged: its golden and the actions on it. Null for any other run. */
export function testRunBanner(store: Store, runId: string): TestRunBanner | null {
  const run = store.getRun(runId);
  const test = run?.meta?.test;
  if (!run || !test || !run.divergence) return null;
  const found = volatileValues(run.divergence);
  const v = found.values[0];
  return {
    golden: test.golden,
    session: test.session,
    volatile: v ? { ...v, args: normalizeAddArgs(v.normalizer), command: normalizeAddCommand(v.normalizer) } : null,
    normalizerFixes: found.explainsAll,
    rerun: ['test', test.golden],
    update: ['test', test.golden, '--update'],
  };
}
