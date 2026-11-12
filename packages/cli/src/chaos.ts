import {
  messageOf,
  UNAVAILABLE_RETRY,
  chaosJudge,
  chaosTargets,
  decideCountUnavailable,
  decideUnavailable,
  effectsFor,
  formatUsd,
  JUDGED_FROM,
  plural,
  PRESET_LABELS,
  recordingRule,
  presetHits,
  presetReplay,
  presetResult,
  refused,
  resultShape,
  sessionUnavailableReason,
  safeLine,
  presetBound,
  presetRule,
  storeEffects,
  type CallRecord,
  type ChaosPreset,
  type ChaosJudge,
  type ChaosVerdict,
  type Effect,
  type Gate,
  type GateDecision,
  type PresetGate,
  type Palette,
  type RunRecord,
  type Store,
  type Unavailable,
  type WritePolicy,
  unavailableReason,
} from '@shadowlap/engine';
import { type ChaosSpec } from './chaos-config.js';
import { type TestSpec } from './checks.js';
import { attemptVerdict, unavailableIn } from './golden-test.js';
import { ProviderRetry, type ProviderStreak } from './provider-retry.js';
import { upstreamOverrides, type ShadowlapConfig } from './config.js';
import { storedResult } from './interventions.js';
import { emitJobEvent } from './job-events.js';
import { type JunitCase } from './junit.js';
import { testAttempt, type GuardMode, type TestAttempt } from './run-agent.js';
import { usageOf, telemetry } from './shared.js';

// The presets' judge is the engine's (chaos-judge.ts), which the dashboard's dialog and panel read too.
export { checkLabels, gateWords, judgedOnExit, presetRule, recordingRule, writeLimits, type ChaosJudge } from '@shadowlap/engine';

/**
 * `test --chaos` and `replay --chaos`: each error-path preset played into a replay of a recording
 * at its place (engine chaos.ts says where, and what it answers), each a fork judged as a golden
 * that forks is: the agent exits 0 and passes the checks an error path must pass (`chaos.expect`,
 * or `--expect`), its writes stubbed so the preset is the only failure played in. The golden's own
 * checks say what its recording's path did, which a path through a failure needn't do, so only
 * their write limits judge it when `chaos.expect` doesn't say: the upper bounds they set on write
 * tools hold on any path. A preset's attempts are decided by a gate as they come in, the golden's
 * own `repeat` and `passes` unless its `chaos.gate` gives one, and the verdict is passed, failed,
 * inconclusive (the gate's attempts ran out between its bounds, or the replay never reached the
 * call), or not applicable (no call the preset can hit). The provider failing for real, beyond what
 * the preset plays in, is the provider's, as under `shadowlap test`: an attempt it failed before the
 * model answered is run again and never counted, one it cut short after is counted by a sequential
 * gate against either verdict, and three in a row leave the preset inconclusive with the provider
 * named, never failed.
 */

export interface PresetRun {
  runId: string;
  /**
   * How the attempt came out: passed, failed, or inconclusive when it says nothing of the agent's
   * error path (the replay never reached the call, so the preset was never played in, all that kept
   * it from passing is a check no attempt can decide, or its provider failed for real).
   */
  verdict: Exclude<ChaosVerdict, 'not-applicable'>;
  /**
   * The provider failed for real in it, beyond what the preset played in: before the model answered
   * (`retried`: run again, never counted), or after (`counted`: a sequential gate counted it against
   * either verdict; a fixed count ran it again). Absent otherwise.
   */
  unavailable?: 'retried' | 'counted';
  /** True for a passed attempt only. */
  passed: boolean;
  exitCode: number;
  checks: Array<{ ok: boolean; label: string; detail: string | null }> | null;
  /** Why it failed, in a line, or null. */
  reason: string | null;
  /** For an agent that exited with an error: the error it died of, as it printed it (`SyntaxError: …`). */
  lastLine: string | null;
}

export interface PresetOutcome {
  preset: ChaosPreset;
  label: string;
  verdict: ChaosVerdict;
  /** The call it hit: the recording's call number, and the tool or model call there. */
  callNo: number | null;
  target: { kind: 'tool' | 'api'; name: string } | null;
  passes: number;
  attempts: number;
  /** One sentence: what the preset did and what came of it, naming the values involved. */
  detail: string;
  /** The same without the call it names, as the terminal's table shows it under its header. */
  summary: string;
  /** For a failure, the first failing attempt's reason; for an inconclusive one, why. */
  reason: string | null;
  runs: PresetRun[];
  /** The gate its attempts were decided by. */
  gate: PresetGate;
  upstreamRequests: number;
  spent: number;
  /** Attempts its provider failed for real and nobody counted, and those it cut short that the gate counted. Absent when none. */
  unavailable?: number;
  cutShort?: number;
}

export interface ChaosContext {
  store: Store;
  config: Pick<ShadowlapConfig, 'normalize' | 'prices' | 'clock' | 'http' | 'mcp'>;
  cwd: string;
  writes: WritePolicy;
  guard: GuardMode;
  session: string;
  /** The golden the recording is, for `test --chaos`. */
  golden?: string | null;
  /** The command to run instead of the recorded one (`replay --chaos -- <command>`). */
  argv?: string[];
  /** Called as each attempt's replay starts. */
  onRun?: (runId: string, preset: ChaosPreset, attempt: number) => void;
  /** True once a signal arrived: the attempt it cut short returns, and nothing after it starts. */
  stopped?: () => boolean;
  /** The tools `--allow-unrecorded` lets an attempt run again though the recording never recorded them and they write. */
  allowUnrecorded?: ReadonlySet<string>;
  /** Called before the pause that follows an attempt the provider was unavailable for, with how long it is, and whether the attempt is counted. */
  onUnavailable?: (u: Unavailable, waitMs: number, counted: boolean) => void;
  /** How unavailable attempts are retried (UNAVAILABLE_RETRY), and the pause itself: tests pass their own. */
  unavailable?: { inARow: number; firstDelayMs: number; maxDelayMs: number };
  sleep?: (ms: number) => Promise<void>;
  /** Unavailable attempts in a row across the session, whichever presets ran them, which stop it at its limit (`sessionInARow` of its presets). */
  streak?: ProviderStreak | null;
}

type FixedGate = { repeat: number; passes: number };

/** The call a preset hits, as a sentence names it: `lookup_order (#4)`, `model call #5`. */
export function callWords(preset: ChaosPreset, target: { callNo: number; name: string }): string {
  return presetHits(preset) === 'tool' ? `${safeLine(target.name)} (#${target.callNo})` : `model call #${target.callNo}`;
}

/** What a preset did there, as a clause: `timed out`, `answered malformed JSON`. */
function did(preset: ChaosPreset, oversize: number): string {
  switch (preset) {
    case 'timeout':
      return 'timed out';
    case 'empty':
      return 'answered with nothing';
    case 'malformed':
      return 'answered malformed JSON';
    case 'oversized':
      return `answered ${oversize.toLocaleString('en-US')} characters`;
    default:
      return `failed with HTTP ${preset}`;
  }
}

/** Whether the replay played the preset in: a tool call answered by it, or a model call failed with its status. */
function applied(preset: ChaosPreset, target: number, calls: readonly CallRecord[]): boolean {
  if (preset === '429' || preset === '500') return calls.some((c) => c.kind === 'api' && c.end?.meta.injected === true && c.end.meta.status === Number(preset));
  if (preset === 'timeout') return calls.some((c) => c.kind === 'tool' && c.end?.meta.injected === true);
  return calls.some((c) => c.kind === 'tool' && c.end?.meta.overriddenFrom === target);
}

/**
 * What the agent said as it failed, for a crash: the error it died of (`SyntaxError: Unexpected end
 * of JSON input`, `TypeError [ERR_X]: …`, a Python `ValueError: …`), else its last line that says
 * something. The runtime's own lines (Node's version, a stack frame, a caret) say nothing.
 */
export function lastLine(output: string): string | null {
  const lines = output.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('[shadowlap]') && !/^at\s/.test(l) && !/^\^+$/.test(l) && !/^Node\.js v\d/.test(l) && !/^File ".*", line \d+/.test(l));
  const error = [...lines].reverse().find((l) => /^[\w$.]*(Error|Exception|Failure)\w*(?: \[[\w$.]+\])?: \S/.test(l));
  const line = error ?? lines.at(-1) ?? null;
  return line ? safeLine(line).slice(0, 200) : null;
}

function notApplicable(preset: ChaosPreset, why: string, gate: PresetOutcome['gate'], hit: { callNo: number; name: string } | null = null): PresetOutcome {
  const at = hit ? `${callWords(preset, hit)}: ` : '';
  const target = hit ? { kind: presetHits(preset) === 'tool' ? ('tool' as const) : ('api' as const), name: hit.name } : null;
  return { preset, label: PRESET_LABELS[preset], verdict: 'not-applicable', callNo: hit?.callNo ?? null, target, passes: 0, attempts: 0, detail: `${at}${why}`, summary: why, reason: null, runs: [], gate, upstreamRequests: 0, spent: 0 };
}

/**
 * Runs each preset on a recording that is in the store, as forks of it, and keeps each outcome in
 * the session (`store.addChaosResult`) as it is decided. `golden` is the golden's own spec: its
 * `repeat` and `passes` gate a preset when `chaos.gate` doesn't, and the upper bounds its expect
 * sets on write tools judge every attempt when `chaos.expect` doesn't say what an error path must do.
 */
export async function runPresets(parent: RunRecord, golden: TestSpec | null, chaos: ChaosSpec, ctx: ChaosContext): Promise<{ outcomes: PresetOutcome[]; interrupted: boolean; judge: ChaosJudge }> {
  const calls = ctx.store.getCalls(parent.runId);
  const targets = chaosTargets(calls, { tool: chaos.tool });
  const gate: Gate | FixedGate = chaos.gate ?? { repeat: golden?.repeat ?? 1, passes: golden?.passes ?? golden?.repeat ?? 1 };
  const shownGate: PresetOutcome['gate'] = 'kind' in gate ? (gate.kind === 'sprt' ? { good: gate.good, bad: gate.bad, risk: gate.risk, max: gate.max } : { repeat: gate.min, passes: gate.min }) : gate;
  // A fork passes on its checks: here, what an error path must do, judged on every attempt.
  const configured = new Map<string, Effect>(Object.entries<Effect>(ctx.config.mcp?.effects ?? {}));
  const { checks, judge } = chaosJudge(chaos, golden, effectsFor(calls, storeEffects(ctx.store, configured)));
  const forkSpec: TestSpec = { ...(checks ?? { repeat: 1, passes: 1, tools: [] }), fork: true };
  const resultOf = storedResult(ctx.store);
  const outcomes: PresetOutcome[] = [];
  let interrupted = false;
  for (const preset of chaos.presets) {
    if (ctx.stopped?.()) {
      interrupted = true;
      break;
    }
    const hits = presetHits(preset);
    const target = hits === 'tool' ? targets.tool : targets.model;
    if ('none' in target) {
      outcomes.push(record(ctx, parent, notApplicable(preset, target.none, shownGate), judge));
      continue;
    }
    const call = calls.find((c) => c.callNo === target.callNo)!;
    const at = { kind: hits === 'tool' ? ('tool' as const) : ('api' as const), name: target.name };
    let served: { result: unknown } | undefined;
    if (preset === 'empty' || preset === 'malformed' || preset === 'oversized') {
      const made = presetResult(preset, resultOf(call).result, resultShape(call), { oversize: chaos.oversize });
      if (refused(made)) {
        outcomes.push(record(ctx, parent, notApplicable(preset, made.refused, shownGate, target), judge));
        continue;
      }
      served = made;
    }
    const replay = presetReplay(preset, target, served);
    const what = did(preset, chaos.oversize);
    const runs: PresetRun[] = [];
    let passes = 0;
    let upstream = 0;
    let spent = 0;
    let decision: GateDecision = 'continue';
    let unreached: string | null = null;
    // The provider failing for real, as `shadowlap test` reads it: an attempt it cut short after the
    // model answered counted against either verdict, by a sequential gate or the fixed count, one it
    // failed before run again; enough in a row across the session (its streak) stop it, this preset
    // and every one after it.
    const providers = new ProviderRetry({ retry: ctx.unavailable ?? UNAVAILABLE_RETRY, sleep: ctx.sleep ?? ((ms: number) => pause(ms, ctx.stopped)), onUnavailable: ctx.onUnavailable, count: true, streak: ctx.streak ?? null });
    // Attempts that count, and of them those the provider cut short.
    let counted = 0;
    let cut = 0;
    // The session stopped for its provider before this preset's turn: it runs nothing.
    let gaveUp: string | null = ctx.streak?.gaveUp ? sessionUnavailableReason(ctx.streak.inARow, ctx.streak.gaveUp, 'preset') : null;
    while (decision === 'continue' && !gaveUp) {
      if (ctx.stopped?.()) {
        interrupted = true;
        break;
      }
      const attempt: TestAttempt = await testAttempt(ctx.store, parent, {
        cwd: ctx.cwd,
        upstreams: upstreamOverrides(process.env),
        extraEnv: {},
        writes: ctx.writes,
        guard: ctx.guard,
        normalizers: ctx.config.normalize,
        prices: ctx.config.prices,
        clock: ctx.config.clock,
        http: ctx.config.http,
        spec: forkSpec,
        replay,
        meta: { chaos: { preset, callNo: target.callNo, session: ctx.session, attempt: runs.length + 1, ...(ctx.golden ? { golden: ctx.golden } : {}) } },
        ...(ctx.argv ? { argv: ctx.argv } : {}),
        timeoutMs: chaos.timeout * 1000,
        onRun: (runId) => {
          emitJobEvent({ type: 'run', runId, role: 'attempt' });
          ctx.onRun?.(runId, preset, runs.length + 1);
        },
        ...(ctx.stopped ? { onSignal: 'return' as const } : {}),
        ...(ctx.allowUnrecorded ? { allowUnrecorded: ctx.allowUnrecorded } : {}),
      });
      const s = attempt.ended.summary;
      telemetry().record({ type: 'test', ...usageOf(attempt.ended, attempt.ms, attempt.code) });
      upstream += s.upstreamRequests;
      spent += s.cost.spent;
      if (attempt.interrupted) {
        interrupted = true;
        break;
      }
      if (!applied(preset, target.callNo, ctx.store.getCalls(s.runId))) {
        // The replay left the recording before the call the preset hits: nothing was played in.
        unreached = s.divergence
          ? `the replay forked at call ${s.divergence.callNo}, before it reached #${target.callNo}, so the preset was never played in: the recording no longer replays as far as that (shadowlap test says why)`
          : `the replay never reached #${target.callNo}, so the preset was never played in`;
        runs.push({ runId: s.runId, verdict: 'inconclusive', passed: false, exitCode: attempt.code, checks: attempt.checks, reason: unreached, lastLine: null });
        break;
      }
      // The provider failed for real, beyond what the preset played in: no failure of the agent's error path.
      const down = unavailableIn(ctx.store, attempt);
      const after = await providers.after(down);
      if (after === 'stop') {
        // In a row across the session when its streak stopped it, else this preset's own.
        gaveUp = unavailableReason(ctx.streak?.gaveUp ? ctx.streak.inARow : providers.inARow, down!);
        runs.push({ runId: s.runId, verdict: 'inconclusive', unavailable: 'retried', passed: false, exitCode: attempt.code, checks: attempt.checks, reason: gaveUp, lastLine: null });
        break;
      }
      if (after === 'retry') {
        runs.push({ runId: s.runId, verdict: 'inconclusive', unavailable: 'retried', passed: false, exitCode: attempt.code, checks: attempt.checks, reason: `the provider was unavailable (${down!.reason}), so this attempt isn't counted`, lastLine: null });
        continue;
      }
      counted++;
      if (after === 'cut') {
        cut++;
        runs.push({ runId: s.runId, verdict: 'inconclusive', unavailable: 'counted', passed: false, exitCode: attempt.code, checks: attempt.checks, reason: `the provider cut it short (${down!.reason}), counted against either verdict`, lastLine: null });
      } else {
        // A check no attempt can decide (a judge with no verdict, a condition it can't read) says nothing
        // of the agent's error path, and won't on the next attempt either: inconclusive, with why.
        if (attemptVerdict(attempt) === 'inconclusive') {
          unreached = attempt.failure!.message;
          runs.push({ runId: s.runId, verdict: 'inconclusive', passed: false, exitCode: attempt.code, checks: attempt.checks, reason: unreached, lastLine: null });
          break;
        }
        const passed = !attempt.failure;
        if (passed) passes++;
        runs.push({ runId: s.runId, verdict: passed ? 'passed' : 'failed', passed, exitCode: attempt.code, checks: attempt.checks, reason: attempt.failure?.message ?? null, lastLine: attempt.kind === 'exit' ? lastLine(attempt.output) : null });
      }
      decision = 'kind' in gate ? decideUnavailable(passes, counted, cut, gate) : decideCountUnavailable(passes, counted, cut, gate.repeat, gate.passes);
    }
    // The provider unavailable too often stopped it before it decided: inconclusive, the provider named.
    if (gaveUp && decision === 'continue') unreached = gaveUp;
    if (interrupted && decision === 'continue') break;
    const verdict: ChaosVerdict = unreached ? 'inconclusive' : decision === 'pass' ? 'passed' : decision === 'fail' ? 'failed' : 'inconclusive';
    const firstFail = runs.find((r) => r.verdict === 'failed');
    const checks = runs.at(-1)?.checks?.length ?? 0;
    // Under a gate, its bound beside the tally (exact under its stopping, stats.ts); the rule is said once, under the table.
    const bound = presetBound(shownGate, { passes, attempts: counted }, decision, cut);
    const cutWords = cut ? ` (${cut} cut short by the provider, counted against either verdict)` : '';
    const tally = counted > 1 ? `${passes} of ${counted} attempts passed${cutWords}${bound ? ` · ${bound}` : ''}` : null;
    const said = firstFail?.lastLine ? ` (${firstFail.lastLine})` : '';
    const summary = unreached
      ? `${what}: ${unreached}`
      : verdict === 'passed'
        ? `${what}: ${tally ?? `the agent exited 0${checks ? `, ${plural(checks, 'check')} passed` : ''}`}`
        : verdict === 'failed'
          ? `${what}: ${tally ? `${tally}; ` : ''}${firstFail?.reason ?? 'it failed'}`
          : `${what}: ${tally ?? `${passes} of ${counted} passed`}, between the gate's bounds when its ${'kind' in gate && gate.kind === 'sprt' ? gate.max : counted} attempts ran out`;
    outcomes.push(
      record(ctx, parent, {
        preset,
        label: PRESET_LABELS[preset],
        verdict,
        callNo: target.callNo,
        target: at,
        passes,
        // Every attempt but those the provider was unavailable for and nobody counted: one that never
        // reached the call, or whose check could not be decided, ran and said so.
        attempts: runs.filter((r) => r.unavailable !== 'retried').length,
        detail: `${callWords(preset, target)} ${summary}${verdict === 'failed' ? said : ''}`,
        summary,
        reason: verdict === 'failed' ? `${firstFail?.reason ?? 'it failed'}${said}` : unreached,
        runs,
        gate: shownGate,
        upstreamRequests: upstream,
        spent,
        ...(providers.unavailable ? { unavailable: providers.unavailable } : {}),
        ...(cut ? { cutShort: cut } : {}),
      }, judge),
    );
  }
  return { outcomes, interrupted, judge };
}

/** Waits `ms`, or less once `stopped` says a signal came: a pause before another attempt never holds up Ctrl-C. */
async function pause(ms: number, stopped?: () => boolean): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && !stopped?.()) await new Promise<void>((r) => setTimeout(r, Math.min(250, until - Date.now())));
}

/**
 * Keeps an outcome in the session, with what judged it and the attempts its provider cut short (a
 * bound reads them back); a store that refuses it costs the history, not the result.
 */
function record(ctx: ChaosContext, parent: RunRecord, o: PresetOutcome, judge: ChaosJudge): PresetOutcome {
  try {
    ctx.store.addChaosResult({
      sessionId: ctx.session,
      runId: parent.runId,
      golden: ctx.golden ?? null,
      preset: o.preset,
      verdict: o.verdict,
      callNo: o.callNo,
      passes: o.passes,
      attempts: o.attempts,
      data: { target: o.target, detail: o.detail, reason: o.reason, runs: o.runs.map((r) => ({ runId: r.runId, verdict: r.verdict, passed: r.passed, exitCode: r.exitCode, ...(r.checks ? { checks: r.checks } : {}), reason: r.reason, ...(r.lastLine ? { lastLine: r.lastLine } : {}) })), gate: o.gate, upstreamRequests: o.upstreamRequests, spent: o.spent, judge, ...(o.cutShort ? { cutShort: o.cutShort } : {}) },
    });
  } catch (err) {
    process.stderr.write(`[shadowlap] the ${o.label} result was not kept: ${messageOf(err)}\n`);
  }
  return o;
}

// ---- what it reports ----

export interface ChaosRecordingResult {
  golden: string | null;
  /** The recording the presets forked. */
  runId: string | null;
  outcomes: PresetOutcome[];
  /** What judged its presets besides the agent exiting 0; null when they couldn't run. */
  judge: ChaosJudge | null;
  /** Why its presets couldn't run at all (a golden that couldn't be imported, chaos off for it). */
  error: string | null;
  skipped: string | null;
  /** Not run: its recorded command came from a pack the repository doesn't track, and nobody said yes. */
  unvouched?: true;
}

export interface ChaosReport {
  version: 1;
  session: string;
  revision: string | null;
  presets: ChaosPreset[];
  passed: number;
  failed: number;
  inconclusive: number;
  notApplicable: number;
  interrupted: boolean;
  /** Each recording, with the rule its presets were decided by, stated once (recordingRule), or null. */
  results: Array<ChaosRecordingResult & { rule: string | null }>;
}

export function chaosReport(results: ChaosRecordingResult[], o: { session: string; revision: string | null; presets: ChaosPreset[]; interrupted: boolean }): ChaosReport {
  const all = results.flatMap((r) => r.outcomes);
  const n = (v: ChaosVerdict) => all.filter((x) => x.verdict === v).length;
  return { version: 1, session: o.session, revision: o.revision, presets: o.presets, passed: n('passed'), failed: n('failed'), inconclusive: n('inconclusive'), notApplicable: n('not-applicable'), interrupted: o.interrupted, results: results.map((r) => ({ ...r, rule: recordingRule(r.outcomes) })) };
}

const VERDICT_WORDS: Readonly<Record<ChaosVerdict, string>> = { passed: 'passed', failed: 'failed', inconclusive: 'inconclusive', 'not-applicable': 'not applicable' };

/**
 * One recording's presets as a table, preset × outcome, under a header that names the calls they
 * hit; a failure's last line is what the agent died of. Under it, the gate, and the checks that
 * judged every attempt besides the agent exiting 0.
 */
export function formatPresets(name: string, outcomes: readonly PresetOutcome[], p: Palette, judge: ChaosJudge | null = null): string {
  const hit = (kind: 'tool' | 'api') => outcomes.find((o) => o.target?.kind === kind && o.callNo !== null);
  const tool = hit('tool');
  const model = hit('api');
  const at = [tool ? `${safeLine(tool.target!.name)} (#${tool.callNo!})` : null, model ? `model call #${model.callNo!}` : null].filter(Boolean).join(' and ');
  const lines = [`${p.yellow('⚡')} ${p.bold(safeLine(name))}: ${plural(outcomes.length, 'error-path preset')}${at ? ` at ${at}` : ''}`];
  const width = Math.max(...outcomes.map((o) => o.label.length));
  // As wide as the longest verdict word the table holds, so a line stays within a terminal's width.
  const words = Math.max(...outcomes.map((o) => VERDICT_WORDS[o.verdict].length));
  for (const o of outcomes) {
    const mark = o.verdict === 'passed' ? p.green('✓') : o.verdict === 'failed' ? p.red('✗') : o.verdict === 'inconclusive' ? p.yellow('?') : p.dim('–');
    const word = VERDICT_WORDS[o.verdict];
    const verdict = o.verdict === 'passed' ? p.green(word) : o.verdict === 'failed' ? p.red(word) : o.verdict === 'inconclusive' ? p.yellow(word) : p.dim(word);
    lines.push(`  ${mark} ${o.label.padEnd(width)}  ${verdict}${' '.repeat(words - word.length + 2)}${o.verdict === 'not-applicable' ? p.dim(safeLine(o.summary)) : safeLine(o.summary)}`);
    const said = o.verdict === 'failed' ? o.runs.find((r) => r.verdict === 'failed')?.lastLine : null;
    if (said) lines.push(p.dim(`      ${safeLine(said)}`));
  }
  const rule = recordingRule(outcomes);
  if (rule) lines.push(p.dim(`  ${rule}`));
  if (outcomes.some((o) => o.attempts > 0) && judge && judge.source !== 'exit') lines.push(p.dim(`  checks: ${judge.checks.map(safeLine).join('; ')} (${JUDGED_FROM[judge.source]})`));
  return lines.join('\n');
}

/** The session's totals, as the last line says them. */
export function chaosTotals(r: ChaosReport, upstreamRequests: number, spent: number): string {
  const parts = [`${r.passed} passed`, `${r.failed} failed`, ...(r.inconclusive ? [`${r.inconclusive} inconclusive`] : []), ...(r.notApplicable ? [`${r.notApplicable} not applicable`] : [])];
  return `${parts.join(', ')} · ${plural(upstreamRequests, 'upstream request')}${spent ? ` · ≈${formatUsd(spent)} spent` : ''}`;
}

/** One attempt as a JUnit failure's details list it, by its own verdict: `attempt 2 (run 01J…): inconclusive: <why>`. */
const attemptLine = (run: PresetRun, i: number) => `attempt ${i + 1} (run ${run.runId}): ${run.verdict === 'passed' ? 'passed' : `${run.verdict}${run.reason ? `: ${run.reason}` : ''}`}`;

/**
 * Each preset of each recording as a JUnit case: a failed one fails, and an inconclusive one fails
 * when CI counts it as failing, else is skipped: neither passed nor failed, as a golden's case is. A
 * CI shows each case on its own, so one a sequential gate decided states the gate's rule after its
 * tally and bound, in its message and its output. A failure's details list each attempt by
 * its own verdict: an attempt that never played the preset in, or that only a check no attempt can
 * decide kept from passing, is inconclusive there too, whatever CI makes of the preset.
 */
export function chaosJunit(results: readonly ChaosRecordingResult[], o: { inconclusive: 'fail' | 'warn' }): JunitCase[] {
  return results.flatMap((r) => {
    const classname = r.golden ?? r.runId ?? 'recording';
    if (r.error) return [{ name: 'error-path presets', classname, timeSeconds: 0, failure: { message: r.error, details: r.error } }];
    return r.outcomes.map((x): JunitCase => {
      const rule = presetRule(x);
      const said = rule ? `${x.detail} · ${rule}` : x.detail;
      const message = `${VERDICT_WORDS[x.verdict]}: ${said}`;
      const fails = x.verdict === 'failed' || (x.verdict === 'inconclusive' && o.inconclusive === 'fail');
      const verdict = fails ? { failure: { message, details: x.runs.map(attemptLine).join('\n') } } : x.verdict === 'inconclusive' ? { skipped: { message } } : {};
      return { name: x.label, classname, timeSeconds: 0, ...verdict, systemOut: said };
    });
  });
}

/**
 * A Markdown table for a CI job summary: each recording, each preset, its verdict and what came of
 * it. Under the table, the rule of each sequential gate that decided presets, stated once: alone
 * when one gate decided every recording's, else after the recordings it decided.
 */
export function chaosMarkdown(r: ChaosReport): string {
  const cell = (s: string) => safeLine(s).replace(/\|/g, '\\|');
  const lines = ['## Shadowlap error-path presets', '', `${r.passed} passed · ${r.failed} failed${r.inconclusive ? ` · ${r.inconclusive} inconclusive` : ''}${r.notApplicable ? ` · ${r.notApplicable} not applicable` : ''}`, '', '| Recording | Preset | Verdict | What came of it |', '|---|---|---|---|'];
  // A recording whose presets couldn't run has no verdict: the Verdict column keeps the four words.
  const apart: string[] = [];
  const rules = new Map<string, string[]>();
  let decided = 0;
  for (const res of r.results) {
    const name = cell(res.golden ?? res.runId ?? '');
    if (res.error || res.skipped) {
      apart.push(`- ${name}: ${res.error ? `not run: ${cell(res.error)}` : `skipped: ${cell(res.skipped ?? '')}`}`);
      continue;
    }
    for (const x of res.outcomes) lines.push(`| ${name} | ${cell(x.label)} | ${VERDICT_WORDS[x.verdict]} | ${cell(x.detail)} |`);
    if (res.outcomes.some((x) => x.attempts > 0)) decided++;
    if (res.rule) rules.set(res.rule, [...(rules.get(res.rule) ?? []), name]);
  }
  // A blank line ends the table: a line right under it would be read as one more row.
  const grouped = [...rules];
  if (grouped.length === 1 && grouped[0]![1].length === decided) lines.push('', cell(grouped[0]![0]));
  else if (grouped.length) lines.push('', ...grouped.map(([rule, names]) => `- ${names.join(', ')}: ${cell(rule)}`));
  if (apart.length) lines.push('', ...apart);
  return `${lines.join('\n')}\n`;
}
