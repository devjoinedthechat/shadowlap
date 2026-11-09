import { basename, resolve } from 'node:path';
import { messageOf, outputTail, UNAVAILABLE_RETRY, agentCallsOf, decideCountUnavailable, decideUnavailable, formatDivergence, formatPassK, formatTally, gateHistory, gateOf, gateResult, hasRecordedCommand, heldFrom, sameCommandLine, judgedUnder, maskedChange, providerUnavailable, sessionUnavailableReason, unavailableReason, unpackRun, volatileValues, wholeInput, type CallRecord, type DivergenceReport, type Gate, type GateDecision, type GateHistory, type GateResult, type JudgeSummary, type Normalizer, type RunMeta, type RunRecord, type Store, type StoreOf, type TestFailure, type TestResult, type TestResultData, type Unavailable, type WritePolicy } from '@shadowlap/engine';
import { checkLine, type CheckResult, type TestSpec } from './checks.js';
import { notRunMessage } from './golden-consent.js';
import { oracleLabels } from './oracle.js';
import { upstreamOverrides, type ShadowlapConfig } from './config.js';
import { readPackHead } from './goldens.js';
import { type JunitCase } from './junit.js';
import { placeholdersFor } from './placeholder-keys.js';
import { ProviderRetry, type ProviderStreak } from './provider-retry.js';
import { providerIds, testAttempt, type GuardMode, type TestAttempt } from './run-agent.js';
import { withoutCommand } from './shared.js';
import { safe } from './ui.js';
import { type PackResult } from './test-report.js';
import { type Turns } from './turns.js';
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
  /** Called before the pause that follows an attempt the provider was unavailable for, with how long it is, and whether the attempt is counted (cut short, under a gate). */
  onUnavailable?: (u: Unavailable, waitMs: number, counted: boolean) => void;
  /** How unavailable attempts are retried (UNAVAILABLE_RETRY), and the pause itself: tests pass their own. */
  unavailable?: { inARow: number; firstDelayMs: number; maxDelayMs: number };
  sleep?: (ms: number) => Promise<void>;
  /** The tools `--allow-unrecorded` lets a replay run again though the recording never recorded them and they write. */
  allowUnrecorded?: ReadonlySet<string>;
  /** The session's turns (turns.ts): each attempt waits for this golden's, so the goldens' attempts interleave. */
  turns?: Turns;
  /** Unavailable attempts in a row across the session, which stop it at its limit (`sessionInARow`). */
  streak?: ProviderStreak | null;
  /**
   * Asked, once a golden's pack is imported, whether its recorded command may run (golden-consent.ts):
   * false leaves it unrun, failed with why. Undefined: it runs.
   */
  confirmCommand?: (run: RunRecord, dir: string) => Promise<boolean>;
}

/** Thrown for a golden the session's provider stopped before its first attempt: inconclusive, the provider named. */
export class ProviderStopped extends Error {}

/** An inconclusive gate's attempts, carried over to a session that continues it. */
export interface Carry {
  /** The sessions they were run in, oldest first. */
  sessions: string[];
  /** Each attempt in order: true for one that passed. */
  outcomes: boolean[];
  /** Which of them the provider cut short after the model answered, by their place: counted against either verdict, as they were. */
  unavailableAt?: number[];
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
 * unavailable (unavailable.ts), why. Such an attempt is a run like any other, followed by a pause.
 * One the provider failed before the model answered is run again and never counted: the agent's
 * tally, a gate's and a fixed count's, leaves it out. One it cut short after the model answered is
 * counted by a gate against either verdict (`cutShort`), and run again under a fixed count.
 */
export type GoldenAttempt = TestAttempt & { unavailable?: Unavailable; cutShort?: true };

export interface RecordingOutcome {
  spec: TestSpec | null;
  /** Every attempt run, unavailable ones included, in order. */
  attempts: GoldenAttempt[];
  /**
   * The attempt the result shows: the last that passed when it passed, or, when only the attempts it
   * carried over passed its gate and every one this session ran failed, the last this session ran;
   * for an inconclusive one the attempt a check could not decide, or the last the provider was
   * unavailable for, when one stopped it; else the first that failed.
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
  /** Attempts the provider cut short after the model answered, which its gate counted against either verdict. */
  cutShort: number;
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
  const plan = attemptPlan(spec, ctx);
  const run = await runAttempts(parent, spec, ctx, plan);
  if (!run.attempts.length) throw new ReplayInterrupted();
  const judged = judgeAttempts(spec, plan, run, ctx.history ?? null);
  if (run.attempts.length > 1 && !judged.interrupted) fileUnder(ctx.store, run.attempts, judged.shown, plan.testMeta);
  // In a row across the session when its streak stopped it, else this golden's own.
  const inARow = ctx.streak?.gaveUp ? ctx.streak.inARow : run.providers.inARow;
  const failure = failureOf(plan, run, judged, inARow);
  const { verdict, shown } = judged;
  const kind: TestFailure | null = verdict === 'passed' ? null : verdict === 'inconclusive' ? 'inconclusive' : (shown.kind ?? 'error');
  const carried = run.carry ? { sessions: run.carry.sessions, attempts: run.carry.outcomes.length } : null;
  return { spec, attempts: run.attempts, shown, passed: judged.passed, required: judged.required, failure, kind, verdict, gate: judged.result, inconclusive: run.unjudged, unavailable: run.providers.unavailable, cutShort: run.providers.cutShort, interrupted: judged.interrupted, carried };
}

/** How many attempts a golden runs and what they continue, and how each attempt's run is filed. */
interface AttemptPlan {
  /** Its gate, with this session's limit; null for a fixed count. */
  gate: Gate | null;
  /** The inconclusive gate's attempts this session continues (`test --continue`), counted first. */
  carry: Carry | null;
  /** How many attempts were carried over. */
  before: number;
  /** The attempts to run: what the gate's limit leaves, else `repeat`. */
  repeat: number;
  /** Of the attempts carried over, those the provider cut short. */
  carriedCut: number;
  /**
   * A golden replayed more than once in a session is one test run with its attempts (`meta.test`
   * `attempt` and `of`): while they run, each attempt after the first is filed under the first, and
   * once they have all ended, under the attempt the result shows, so the Runs page, the sidebar and
   * the Tests screen all open the run that says how the golden came out.
   */
  testMeta: (i: number, of: string | null) => Partial<RunMeta> | null;
}

function attemptPlan(spec: TestSpec | null, ctx: RecordingTestContext): AttemptPlan {
  // A gate decides as attempts come in, up to its limit; without one, `repeat` attempts run.
  const gate = spec?.gate ? withLimit(spec.gate, ctx.maxAttempts) : null;
  const carry = gate && ctx.carry && ctx.carry.outcomes.length < gate.max ? ctx.carry : null;
  const before = carry?.outcomes.length ?? 0;
  const repeat = gate ? gate.max - before : (spec?.repeat ?? 1);
  const carriedCut = carry ? (carry.unavailableAt ?? []).filter((i) => i >= 0 && i < carry.outcomes.length && !carry.outcomes[i]).length : 0;
  const testMeta = (i: number, of: string | null): Partial<RunMeta> | null => (ctx.test ? { test: { ...ctx.test, ...(repeat + before > 1 ? { attempt: before + i + 1 } : {}), ...(of ? { of } : {}) } } : null);
  return { gate, carry, before, repeat, carriedCut, testMeta };
}

/** What every attempt of a golden replays with: offline unless it may fork, under the session's policies. */
function attemptOptions(parent: RunRecord, spec: TestSpec | null, ctx: RecordingTestContext): Parameters<typeof testAttempt>[2] {
  // A recording marked `fork` may diverge on purpose; from the fork on it needs the real providers.
  const live = ctx.online || !!spec?.fork;
  const upstreams = live ? upstreamOverrides(process.env) : Object.fromEntries([...Object.keys(providerIds()), 'http'].map((id) => [id, 'offline']));
  // Offline, its agent gets a placeholder for each key the environment lacks: nothing it sends goes live.
  const extraEnv = live ? {} : placeholdersFor(ctx.store, parent, 'offline');
  const { config } = ctx;
  return {
    cwd: ctx.cwd,
    upstreams,
    extraEnv,
    writes: ctx.writes,
    guard: ctx.guard,
    normalizers: config.normalize,
    prices: config.prices,
    clock: config.clock,
    http: config.http,
    ...(config.redact ? { redact: config.redact } : {}),
    spec,
    ...(ctx.argv ? { argv: ctx.argv } : {}),
    ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}),
    ...(ctx.stopped ? { onSignal: 'return' as const } : {}),
    ...(ctx.allowUnrecorded ? { allowUnrecorded: ctx.allowUnrecorded } : {}),
  };
}

/** A golden's attempts as they ran, and what they decided as they came in. */
interface AttemptsRun {
  /** Every attempt run, unavailable ones included, in order. */
  attempts: GoldenAttempt[];
  decision: GateDecision;
  /** Its first attempt replayed clean, which settled its gate. */
  clean: boolean;
  /** Attempts a check could not judge: the first one stops the golden. */
  unjudged: number;
  /**
   * What the provider did to the attempts: those never counted, those cut short and counted by the
   * gate, how many in a row, and whether too many in a row stopped it.
   */
  providers: ProviderRetry;
  /** The attempts carried over, unless a clean replay settled the gate without them. */
  carry: Carry | null;
}

/** Runs a golden's attempts until its gate decides, its count is run, or something stops it. */
async function runAttempts(parent: RunRecord, spec: TestSpec | null, ctx: RecordingTestContext, plan: AttemptPlan): Promise<AttemptsRun> {
  const { gate } = plan;
  const options = attemptOptions(parent, spec, ctx);
  const retry = ctx.unavailable ?? UNAVAILABLE_RETRY;
  const sleep = ctx.sleep ?? ((ms: number) => pause(ms, ctx.stopped));
  // A gate and a fixed count alike count an attempt cut short after the model answered, against either verdict.
  const providers = new ProviderRetry({ retry, sleep, onUnavailable: ctx.onUnavailable, count: true, streak: ctx.streak ?? null });
  const run: AttemptsRun = { attempts: [], decision: 'continue', clean: false, unjudged: 0, providers, carry: plan.carry };
  // Attempts that count: every one but those the provider was unavailable for and nobody counts.
  let counted = 0;
  // A gate's max counts the attempts the provider didn't cut short (decideUnavailable): those it did
  // run beside them, up to as many again, where the gate is left inconclusive.
  const room = () => (gate ? plan.before - plan.carriedCut + counted - providers.cutShort < gate.max : counted < plan.repeat);
  while (room()) {
    if (ctx.stopped?.()) break;
    if (gate && counted >= 2 * gate.max) {
      run.decision = 'inconclusive';
      break;
    }
    const next = await nextAttempt(parent, ctx, plan, run, options);
    if (next === 'stop') break;
    if (next === 'retry') continue;
    counted++;
    // A check that couldn't be judged here won't be on the next attempt either.
    if (next.after === 'counted' && attemptVerdict(next.attempt) === 'inconclusive') {
      run.unjudged++;
      break;
    }
    if (!gate) continue;
    run.decision = gateAfter(gate, next, run, plan.carriedCut, ctx.history ?? null);
    if (run.decision !== 'continue') break;
  }
  return run;
}

/**
 * The next attempt, run in its turn among the session's goldens, and how the provider's answers in
 * it count; `retry` for one the provider was unavailable for before the model answered, and `stop`
 * when nothing more runs: a signal, the attempt interrupted, the provider down too long.
 */
async function nextAttempt(parent: RunRecord, ctx: RecordingTestContext, plan: AttemptPlan, run: AttemptsRun, options: Parameters<typeof testAttempt>[2]): Promise<{ attempt: GoldenAttempt; after: 'counted' | 'cut' } | 'retry' | 'stop'> {
  const { attempts, providers } = run;
  const i = attempts.length;
  const meta = plan.testMeta(i, i > 0 ? (attempts[0]?.ended.summary.runId ?? null) : null);
  // Its turn among the session's goldens, given back once the attempt has ended and any pause the
  // provider asked for after it is over: the provider is the session's, and every golden waits.
  const turn = ctx.turns ? await ctx.turns.take() : null;
  try {
    if (ctx.stopped?.()) return 'stop';
    // The provider stayed unavailable too many attempts in a row across the session: nothing more runs.
    const down0 = ctx.streak?.gaveUp ?? null;
    if (down0) {
      if (!attempts.length) throw new ProviderStopped(sessionUnavailableReason(ctx.streak!.inARow, down0));
      providers.gaveUp = down0;
      return 'stop';
    }
    const attempt: GoldenAttempt = await testAttempt(ctx.store, parent, {
      ...options,
      ...(meta ? { meta } : {}),
      ...(ctx.onRun ? { onRun: (runId: string) => ctx.onRun!(runId, plan.before + i + 1, plan.before + plan.repeat + providers.unavailable) } : {}),
    });
    attempts.push(attempt);
    if (attempt.interrupted) return 'stop';
    // The agent failed while its provider was unavailable (ProviderRetry): before the model answered,
    // no evidence about the agent, run again after a pause, never counted; cut short after it, counted
    // by the gate against either verdict; too many in a row, and the golden is inconclusive.
    const down = unavailableIn(ctx.store, attempt);
    if (down) attempt.unavailable = down;
    const after = await providers.after(down);
    if (after === 'stop' || after === 'retry') return after;
    if (after === 'cut') attempt.cutShort = true;
    return { attempt, after };
  } finally {
    turn?.();
  }
}

/** What a gate decides once an attempt has counted: a clean first replay settles it, else the tally so far. */
function gateAfter(gate: Gate, next: { attempt: GoldenAttempt; after: 'counted' | 'cut' }, run: AttemptsRun, carriedCut: number, history: GateHistory | null): GateDecision {
  // A clean replay comes out the same every time: its one attempt settles the gate, whatever
  // attempts that forked were carried over (the agent no longer forks).
  if (run.attempts.length === 1 && next.after === 'counted' && replayedClean(next.attempt)) {
    run.clean = true;
    run.carry = null;
    return next.attempt.failure ? 'fail' : 'pass';
  }
  const { carry } = run;
  const carriedPasses = carry ? carry.outcomes.filter(Boolean).length : 0;
  const mine = run.attempts.filter((a) => !a.unavailable || a.cutShort);
  return decideUnavailable(carriedPasses + mine.filter((a) => !a.failure).length, (carry?.outcomes.length ?? 0) + mine.length, (carry ? carriedCut : 0) + mine.filter((a) => a.cutShort).length, gate, history);
}

/** How a golden's attempts came out together. */
interface Judged {
  /** The attempts that count: what the agent did with its provider there, the ones it cut short and a gate counted included. */
  mine: GoldenAttempt[];
  passed: number;
  required: number | null;
  /** Of `mine`, the attempts the provider cut short. */
  cut: number;
  /** The outcomes of the attempts carried over. */
  carried: boolean[];
  verdict: RecordingOutcome['verdict'];
  result: GateResult | null;
  shown: GoldenAttempt;
  interrupted: boolean;
  /** The attempt a check could not decide, when it left the golden undecided. */
  unjudgedAttempt: GoldenAttempt | undefined;
  /** The last attempt, when the provider being unavailable too long left the golden undecided. */
  unavailableAttempt: GoldenAttempt | undefined;
}

function judgeAttempts(spec: TestSpec | null, plan: AttemptPlan, run: AttemptsRun, history: GateHistory | null): Judged {
  const { gate, repeat } = plan;
  const { attempts, decision, unjudged, carry } = run;
  const { gaveUp, unavailable } = run.providers;
  const mine = attempts.filter((a) => !a.unavailable || a.cutShort);
  const interrupted = attempts.some((a) => a.interrupted !== null) || (!gaveUp && (gate ? decision === 'continue' && !unjudged : mine.length < repeat && !unjudged));
  const passed = mine.filter((a) => !a.failure).length;
  const required = gate ? null : (spec?.passes ?? 1);
  const judged = mine.filter((a) => attemptVerdict(a) !== 'inconclusive');
  // A fixed count's verdict with every attempt the provider cut short counted against it (decideCountUnavailable).
  const cut = mine.filter((a) => a.cutShort).length;
  const byCount = gate ? null : decideCountUnavailable(passed, judged.length, cut, repeat, required!);
  const carried = carry ? carry.outcomes : [];
  // An attempt a check could not decide stopped the golden. A gate stops as soon as it decides, so
  // that attempt came while it was still open: the golden is inconclusive, and its gate decided
  // nothing. A fixed count runs its attempts whatever they settle, so the ones judged before that
  // attempt may have settled it already (enough passed, or too many failed for the attempts left to
  // make up): their verdict stands, as an attempt that says nothing either way changes no settled count.
  const undecided = unjudged > 0 && (gate !== null || byCount === 'continue');
  // The provider unavailable too many attempts in a row stops it the same way: a gate still open, or
  // a count not yet settled, is inconclusive, never failed.
  const unavailableStop = gaveUp !== null && (gate !== null ? decision === 'continue' : byCount === 'continue');
  // The positions, among the gate's outcomes, of the attempts the provider cut short: carried over and this session's.
  const unavailableAt = [...(carry?.unavailableAt ?? []), ...judged.flatMap((a, k) => (a.cutShort ? [carried.length + k] : []))];
  const result = gate && !undecided ? gateResult(gate, [...carried, ...judged.map((a) => !a.failure)], { history, clean: run.clean, decision, carried: carried.length, unavailable, ...(unavailableAt.length ? { unavailableAt } : {}) }) : null;
  const verdict: RecordingOutcome['verdict'] = undecided || unavailableStop ? 'inconclusive' : verdictWord(gate ? decision : byCount!);
  const unjudgedAttempt = undecided ? mine.find((a) => attemptVerdict(a) === 'inconclusive') : undefined;
  const unavailableAttempt = unavailableStop ? attempts.at(-1) : undefined;
  const shown = verdict === 'passed' ? passedShown(mine, attempts) : (unjudgedAttempt ?? unavailableAttempt ?? mine.find((a) => attemptVerdict(a) === 'failed') ?? mine.find((a) => a.failure) ?? attempts.at(-1)!);
  return { mine, passed, required, cut, carried, verdict, result, shown, interrupted, unjudgedAttempt, unavailableAttempt };
}

/**
 * The attempt a golden that passed shows: its last that passed. A gate continued from an inconclusive
 * session can pass on the attempts it carried over while every one this session ran failed: it then
 * shows the last this session ran, the one that counted if any did, as it has none of its own that
 * passed, and the gate's line says what the tally came to.
 */
function passedShown(mine: readonly GoldenAttempt[], attempts: readonly GoldenAttempt[]): GoldenAttempt {
  return mine.filter((a) => !a.failure).at(-1) ?? mine.at(-1) ?? attempts.at(-1)!;
}

/** A gate's or a count's decision as a verdict: one still going is inconclusive. */
const verdictWord = (d: GateDecision): RecordingOutcome['verdict'] => (d === 'pass' ? 'passed' : d === 'fail' ? 'failed' : 'inconclusive');

/** An attempt's line in a golden's details: how it ended, and how its provider's answers counted. */
function attemptMark(a: GoldenAttempt): string {
  if (a.cutShort) return `⏸ the provider cut it short (${a.unavailable!.reason}), counted against either verdict: ${a.failure!.message}`;
  if (a.unavailable) return `⏸ the provider was unavailable (${a.unavailable.reason}), not counted: ${a.failure!.message}`;
  return a.failure ? `${attemptVerdict(a) === 'inconclusive' ? '?' : '✗'} ${a.failure.message}` : '✓ passed';
}

/** Every attempt's line, those carried over first. */
function attemptLines(carried: readonly boolean[], attempts: readonly GoldenAttempt[]): string {
  return [
    ...(carried.length ? [`attempts 1 to ${carried.length}  carried over: ${carried.filter(Boolean).length} passed`] : []),
    ...attempts.map((a, i) => `attempt ${carried.length + i + 1}  ${attemptMark(a)}`),
  ].join('\n');
}

/** Why a golden failed or is inconclusive, as its result says it; undefined when it passed. */
function failureOf(plan: AttemptPlan, run: AttemptsRun, j: Judged, inARow: number): JunitCase['failure'] {
  const { attempts } = run;
  const { gaveUp } = run.providers;
  const each = () => attemptLines(j.carried, attempts);
  if (j.unjudgedAttempt) return unjudgedFailure(j.unjudgedAttempt, plan.gate ? 0 : plan.repeat - j.mine.length, attempts.length === 1 ? null : each());
  if (j.unavailableAttempt && gaveUp) {
    // Inconclusive with the provider named: nothing here is a verdict on the agent.
    return { message: unavailableReason(inARow, gaveUp), details: `${j.result ? `${formatTally(j.result)}\n` : ''}${each()}\n\n${j.unavailableAttempt.failure!.details}` };
  }
  if (j.result && j.verdict !== 'passed') {
    const f = j.shown.failure;
    return {
      message: `${j.result.sentence}${f && j.verdict === 'failed' ? `. Attempt ${j.carried.length + attempts.indexOf(j.shown) + 1}: ${f.message}` : ''}`,
      details: `${formatTally(j.result)}\n${each()}${f ? `\n\n${f.details}` : ''}`,
    };
  }
  if (plan.gate) return undefined;
  if (j.verdict === 'inconclusive' && j.cut) {
    // The attempts the provider cut short decide the count either way: no verdict rests on how they would have ended.
    return {
      message: `inconclusive: ${j.passed} of ${j.mine.length} attempts passed, ${j.cut} of them cut short by the provider, ${j.required!} needed: counted as failures the count is lost, as passes it is met, so it rests on how they would have ended`,
      details: each(),
    };
  }
  if (j.verdict !== 'failed') return undefined;
  const f = j.shown.failure!;
  if (attempts.length === 1) return f;
  // An attempt a check could not decide after the count was lost is counted apart, never as failed.
  const unavailable = run.providers.unavailable;
  return {
    message: `${j.passed} of ${j.mine.length} attempts passed${run.unjudged ? `, ${run.unjudged} inconclusive` : ''}${j.cut ? `, ${j.cut} cut short by the provider, counted against either verdict` : ''}${unavailable ? `, ${unavailable} not counted: the provider was unavailable` : ''}, ${j.required!} needed. Attempt ${attempts.indexOf(j.shown) + 1}: ${f.message}`,
    details: `${each()}\n\n${f.details}`,
  };
}

/**
 * Why a golden a check could not decide is inconclusive: the attempt's own line already says a check
 * was inconclusive, and which; with the attempts of a repeat it kept from running (`left`), and every
 * attempt's line when there were several (`lines`).
 */
function unjudgedFailure(a: GoldenAttempt, left: number, lines: string | null): NonNullable<JunitCase['failure']> {
  const f = a.failure!;
  const message = /^check inconclusive: /.test(f.message) ? f.message : `inconclusive: ${f.message.replace(/^check failed: /, 'a check could not be judged: ')}`;
  const notRun = left > 0 ? `; ${left} more attempt${left === 1 ? '' : 's'} not run: ${left === 1 ? 'it' : 'they'} would be undecided too` : '';
  return { message: `${message}${notRun}`, details: lines === null ? f.details : `${lines}\n\n${f.details}` };
}

/**
 * Why an attempt says nothing about the agent because its provider was unavailable, or null: it
 * failed, by no time limit of the test's (the agent's own clock) and with no divergence a replay must
 * not have, while one of its live model calls ended on an error the provider sends when it can't
 * answer (unavailable.ts).
 */
export function unavailableIn(store: StoreOf<'recording'>, a: TestAttempt): Unavailable | null {
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

/**
 * Two gates with the same figures, whatever limit each ran under and whatever share of a session's
 * risk each failed at: an SPRT's `failRisk`, a gate against history's `risk` (suite.ts sets both),
 * and whatever record a pass past a history gate's own max was held to (`widened`), which each
 * session's plan reads afresh, as it sizes the limit.
 */
const sameGate = (a: Gate, b: Gate) => JSON.stringify(rule(a)) === JSON.stringify(rule(b));
function rule(g: Gate): Gate {
  const x = { ...gateOf(g), max: 0 };
  if (x.kind === 'sprt') delete x.failRisk;
  else {
    x.risk = 0;
    delete x.widened;
  }
  return x;
}

/** The risk a gate failed a golden at: an SPRT's for a failure, a gate against history's. */
const failingRisk = (g: Gate): number => (g.kind === 'sprt' ? (g.failRisk ?? g.risk) : g.risk);

/**
 * What `test --continue` carries over for a golden: the attempts of its last result, when that
 * result is an inconclusive gate's on the same recording, under the same checks and the same gate,
 * so the attempts this session adds continue the very test it ran out of room for (an SPRT or a
 * history gate continued to a higher limit decides exactly as one that had that limit from the
 * start). A settled verdict is never continued: asking again after it stopped would be peeking.
 */
export function carryFor(store: StoreOf<'tests'>, golden: string, o: { goldenRunId: string; checks: readonly string[]; gate: Gate; limit: number; session?: string | null; branch?: string | null }): { carry: Carry; gate: Gate } | { why: string } {
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
  // A session splits its risk across its gated goldens, so the share a gate failed at can differ
  // between sessions. It continues under the share it was decided at, never a larger one than this
  // session gives it, which would spend more than its share.
  if (failingRisk(g) > failingRisk(o.gate)) return { why: "its last result was decided at a larger share of the session's risk than this session gives it" };
  const outcomes = outcomesOf(g);
  if (!outcomes || !outcomes.length) return { why: 'its last result kept no attempts to continue' };
  if (outcomes.length >= o.limit) return { why: `its last result already ran the ${o.limit} attempts its gate allows: raise the limit with --max-attempts` };
  const cut = Array.isArray(g.unavailableAt) ? g.unavailableAt.filter((i) => Number.isInteger(i) && i >= 0 && i < outcomes.length) : [];
  return { carry: { sessions: [...(last.data?.continued?.sessions ?? []), last.sessionId], outcomes, ...(cut.length ? { unavailableAt: cut } : {}) }, gate: decidedAt(o.gate, g) };
}

/** `now`'s gate, at the share of the risk `before` was decided at: its failRisk, or a gate against history's risk. */
function decidedAt(now: Gate, before: Gate): Gate {
  if (now.kind === 'baseline') return { ...now, risk: before.risk };
  const { failRisk: _now, ...figures } = now;
  const shared = before.kind === 'sprt' && before.failRisk !== undefined && before.failRisk !== before.risk ? before.failRisk : undefined;
  return { ...figures, ...(shared !== undefined ? { failRisk: shared } : {}) };
}

/**
 * Files a golden's attempts under the one its result shows. Never fails the test: the store may be
 * busy with another process, or a run gone, and the attempts then stay filed under the first.
 */
function fileUnder(store: StoreOf<'recording'>, attempts: readonly TestAttempt[], shown: TestAttempt, meta: (i: number, of: string | null) => Partial<RunMeta> | null): void {
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
  /** Not run: its recorded command came from a pack the repository doesn't track, and nobody said yes (golden-consent.ts). */
  unvouched?: true;
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
 *
 * A pack's command that differs from the copy's is the pack's, someone else's for all the copy's
 * own mark says: the run comes back marked (`commandFromImport`), so a pack that reuses the id of a
 * run recorded here, with a command of its own, asks before it runs as any pack from elsewhere does.
 * A pack masks the credentials a command line carries (credentialFreeArgv): one whose command is the
 * copy's but for those is the copy's, and runs as the copy recorded it, with them.
 */
export function importGolden(store: StoreOf<'recording' | 'readModels'>, dir: string): RunRecord {
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
  if (!other?.command) return parent;
  if (sameCommandLine(other.command.argv, parent.command.argv)) return { ...parent, command: { ...other.command, argv: parent.command.argv } };
  return { ...parent, command: other.command, meta: { ...(parent.meta ?? {}), commandFromImport: true } };
}

export async function testGolden(dir: string, golden: string, spec: TestSpec | null, ctx: RecordingTestContext): Promise<GoldenOutcome> {
  const started = Date.now();
  const base = { golden, dir, name: basename(resolve(dir)), spec };
  let parent: RunRecord | null = null;
  let normalizers: Normalizer[] = [...ctx.config.normalize];
  const notes: string[] = [];
  try {
    parent = importGolden(ctx.store, dir);
    if (ctx.confirmCommand && !(await ctx.confirmCommand(parent, dir))) {
      const message = notRunMessage(dir);
      return { ...base, parent, result: null, failure: { message, details: message }, kind: 'error', seconds: (Date.now() - started) / 1000, normalizers, interrupted: false, notes, unvouched: true };
    }
    // The store may hold the run as it was recorded, before the pack redacted it: importGolden made
    // sure it is the pack's recording, its redaction aside, and replays the pack's command. Replaying
    // the pack applies its redaction rules as normalizers, and so does replaying that copy, so a
    // golden passes or fails here as it does in CI, where only the pack exists.
    // That copy may also carry an earlier pack's rules, when the run was packed again with more.
    const head = readPackHead(dir);
    const packed = 'error' in head || JSON.stringify(parent.meta?.redactions ?? []) === JSON.stringify(head.redactions) ? [] : head.redactions;
    // A replay of a redacted run applies the rules it carries as well.
    normalizers = [...ctx.config.normalize, ...packed, ...(parent.meta?.redactions ?? [])];
    let gate = spec?.gate ? withLimit(spec.gate, ctx.maxAttempts) : null;
    const checks = oracleLabels(spec).slice(1);
    // --continue: an inconclusive gate's attempts carry over, when nothing it was judged by changed.
    let carry: Carry | null = null;
    if (ctx.continue && gate) {
      const found = carryFor(ctx.store, golden, { goldenRunId: parent.runId, checks, gate, limit: gate.max, session: ctx.test?.session ?? null, ...(ctx.branch !== undefined ? { branch: ctx.branch } : {}) });
      if ('carry' in found) {
        carry = found.carry;
        // Under the share of the risk it was decided at.
        gate = found.gate;
        spec = { ...spec!, gate: found.gate };
        notes.push(`continues its last result: ${found.carry.outcomes.length} attempts carried over, ${found.carry.outcomes.filter(Boolean).length} passed, up to ${gate.max}`);
      } else notes.push(`nothing to continue (${found.why}): it ran afresh`);
    }
    // A gate against history compares with this golden's last sessions: under the same recording
    // and checks, this session's own result left out, and those whose attempts carry over.
    // Only sessions that passed on the baseline branch, for no pull request, are a baseline (gate-history.ts).
    const { history, note } = goldenHistory(ctx.store, golden, gate, { goldenRunId: parent.runId, checks, excludeSession: [...(ctx.test?.session ? [ctx.test.session] : []), ...(carry?.sessions ?? [])], ...(ctx.baselineBranch !== undefined ? { baselineBranch: ctx.baselineBranch } : {}) });
    if (note) notes.push(note);
    const tested: RecordingTestContext = { ...ctx, ...(packed.length ? { config: { ...ctx.config, normalize: [...ctx.config.normalize, ...packed] } } : {}), ...(history ? { history } : {}), carry };
    const result = await testRecording(parent, spec, tested);
    return { ...base, parent, result, failure: result.failure, kind: result.kind, seconds: (Date.now() - started) / 1000, normalizers, interrupted: result.interrupted, notes };
  } catch (err) {
    const message = messageOf(err);
    // The session's provider stopped it before it ran: inconclusive, the provider named, never failed.
    return { ...base, parent, result: null, failure: { message, details: message }, kind: err instanceof ProviderStopped ? 'inconclusive' : 'error', seconds: (Date.now() - started) / 1000, normalizers, interrupted: err instanceof ReplayInterrupted, notes };
  }
}

/**
 * What a gate against history compares with: the golden's last sessions under the same recording
 * and checks, the sessions given left out (gate-history.ts), and what to say when there are none.
 * Nothing for any other gate. `test` reads it for each golden, `bisect` once for its search.
 */
export function goldenHistory(store: StoreOf<'tests'>, golden: string, gate: Gate | null, o: { goldenRunId: string; checks: readonly string[]; excludeSession?: readonly string[]; baselineBranch?: string | null }): { history: GateHistory | null; note: string | null } {
  if (gate?.kind !== 'baseline') return { history: null, note: null };
  const history = gateHistory(store, golden, { window: gate.window, first: gate.min, goldenRunId: o.goldenRunId, checks: o.checks, mode: 'fork', excludeSession: o.excludeSession ?? [], ...(o.baselineBranch !== undefined ? { branch: o.baselineBranch } : {}) });
  if (history.attempts) return { history, note: null };
  return { history, note: o.baselineBranch === null ? `${NO_HISTORY_YET}: ${NO_BASELINE_BRANCH}` : NO_HISTORY };
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
export function resultData(store: StoreOf<'recording'>, o: GoldenOutcome): TestResultData {
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
  data.attempts = { total: r.attempts.length - r.unavailable, passed: r.passed, required: r.required, runs: r.attempts.map((a) => a.ended.summary.runId), ...(r.inconclusive ? { inconclusive: r.inconclusive } : {}), ...(r.unavailable ? { unavailable: r.unavailable } : {}), ...(r.cutShort ? { cutShort: r.cutShort } : {}) };
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
/** A golden's verdict: its result's, else failed when it has a failure, unless that failure is inconclusive (the session's provider stopped it before it ran). */
export const verdictOf = (o: Pick<GoldenOutcome, 'result' | 'failure'> & { kind?: GoldenOutcome['kind'] }): RecordingOutcome['verdict'] => o.result?.verdict ?? (o.failure ? (o.kind === 'inconclusive' ? 'inconclusive' : 'failed') : 'passed');

/** Whether CI lets a golden through: it passed, or it is inconclusive and inconclusive verdicts warn. */
export const letThrough = (o: Pick<GoldenOutcome, 'result' | 'failure'> & { kind?: GoldenOutcome['kind'] }, mode: InconclusiveMode): boolean => {
  const v = verdictOf(o);
  return v === 'passed' || (v === 'inconclusive' && mode === 'warn');
};

/**
 * What a golden's inconclusive does this session: `--inconclusive` when it was given; else a gate
 * against history that ran out of attempts while its record holds fewer sessions than it reads
 * (`short`) only warns, as with so little history it can't tell a drop from chance, and says so
 * (`warned`: `needs more history: 3 of 30 sessions`), unless the session's plan read its last sessions
 * below the sessions before them (`counts`, a decline or a drop), which more history would not explain
 * away: that one counts, and says why (`counted`). Anything else fails the run. A clear failure fails
 * either way, and an inconclusive the provider or a check that couldn't be decided caused counts.
 */
export function inconclusiveFor(o: Pick<GoldenOutcome, 'result' | 'failure'> & { kind?: GoldenOutcome['kind'] }, given: InconclusiveMode | null, short: { sessions: number; of: number } | null | undefined, counts?: string | null): { mode: InconclusiveMode; warned: string | null; counted: string | null } {
  if (given) return { mode: given, warned: null, counted: null };
  const gate = o.result?.gate;
  if (short && verdictOf(o) === 'inconclusive' && gate?.kind === 'baseline' && gate.decision === 'inconclusive') {
    if (counts) return { mode: 'fail', warned: null, counted: `counts though it has only ${short.sessions} of ${short.of} sessions: ${counts}` };
    return { mode: 'warn', warned: `needs more history: ${short.sessions} of ${short.of} sessions`, counted: null };
  }
  return { mode: 'fail', warned: null, counted: null };
}

/** The golden's entry in the JSON report (`--json`), which the GitHub Action reads. */
export function packResult(o: GoldenOutcome, extra: { expect: Record<string, unknown> | null; updated?: PackResult['updated']; inconclusive?: InconclusiveMode; warned?: string | null; counted?: string | null; injection?: PackResult['injection'] }): PackResult {
  const r = o.result;
  const s = r?.shown.ended.summary ?? null;
  return {
    name: o.name,
    dir: o.dir,
    golden: o.golden,
    mode: o.spec?.fork ? 'fork' : 'replay',
    ok: letThrough(o, extra.inconclusive ?? 'fail'),
    verdict: verdictOf(o),
    ...(extra.warned ? { warned: extra.warned } : {}),
    ...(extra.counted ? { counted: extra.counted } : {}),
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
    attempts: r && (r.attempts.length > 1 || r.gate || o.spec?.gate) ? { total: r.attempts.length - r.unavailable, passed: r.passed, inconclusive: r.inconclusive, required: r.required, ...(r.unavailable ? { unavailable: r.unavailable } : {}), ...(r.cutShort ? { cutShort: r.cutShort } : {}) } : null,
    gate: r?.gate ?? null,
    expect: extra.expect,
    updated: extra.updated ?? null,
    judge: r ? judgeOf(r.attempts) : null,
    injection: extra.injection ?? null,
  };
}

/** The checks, one per line, as the terminal and the JUnit report show them: passed, failed, inconclusive or not applicable. */
export function formatChecks(checks: CheckResult[]): string {
  // Each on its one line, its control characters escaped: a judge's reason is a model's words, and can
  // break the line where a CI log reads what starts the next as a command.
  return checks.map((c) => safe(checkLine(c))).join('\n');
}

/**
 * The golden as a JUnit test case. An inconclusive one is a failure, or, when inconclusive verdicts
 * warn, skipped: neither passed nor failed. A gated golden's output starts with its gate's verdict
 * line (the verdict word, the tally, the bound and the rule) and pass^k, which CI dashboards
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
export function pruneReplays(store: StoreOf<'recording' | 'tests'>, session: { sessionId: string; startedAt: number }, tested: ReadonlyMap<string, { ok: boolean; fork: boolean }>): number {
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
export function pruneQuietly(store: StoreOf<'recording' | 'tests'>, session: { sessionId: string; startedAt: number }, tested: ReadonlyMap<string, { ok: boolean; fork: boolean }>): string | null {
  try {
    pruneReplays(store, session, tested);
    return null;
  } catch (err) {
    return `older replays were not pruned this time: ${messageOf(err)}`;
  }
}
