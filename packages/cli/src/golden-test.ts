import { basename, resolve } from 'node:path';
import { formatDivergence, hasRecordedCommand, heldFrom, maskedChange, unpackRun, volatileValues, type CallRecord, type DivergenceReport, type Normalizer, type RunMeta, type RunRecord, type Store, type TestFailure, type TestResultData, type WritePolicy } from '@shadowlap/engine';
import { type CheckResult, type TestSpec } from './checks.js';
import { upstreamOverrides, type ShadowlapConfig } from './config.js';
import { readPackHead } from './goldens.js';
import { type JunitCase } from './junit.js';
import { placeholderAwsCredentials, providerIds, testAttempt, type GuardMode, type TestAttempt } from './run-agent.js';
import { withoutCommand } from './shared.js';
import { type PackResult } from './test-report.js';

/**
 * One golden under `shadowlap test` (and each commit of `shadowlap bisect`): its recording replayed
 * as many times as its config asks, offline unless it may fork, and judged the way a test is. What
 * came out is kept as the golden's result in the store's test history and in the reports.
 */

export interface RecordingTestContext {
  store: Store;
  config: Pick<ShadowlapConfig, 'normalize' | 'prices' | 'clock' | 'http'>;
  /** Where the recorded command runs. */
  cwd: string;
  writes: WritePolicy;
  guard: GuardMode;
  /** Live calls after a divergence; a golden marked `fork` always has them. */
  online: boolean;
  /** Marks each replay as made by this test session for this golden (`meta.test`). */
  test?: { golden: string; session: string } | null;
  /** Called as each replay starts, with its run id. */
  onRun?: (runId: string, attempt: number, of: number) => void;
  /** The command to run instead of the recorded one (bisect runs it in a worktree). */
  argv?: string[];
  timeoutMs?: number | null;
  /**
   * For a caller that winds down on a signal by itself (`test`, `bisect`): true once one arrived. The
   * attempt it cuts short then returns, and no other attempt starts. Without it, a signal ends the
   * process once the replay it cut short has ended.
   */
  stopped?: () => boolean;
}

/** A signal stopped the replays of a recording before the first one could start. */
export class ReplayInterrupted extends Error {
  constructor() {
    super('interrupted before its replay started');
    this.name = 'ReplayInterrupted';
  }
}

export interface RecordingOutcome {
  spec: TestSpec | null;
  attempts: TestAttempt[];
  /** The attempt the result shows: the last that passed when enough did, else the first that failed. */
  shown: TestAttempt;
  passed: number;
  required: number;
  /** Why it failed, or undefined when it passed. */
  failure: JunitCase['failure'];
  kind: TestFailure | null;
  /** A signal cut an attempt short, or kept the rest from starting: the outcome says nothing about the recording. */
  interrupted: boolean;
}

/** Replays a recording that is already in the store, as a test does, and judges it. */
export async function testRecording(parent: RunRecord, spec: TestSpec | null, ctx: RecordingTestContext): Promise<RecordingOutcome> {
  // A golden has to be able to start its agent. One packed straight from a capture cannot, and
  // spawning its placeholder would fail for a reason the report would not name.
  if (!ctx.argv && !hasRecordedCommand(parent)) {
    throw new Error(`this recording ${withoutCommand(parent)} and has no command to run. Replay it once with your agent (shadowlap replay <run> -- <command>) and pack that run: it records everything, and has a command of its own`);
  }
  // A recording marked `fork` may diverge on purpose; from the fork on it needs the real providers.
  const live = ctx.online || !!spec?.fork;
  const upstreams = live ? upstreamOverrides(process.env) : Object.fromEntries([...Object.keys(providerIds()), 'http'].map((id) => [id, 'offline']));
  const extraEnv = live ? {} : placeholderAwsCredentials(process.env, ctx.store.getCalls(parent.runId));
  const attempts: TestAttempt[] = [];
  const repeat = spec?.repeat ?? 1;
  // A golden replayed more than once in a session is one test run with its attempts (`meta.test`
  // `attempt` and `of`): while they run, each attempt after the first is filed under the first, and
  // once they have all ended, under the attempt the result shows, so the Runs page, the sidebar and
  // the Tests screen all open the run that says how the golden came out.
  const testMeta = (i: number, of: string | null): Partial<RunMeta> | null => (ctx.test ? { test: { ...ctx.test, ...(repeat > 1 ? { attempt: i + 1 } : {}), ...(of ? { of } : {}) } } : null);
  for (let i = 0; i < repeat; i++) {
    if (ctx.stopped?.()) break;
    const meta = testMeta(i, i > 0 ? (attempts[0]?.ended.summary.runId ?? null) : null);
    const attempt = await testAttempt(ctx.store, parent, {
      cwd: ctx.cwd,
      upstreams,
      extraEnv,
      writes: ctx.writes,
      guard: ctx.guard,
      normalizers: ctx.config.normalize,
      prices: ctx.config.prices,
      clock: ctx.config.clock,
      http: ctx.config.http,
      spec,
      ...(ctx.argv ? { argv: ctx.argv } : {}),
      ...(meta ? { meta } : {}),
      ...(ctx.onRun ? { onRun: (runId: string) => ctx.onRun!(runId, i + 1, repeat) } : {}),
      ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}),
      ...(ctx.stopped ? { onSignal: 'return' as const } : {}),
    });
    attempts.push(attempt);
    if (attempt.interrupted) break;
  }
  if (!attempts.length) throw new ReplayInterrupted();
  const interrupted = attempts.length < repeat || attempts.some((a) => a.interrupted !== null);
  const passed = attempts.filter((a) => !a.failure).length;
  const required = spec?.passes ?? 1;
  const shown = passed >= required ? attempts.filter((a) => !a.failure).at(-1)! : attempts.find((a) => a.failure)!;
  if (attempts.length > 1 && !interrupted) fileUnder(ctx.store, attempts, shown, testMeta);
  let failure: JunitCase['failure'];
  if (passed < required) {
    const f = shown.failure!;
    failure =
      attempts.length === 1
        ? f
        : {
            message: `${passed} of ${attempts.length} attempts passed, ${required} needed. Attempt ${attempts.indexOf(shown) + 1}: ${f.message}`,
            details: `${attempts.map((a, i) => `attempt ${i + 1}  ${a.failure ? `✗ ${a.failure.message}` : '✓ passed'}`).join('\n')}\n\n${f.details}`,
          };
  }
  return { spec, attempts, shown, passed, required, failure, kind: failure ? (shown.kind ?? 'error') : null, interrupted };
}

/**
 * Files a golden's attempts under the one its result shows. Never fails the test: the store may be
 * busy with another process, or a run gone, and the attempts then stay filed under the first.
 */
function fileUnder(store: Store, attempts: readonly TestAttempt[], shown: TestAttempt, meta: (i: number, of: string | null) => Partial<RunMeta> | null): void {
  const head = shown.ended.summary.runId;
  attempts.forEach((a, i) => {
    const runId = a.ended.summary.runId;
    const patch = meta(i, runId === head ? null : head);
    if (!patch) return;
    try {
      store.updateRunMeta(runId, patch);
    } catch {
      // Left under the first attempt.
    }
  });
}

/** A golden as `shadowlap test` ran it: its pack, its recording, and how it came out. */
export interface GoldenOutcome {
  /** Its name in the test history: the pack folder relative to the project. */
  golden: string;
  /** The pack directory as given. */
  dir: string;
  /** The pack directory's own name. */
  name: string;
  parent: RunRecord | null;
  spec: TestSpec | null;
  /** Null when the golden could not be replayed at all (`failure` says why). */
  result: RecordingOutcome | null;
  failure: JunitCase['failure'];
  kind: TestFailure | null;
  seconds: number;
  /** The normalizers its replays matched under: the config's, and the pack's redaction rules. */
  normalizers: Normalizer[];
  /** A signal stopped it before its replays were done: it has no result. */
  interrupted: boolean;
}

/**
 * Imports a golden's pack into the store (once) and returns the recording it replays: the last run
 * in its run.json, whether it was imported now or was already there. (With a store that persists,
 * a pack's ancestors can be missing while the run itself is present.)
 *
 * A golden replays the recording and the command its own pack holds. The store may hold another
 * recording under the same run id: a copy pulled from a pull request's folder, a pack someone sent
 * that reused the id, the golden this one was copied from. When only its command differs, the
 * pack's command runs, as wherever only the pack exists; when its calls differ, the golden fails,
 * naming where the store's copy came from. A command from that copy never runs. A copy that only
 * carries more or fewer redaction rules than the pack is the pack's recording (see unpackRun).
 */
export function importGolden(store: Store, dir: string): RunRecord {
  const { imported, skipped, mismatched } = unpackRun(store, dir);
  const head = readPackHead(dir);
  const parentId = 'error' in head ? (imported.at(-1) ?? skipped.at(-1)) : head.runId;
  const parent = parentId ? store.getRun(parentId) : null;
  if (!parent) throw new Error('the pack contains no runs');
  const other = mismatched.find((m) => m.runId === parent.runId);
  if (other?.calls) {
    const id = parent.runId.slice(0, 10);
    throw new Error(
      `the store already holds another recording under this golden's run id ${id} (${heldFrom(parent)}), and its calls differ from the pack's. A golden replays only its own pack: delete the store's copy (shadowlap rm ${id}) to test this one, or, for a golden copied from another, pack a run of its own`,
    );
  }
  return other?.command ? { ...parent, command: other.command } : parent;
}

export async function testGolden(dir: string, golden: string, spec: TestSpec | null, ctx: RecordingTestContext): Promise<GoldenOutcome> {
  const started = Date.now();
  const base = { golden, dir, name: basename(resolve(dir)), spec };
  let parent: RunRecord | null = null;
  let normalizers: Normalizer[] = [...ctx.config.normalize];
  try {
    parent = importGolden(ctx.store, dir);
    // The store may hold the run as it was recorded, before the pack redacted it: importGolden made
    // sure it is the pack's recording, its redaction aside, and replays the pack's command. Replaying
    // the pack applies its redaction rules as normalizers, and so does replaying that copy, so a
    // golden passes or fails here as it does in CI, where only the pack exists.
    // That copy may also carry an earlier pack's rules, when the run was packed again with more.
    const head = readPackHead(dir);
    const packed = 'error' in head || JSON.stringify(parent.meta?.redactions ?? []) === JSON.stringify(head.redactions) ? [] : head.redactions;
    // A replay of a redacted run applies the rules it carries as well.
    normalizers = [...ctx.config.normalize, ...packed, ...(parent.meta?.redactions ?? [])];
    const result = await testRecording(parent, spec, packed.length ? { ...ctx, config: { ...ctx.config, normalize: [...ctx.config.normalize, ...packed] } } : ctx);
    return { ...base, parent, result, failure: result.failure, kind: result.kind, seconds: (Date.now() - started) / 1000, normalizers, interrupted: result.interrupted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, parent, result: null, failure: { message, details: message }, kind: 'error', seconds: (Date.now() - started) / 1000, normalizers, interrupted: err instanceof ReplayInterrupted };
  }
}

/**
 * Tokens of a run's model calls: input, cache reads and writes included, and with `output` the
 * output too; with `live`, only calls that reached a provider. Every call's input is what the run
 * costs to run live; the live calls' input and output are what a replay spent.
 */
export function tokensOf(calls: readonly CallRecord[], o: { live?: boolean; output?: boolean } = {}): number {
  return calls
    .filter((c) => c.kind === 'api' && (!o.live || c.origin === 'live'))
    .reduce((n, c) => {
      const u = c.end?.meta.usage;
      return n + (u ? u.inputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0) + (o.output ? u.outputTokens : 0) : 0);
    }, 0);
}

type Summary = TestAttempt['ended']['summary'];
/** Calls by origin, as the reports and the history show them: overridden calls count as replayed. */
const callsOf = (s: Summary) => ({ total: s.total, replayed: s.byOrigin.replayed + s.byOrigin.overridden, live: s.byOrigin.live, blocked: s.byOrigin.blocked, stubbed: s.byOrigin.stubbed });
const notRespentOf = (s: Summary) => s.tokensNotRespent.inputTokens + (s.tokensNotRespent.cacheReadInputTokens ?? 0);
const upstreamOf = (attempts: readonly TestAttempt[]) => attempts.reduce((n, a) => n + a.ended.summary.upstreamRequests, 0);

/** A changed value as the history keeps it: long strings and large objects cut to 2,000 characters. */
function clipValue(v: unknown): unknown {
  if (typeof v === 'string') return v.length > 2000 ? `${v.slice(0, 2000)}…` : v;
  if (v !== null && typeof v === 'object') {
    const json = JSON.stringify(v);
    return json.length > 2000 ? `${json.slice(0, 2000)}…` : v;
  }
  return v;
}

/** The last lines the agent printed, for a failure. */
export function outputTail(output: string, lines = 20): string | null {
  const t = output.trim();
  return t ? t.split('\n').slice(-lines).join('\n') : null;
}

/**
 * The change that made a request diverge: its first change the rules in force (`rules`: the
 * config's normalizers and the pack's redaction rules) don't mask. The report lists every change in
 * the request as sent, the masked ones too. Null for a divergence that is no changed request.
 */
export function divergenceCause(d: DivergenceReport, rules: readonly Normalizer[]): string | null {
  if (d.type !== 'request_changed') return null;
  return (d.diff ?? []).find((e) => !maskedChange(e, rules, d))?.path ?? null;
}

/** What the store keeps about a golden's result besides its verdict. */
export function resultData(store: Store, o: GoldenOutcome): TestResultData {
  const data: TestResultData = { mode: o.spec?.fork ? 'fork' : 'replay' };
  const r = o.result;
  if (!r) {
    if (o.failure) data.details = o.failure.details;
    return data;
  }
  const s = r.shown.ended.summary;
  data.calls = callsOf(s);
  data.upstreamRequests = upstreamOf(r.attempts);
  data.tokensNotRespent = notRespentOf(s);
  data.inputTokens = tokensOf(store.getCalls(s.runId));
  if (r.shown.checks) data.checks = r.shown.checks;
  if (r.attempts.length > 1) data.attempts = { total: r.attempts.length, passed: r.passed, required: r.required, runs: r.attempts.map((a) => a.ended.summary.runId) };
  if (s.divergence) {
    const d = s.divergence;
    data.divergence = {
      type: d.type,
      callNo: d.callNo,
      kind: d.kind,
      name: d.name,
      replayedBefore: d.replayedBefore,
      // The changed values themselves, cut short: the printed report has what a reader needs, and
      // whether they are values made anew on every run is judged here, on all of them.
      ...(d.diff ? { diff: d.diff.slice(0, 12).map((e) => ({ ...e, ...('before' in e ? { before: clipValue(e.before) } : {}), ...('after' in e ? { after: clipValue(e.after) } : {}) })), entries: d.diff.length } : {}),
      ...(d.hints ? { hints: d.hints } : {}),
      volatile: volatileValues(d, o.normalizers),
      cause: divergenceCause(d, o.normalizers),
      text: formatDivergence(d),
    };
  }
  if (o.failure) data.details = o.failure.details;
  // What the agent printed last, as the Markdown report shows it: the Tests screen shows it for a failure.
  const tail = o.failure ? outputTail(r.shown.output) : null;
  if (tail) data.output = tail.split('\n').map((l) => (l.length > 400 ? `${l.slice(0, 399)}…` : l)).join('\n').slice(-6000);
  return data;
}

/** The golden's entry in the JSON report (`--json`), which the GitHub Action reads. */
export function packResult(o: GoldenOutcome, extra: { expect: Record<string, unknown> | null; updated?: PackResult['updated']; injection?: PackResult['injection'] }): PackResult {
  const r = o.result;
  const s = r?.shown.ended.summary ?? null;
  return {
    name: o.name,
    dir: o.dir,
    golden: o.golden,
    mode: o.spec?.fork ? 'fork' : 'replay',
    ok: !o.failure,
    failure: o.kind,
    message: o.failure?.message ?? null,
    details: o.failure?.details ?? null,
    output: o.failure && r ? outputTail(r.shown.output) : null,
    seconds: o.seconds,
    runId: s?.runId ?? null,
    runs: r ? r.attempts.map((a) => ({ runId: a.ended.summary.runId, ok: !a.failure })) : [],
    goldenRunId: o.parent?.runId ?? null,
    calls: s ? callsOf(s) : null,
    upstreamRequests: r ? upstreamOf(r.attempts) : null,
    tokensNotRespent: s ? notRespentOf(s) : null,
    divergence: s?.divergence ? { type: s.divergence.type, callNo: s.divergence.callNo, kind: s.divergence.kind, name: s.divergence.name, ...(s.divergence.recorded !== undefined ? { recorded: s.divergence.recorded } : {}) } : null,
    checks: r?.shown.checks ?? null,
    attempts: r && r.attempts.length > 1 ? { total: r.attempts.length, passed: r.passed, required: r.required } : null,
    expect: extra.expect,
    updated: extra.updated ?? null,
    injection: extra.injection ?? null,
  };
}

/** The checks, one per line, as the terminal and the JUnit report show them. */
export function formatChecks(checks: CheckResult[]): string {
  return checks.map((c) => (c.ok ? `✓ ${c.label}` : `✗ ${c.label}: ${c.detail}`)).join('\n');
}

/** The golden as a JUnit test case. */
export function junitCase(o: GoldenOutcome): JunitCase {
  const checks = o.result?.shown.checks;
  const failure = o.failure && checks?.length ? { ...o.failure, details: `${formatChecks(checks)}\n\n${o.failure.details}` } : o.failure;
  const output = o.result?.shown.output ?? '';
  return { name: o.name, classname: 'shadowlap.replay', timeSeconds: o.seconds, ...(failure ? { failure } : {}), ...(output ? { systemOut: output } : {}) };
}

/** A session that never ended this long before another started had its process killed: it is over. */
const STALE_SESSION_MS = 24 * 60 * 60 * 1000;

/**
 * Replays of earlier sessions that passed are not kept once a newer one exists: the test history
 * keeps how each did, and the store doesn't fill with clean replays. Nor are replays a signal cut
 * short (crashed), which say nothing either way. Kept: every failing replay (a fix starts from one),
 * the newest passing one when this session's replay of that golden failed (to compare against),
 * anything with labels, notes or runs made from it, and anything from a session still running or
 * that ended after this one started. A session that never ended and started over a day before this
 * one counts as ended: its process was killed. Returns how many runs it deleted.
 *
 * Only the runs go. Blobs are shared by content, and another process may be recording into the same
 * store right now, writing each blob a moment before the call that references it: collecting
 * unreferenced blobs here could take those. What a live replay alone held waits for `shadowlap gc`.
 */
export function pruneReplays(store: Store, session: { sessionId: string; startedAt: number }, tested: ReadonlyMap<string, { ok: boolean; fork: boolean }>): number {
  const byGolden = new Map<string, RunRecord[]>();
  for (const run of store.testReplays([...tested.keys()])) {
    const t = run.meta?.test;
    if (!t || t.session === session.sessionId || !tested.has(t.golden)) continue;
    const list = byGolden.get(t.golden);
    if (list) list.push(run);
    else byGolden.set(t.golden, [run]);
  }
  const ended = new Map<string, number | null>();
  const endedAt = (id: string) => {
    if (!ended.has(id)) {
      const s = store.getTestSession(id);
      ended.set(id, s ? (s.endedAt ?? (s.startedAt < session.startedAt - STALE_SESSION_MS ? s.startedAt : null)) : null);
    }
    return ended.get(id)!;
  };
  let deleted = 0;
  for (const [golden, runs] of byGolden) {
    const now = tested.get(golden)!;
    const passing = runs.filter((r) => r.status === 'completed' && !r.meta?.checks?.some((c) => !c.ok) && (!r.divergence || now.fork));
    // Cut short by a signal, or left running by a session whose process was killed (which only counts once it is stale).
    const cut = runs.filter((r) => r.status === 'crashed' || r.status === 'running');
    for (const run of [...passing.slice(now.ok ? 0 : 1), ...cut]) {
      const at = endedAt(run.meta!.test!.session);
      if (at === null || at > session.startedAt) continue;
      if (run.meta?.labels?.length || run.meta?.notes?.length || store.childRuns(run.runId).length) continue;
      store.deleteRun(run.runId);
      deleted++;
    }
  }
  return deleted;
}

/**
 * `pruneReplays` for a test session, which it never fails: the store may be busy with another
 * process, and the replays can wait for the next session. Returns why nothing was pruned, or null.
 */
export function pruneQuietly(store: Store, session: { sessionId: string; startedAt: number }, tested: ReadonlyMap<string, { ok: boolean; fork: boolean }>): string | null {
  try {
    pruneReplays(store, session, tested);
    return null;
  } catch (err) {
    return `older replays were not pruned this time: ${err instanceof Error ? err.message : String(err)}`;
  }
}
