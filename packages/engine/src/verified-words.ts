import { formatUsd } from './prices.js';
import type { Footprint } from './verify.js';

/**
 * How verify found the runs a preview or a migration took, in the words `shadowlap migrate` prints
 * and the dashboard's Preview shows: each run's tally, how many runs ran end to end, what they cost
 * a run end to end, and what a run the preview cleared rests on. No imports but prices: a page may
 * bundle it as it is.
 */

/**
 * A run verify took: its passes of its attempts, under a gate the bound of its pass rate (null for a
 * clean replay or a fixed count), and `undecided`, why its last attempt could not be judged, which
 * stopped it. A good run kept against its baseline has the baseline's tally too.
 */
export interface VerifiedTally {
  passes: number;
  attempts: number;
  bound?: string | null;
  undecided?: string | null;
  baseline?: { passes: number; attempts: number } | null;
}

/**
 * A verified run's tally after its outcome: ` · 12 of 12 · rate >= 0.76 (95%)`, and an attempt that
 * could not be judged apart, never as one that failed: ` · 2 of 2, attempt 3 not judged`. Nothing for
 * a run verify didn't take, or one kept before tallies were.
 */
export function tallyWords(t: VerifiedTally | null | undefined): string {
  if (!t) return '';
  const tally = t.undecided ? `${t.attempts > 1 ? `${t.passes} of ${t.attempts - 1}, ` : ''}attempt ${t.attempts} not judged` : `${t.passes} of ${t.attempts}${t.baseline ? `, baseline ${t.baseline.passes} of ${t.baseline.attempts}` : ''}`;
  return ` · ${tally}${t.bound ? ` · ${t.bound}` : ''}`;
}

/** How verify found a run, after its verdict: `kept, verified · 12 of 12 · rate >= 0.76 (95%)`; an outcome that is the verdict word (inconclusive) is said once. */
export function verifiedWords(x: { verdict: string; outcome: string; tally: VerifiedTally | null }): string {
  return `${x.outcome === x.verdict ? '' : `${x.outcome}, `}verified${tallyWords(x.tally)}`;
}

/** How many of the runs were run end to end: `3 of 4 runs verified end to end`. */
export function verifiedCount(runs: ReadonlyArray<{ verified: boolean }>): string {
  const all = runs.length;
  return `${runs.filter((x) => x.verified).length} of ${all} run${all === 1 ? '' : 's'} verified end to end`;
}

/** How far a figure moved, after it: ` (+25%)`, ` (−50%)`; nothing when either is unknown or it started at 0. */
export const changePct = (a: number | null, b: number | null): string => (a === null || b === null ? '' : a === 0 ? '' : ` (${b >= a ? '+' : '−'}${Math.round((Math.abs(b - a) / a) * 100)}%)`);

/** A cost in words: `≈$0.014`, or `unknown` without a price. */
export const usdOrUnknown = (n: number | null): string => (n === null ? 'unknown' : `≈${formatUsd(n)}`);

/** What the runs verified cost a run end to end, in words: `4,000 → 5,000 input tokens (+25%) · ≈$0.014 → ≈$0.018 (+29%)`. */
export function endToEndWords(e: { recorded: Footprint; now: Footprint }): string {
  const tokens = (n: number) => Math.round(n).toLocaleString('en-US');
  const moved = changePct(e.recorded.inputTokens, e.now.inputTokens);
  return `${tokens(e.recorded.inputTokens)} → ${tokens(e.now.inputTokens)} input tokens${/^ \([+−]0%\)$/.test(moved) ? '' : moved}${e.recorded.cost !== null && e.now.cost !== null ? ` · ${usdOrUnknown(e.recorded.cost)} → ${usdOrUnknown(e.now.cost)}${changePct(e.recorded.cost, e.now.cost)}` : ''}`;
}

/** What a run the preview cleared rests on, in words. */
export const CLEARED = "the same decisions, no write and no check it can't read: not run end to end";
