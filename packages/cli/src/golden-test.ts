import { basename, resolve } from 'node:path';
import { UNAVAILABLE_RETRY, agentCallsOf, decide, decideCount, formatDivergence, formatPassK, formatTally, gateHistory, gateOf, gateResult, hasRecordedCommand, heldFrom, judgedUnder, maskedChange, providerUnavailable, retryDelay, unavailableReason, unpackRun, volatileValues, wholeInput, type CallRecord, type DivergenceReport, type Gate, type GateDecision, type GateHistory, type GateResult, type JudgeSummary, type Normalizer, type RunMeta, type RunRecord, type Store, type TestFailure, type TestResult, type TestResultData, type Unavailable, type WritePolicy } from '@shadowlap/engine';
import { checkLine, type CheckResult, type TestSpec } from './checks.js';
import { oracleLabels } from './attempts.js';
import { upstreamOverrides, type ShadowlapConfig } from './config.js';
import { readPackHead } from './goldens.js';
import { type JunitCase } from './junit.js';
import { placeholdersFor } from './placeholder-keys.js';
import { providerIds, testAttempt, type GuardMode, type TestAttempt } from './run-agent.js';
import { withoutCommand } from './shared.js';
import { type PackResult } from './test-report.js';
import { NO_BASELINE_BRANCH } from './baseline-branch.js';

/**
 * One golden under `shadowlap test` (and each commit of `shadowlap bisect`): its recording replayed
 * as many times as its config asks, offline unless it may fork, and judged the way a test is. What
 * came out is kept as the golden's result in the store's test history and in the reports.
 */

export interface RecordingTestContext {
  store: Store;
  /** `redact`: the rules applied to what a judge check reads. */
  config: Pick<ShadowlapConfig, 'normalize' | 'prices' | 'clock' | 'http'> & { redact?: ShadowlapConfig['redact'] };
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
  /**
   * Where the session runs (baseline-branch.ts): the branch it tests, and the branch a gate against
   * history takes its baseline from (null: none known, so no session is a baseline). Undefined: each
   * result's own, as the session that kept it saw it.
   */
  branch?: string | null;
  baselineBranch?: string | null;
  /** Raises the gate's limit for this session only: its `max`, the most attempts it runs. */
  maxAttempts?: number | null;
  /**
   * `test --continue`: carry an inconclusive gate's attempts over from the golden's last result
   * instead of starting over (testGolden finds them; `carry` is what testRecording counts first).
   */
  continue?: boolean;
  carry?: Carry | null;
  /** Called before the pause that follows an attempt the provider was unavailable for, with how long it is. */
  onUnavailable?: (u: Unavailable, waitMs: number) => void;
  /** How unavailable attempts are retried (UNAVAILABLE_RETRY), and the pause itself: tests pass their own. */
  unavailable?: { inARow: number; firstDelayMs: number; maxDelayMs: number };
  sleep?: (ms: number) => Promise<void>;
}

/** An inconclusive gate's attempts, carried over to a session that continues it. */
export interface Carry {
  /** The sessions they were run in, oldest first. */
  sessions: string[];
  /** Each attempt in order: true for one that passed. */
  outcomes: boolean[];
}

/** A signal stopped the replays of a recording before the first one could start. */
export class ReplayInterrupted extends Error {
  constructor() {
    super('interrupted before its replay started');
    this.name = 'ReplayInterrupted';
  }
}

/**
 * An attempt as a golden keeps it: its replay and, when the agent failed while its provider was
 * unavailable (unavailable.ts), why. Such an attempt is a run like any other, retried after a pause
 * and never counted: the agent's tally, a gate's and a fixed count's, leaves it out.
 */
export type GoldenAttempt = TestAttempt & { unavailable?: Unavailable };

export interface RecordingOutcome {
  spec: TestSpec | null;
  /** Every attempt run, unavailable ones included, in order. */
  attempts: GoldenAttempt[];
  /**
   * The attempt the result shows: the last that passed when it passed; for an inconclusive one the
   * attempt a check could not decide, or the last the provider was unavailable for, when one stopped
   * it; else the first that failed.
   */
  shown: GoldenAttempt;
  passed: number;
  /** Attempts that had to pass, out of `repeat`; null when a gate decided. */
  required: number | null;
  /** Why it failed or is inconclusive, or undefined when it passed. */
  failure: JunitCase['failure'];
  kind: TestFailure | null;
  /**
   * How it came out. Inconclusive: its gate ran out of attempts between its bounds, or what kept it
   * from passing is a check that could not be decided (a judge with no verdict and no way to ask the
   * judge, a condition it can't read), which fails the run all the same unless inconclusive verdicts
   * warn. Test stops at an attempt a check could not decide, as no attempt after it would decide it
   * either: a fixed count the attempts before it already settled keeps their verdict, passed or failed.
   */
  verdict: 'passed' | 'failed' | 'inconclusive';
  /**
   * A golden with a gate: what the gate decided, and why. Null without one, and for one an attempt a
   * check could not decide stopped before its gate decided: the gate said nothing, and `failure` says why.
   */
  gate: GateResult | null;
  /** Attempts a check couldn't judge: no evidence either way. */
  inconclusive: number;
  /** Attempts the provider was unavailable for: retried, never counted. */
  unavailable: number;
  /** A signal cut an attempt short, or kept the rest from starting: the outcome says nothing about the recording. */
  interrupted: boolean;
  /** Attempts carried over from the sessions it continued (`test --continue`), counted by `gate` before this session's. */
  carried: { sessions: string[]; attempts: number } | null;
}

/**
 * How one attempt came out. Inconclusive when every check it failed is one that couldn't be judged
 * (a judge with no recorded verdict and no way to ask live reads `inconclusive`): that says nothing
 * about the agent, and no other attempt in this environment would say more. Unavailable when the
 * agent failed while its provider was (unavailable.ts): that says nothing about it either, but a
 * later attempt may, so it is retried.
 */
export function attemptVerdict(a: Pick<TestAttempt, 'failure' | 'kind' | 'checks'> & { unavailable?: Unavailable | undefined }): 'passed' | 'failed' | 'inconclusive' | 'unavailable' {
  if (a.unavailable) return 'unavailable';
  if (!a.failure) return 'passed';
  if (a.kind !== 'check') return 'failed';
  const notOk = (a.checks ?? []).filter((c) => !c.ok);
  return notOk.length > 0 && notOk.every((c) => c.status === 'inconclusive') ? 'inconclusive' : 'failed';
}

/** A replay that forked nowhere and ran nothing live: every attempt would come out the same, so one settles it. */
const replayedClean = (a: TestAttempt) => !a.ended.summary.divergence && a.ended.summary.byOrigin.live === 0;

/** The gate with this session's limit, when one was given (`test --max-attempts`): never below its own `max`. */
export function withLimit(gate: Gate, limit: number | null | undefined): Gate {
  if (!limit || limit <= gate.max) return gate;
  return { ...gate, max: limit };
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
  // Offline, its agent gets a placeholder for each key the environment lacks: nothing it sends goes live.
  const extraEnv = live ? {} : placeholdersFor(ctx.store, parent, 'offline');
  const attempts: GoldenAttempt[] = [];
  // A gate decides as attempts come in, up to its limit; without one, `repeat` attempts run.
  const gate = spec?.gate ? withLimit(spec.gate, ctx.maxAttempts) : null;
  // Attempts carried over from the inconclusive sessions this one continues count first.
  let carry = gate && ctx.carry && ctx.carry.outcomes.length < gate.max ? ctx.carry : null;
  const before = carry?.outcomes.length ?? 0;
  const repeat = gate ? gate.max - before : (spec?.repeat ?? 1);
  // A golden replayed more than once in a session is one test run with its attempts (`meta.test`
  // `attempt` and `of`): while they run, each attempt after the first is filed under the first, and
  // once they have all ended, under the attempt the result shows, so the Runs page, the sidebar and
  // the Tests screen all open the run that says how the golden came out.
  const testMeta = (i: number, of: string | null): Partial<RunMeta> | null => (ctx.test ? { test: { ...ctx.test, ...(repeat + before > 1 ? { attempt: before + i + 1 } : {}), ...(of ? { of } : {}) } } : null);
  const retry = ctx.unavailable ?? UNAVAILABLE_RETRY;
  const sleep = ctx.sleep ?? ((ms: number) => pause(ms, ctx.stopped));
  let decision: GateDecision = 'continue';
  let clean = false;
  let unjudged = 0;
  // Attempts the provider was unavailable for, in all and in a row; and whether too many in a row stopped it.
  let unavailable = 0;
  let inARow = 0;
  let gaveUp: Unavailable | null = null;
  // Attempts that count: every one but those the provider was unavailable for.
  let counted = 0;
  while (counted < repeat) {
    if (ctx.stopped?.()) break;
    const i = attempts.length;
    const meta = testMeta(i, i > 0 ? (attempts[0]?.ended.summary.runId ?? null) : null);
    const attempt: GoldenAttempt = await testAttempt(ctx.store, parent, {
      cwd: ctx.cwd,
      upstreams,
      extraEnv,
      writes: ctx.writes,
      guard: ctx.guard,
      normalizers: ctx.config.normalize,
      prices: ctx.config.prices,
      clock: ctx.config.clock,
      http: ctx.config.http,
      ...(ctx.config.redact ? { redact: ctx.config.redact } : {}),
      spec,
      ...(ctx.argv ? { argv: ctx.argv } : {}),
      ...(meta ? { meta } : {}),
      ...(ctx.onRun ? { onRun: (runId: string) => ctx.onRun!(runId, before + i + 1, before + repeat + unavailable) } : {}),
      ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}),
      ...(ctx.stopped ? { onSignal: 'return' as const } : {}),
    });
    attempts.push(attempt);
    if (attempt.interrupted) break;
    // The agent failed while its provider was unavailable: no evidence about the agent. Retried
    // after a pause, never counted; too many in a row, and the golden is inconclusive.
    const down = unavailableIn(ctx.store, attempt);
    if (down) {
      attempt.unavailable = down;
      unavailable++;
      inARow++;
      if (inARow >= retry.inARow) {
        gaveUp = down;
        break;
      }
      const wait = retryDelay(inARow, down.retryAfterMs, Math.random, retry);
      ctx.onUnavailable?.(down, wait);
      await sleep(wait);
      continue;
    }
    inARow = 0;
    counted++;
    // A check that couldn't be judged here won't be on the next attempt either.
    if (attemptVerdict(attempt) === 'inconclusive') {
      unjudged++;
      break;
    }
    if (!gate) continue;
    // A clean replay comes out the same every time: its one attempt settles the gate, whatever
    // attempts that forked were carried over (the agent no longer forks).
    if (i === 0 && replayedClean(attempt)) {
      clean = true;
      carry = null;
      decision = attempt.failure ? 'fail' : 'pass';
      break;
    }
    const carriedPasses = carry ? carry.outcomes.filter(Boolean).length : 0;
    const mine = attempts.filter((a) => !a.unavailable);
    decision = decide(carriedPasses + mine.filter((a) => !a.failure).length, (carry?.outcomes.length ?? 0) + mine.length, gate, ctx.history ?? null);
    if (decision !== 'continue') break;
  }
  if (!attempts.length) throw new ReplayInterrupted();
  // The attempts that count: what the agent did with its provider there.
  const mine = attempts.filter((a) => !a.unavailable);
  const interrupted = attempts.some((a) => a.interrupted !== null) || (!gaveUp && (gate ? decision === 'continue' && !unjudged : mine.length < repeat && !unjudged));
  const passed = mine.filter((a) => !a.failure).length;
  const required = gate ? null : (spec?.passes ?? 1);
  const judged = mine.filter((a) => attemptVerdict(a) !== 'inconclusive');
  const carried = carry ? carry.outcomes : [];
  // An attempt a check could not decide stopped the golden. A gate stops as soon as it decides, so
  // that attempt came while it was still open: the golden is inconclusive, and its gate decided
  // nothing. A fixed count runs its attempts whatever they settle, so the ones judged before that
  // attempt may have settled it already (enough passed, or too many failed for the attempts left to
  // make up): their verdict stands, as an attempt that says nothing either way changes no settled count.
  const undecided = unjudged > 0 && (gate !== null || decideCount(passed, judged.length, repeat, required!) === 'continue');
  // The provider unavailable too many attempts in a row stops it the same way: a gate still open, or
  // a count not yet settled, is inconclusive, never failed.
  const unavailableStop = gaveUp !== null && (gate !== null ? decision === 'continue' : decideCount(passed, judged.length, repeat, required!) === 'continue');
  const result = gate && !undecided ? gateResult(gate, [...carried, ...judged.map((a) => !a.failure)], { history: ctx.history ?? null, clean, decision, carried: carried.length, unavailable }) : null;
  const verdict: RecordingOutcome['verdict'] = undecided || unavailableStop ? 'inconclusive' : gate ? (decision === 'pass' ? 'passed' : decision === 'fail' ? 'failed' : 'inconclusive') : passed >= required! ? 'passed' : 'failed';
  const unjudgedAttempt = undecided ? mine.find((a) => attemptVerdict(a) === 'inconclusive') : undefined;
  const unavailableAttempt = unavailableStop ? attempts.at(-1) : undefined;
  const shown = verdict === 'passed' ? mine.filter((a) => !a.failure).at(-1)! : (unjudgedAttempt ?? unavailableAttempt ?? mine.find((a) => attemptVerdict(a) === 'failed') ?? mine.find((a) => a.failure) ?? attempts.at(-1)!);
  if (attempts.length > 1 && !interrupted) fileUnder(ctx.store, attempts, shown, testMeta);
  let failure: JunitCase['failure'];
  const mark = (a: GoldenAttempt) => (a.unavailable ? `⏸ the provider was unavailable (${a.unavailable.reason}), not counted: ${a.failure!.message}` : a.failure ? `${attemptVerdict(a) === 'inconclusive' ? '?' : '✗'} ${a.failure.message}` : '✓ passed');
  const each = () =>
    [
      ...(carried.length ? [`attempts 1 to ${carried.length}  carried over: ${carried.filter(Boolean).length} passed`] : []),
      ...attempts.map((a, i) => `attempt ${carried.length + i + 1}  ${mark(a)}`),
    ].join('\n');
  if (unjudgedAttempt) {
    const f = unjudgedAttempt.failure!;
    // The attempt's own line already says a check was inconclusive, and which.
    const message = /^check inconclusive: /.test(f.message) ? f.message : `inconclusive: ${f.message.replace(/^check failed: /, 'a check could not be judged: ')}`;
    // The attempts of a repeat an undecided check kept from running.
    const left = gate ? 0 : repeat - mine.length;
    const notRun = left > 0 ? `; ${left} more attempt${left === 1 ? '' : 's'} not run: ${left === 1 ? 'it' : 'they'} would be undecided too` : '';
    failure = { message: `${message}${notRun}`, details: attempts.length === 1 ? f.details : `${each()}\n\n${f.details}` };
  } else if (unavailableAttempt && gaveUp) {
    // Inconclusive with the provider named: nothing here is a verdict on the agent.
    failure = { message: unavailableReason(inARow, gaveUp), details: `${result ? `${formatTally(result)}\n` : ''}${each()}\n\n${unavailableAttempt.failure!.details}` };
  } else if (result && verdict !== 'passed') {
    const f = shown.failure;
    const tally = formatTally(result);
    failure = {
      message: `${result.sentence}${f && verdict === 'failed' ? `. Attempt ${carried.length + attempts.indexOf(shown) + 1}: ${f.message}` : ''}`,
      details: `${tally}\n${each()}${f ? `\n\n${f.details}` : ''}`,
    };
  } else if (!gate && verdict === 'failed') {
    const f = shown.failure!;
    // An attempt a check could not decide after the count was lost is counted apart, never as failed.
    failure =
      attempts.length === 1
        ? f
        : {
            message: `${passed} of ${mine.length} attempts passed${unjudged ? `, ${unjudged} inconclusive` : ''}${unavailable ? `, ${unavailable} not counted: the provider was unavailable` : ''}, ${required} needed. Attempt ${attempts.indexOf(shown) + 1}: ${f.message}`,
            details: `${each()}\n\n${f.details}`,
          };
  }
  const kind: TestFailure | null = verdict === 'passed' ? null : verdict === 'inconclusive' ? 'inconclusive' : (shown.kind ?? 'error');
  return { spec, attempts, shown, passed, required, failure, kind, verdict, gate: result, inconclusive: unjudged, unavailable, interrupted, carried: carry ? { sessions: carry.sessions, attempts: carry.outcomes.length } : null };
}

/**
 * Why an attempt says nothing about the agent because its provider was unavailable, or null: it
 * failed, by no time limit of the test's (the agent's own clock) and with no divergence a replay must
 * not have, while one of its live model calls ended on an error the provider sends when it can't
 * answer (unavailable.ts).
 */
export function unavailableIn(store: Store, a: TestAttempt): Unavailable | null {
  // A replay no preload loaded in (the guard's failure) failed by itself, whatever its provider answered.
  if (!a.failure || a.interrupted || a.kind === 'diverged' || a.kind === 'guard') return null;
  // Stopped at the test's time limit: the run ended as crashed with no signal behind it.
  if (a.ended.summary.status === 'crashed') return null;
  return providerUnavailable(store.getCalls(a.ended.summary.runId));
}

/** Waits `ms`, or less once `stopped` says a signal came: a pause before a retry never holds up Ctrl-C. */
async function pause(ms: number, stopped?: () => boolean): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && !stopped?.()) await new Promise<void>((r) => setTimeout(r, Math.min(250, until - Date.now())));
}

/** A stored gate result's attempts in order: kept since results kept them, or read off an SPRT's scores before. */
function outcomesOf(g: GateResult): boolean[] | null {
  if (Array.isArray(g.outcomes)) return g.outcomes;
  const e = g.evidence;
  if (e?.kind !== 'sprt' || !Array.isArray(e.scores)) return null;
  return e.scores.map((score, i) => score > (i ? e.scores[i - 1]! : 0));
}

/** Two gates with the same figures, whatever limit each ran under. */
const sameGate = (a: Gate, b: Gate) => JSON.stringify({ ...gateOf(a), max: 0 }) === JSON.stringify({ ...gateOf(b), max: 0 });

/**
 * What `test --continue` carries over for a golden: the attempts of its last result, when that
 * result is an inconclusive gate's on the same recording, under the same checks and the same gate,
 * so the attempts this session adds continue the very test it ran out of room for (an SPRT or a
 * history gate continued to a higher limit decides exactly as one that had that limit from the
 * start). A settled verdict is never continued: asking again after it stopped would be peeking.
 */
export function carryFor(store: Store, golden: string, o: { goldenRunId: string; checks: readonly string[]; gate: Gate; limit: number; session?: string | null; branch?: string | null }): { carry: Carry } | { why: string } {
  const last: TestResult | undefined = store.listTestResults({ golden, limit: 2 }).find((r) => r.sessionId !== o.session);
  if (!last) return { why: 'it has no result to continue yet' };
  // Another branch's agent is another agent: its attempts are no part of this one's tally.
  const was = last.data?.branch;
  if (o.branch && was && was !== o.branch) return { why: `its last result ran on ${was}, not ${o.branch}` };
  const g = last.data?.gate;
  // An attempt a check could not decide stopped it before its gate decided anything: there is no gate to continue.
  if (!g) return { why: last.data?.attempts?.inconclusive ? 'a check could not be decided in its last result, which stopped it before its gate decided' : 'its last result had no gate' };
  if (g.decision !== 'inconclusive') return { why: `its last result ${g.decision === 'pass' ? 'passed' : g.decision === 'fail' ? 'failed' : 'did not finish'}, so there is nothing to continue` };
  if (last.goldenRunId !== o.goldenRunId) return { why: 'it was re-recorded since its last result' };
  if (!judgedUnder(last, o.checks)) return { why: 'its checks changed since its last result' };
  if (!sameGate(g, o.gate)) return { why: 'its gate changed since its last result' };
  const outcomes = outcomesOf(g);
  if (!outcomes || !outcomes.length) return { why: 'its last result kept no attempts to continue' };
  if (outcomes.length >= o.limit) return { why: `its last result already ran the ${o.limit} attempts its gate allows: raise the limit with --max-attempts` };
  return { carry: { sessions: [...(last.data?.continued?.sessions ?? []), last.sessionId], outcomes } };
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
  /** What to know about how its gate decided: that it had no history yet, what `--continue` carried over or why it couldn't. */
  notes: string[];
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
  const notes: string[] = [];
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
    const gate = spec?.gate ? withLimit(spec.gate, ctx.maxAttempts) : null;
    const checks = oracleLabels(spec).slice(1);
    // --continue: an inconclusive gate's attempts carry over, when nothing it was judged by changed.
    let carry: Carry | null = null;
    if (ctx.continue && gate) {
      const found = carryFor(ctx.store, golden, { goldenRunId: parent.runId, checks, gate, limit: gate.max, session: ctx.test?.session ?? null, ...(ctx.branch !== undefined ? { branch: ctx.branch } : {}) });
      if ('carry' in found) {
        carry = found.carry;
        notes.push(`continues its last result: ${found.carry.outcomes.length} attempts carried over, ${found.carry.outcomes.filter(Boolean).length} passed, up to ${gate.max}`);
      } else notes.push(`nothing to continue (${found.why}): it ran afresh`);
    }
    // A gate against history compares with this golden's last sessions: under the same recording
    // and checks, this session's own result left out, and those whose attempts carry over.
    // Only sessions that passed on the baseline branch, for no pull request, are a baseline (gate-history.ts).
    const history = gate?.kind === 'baseline' ? gateHistory(ctx.store, golden, { window: gate.window, goldenRunId: parent.runId, checks, mode: 'fork', excludeSession: [...(ctx.test?.session ? [ctx.test.session] : []), ...(carry?.sessions ?? [])], ...(ctx.baselineBranch !== undefined ? { branch: ctx.baselineBranch } : {}) }) : null;
    if (gate?.kind === 'baseline' && !history?.attempts) notes.push(ctx.baselineBranch === null ? `${NO_HISTORY_YET}: ${NO_BASELINE_BRANCH}` : NO_HISTORY);
    const tested: RecordingTestContext = { ...ctx, ...(packed.length ? { config: { ...ctx.config, normalize: [...ctx.config.normalize, ...packed] } } : {}), ...(history ? { history } : {}), carry };
    const result = await testRecording(parent, spec, tested);
    return { ...base, parent, result, failure: result.failure, kind: result.kind, seconds: (Date.now() - started) / 1000, normalizers, interrupted: result.interrupted, notes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, parent, result: null, failure: { message, details: message }, kind: 'error', seconds: (Date.now() - started) / 1000, normalizers, interrupted: err instanceof ReplayInterrupted, notes };
  }
}

/** Said when a gate against history has none to compare with. */
export const NO_HISTORY =
  'no session that passed on the baseline branch for it yet, so its gate compared with its recording, the one attempt it was packed from: a session that passes on the baseline branch, outside a pull request, becomes its baseline. In CI, keep the store between jobs (the GitHub Action keeps it for a gate against history)';
/** The start of what is said when no baseline branch is known. */
const NO_HISTORY_YET = 'its gate compared with its recording, the one attempt it was packed from';

/**
 * Tokens of a run's model calls: input, cache reads and writes included, and with `output` the
 * output too; with `live`, only calls that reached a provider. Every call's input is what the run
 * costs to run live; the live calls' input and output are what a replay spent. The agent's calls
 * only: a judge check's are counted apart.
 */
export function tokensOf(calls: readonly CallRecord[], o: { live?: boolean; output?: boolean } = {}): number {
  return agentCallsOf(calls)
    .filter((c) => c.kind === 'api' && (!o.live || c.origin === 'live'))
    .reduce((n, c) => {
      const u = c.end?.meta.usage;
      return n + (u ? u.inputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0) + (o.output ? u.outputTokens : 0) : 0);
    }, 0);
}

type Summary = TestAttempt['ended']['summary'];
/** Calls by origin, as the reports and the history show them: overridden calls count as replayed. */
const callsOf = (s: Summary) => ({ total: s.total, replayed: s.byOrigin.replayed + s.byOrigin.overridden, live: s.byOrigin.live, blocked: s.byOrigin.blocked, stubbed: s.byOrigin.stubbed });
const notRespentOf = (s: Summary) => wholeInput(s.tokensNotRespent);
/** Every request a golden's replays sent upstream, a judge check's included: none, for one replayed offline. */
export const upstreamOf = (attempts: readonly TestAttempt[]) => attempts.reduce((n, a) => n + a.ended.summary.upstreamRequests + (a.ended.summary.judge?.upstreamRequests ?? 0), 0);
/** USD the attempts spent on live calls. */
const spentOf = (attempts: readonly TestAttempt[]) => attempts.reduce((n, a) => n + a.ended.summary.cost.spent, 0);

/** What a golden's judge checks did and cost over every attempt, apart from the agent; null without a judge call. */
export function judgeOf(attempts: readonly TestAttempt[]): JudgeSummary | null {
  const parts = attempts.flatMap((a) => (a.ended.summary.judge ? [a.ended.summary.judge] : []));
  if (!parts.length) return null;
  return parts.reduce((t, j) => ({
    calls: t.calls + j.calls,
    replayed: t.replayed + j.replayed,
    live: t.live + j.live,
    notAsked: t.notAsked + j.notAsked,
    upstreamRequests: t.upstreamRequests + j.upstreamRequests,
    spent: t.spent + j.spent,
    saved: t.saved + j.saved,
    unknownModels: [...new Set([...t.unknownModels, ...j.unknownModels])],
  }));
}

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
  // Every result keeps its attempts, one included: a gate against history pools them. `total` counts
  // those that count; the runs of the ones the provider was unavailable for are kept beside them.
  data.attempts = { total: r.attempts.length - r.unavailable, passed: r.passed, required: r.required, runs: r.attempts.map((a) => a.ended.summary.runId), ...(r.inconclusive ? { inconclusive: r.inconclusive } : {}), ...(r.unavailable ? { unavailable: r.unavailable } : {}) };
  data.verdict = r.verdict;
  if (r.gate) data.gate = r.gate;
  if (r.carried) data.continued = r.carried;
  data.spent = spentOf(r.attempts);
  const judge = judgeOf(r.attempts);
  if (judge) data.judge = judge;
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
export function packResult(o: GoldenOutcome, extra: { expect: Record<string, unknown> | null; updated?: PackResult['updated']; inconclusive?: InconclusiveMode; injection?: PackResult['injection'] }): PackResult {
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
    runs: r ? r.attempts.map((a) => ({ runId: a.ended.summary.runId, ok: !a.failure, verdict: attemptVerdict(a) })) : [],
    goldenRunId: o.parent?.runId ?? null,
    calls: s ? callsOf(s) : null,
    upstreamRequests: r ? upstreamOf(r.attempts) : null,
    tokensNotRespent: s ? notRespentOf(s) : null,
    divergence: s?.divergence ? { type: s.divergence.type, callNo: s.divergence.callNo, kind: s.divergence.kind, name: s.divergence.name, ...(s.divergence.recorded !== undefined ? { recorded: s.divergence.recorded } : {}) } : null,
    checks: r?.shown.checks ?? null,
    // A gated golden has them whether or not its gate decided; an attempt a check could not decide counts
    // neither way, and one the provider was unavailable for is not counted at all.
    attempts: r && (r.attempts.length > 1 || r.gate || o.spec?.gate) ? { total: r.attempts.length - r.unavailable, passed: r.passed, inconclusive: r.inconclusive, required: r.required, ...(r.unavailable ? { unavailable: r.unavailable } : {}) } : null,
    gate: r?.gate ?? null,
    expect: extra.expect,
    updated: extra.updated ?? null,
    judge: r ? judgeOf(r.attempts) : null,
    injection: extra.injection ?? null,
  };
}

/** The checks, one per line, as the terminal and the JUnit report show them: passed, failed, inconclusive or not applicable. */
export function formatChecks(checks: CheckResult[]): string {
  return checks.map((c) => checkLine(c)).join('\n');
}

/**
 * The golden as a JUnit test case. An inconclusive one is a failure, or, when inconclusive verdicts
 * warn, skipped: neither passed nor failed. A gated golden's output starts with its gate's verdict
 * line (the verdict word, the tally, the Wilson bound and the rule) and pass^k, which CI dashboards
 * show beside the case; one an attempt a check could not decide stopped has none, as its gate
 * decided nothing: its message and details say why it is inconclusive.
 */
export function junitCase(o: GoldenOutcome, mode: InconclusiveMode = 'fail'): JunitCase {
  const checks = o.result?.shown.checks;
  const failure = o.failure && checks?.length ? { ...o.failure, details: `${formatChecks(checks)}\n\n${o.failure.details}` } : o.failure;
  const gate = o.result?.gate && o.result.gate.decision !== 'continue' ? o.result.gate : null;
  // A golden that passed with a check that did not apply says so where a CI's view of the case shows
  // it: a plain pass would claim more than was checked.
  const notAll = !failure && checks?.some((c) => c.status !== 'passed') ? `${formatChecks(checks)}\n\n` : '';
  const passK = gate ? formatPassK(gate) : null;
  const output = `${gate ? `[shadowlap] ${gate.sentence}\n${passK ? `[shadowlap] ${passK}\n` : ''}` : ''}${notAll}${o.result?.shown.output ?? ''}`;
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
