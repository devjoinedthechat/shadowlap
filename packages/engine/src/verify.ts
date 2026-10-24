import { probeVerdict } from './blame.js';
import { agentCallsOf } from './judge-scope.js';
import { baselineShort, describeBaselineRule, dropBound, type BaselineDecision, type BaselineRule, type BaselineSource, type DropBound } from './noninferiority.js';
import { formatUsd } from './prices.js';
import { atLeast, atMost, decide, describeGate, percent, wilsonBound, type GateDecision, type GateResult, type SprtGate } from './stats.js';
import type { Palette } from './report.js';
import { plain } from './report.js';
import { safeLine } from './text.js';
import type { CallRecord } from './types.js';

/**
 * Whether a change does what it was made for without breaking what worked. Three kinds of recorded
 * run go in, each replayed under the change, several times where the replay forks:
 *
 * - **target** runs failed, and the change was written to fix them;
 * - **held-out** runs failed the same way, and whoever wrote the change never looked at them, so a
 *   fix that only fits the runs it was written against shows up here;
 * - **good** runs passed, and must still pass.
 *
 * A target or held-out run passes or fails on its attempts as a gate decides after each one
 * (stats.ts): by default it tells a run that meets the oracle 90% of the time or more from one that
 * meets it 70% or less, each verdict wrong at most 5% of the time at those two rates, and is
 * inconclusive when the gate's attempts run out between them. "Fixed" stays absolute: the run passes
 * the gate. A fixed count (`needed` of `attempts`) still decides when one is given.
 *
 * A good run is kept relative to its own baseline (noninferiority.ts): not worse than the same run
 * under the code before the change by `margin` or more, each attempt of the change paired with one
 * of the baseline's, or against its golden's history. A run that drops by the margin or more is kept
 * at most `risk` of the time, whatever its baseline's own pass rate. Where no baseline can be had (no
 * git repository, no change to compare with, no history), a good run falls back to the gate on its
 * own, and the report says so.
 *
 * The change is accepted only when every failing run is fixed and every good run kept. A replay
 * that forks nowhere served every call from the recording, so it would come out the same every time:
 * one attempt settles it, which is what makes checking a harness fix, or the good runs a prompt
 * change doesn't touch, free.
 */

export type VerifyRole = 'target' | 'holdout' | 'good';
export type RunVerdict = 'pass' | 'fail' | 'open';

/**
 * What a run would cost to run live: its model requests whatever their origin, as budget checks
 * count them. The agent's: a judge check's calls are none of what a change to the agent costs.
 */
export interface Footprint {
  /** Uncached input, cache reads and cache writes. */
  inputTokens: number;
  outputTokens: number;
  /** USD, or null when a model has no price. */
  cost: number | null;
}

export function footprintOf(calls: readonly CallRecord[], costOf: (c: CallRecord) => number | null): Footprint {
  let inputTokens = 0;
  let outputTokens = 0;
  let cost: number | null = 0;
  for (const c of agentCallsOf(calls)) {
    const u = c.kind === 'api' ? c.end?.meta.usage : undefined;
    if (!u) continue;
    inputTokens += u.inputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
    outputTokens += u.outputTokens;
    const usd = costOf(c);
    cost = usd === null || cost === null ? null : cost + usd;
  }
  return { inputTokens, outputTokens, cost };
}

export interface VerifyAttempt {
  runId: string;
  passed: boolean;
  /**
   * How it came out: inconclusive when all it fell short on is a check that could not be decided (a
   * judge that could not answer, a condition it could not read), which says nothing of the change.
   * Absent from reports made before attempts had one.
   */
  verdict?: 'passed' | 'failed' | 'inconclusive';
  exitCode: number;
  failures: string[];
  /** Where the attempt forked, or null when it replayed clean. */
  forkedAt: number | null;
  spent: number;
  upstreamRequests: number;
  footprint: Footprint;
}

export interface VerifiedRun {
  runId: string;
  role: VerifyRole;
  attempts: VerifyAttempt[];
  passes: number;
  /** The first attempt replayed clean, so every attempt would have come out the same. */
  deterministic: boolean;
  /** `open` while unsettled, and for a gate that ended inconclusive (`decision` says which). */
  verdict: RunVerdict;
  /** A gate decided the run: what it said last, inconclusive included. Absent when a fixed count did, and in reports made before gates. */
  decision?: GateDecision;
  /** A gate decided the run: its result, with the pass rate's interval and the risk it was decided at (stats.ts). */
  gate?: GateResult | null;
  /** How the recording itself fares against the oracle; `passed` is null when the recording can't settle it. */
  recorded: { passed: boolean | null; failures: string[]; footprint: Footprint };
  /**
   * Why its last attempt could not be judged, when all it fell short on was a check no attempt could
   * decide: the run stopped there, inconclusive, as no attempt after it would say more. Null or absent
   * otherwise.
   */
  undecided?: string | null;
  /**
   * A good run decided against its own baseline: the baseline's passes and attempts, where they came
   * from (the same run at the base revision, paired with the change's attempts, or its golden's test
   * history), and the revision it ran at. Absent for a target or held-out run, a clean replay, a run
   * with no baseline, and in reports made before baselines.
   */
  baseline?: { passes: number; attempts: number; source: BaselineSource; revision?: string | null };
  /** The drop from its baseline that breaks it (0.1 is 10 points), with `baseline`. */
  margin?: number;
  /** With `baseline`: a confidence interval for the drop from the baseline, each end valid whenever the test stopped. */
  drop?: DropBound | null;
  /** With a paired baseline: the baseline's attempts, each the run at the base revision. */
  baselineRuns?: VerifyAttempt[];
  /** A good run judged by its gate on its own: why it had no baseline. Absent otherwise. */
  noBaseline?: string | null;
}

/** A run's verdict after `done` attempts. A deterministic run is settled by its first. */
export function runVerdict(passes: number, done: number, attempts: number, needed: number, deterministic: boolean): RunVerdict {
  if (deterministic && done > 0) return passes > 0 ? 'pass' : 'fail';
  const v = probeVerdict(passes, done, attempts, needed);
  return v === 'rescued' ? 'pass' : v === 'lost' ? 'fail' : 'open';
}

/**
 * A run's verdict under a gate after `done` attempts, `passes` of which passed: a deterministic run
 * is settled by its first, else the gate decides. `open` while it continues, and for an
 * inconclusive gate, which `decision` tells apart.
 */
export function gateVerdict(passes: number, done: number, gate: SprtGate, deterministic: boolean): { verdict: RunVerdict; decision: GateDecision } {
  const decision: GateDecision = deterministic && done > 0 ? (passes > 0 ? 'pass' : 'fail') : decide(passes, done, gate);
  return { verdict: decision === 'pass' ? 'pass' : decision === 'fail' ? 'fail' : 'open', decision };
}

/**
 * A good run's verdict from the test against its baseline: kept passes it, broken fails it, and an
 * inconclusive test, or one still going, leaves it open.
 */
export function keptVerdict(decision: BaselineDecision): { verdict: RunVerdict; decision: GateDecision } {
  if (decision === 'kept') return { verdict: 'pass', decision: 'pass' };
  if (decision === 'broken') return { verdict: 'fail', decision: 'fail' };
  return { verdict: 'open', decision };
}

export type VerifyOutcome = 'accepted' | 'rejected' | 'incomplete';

export interface VerifyDecision {
  verdict: VerifyOutcome;
  /** Why it was not accepted, a run at a time. */
  reasons: string[];
  /** What the evidence lacks: no good runs, no held-out runs, runs whose recording contradicts their role. */
  warnings: string[];
}

const ROLE: Record<VerifyRole, string> = { target: 'target', holdout: 'held-out', good: 'good' };
const short = (id: string) => id.slice(0, 10);

/** What happened to a run, in the words of its role: fixed or not, kept or broken; or that its gate couldn't tell, or an attempt couldn't be judged. */
export function outcomeOf(r: Pick<VerifiedRun, 'role' | 'verdict'> & { decision?: GateDecision | undefined; undecided?: string | null | undefined }): 'fixed' | 'not fixed' | 'kept' | 'broken' | 'unsettled' | 'inconclusive' {
  if (r.verdict === 'open') return r.decision === 'inconclusive' || r.undecided ? 'inconclusive' : 'unsettled';
  if (r.role === 'good') return r.verdict === 'pass' ? 'kept' : 'broken';
  return r.verdict === 'pass' ? 'fixed' : 'not fixed';
}

/**
 * A good run against its baseline: both tallies, and the bound on the drop that bears on its
 * verdict: `38 of 38 passed, baseline 38 of 38 · drop <= 0.10 (95%)`.
 */
export function keptTally(r: Pick<VerifiedRun, 'passes' | 'attempts' | 'drop' | 'decision'>, b: NonNullable<VerifiedRun['baseline']>): string {
  const bound = r.drop ? dropBound(r.drop, r.decision) : null;
  return `${r.passes} of ${r.attempts.length} passed, baseline ${b.passes} of ${b.attempts}${bound ? ` · ${bound}` : ''}`;
}

/**
 * A run's tally, and under a gate the Wilson bound at the confidence it decided at: `12 of 12 passed
 * · rate >= 0.76 (95%)`. An attempt that could not be judged is counted apart, never as one that
 * failed, and a gate it stopped before deciding gives no bound: `2 of 2 passed, attempt 3 not judged`.
 */
function tally(r: VerifiedRun): string {
  if (r.undecided) {
    const judged = r.attempts.filter((a) => a.verdict !== 'inconclusive').length;
    return `${judged ? `${r.passes} of ${judged} passed, ` : ''}attempt ${r.attempts.length} not judged`;
  }
  if (r.deterministic) return 'clean replay';
  if (r.baseline) return keptTally(r, r.baseline);
  const g = r.gate;
  const bound = g && r.attempts.length ? wilsonBound(g) : null;
  return `${r.passes} of ${r.attempts.length} passed${bound ? ` · ${bound}` : ''}`;
}

/**
 * Whether a reason `decideVerify` gives says a run is inconclusive or not settled, rather than that the
 * change failed it: a report marks it in amber, as it does the run's outcome, never in red.
 */
export function unsettledReason(reason: string): boolean {
  return /^(?:target|held-out|good) run \S+ inconclusive: /.test(reason) || /^\d+ runs? not settled\b/.test(reason);
}

export function decideVerify(runs: readonly VerifiedRun[], stopReason: string | null): VerifyDecision {
  const reasons: string[] = [];
  for (const r of runs) {
    if (r.verdict !== 'fail') continue;
    const why = r.attempts.find((a) => !a.passed)?.failures[0];
    reasons.push(`${ROLE[r.role]} run ${short(r.runId)} ${outcomeOf(r)}: ${tally(r)}${why ? ` (${why})` : ''}`);
  }
  // A gate that ran out of attempts between its bounds settled nothing either, and says so apart; so
  // does a run whose attempt could not be judged, which is no failure of the change.
  for (const r of runs) if (r.decision === 'inconclusive' && !r.undecided) reasons.push(`${ROLE[r.role]} run ${short(r.runId)} inconclusive: ${tally(r)}, ${r.baseline ? 'neither kept nor broken against its baseline when its pairs ran out' : "between the gate's bounds when its attempts ran out"}`);
  for (const r of runs) if (r.undecided) reasons.push(`${ROLE[r.role]} run ${short(r.runId)} inconclusive: attempt ${r.attempts.length} could not be judged: ${r.undecided}`);
  const open = runs.filter((r) => r.verdict === 'open' && r.decision !== 'inconclusive' && !r.undecided);
  if (open.length) reasons.push(`${open.length} run${open.length === 1 ? '' : 's'} not settled${stopReason ? `: ${stopReason}` : ''}`);

  const warnings: string[] = [];
  for (const r of runs) {
    if (r.role !== 'good' && r.recorded.passed === true) warnings.push(`${ROLE[r.role]} run ${short(r.runId)} already passes as recorded, so fixing it proves nothing`);
    if (r.role === 'good' && r.recorded.passed === false) warnings.push(`good run ${short(r.runId)} fails as recorded (${r.recorded.failures[0]}), so it is not a good run`);
  }
  // A good run that forked with no baseline to compare with was judged by its gate on its own.
  const alone = runs.filter((r) => r.role === 'good' && r.noBaseline);
  if (alone.length) warnings.push(`${alone.length === 1 ? `good run ${short(alone[0]!.runId)} was` : `${alone.length} good runs were`} judged by the gate on ${alone.length === 1 ? 'its' : 'their'} own, not against the code before the change: ${alone[0]!.noBaseline}`);
  const has = (role: VerifyRole) => runs.some((r) => r.role === role);
  if (!has('good')) warnings.push('no good runs: nothing was checked for regressions (--keeps label:good)');
  if (has('target') && !has('holdout')) warnings.push('no held-out runs: the change was only tried on the runs it was written for (--holdout)');

  const failed = runs.some((r) => r.verdict === 'fail');
  const unsettled = runs.some((r) => r.verdict === 'open');
  return { verdict: failed ? 'rejected' : unsettled ? 'incomplete' : 'accepted', reasons, warnings };
}

export interface VerifyReport extends VerifyDecision {
  runs: VerifiedRun[];
  /** The most attempts a run takes: the gate's `max`, or the fixed count. */
  attemptsPerRun: number;
  /** The passes a run needs: the fixed count's, or with a gate the fewest that can pass it (12 at 0.9, 0.7, 0.05). */
  needed: number;
  /** The gate each run was decided by; null when a fixed count (`needed` of `attemptsPerRun`) decided. Absent in reports made before gates. */
  gate?: SprtGate | null;
  oracle: string[];
  /** Request fields the change sets from each run's first model call; empty when the change is all in the code. */
  fields: Record<string, unknown>;
  /** The code the change was verified at. */
  codeVersion: string | null;
  attempts: number;
  spent: number;
  upstreamRequests: number;
  /** What its judge checks' calls cost, apart from `spent` and `upstreamRequests`: only when a judge was asked. */
  judge?: { spent: number; upstreamRequests: number };
  unknownModels: string[];
  stopReason: string | null;
  /** What the replays warned about: a tool that changed since its recording (and so needs --live-tool), a connection that bypassed Shadowlap. */
  replayWarnings: string[];
  /**
   * The rule good runs were kept by, stated once: against what (`source`, and for a paired baseline
   * the base revision and how reports name it), the margin, the risk and the most pairs or attempts.
   * Null when no good run was verified against a baseline; absent in reports made before baselines.
   */
  kept?: (BaselineRule & { source: BaselineSource; revision?: string | null; label?: string | null }) | null;
}

/** What the settled runs would cost live, as recorded and under the change (the mean of each run's attempts). */
export function footprintDelta(runs: readonly VerifiedRun[]): { runs: number; recorded: Footprint; now: Footprint } | null {
  const measured = runs.filter((r) => r.attempts.length > 0);
  if (!measured.length) return null;
  const add = (a: Footprint, b: Footprint): Footprint => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cost: a.cost === null || b.cost === null ? null : a.cost + b.cost });
  const zero: Footprint = { inputTokens: 0, outputTokens: 0, cost: 0 };
  let recorded = zero;
  let now = zero;
  for (const r of measured) {
    recorded = add(recorded, r.recorded.footprint);
    const sum = r.attempts.reduce((acc, a) => add(acc, a.footprint), zero);
    const n = r.attempts.length;
    now = add(now, { inputTokens: sum.inputTokens / n, outputTokens: sum.outputTokens / n, cost: sum.cost === null ? null : sum.cost / n });
  }
  const per = (f: Footprint): Footprint => ({ inputTokens: f.inputTokens / measured.length, outputTokens: f.outputTokens / measured.length, cost: f.cost === null ? null : f.cost / measured.length });
  return { runs: measured.length, recorded: per(recorded), now: per(now) };
}

/** Tokens precise enough to compare: `formatTokens` rounds 1,000 and 1,040 to the same 1k. */
const tokens = (n: number) => (n < 10_000 ? Math.round(n).toLocaleString('en-US') : n < 1_000_000 ? `${(n / 1_000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`);

const pct = (before: number, after: number) => {
  if (before === 0) return after === 0 ? '±0%' : 'new';
  const d = ((after - before) / before) * 100;
  return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d) < 10 ? Math.abs(d).toFixed(1) : Math.round(Math.abs(d))}%`;
};

/**
 * How a run is judged, in a sentence: the oracle, and the rule that decides on its attempts. With a
 * gate, `… Its gate decides after each attempt (gate: tells 90%+ from 70%- at <= 5% risk, up to 80
 * attempts); a clean replay settles it in one.`
 */
export function verifyRule(r: Pick<VerifyReport, 'needed' | 'attemptsPerRun' | 'gate' | 'fields' | 'oracle'> & { kept?: VerifyReport['kept'] }): string {
  const fields = Object.entries(r.fields);
  const change = fields.length ? `, with ${fields.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')} from each run's first model call` : '';
  const oracle = r.oracle.map(safeLine).join('; ');
  const kept = r.kept ? ` A good run that forks is ${describeBaselineRule({ ...r.kept, revision: r.kept.label ?? r.kept.revision ?? null })}.` : '';
  if (r.gate) return `A run's attempts must meet the oracle${change}: ${oracle}. Its gate decides after each attempt (gate: ${describeGate(r.gate)}); a clean replay settles it in one.${kept}`;
  return `A run passes when ${r.needed} of ${r.attemptsPerRun} attempts meet the oracle${change}: ${oracle}.${kept}`;
}

/** A gate's rule in a few words, for a step's line: `tells 90%+ from 70%- at <= 5% risk`. */
export function gateShort(g: Pick<SprtGate, 'good' | 'bad' | 'risk'>): string {
  return `tells ${atLeast(g.good)} from ${atMost(g.bad)} at <= ${percent(g.risk)} risk`;
}

/**
 * How each run was decided, after a tally of runs: `each at 4 of 5 attempts`, or `each by its gate,
 * which tells 90%+ from 70%- at <= 5% risk`. When good runs were kept against their baseline, both
 * rules: `each failing run by its gate, which tells 90%+ from 70%- at <= 5% risk, and each good one
 * against its baseline, which tells no drop from one of 10+ points at <= 5% risk`.
 */
export function eachRun(v: Pick<VerifyReport, 'needed' | 'attemptsPerRun' | 'gate'> & { kept?: VerifyReport['kept'] }): string {
  if (!v.gate) return `each at ${v.needed} of ${v.attemptsPerRun} attempts`;
  const gate = `by its gate, which ${gateShort(v.gate)}`;
  if (!v.kept) return `each ${gate}`;
  return `each failing run ${gate}, and each good one against ${v.kept.source === 'history' ? "its golden's history" : 'its baseline'}, which ${baselineShort(v.kept)}`;
}

export function formatVerify(r: VerifyReport, p: Palette = plain): string {
  const lines: string[] = [];
  const count = (role: VerifyRole) => {
    const of = r.runs.filter((x) => x.role === role);
    return { of: of.length, ok: of.filter((x) => x.verdict === 'pass').length, unsure: of.filter((x) => outcomeOf(x) === 'inconclusive').length };
  };
  const t = count('target');
  const h = count('holdout');
  const g = count('good');
  // A run that is inconclusive is neither fixed nor kept, nor one the change failed: counted apart.
  const unsure = (c: { unsure: number }) => (c.unsure ? ` (${c.unsure} inconclusive)` : '');
  const parts = [
    t.of ? `fixes ${t.ok} of ${t.of} target run${t.of === 1 ? '' : 's'}${unsure(t)}` : '',
    h.of ? `${t.of ? '' : 'fixes '}${h.ok} of ${h.of} held-out run${h.of === 1 ? '' : 's'}${unsure(h)}` : '',
    g.of ? `keeps ${g.ok} of ${g.of} good run${g.of === 1 ? '' : 's'}${unsure(g)}` : '',
  ].filter(Boolean);
  const sentence = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? 'no runs');
  const head = r.verdict === 'accepted' ? `${p.green('✓')} ${p.bold('Accepted')}` : r.verdict === 'rejected' ? `${p.red('✗')} ${p.bold('Rejected')}` : `${p.yellow('!')} ${p.bold('Incomplete')}`;
  lines.push(`${head}: the change ${sentence}`);
  // What the change failed in red; a run it could not settle, inconclusive or not settled, in amber.
  for (const reason of r.reasons) lines.push(`  ${unsettledReason(reason) ? p.yellow('·') : p.red('·')} ${safeLine(reason)}`);

  lines.push('', p.dim(`  ${verifyRule(r)}`));

  if (r.runs.length) {
    lines.push('');
    const outcomeWidth = Math.max(...r.runs.map((x) => outcomeOf(x).length));
    for (const x of r.runs) {
      const o = outcomeOf(x);
      const colored = o === 'fixed' || o === 'kept' ? p.green(o.padEnd(outcomeWidth)) : o === 'unsettled' || o === 'inconclusive' ? p.yellow(o.padEnd(outcomeWidth)) : p.red(o.padEnd(outcomeWidth));
      const failure = x.verdict === 'fail' ? x.attempts.find((a) => !a.passed)?.failures[0] : (x.undecided ?? undefined);
      const forks = [...new Set(x.attempts.map((a) => a.forkedAt).filter((f): f is number => f !== null))];
      const note = failure ? safeLine(failure) : forks.length ? `forked at ${forks.map((f) => `#${f}`).join(', ')}` : '';
      const width = r.gate ? (r.kept ? 64 : 38) : 14;
      lines.push(`    ${ROLE[x.role].padEnd(8)}  ${short(x.runId)}  ${colored}  ${tally(x).padEnd(width)}${note ? `  ${p.dim(note)}` : ''}`.trimEnd());
    }
  }

  if (r.warnings.length || r.replayWarnings.length) {
    lines.push('');
    for (const w of [...r.warnings, ...r.replayWarnings]) lines.push(`  ${p.yellow('!')} ${safeLine(w)}`);
  }

  lines.push('');
  const d = footprintDelta(r.runs);
  if (d) {
    const input = `${tokens(d.recorded.inputTokens)} → ${tokens(d.now.inputTokens)} input tokens (${pct(d.recorded.inputTokens, d.now.inputTokens)})`;
    const cost = d.recorded.cost !== null && d.now.cost !== null ? ` · ≈${formatUsd(d.recorded.cost)} → ≈${formatUsd(d.now.cost)} (${pct(d.recorded.cost, d.now.cost)})` : '';
    lines.push(p.dim(`  per run, as it would run live: ${input}${cost}`));
  }
  const unpriced = r.unknownModels.length ? ` (no price for ${r.unknownModels.map(safeLine).join(', ')})` : '';
  const judged = r.judge ? ` · judge checks: ${r.judge.upstreamRequests} upstream request${r.judge.upstreamRequests === 1 ? '' : 's'}, ≈${formatUsd(r.judge.spent)}` : '';
  lines.push(p.dim(`  verifying: ${r.attempts} attempt${r.attempts === 1 ? '' : 's'} · ${r.upstreamRequests} upstream requests · ≈${formatUsd(r.spent)} spent${unpriced}${judged}${r.codeVersion ? ` · code ${safeLine(r.codeVersion)}` : ''}`));
  return lines.join('\n');
}
