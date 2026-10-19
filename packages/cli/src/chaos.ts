import {
  chaosTargets,
  decide,
  effectsFor,
  formatUsd,
  PRESET_LABELS,
  presetHits,
  presetReplay,
  presetResult,
  refused,
  resultShape,
  safeLine,
  storeEffects,
  type CallRecord,
  type ChaosPreset,
  type ChaosVerdict,
  type Effect,
  type EffectOf,
  type Gate,
  type GateDecision,
  type Palette,
  type RunRecord,
  type Store,
  type WritePolicy,
} from '@shadowlap/engine';
import { type ChaosSpec } from './chaos-config.js';
import { evaluateChecks, type TestSpec } from './checks.js';
import { attemptVerdict } from './golden-test.js';
import { upstreamOverrides, type ShadowlapConfig } from './config.js';
import { storedResult } from './interventions.js';
import { emitJobEvent } from './job-events.js';
import { type JunitCase } from './junit.js';
import { testAttempt, type GuardMode, type TestAttempt } from './run-agent.js';
import { usageOf, telemetry } from './shared.js';

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
 * call), or not applicable (no call the preset can hit).
 */

export interface PresetRun {
  runId: string;
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
  gate: { good: number; bad: number; risk: number; max: number } | { repeat: number; passes: number };
  upstreamRequests: number;
  spent: number;
}

/** What judged a recording's presets besides the agent exiting 0. */
export interface ChaosJudge {
  /**
   * `chaos.expect` (the golden's tests entry), `--expect` (replay --chaos), `write-limits` (the upper
   * bounds the golden's own expect sets on write tools), or `exit` (nothing but the exit status).
   */
  source: 'chaos.expect' | '--expect' | 'write-limits' | 'exit';
  /** The checks, as a failure names them: `issue_refund called at most 1 time`. */
  checks: string[];
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
}

type FixedGate = { repeat: number; passes: number };

/** Today's fixed counts as a decision after each attempt: the same verdict, reached as soon as it can't change. */
function decideFixed(passes: number, attempts: number, g: FixedGate): GateDecision {
  if (passes >= g.passes) return 'pass';
  if (attempts - passes > g.repeat - g.passes) return 'fail';
  return attempts >= g.repeat ? 'fail' : 'continue';
}

/** The gate in words: `pass at 90% or more, fail at 70% or less, at most 5% risk, up to 20 attempts`, or `1 of 1 attempt must pass`. */
export function gateWords(g: PresetOutcome['gate']): string {
  if ('good' in g) return `pass at ${Math.round(g.good * 100)}% or more, fail at ${Math.round(g.bad * 100)}% or less, at most ${Math.round(g.risk * 100)}% risk, up to ${g.max} attempts`;
  return `${g.passes} of ${g.repeat} attempt${g.repeat === 1 ? '' : 's'} must pass`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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

/**
 * The checks every error path must pass when `chaos.expect` doesn't say: the upper bounds the
 * golden's own expect sets on write tools, a tool of unknown effect counted as one. They hold on any
 * path (an agent whose lookup timed out may escalate rather than refund, but never refunds more than
 * the golden allows). A lower bound, or a bound on a read, says what the recorded path did, which a
 * path through a failure needn't do: a read retried after a timeout is the agent doing its job.
 * Null when the golden's expect sets no such bound.
 */
export function writeLimits(golden: TestSpec | null, effectOf: EffectOf): TestSpec | null {
  if (!golden) return null;
  const tools = golden.tools
    .filter((t) => Number.isFinite(t.count.max) && effectOf(t.name) !== 'read' && effectOf(t.name) !== 'pure')
    .map((t) => ({ name: t.name, count: { min: 0, max: t.count.max }, ...(t.args ? { args: t.args } : {}) }));
  return tools.length ? { fork: true, repeat: 1, passes: 1, tools } : null;
}

/** A spec's checks as a failure names them, without running them. */
export function checkLabels(spec: TestSpec): string[] {
  return evaluateChecks(spec, { calls: [], output: '', argsOf: () => undefined, answer: null, costOf: () => null }).map((r) => r.label);
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
  const configured = new Map<string, Effect>(Object.entries(ctx.config.mcp?.effects ?? {}) as Array<[string, Effect]>);
  const limits = chaos.expect ? null : writeLimits(golden, effectsFor(calls, storeEffects(ctx.store, configured)));
  const checks = chaos.expect ?? limits;
  const judge: ChaosJudge = checks ? { source: chaos.expect ? (chaos.expectFrom ?? 'chaos.expect') : 'write-limits', checks: checkLabels(checks) } : { source: 'exit', checks: [] };
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
      outcomes.push(record(ctx, parent, notApplicable(preset, target.none, shownGate)));
      continue;
    }
    const call = calls.find((c) => c.callNo === target.callNo)!;
    const at = { kind: hits === 'tool' ? ('tool' as const) : ('api' as const), name: target.name };
    let served: { result: unknown } | undefined;
    if (preset === 'empty' || preset === 'malformed' || preset === 'oversized') {
      const made = presetResult(preset, resultOf(call).result, resultShape(call), { oversize: chaos.oversize });
      if (refused(made)) {
        outcomes.push(record(ctx, parent, notApplicable(preset, made.refused, shownGate, target)));
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
    while (decision === 'continue') {
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
        runs.push({ runId: s.runId, passed: false, exitCode: attempt.code, checks: attempt.checks, reason: unreached, lastLine: null });
        break;
      }
      // A check no attempt can decide (a judge with no verdict, a condition it can't read) says nothing
      // of the agent's error path, and won't on the next attempt either: inconclusive, with why.
      if (attemptVerdict(attempt) === 'inconclusive') {
        unreached = attempt.failure!.message;
        runs.push({ runId: s.runId, passed: false, exitCode: attempt.code, checks: attempt.checks, reason: unreached, lastLine: null });
        break;
      }
      const passed = !attempt.failure;
      if (passed) passes++;
      runs.push({ runId: s.runId, passed, exitCode: attempt.code, checks: attempt.checks, reason: attempt.failure?.message ?? null, lastLine: attempt.kind === 'exit' ? lastLine(attempt.output) : null });
      decision = 'kind' in gate ? decide(passes, runs.length, gate) : decideFixed(passes, runs.length, gate);
    }
    if (interrupted && decision === 'continue') break;
    const verdict: ChaosVerdict = unreached ? 'inconclusive' : decision === 'pass' ? 'passed' : decision === 'fail' ? 'failed' : 'inconclusive';
    const firstFail = runs.find((r) => !r.passed);
    const checks = runs.at(-1)?.checks?.length ?? 0;
    const tally = runs.length > 1 ? `${passes} of ${runs.length} attempts passed` : null;
    const said = firstFail?.lastLine ? ` (${firstFail.lastLine})` : '';
    const summary = unreached
      ? `${what}: ${unreached}`
      : verdict === 'passed'
        ? `${what}: ${tally ?? `the agent exited 0${checks ? `, ${plural(checks, 'check')} passed` : ''}`}`
        : verdict === 'failed'
          ? `${what}: ${tally ? `${tally}; ` : ''}${firstFail?.reason ?? 'it failed'}`
          : `${what}: ${tally ?? `${passes} of ${runs.length} passed`}, between the gate's bounds when its ${'kind' in gate && gate.kind === 'sprt' ? gate.max : runs.length} attempts ran out`;
    outcomes.push(
      record(ctx, parent, {
        preset,
        label: PRESET_LABELS[preset],
        verdict,
        callNo: target.callNo,
        target: at,
        passes,
        attempts: runs.length,
        detail: `${callWords(preset, target)} ${summary}${verdict === 'failed' ? said : ''}`,
        summary,
        reason: verdict === 'failed' ? `${firstFail?.reason ?? 'it failed'}${said}` : unreached,
        runs,
        gate: shownGate,
        upstreamRequests: upstream,
        spent,
      }),
    );
  }
  return { outcomes, interrupted, judge };
}

/** Keeps an outcome in the session; a store that refuses it costs the history, not the result. */
function record(ctx: ChaosContext, parent: RunRecord, o: PresetOutcome): PresetOutcome {
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
      data: { target: o.target, detail: o.detail, reason: o.reason, runs: o.runs.map((r) => ({ runId: r.runId, passed: r.passed, exitCode: r.exitCode, ...(r.checks ? { checks: r.checks } : {}), reason: r.reason, ...(r.lastLine ? { lastLine: r.lastLine } : {}) })), gate: o.gate as Record<string, unknown>, upstreamRequests: o.upstreamRequests, spent: o.spent },
    });
  } catch (err) {
    process.stderr.write(`[shadowlap] the ${o.label} result was not kept: ${(err as Error).message}\n`);
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
  results: ChaosRecordingResult[];
}

export function chaosReport(results: ChaosRecordingResult[], o: { session: string; revision: string | null; presets: ChaosPreset[]; interrupted: boolean }): ChaosReport {
  const all = results.flatMap((r) => r.outcomes);
  const n = (v: ChaosVerdict) => all.filter((x) => x.verdict === v).length;
  return { version: 1, session: o.session, revision: o.revision, presets: o.presets, passed: n('passed'), failed: n('failed'), inconclusive: n('inconclusive'), notApplicable: n('not-applicable'), interrupted: o.interrupted, results };
}

const VERDICT_WORDS: Readonly<Record<ChaosVerdict, string>> = { passed: 'passed', failed: 'failed', inconclusive: 'inconclusive', 'not-applicable': 'not applicable' };

/** Where checks that judged the presets came from, as the table's last line says it. */
const JUDGED_FROM: Readonly<Record<Exclude<ChaosJudge['source'], 'exit'>, string>> = {
  'chaos.expect': 'chaos.expect',
  '--expect': '--expect',
  'write-limits': "the write limits of the golden's expect",
};

/**
 * One recording's presets as a table, preset × outcome, under a header that names the calls they
 * hit; a failure's last line is what the agent died of. Under it, the gate, and the checks that
 * judged every attempt besides the agent exiting 0.
 */
export function formatPresets(name: string, outcomes: readonly PresetOutcome[], p: Palette, judge: ChaosJudge | null = null): string {
  const hit = (kind: 'tool' | 'api') => outcomes.find((o) => o.target?.kind === kind && o.callNo !== null);
  const tool = hit('tool');
  const model = hit('api');
  const at = [tool ? `${safeLine(tool.target!.name)} (#${tool.callNo})` : null, model ? `model call #${model.callNo}` : null].filter(Boolean).join(' and ');
  const lines = [`${p.yellow('⚡')} ${p.bold(safeLine(name))}: ${plural(outcomes.length, 'error-path preset')}${at ? ` at ${at}` : ''}`];
  const width = Math.max(...outcomes.map((o) => o.label.length));
  // As wide as the longest verdict word the table holds, so a line stays within a terminal's width.
  const words = Math.max(...outcomes.map((o) => VERDICT_WORDS[o.verdict].length));
  for (const o of outcomes) {
    const mark = o.verdict === 'passed' ? p.green('✓') : o.verdict === 'failed' ? p.red('✗') : o.verdict === 'inconclusive' ? p.yellow('?') : p.dim('–');
    const word = VERDICT_WORDS[o.verdict];
    const verdict = o.verdict === 'passed' ? p.green(word) : o.verdict === 'failed' ? p.red(word) : o.verdict === 'inconclusive' ? p.yellow(word) : p.dim(word);
    lines.push(`  ${mark} ${o.label.padEnd(width)}  ${verdict}${' '.repeat(words - word.length + 2)}${o.verdict === 'not-applicable' ? p.dim(safeLine(o.summary)) : safeLine(o.summary)}`);
    const said = o.verdict === 'failed' ? o.runs.find((r) => !r.passed)?.lastLine : null;
    if (said) lines.push(p.dim(`      ${safeLine(said)}`));
  }
  const gated = outcomes.find((o) => o.attempts > 0);
  if (gated && 'good' in gated.gate) lines.push(p.dim(`  gate: ${gateWords(gated.gate)}`));
  if (gated && judge && judge.source !== 'exit') lines.push(p.dim(`  checks: ${judge.checks.map(safeLine).join('; ')} (${JUDGED_FROM[judge.source]})`));
  return lines.join('\n');
}

/** The hint under a table whose presets only the exit status judged: what would say more, in two lines. */
export function judgedOnExit(where: 'chaos.expect' | '--expect'): string {
  const example = `{"tools":{"issue_refund":"<= 1"}}`;
  const first = 'Each preset was judged on the agent exiting 0 alone: no checks say what an error path must do.';
  return where === '--expect' ? `${first}\nSay it with --expect, such as --expect '${example}'.` : `${first}\nSay it in its tests entry, as "chaos": { "expect": ${example} }, or as upper bounds on write tools in its "expect".`;
}

/** The session's totals, as the last line says them. */
export function chaosTotals(r: ChaosReport, upstreamRequests: number, spent: number): string {
  const parts = [`${r.passed} passed`, `${r.failed} failed`, ...(r.inconclusive ? [`${r.inconclusive} inconclusive`] : []), ...(r.notApplicable ? [`${r.notApplicable} not applicable`] : [])];
  return `${parts.join(', ')} · ${plural(upstreamRequests, 'upstream request')}${spent ? ` · ≈${formatUsd(spent)} spent` : ''}`;
}

/** Each preset of each recording as a JUnit case: a failed one fails, an inconclusive one fails when CI counts it as failing. */
export function chaosJunit(results: readonly ChaosRecordingResult[], o: { inconclusive: 'fail' | 'warn' }): JunitCase[] {
  return results.flatMap((r) => {
    const classname = r.golden ?? r.runId ?? 'recording';
    if (r.error) return [{ name: 'error-path presets', classname, timeSeconds: 0, failure: { message: r.error, details: r.error } }];
    return r.outcomes.map((x): JunitCase => {
      const fails = x.verdict === 'failed' || (x.verdict === 'inconclusive' && o.inconclusive === 'fail');
      return { name: x.label, classname, timeSeconds: 0, ...(fails ? { failure: { message: `${VERDICT_WORDS[x.verdict]}: ${x.detail}`, details: x.runs.map((run, i) => `attempt ${i + 1} (run ${run.runId}): ${run.passed ? 'passed' : `failed: ${run.reason ?? ''}`}`).join('\n') } } : {}), systemOut: x.detail };
    });
  });
}

/** A Markdown table for a CI job summary: each recording, each preset, its verdict and what came of it. */
export function chaosMarkdown(r: ChaosReport): string {
  const cell = (s: string) => safeLine(s).replace(/\|/g, '\\|');
  const lines = ['## Shadowlap error-path presets', '', `${r.passed} passed · ${r.failed} failed${r.inconclusive ? ` · ${r.inconclusive} inconclusive` : ''}${r.notApplicable ? ` · ${r.notApplicable} not applicable` : ''}`, '', '| Recording | Preset | Verdict | What came of it |', '|---|---|---|---|'];
  // A recording whose presets couldn't run has no verdict: the Verdict column keeps the four words.
  const apart: string[] = [];
  for (const res of r.results) {
    const name = cell(res.golden ?? res.runId ?? '');
    if (res.error || res.skipped) {
      apart.push(`- ${name}: ${res.error ? `not run: ${cell(res.error)}` : `skipped: ${cell(res.skipped ?? '')}`}`);
      continue;
    }
    for (const x of res.outcomes) lines.push(`| ${name} | ${cell(x.label)} | ${VERDICT_WORDS[x.verdict]} | ${cell(x.detail)} |`);
  }
  if (apart.length) lines.push('', ...apart);
  return `${lines.join('\n')}\n`;
}
