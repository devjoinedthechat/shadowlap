import { probeVerdict } from './blame.js';
import { formatUsd } from './prices.js';
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
 * A run passes when enough of its attempts meet the oracle. The change is accepted only when every
 * failing run is fixed and every good run kept. A replay that forks nowhere served every call from
 * the recording, so it would come out the same every time: one attempt settles it, which is what
 * makes checking a harness fix, or the good runs a prompt change doesn't touch, free.
 */

export type VerifyRole = 'target' | 'holdout' | 'good';
export type RunVerdict = 'pass' | 'fail' | 'open';

/** What a run would cost to run live: its model requests whatever their origin, as budget checks count them. */
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
  for (const c of calls) {
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
  verdict: RunVerdict;
  /** How the recording itself fares against the oracle; `passed` is null when the recording can't settle it. */
  recorded: { passed: boolean | null; failures: string[]; footprint: Footprint };
}

/** A run's verdict after `done` attempts. A deterministic run is settled by its first. */
export function runVerdict(passes: number, done: number, attempts: number, needed: number, deterministic: boolean): RunVerdict {
  if (deterministic && done > 0) return passes > 0 ? 'pass' : 'fail';
  const v = probeVerdict(passes, done, attempts, needed);
  return v === 'rescued' ? 'pass' : v === 'lost' ? 'fail' : 'open';
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

/** What happened to a run, in the words of its role: fixed or not, kept or broken. */
export function outcomeOf(r: Pick<VerifiedRun, 'role' | 'verdict'>): 'fixed' | 'not fixed' | 'kept' | 'broken' | 'unsettled' {
  if (r.verdict === 'open') return 'unsettled';
  if (r.role === 'good') return r.verdict === 'pass' ? 'kept' : 'broken';
  return r.verdict === 'pass' ? 'fixed' : 'not fixed';
}

function tally(r: VerifiedRun): string {
  if (r.deterministic) return 'clean replay';
  return `${r.passes} of ${r.attempts.length} passed`;
}

export function decideVerify(runs: readonly VerifiedRun[], stopReason: string | null): VerifyDecision {
  const reasons: string[] = [];
  for (const r of runs) {
    if (r.verdict !== 'fail') continue;
    const why = r.attempts.find((a) => !a.passed)?.failures[0];
    reasons.push(`${ROLE[r.role]} run ${short(r.runId)} ${outcomeOf(r)}: ${tally(r)}${why ? ` (${why})` : ''}`);
  }
  const open = runs.filter((r) => r.verdict === 'open');
  if (open.length) reasons.push(`${open.length} run${open.length === 1 ? '' : 's'} not settled${stopReason ? `: ${stopReason}` : ''}`);

  const warnings: string[] = [];
  for (const r of runs) {
    if (r.role !== 'good' && r.recorded.passed === true) warnings.push(`${ROLE[r.role]} run ${short(r.runId)} already passes as recorded, so fixing it proves nothing`);
    if (r.role === 'good' && r.recorded.passed === false) warnings.push(`good run ${short(r.runId)} fails as recorded (${r.recorded.failures[0]}), so it is not a good run`);
  }
  const has = (role: VerifyRole) => runs.some((r) => r.role === role);
  if (!has('good')) warnings.push('no good runs: nothing was checked for regressions (--keeps label:good)');
  if (has('target') && !has('holdout')) warnings.push('no held-out runs: the change was only tried on the runs it was written for (--holdout)');

  const failed = runs.some((r) => r.verdict === 'fail');
  return { verdict: failed ? 'rejected' : open.length ? 'incomplete' : 'accepted', reasons, warnings };
}

export interface VerifyReport extends VerifyDecision {
  runs: VerifiedRun[];
  attemptsPerRun: number;
  needed: number;
  oracle: string[];
  /** Request fields the change sets from each run's first model call; empty when the change is all in the code. */
  fields: Record<string, unknown>;
  /** The code the change was verified at. */
  codeVersion: string | null;
  attempts: number;
  spent: number;
  upstreamRequests: number;
  unknownModels: string[];
  stopReason: string | null;
  /** What the replays warned about: a tool that changed since its recording (and so needs --live-tool), a connection that bypassed Shadowlap. */
  replayWarnings: string[];
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

export function formatVerify(r: VerifyReport, p: Palette = plain): string {
  const lines: string[] = [];
  const count = (role: VerifyRole) => {
    const of = r.runs.filter((x) => x.role === role);
    return { of: of.length, ok: of.filter((x) => x.verdict === 'pass').length };
  };
  const t = count('target');
  const h = count('holdout');
  const g = count('good');
  const parts = [
    t.of ? `fixes ${t.ok} of ${t.of} target run${t.of === 1 ? '' : 's'}` : '',
    h.of ? `${t.of ? '' : 'fixes '}${h.ok} of ${h.of} held-out run${h.of === 1 ? '' : 's'}` : '',
    g.of ? `keeps ${g.ok} of ${g.of} good run${g.of === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  const sentence = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? 'no runs');
  const head = r.verdict === 'accepted' ? `${p.green('✓')} ${p.bold('Accepted')}` : r.verdict === 'rejected' ? `${p.red('✗')} ${p.bold('Rejected')}` : `${p.yellow('!')} ${p.bold('Incomplete')}`;
  lines.push(`${head}: the change ${sentence}`);
  for (const reason of r.reasons) lines.push(`  ${p.red('·')} ${safeLine(reason)}`);

  const fields = Object.entries(r.fields);
  const change = fields.length ? `, with ${fields.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')} from each run's first model call` : '';
  lines.push('', p.dim(`  A run passes when ${r.needed} of ${r.attemptsPerRun} attempts meet the oracle${change}: ${r.oracle.map(safeLine).join('; ')}.`));

  if (r.runs.length) {
    lines.push('');
    const outcomeWidth = Math.max(...r.runs.map((x) => outcomeOf(x).length));
    for (const x of r.runs) {
      const o = outcomeOf(x);
      const colored = o === 'fixed' || o === 'kept' ? p.green(o.padEnd(outcomeWidth)) : o === 'unsettled' ? p.yellow(o.padEnd(outcomeWidth)) : p.red(o.padEnd(outcomeWidth));
      const failure = x.verdict === 'fail' ? x.attempts.find((a) => !a.passed)?.failures[0] : undefined;
      const forks = [...new Set(x.attempts.map((a) => a.forkedAt).filter((f): f is number => f !== null))];
      const note = failure ? safeLine(failure) : forks.length ? `forked at ${forks.map((f) => `#${f}`).join(', ')}` : '';
      lines.push(`    ${ROLE[x.role].padEnd(8)}  ${short(x.runId)}  ${colored}  ${tally(x).padEnd(14)}${note ? `  ${p.dim(note)}` : ''}`.trimEnd());
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
  lines.push(p.dim(`  verifying: ${r.attempts} attempt${r.attempts === 1 ? '' : 's'} · ${r.upstreamRequests} upstream requests · ≈${formatUsd(r.spent)} spent${unpriced}${r.codeVersion ? ` · code ${safeLine(r.codeVersion)}` : ''}`));
  return lines.join('\n');
}
