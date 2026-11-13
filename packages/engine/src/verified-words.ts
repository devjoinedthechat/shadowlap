import { formatUsd } from './prices.js';
import type { Footprint } from './verify.js';

/**
 * How verify found the runs a preview or a migration took, in the words `shadowlap migrate` prints
 * and the dashboard's Preview shows: each run's tally, how many runs ran end to end, what they cost
 * a run end to end, and what a run the preview cleared rests on. No imports but prices: a page may
 * bundle it as it is.
 */

/**
 * A run's tally in its parts, as verify's line says it (`verifyTallyLine`) and a page draws it: what
 * it counted, why an attempt stopped it, the attempts the provider cut short, and the bound.
 */
export interface VerifyTally {
  /**
   * What it counted: `12 of 12 passed`; against its baseline both tallies, `38 of 38 passed, baseline
   * 38 of 38`; `clean replay` for a run its first attempt settled. For a run an attempt it could not
   * judge stopped, the attempts judged before it, one the provider cut short among them (`2 of 3
   * passed`), or null when none was.
   */
  tally: string | null;
  /**
   * Why an attempt it could not judge stopped it before its gate decided: `the provider unavailable`
   * when the provider stayed unavailable attempt after attempt (`unavailableStop`), else `attempt 4
   * not judged`. Null for a run that was decided.
   */
  undecided: string | null;
  /** The attempts the provider cut short, each counted against either verdict: `2 cut short by the provider, counted against either verdict`. Null when none was, and for a run an attempt stopped. */
  cutShort: string | null;
  /**
   * The bound that bears on its verdict, at the confidence it was decided at: `rate >= 0.76 (95%)`, or
   * against its baseline `drop <= 0.10 (95%)`. Null for a fixed count, a clean replay and a run an
   * attempt stopped, and where the figures a report kept can't give one (a report from another
   * version or another machine): the tally alone then.
   */
  bound: string | null;
}

/**
 * A run's tally as verify's line says it, from its parts (`verifyTally`), a part left out left out of
 * the line: `12 of 12 passed · rate >= 0.76 (95%)`; `17 of 18 passed (1 cut short by the provider,
 * counted against either verdict) · rate >= 0.60 (95%)`; `2 of 3 passed, attempt 4 not judged`.
 */
export function verifyTallyLine(t: Partial<VerifyTally>): string {
  const counted = [t.tally, t.undecided].filter(Boolean).join(', ');
  return `${counted}${t.cutShort ? ` (${t.cutShort})` : ''}${t.bound ? ` · ${t.bound}` : ''}`;
}

/**
 * A run verify took, as a preview or a migration keeps it: its passes of its attempts, under a gate
 * the bound of its pass rate (null for a clean replay or a fixed count), and `undecided`, why its last
 * attempt could not be judged, which stopped it. A good run kept against its baseline has the
 * baseline's tally too. `parts` is its tally in verify's own parts (`verifyTally`), absent from a
 * session kept before they were.
 */
export interface VerifiedTally {
  passes: number;
  attempts: number;
  bound?: string | null;
  undecided?: string | null;
  baseline?: { passes: number; attempts: number } | null;
  parts?: VerifyTally | null;
}

/**
 * A kept run's tally in verify's parts: the ones it was kept with, else those its figures give, in
 * the same words, the bound the one kept. What a session kept before the parts never held stays out:
 * attempts the provider cut short, and a provider that stayed unavailable (its attempt reads as one
 * not judged).
 */
export function tallyParts(t: VerifiedTally): VerifyTally {
  if (t.parts) return t.parts;
  if (t.undecided) return { tally: t.attempts > 1 ? `${t.passes} of ${t.attempts - 1} passed` : null, undecided: `attempt ${t.attempts} not judged`, cutShort: null, bound: null };
  return { tally: `${t.passes} of ${t.attempts} passed${t.baseline ? `, baseline ${t.baseline.passes} of ${t.baseline.attempts}` : ''}`, undecided: null, cutShort: null, bound: t.bound ?? null };
}

/**
 * A verified run's tally after its outcome, as verify's line says it: ` · 12 of 12 passed · rate >=
 * 0.76 (95%)`, and an attempt that could not be judged apart, never as one that failed: ` · 2 of 2
 * passed, attempt 3 not judged`. Nothing for a run verify didn't take.
 */
export function tallyWords(t: VerifiedTally | null | undefined): string {
  if (!t) return '';
  return ` · ${verifyTallyLine(tallyParts(t))}`;
}

/** A verified run's tally without its bound, as a row beside its outcome draws it: `12 of 12 passed`, `2 of 2 passed, attempt 3 not judged`; nothing for a run verify didn't take. */
export function tallyCount(t: VerifiedTally | null | undefined): string {
  if (!t) return '';
  const { bound: _bound, ...counted } = tallyParts(t);
  return verifyTallyLine(counted);
}

/** How verify found a run, after its verdict: `kept, verified · 12 of 12 passed · rate >= 0.76 (95%)`; an outcome that is the verdict word (inconclusive) is said once. */
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
