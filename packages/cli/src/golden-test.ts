import { basename, resolve } from 'node:path';
import { decide, formatDivergence, formatTally, gateHistory, gateResult, hasRecordedCommand, heldFrom, maskedChange, unpackRun, volatileValues, type CallRecord, type DivergenceReport, type Gate, type GateDecision, type GateHistory, type GateResult, type Normalizer, type RunMeta, type RunRecord, type Store, type TestFailure, type TestResultData, type WritePolicy } from '@shadowlap/engine';
import { type CheckResult, type TestSpec } from './checks.js';
import { oracleLabels } from './attempts.js';
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
  /** A golden whose gate compares with its history: the attempts of its last sessions, pooled (testGolden reads them). */
  history?: GateHistory | null;
  /** Raises the gate's limit for this session only: an SPRT gate's max, or the attempts a history gate decides after. */
  maxAttempts?: number | null;
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
  /** The attempt the result shows: the last that passed when it passed, else the first that failed (or couldn't be judged). */
  shown: TestAttempt;
  passed: number;
  /** Attempts that had to pass, out of `repeat`; null when a gate decided. */
  required: number | null;
  /** Why it failed or is inconclusive, or undefined when it passed. */
  failure: JunitCase['failure'];
  kind: TestFailure | null;
  /** How it came out. Inconclusive: its gate ran out of attempts between its bounds, or a check couldn't be judged. */
  verdict: 'passed' | 'failed' | 'inconclusive';
  /** A golden with a gate: what the gate decided, and why. */
  gate: GateResult | null;
  /** Attempts a check couldn't judge: no evidence either way. */
  inconclusive: number;
  /** A signal cut an attempt short, or kept the rest from starting: the outcome says nothing about the recording. */
  interrupted: boolean;
}

/**
 * How one attempt came out. Inconclusive when every check it failed is one that couldn't be judged
 * (a judge with no recorded verdict and no way to ask live reads `inconclusive`): that says nothing
 * about the agent, and no other attempt in this environment would say more.
 */
export function attemptVerdict(a: Pick<TestAttempt, 'failure' | 'kind' | 'checks'>): 'passed' | 'failed' | 'inconclusive' {
  if (!a.failure) return 'passed';
  if (a.kind !== 'check') return 'failed';
  const notOk = (a.checks ?? []).filter((c) => !c.ok);
  return notOk.length > 0 && notOk.every((c) => (c as { status?: string }).status === 'inconclusive') ? 'inconclusive' : 'failed';
}

/** A replay that forked nowhere and ran nothing live: every attempt would come out the same, so one settles it. */
const replayedClean = (a: TestAttempt) => !a.ended.summary.divergence && a.ended.summary.byOrigin.live === 0;

/** The gate with this session's limit, when one was given (`test --max-attempts`). */
function withLimit(gate: Gate, limit: number | null | undefined): Gate {
  if (!limit) return gate;
  return gate.kind === 'sprt' ? { ...gate, max: Math.max(gate.max, limit) } : { ...gate, min: Math.max(gate.min, limit) };
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
  // A gate decides as attempts come in, up to its limit; without one, `repeat` attempts run.
  const gate = spec?.gate ? withLimit(spec.gate, ctx.maxAttempts) : null;
  const repeat = gate ? (gate.kind === 'sprt' ? gate.max : gate.min) : (spec?.repeat ?? 1);
  // A golden replayed more than once in a session is one test run with its attempts (`meta.test`
  // `attempt` and `of`): while they run, each attempt after the first is filed under the first, and
  // once they have all ended, under the attempt the result shows, so the Runs page, the sidebar and
  // the Tests screen all open the run that says how the golden came out.
  const testMeta = (i: number, of: string | null): Partial<RunMeta> | null => (ctx.test ? { test: { ...ctx.test, ...(repeat > 1 ? { attempt: i + 1 } : {}), ...(of ? { of } : {}) } } : null);
  let decision: GateDecision = 'continue';
  let clean = false;
  let unjudged = 0;
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
    // A check that couldn't be judged here won't be on the next attempt either.
    if (attemptVerdict(attempt) === 'inconclusive') {
      unjudged++;
      break;
    }
    if (!gate) continue;
    // A clean replay comes out the same every time: its one attempt settles the gate.
    if (i === 0 && replayedClean(attempt)) {
      clean = true;
      decision = attempt.failure ? 'fail' : 'pass';
      break;
    }
    decision = decide(attempts.filter((a) => !a.failure).length, attempts.length, gate, ctx.history ?? null);
    if (decision !== 'continue') break;
  }
  if (!attempts.length) throw new ReplayInterrupted();
  const interrupted = attempts.some((a) => a.interrupted !== null) || (gate ? decision === 'continue' && !unjudged : attempts.length < repeat && !unjudged);
  const passed = attempts.filter((a) => !a.failure).length;
  const required = gate ? null : (spec?.passes ?? 1);
  const judged = attempts.filter((a) => attemptVerdict(a) !== 'inconclusive');
  const result = gate ? gateResult(gate, judged.map((a) => !a.failure), { history: ctx.history ?? null, clean, decision: unjudged ? 'continue' : decision }) : null;
  const verdict: RecordingOutcome['verdict'] = unjudged ? 'inconclusive' : gate ? (decision === 'pass' ? 'passed' : decision === 'fail' ? 'failed' : 'inconclusive') : passed >= required! ? 'passed' : 'failed';
  const unjudgedAttempt = attempts.find((a) => attemptVerdict(a) === 'inconclusive');
  const shown = verdict === 'passed' ? attempts.filter((a) => !a.failure).at(-1)! : (unjudgedAttempt ?? attempts.find((a) => a.failure) ?? attempts.at(-1)!);
  if (attempts.length > 1 && !interrupted) fileUnder(ctx.store, attempts, shown, testMeta);
  let failure: JunitCase['failure'];
  const each = () => attempts.map((a, i) => `attempt ${i + 1}  ${a.failure ? `${attemptVerdict(a) === 'inconclusive' ? '?' : '✗'} ${a.failure.message}` : '✓ passed'}`).join('\n');
  if (unjudgedAttempt) {
    const f = unjudgedAttempt.failure!;
    failure = { message: `inconclusive: ${f.message.replace(/^check failed: /, 'a check could not be judged: ')}`, details: attempts.length === 1 ? f.details : `${each()}\n\n${f.details}` };
  } else if (result && verdict !== 'passed') {
    const f = shown.failure;
    const tally = formatTally(result);
    failure = {
      message: `${result.sentence}${f && verdict === 'failed' ? `. Attempt ${attempts.indexOf(shown) + 1}: ${f.message}` : ''}`,
      details: `${tally}\n${each()}${f ? `\n\n${f.details}` : ''}`,
    };
  } else if (!gate && verdict === 'failed') {
    const f = shown.failure!;
    failure =
      attempts.length === 1
        ? f
        : {
            message: `${passed} of ${attempts.length} attempts passed, ${required} needed. Attempt ${attempts.indexOf(shown) + 1}: ${f.message}`,
            details: `${each()}\n\n${f.details}`,
          };
  }
  const kind: TestFailure | null = verdict === 'passed' ? null : verdict === 'inconclusive' ? 'inconclusive' : (shown.kind ?? 'error');
  return { spec, attempts, shown, passed, required, failure, kind, verdict, gate: result, inconclusive: unjudged, interrupted };
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
    // A gate against history compares with this golden's last sessions: under the same recording
    // and checks, this session's own result left out.
    const gate = spec?.gate;
    const history = gate?.kind === 'baseline' ? gateHistory(ctx.store, golden, { window: gate.window, goldenRunId: parent.runId, checks: oracleLabels(spec).slice(1), mode: 'fork', excludeSession: ctx.test?.session ?? null }) : null;
    const tested: RecordingTestContext = { ...ctx, ...(packed.length ? { config: { ...ctx.config, normalize: [...ctx.config.normalize, ...packed] } } : {}), ...(history ? { history } : {}) };
    const result = await testRecording(parent, spec, tested);
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
/** USD the attempts spent on live calls. */
const spentOf = (attempts: readonly TestAttempt[]) => attempts.reduce((n, a) => n + a.ended.summary.cost.spent, 0);

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
  // Every result keeps its attempts, one included: a gate against history pools them.
  data.attempts = { total: r.attempts.length, passed: r.passed, required: r.required, runs: r.attempts.map((a) => a.ended.summary.runId), ...(r.inconclusive ? { inconclusive: r.inconclusive } : {}) };
  data.verdict = r.verdict;
  if (r.gate) data.gate = r.gate;
  data.spent = spentOf(r.attempts);
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

/** What CI does with an inconclusive verdict, a gate's or a check's: fail the run (the default), or warn and let it through. */
export type InconclusiveMode = 'fail' | 'warn';

/** How a golden came out: one that couldn't be replayed at all failed. */
export const verdictOf = (o: Pick<GoldenOutcome, 'result' | 'failure'>): RecordingOutcome['verdict'] => o.result?.verdict ?? (o.failure ? 'failed' : 'passed');

/** Whether CI lets a golden through: it passed, or it is inconclusive and inconclusive verdicts warn. */
export const letThrough = (o: Pick<GoldenOutcome, 'result' | 'failure'>, mode: InconclusiveMode): boolean => {
  const v = verdictOf(o);
  return v === 'passed' || (v === 'inconclusive' && mode === 'warn');
};

/** The golden's entry in the JSON report (`--json`), which the GitHub Action reads. */
export function packResult(o: GoldenOutcome, extra: { expect: Record<string, unknown> | null; updated?: PackResult['updated']; inconclusive?: InconclusiveMode }): PackResult {
  const r = o.result;
  const s = r?.shown.ended.summary ?? null;
  return {
    name: o.name,
    dir: o.dir,
    golden: o.golden,
    mode: o.spec?.fork ? 'fork' : 'replay',
    ok: letThrough(o, extra.inconclusive ?? 'fail'),
    verdict: verdictOf(o),
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
    attempts: r && (r.attempts.length > 1 || r.gate) ? { total: r.attempts.length, passed: r.passed, required: r.required } : null,
    gate: r?.gate ?? null,
    expect: extra.expect,
    updated: extra.updated ?? null,
  };
}

/** The checks, one per line, as the terminal and the JUnit report show them. */
export function formatChecks(checks: CheckResult[]): string {
  return checks.map((c) => (c.ok ? `✓ ${c.label}` : `✗ ${c.label}: ${c.detail}`)).join('\n');
}

/**
 * The golden as a JUnit test case. An inconclusive one is a failure, or, when inconclusive verdicts
 * warn, skipped: neither passed nor failed. A gated golden's output starts with its gate's sentence
 * and tally, which CI dashboards show beside the case.
 */
export function junitCase(o: GoldenOutcome, mode: InconclusiveMode = 'fail'): JunitCase {
  const checks = o.result?.shown.checks;
  const failure = o.failure && checks?.length ? { ...o.failure, details: `${formatChecks(checks)}\n\n${o.failure.details}` } : o.failure;
  const gate = o.result?.gate;
  const output = `${gate ? `[shadowlap] ${gate.sentence}\n[shadowlap] ${formatTally(gate)}\n` : ''}${o.result?.shown.output ?? ''}`;
  const skipped = verdictOf(o) === 'inconclusive' && mode === 'warn' && failure ? { message: failure.message } : null;
  return { name: o.name, classname: 'shadowlap.replay', timeSeconds: o.seconds, ...(skipped ? { skipped } : failure ? { failure } : {}), ...(output ? { systemOut: output } : {}) };
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
