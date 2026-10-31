import { formatUsd } from '../prices.js';
import type { Estimate } from './estimate.js';

/**
 * Spending: the one setting that decides when a billed job asks before it starts. A job whose
 * estimate, as its card shows it, is at or under the threshold starts on click; one above it asks;
 * one with no estimate always asks; one that bills nothing starts at once on every setting. It is
 * each person's own, kept on their machine (user-settings.ts), never in shadowlap.config.json, so CI
 * and teammates never take it on, and nothing in the CLI reads it. It is no budget: `--budget` and
 * CI's fix budget still stop a job. The rule and its words are here, with nothing imported but the
 * price formatting, so the dashboard's pages, its server and the terminal UI say them alike.
 */

/** The threshold an estimate is held to: dollars in whole cents (0 is Always ask), or null for Never ask. */
export type Spending = number | null;

/** What Spending is until someone changes it: ask above $0.50. */
export const SPENDING_DEFAULT = 0.5;

/** The most an amount may be: anything above it is no threshold anyone means. */
export const SPENDING_MAX = 1_000_000;

/** The picks beside the amount: Always ask ($0), $0.50, $2, Never ask (no limit). */
export const SPENDING_PICKS: ReadonlyArray<{ label: string; value: Spending }> = [
  { label: 'Always ask', value: 0 },
  { label: '$0.50', value: 0.5 },
  { label: '$2', value: 2 },
  { label: 'Never ask', value: null },
];

/** What the field says when an amount typed is none: "An amount in dollars, such as 0.50". */
export const SPENDING_REFUSED = 'An amount in dollars, such as 0.50';

/** Whether a value is a threshold Spending can hold: a whole number of cents from $0 to the most, or null. */
export function validSpending(v: unknown): v is Spending {
  if (v === null) return true;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= SPENDING_MAX && Math.abs(Math.round(v * 100) - v * 100) < 1e-6;
}

/**
 * An amount as typed in the field: a `$`, spaces and commas ignored, whole cents; an empty field is
 * no limit (Never ask). Anything else is refused with what to type.
 */
export function parseSpending(text: string): { ok: true; value: Spending } | { ok: false; why: string } {
  const bare = text.replace(/[\s$,]/g, '');
  if (!bare) return { ok: true, value: null };
  if (!/^(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(bare)) return { ok: false, why: SPENDING_REFUSED };
  const value = Math.round(Number(bare) * 100) / 100;
  return value <= SPENDING_MAX ? { ok: true, value } : { ok: false, why: SPENDING_REFUSED };
}

/** A threshold in dollars, as the setting says it: `$0.50`, `$2`, `$1,000`. */
export function spendingUsd(v: number): string {
  const whole = Math.abs(v - Math.round(v)) < 1e-9;
  return `$${v.toLocaleString('en-US', whole ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The field's text for a threshold: `0.50`, `2`; empty for Never ask. */
export function spendingField(v: Spending): string {
  if (v === null) return '';
  return Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(2);
}

/** The setting's words, a line a sentence: "Ask before spending more than $0.50." "A job with no estimate always asks." */
export function spendingWords(v: Spending): string[] {
  if (v === null) return ['Never ask before spending.', 'A job with no estimate still asks.'];
  if (v === 0) return ['Always ask before spending.'];
  return [`Ask before spending more than ${spendingUsd(v)}.`, 'A job with no estimate always asks.'];
}

/** Spending in an ask's footer and in its toast, short enough for one line on a phone: `Asks above $0.50`, `Always asks`, `Never asks`. */
export function askWords(v: Spending): string {
  if (v === null) return 'Never asks';
  return v === 0 ? 'Always asks' : `Asks above ${spendingUsd(v)}`;
}

/** An amount as the CLI prints an estimate: `≈$0.0271`, `≈$0.270`, `≈$10.88`; `<$0.001` under a tenth of a cent. */
export function amountWords(usd: number): string {
  const s = formatUsd(usd);
  return s.startsWith('<') ? s : `≈${s}`;
}

/** The amount as shown, which is what Spending holds a job to: "≈$0.50" never asks above $0.50. */
export function heldAmount(usd: number): number {
  return usd > 0 ? Number(formatUsd(usd).replace(/[^\d.]/g, '')) : 0;
}

/** An estimate's price in words: `≈$0.027`, `At most ≈$10.88`, `Free`; `no estimate` without one. */
export function priceWords(e: Pick<Estimate, 'usd' | 'ceiling'>): string {
  if (e.usd === null) return 'no estimate';
  if (e.usd === 0) return 'Free';
  return `${e.ceiling ? 'At most ' : ''}${amountWords(e.usd)}`;
}

/**
 * An ask's cost line, price first and its parts after it: `≈$0.054, twice as recorded · live from #3,
 * writes fenced`; `Billed by your provider · the agent’s own model calls · no estimate until it has
 * run once` for a job with no estimate.
 */
export function costLine(e: Pick<Estimate, 'usd' | 'ceiling' | 'note' | 'parts' | 'none'>): string[] {
  if (e.usd === null) return ['Billed by your provider', ...e.parts, ...(e.none ? [e.none] : [])];
  return [`${priceWords(e)}${e.note ? `, ${e.note}` : ''}`, ...e.parts];
}

/** How a button that starts a job is drawn: `form`, it opens a dialog that asks what to run; `wait`, it waits on another job or the server. */
export interface CostShown {
  form?: boolean;
  wait?: boolean;
}

/**
 * Whether a job asks before it starts at this threshold: one with no estimate, one that asks for what
 * it does (`always`), and a form always do; one that bills nothing never does; else one whose amount
 * as shown is above the threshold. Never ask asks only of a job with no estimate.
 */
export function asksFirst(e: Pick<Estimate, 'usd' | 'always'> | null | undefined, threshold: Spending, o: CostShown = {}): boolean {
  if (!e || e.usd === null || e.always || o.form) return true;
  if (e.usd === 0 || threshold === null) return false;
  return heldAmount(e.usd) > threshold;
}

/**
 * The line a button's card says under its sentence: `≈$0.027 · starts at once`, `At most ≈$10.88 ·
 * asks first`, `Free · asks first`, `no estimate · asks first`; a form's, or a button's that waits,
 * the amount alone. Null for a job that bills nothing and asks nothing first: it has no line.
 */
export function costWords(e: Pick<Estimate, 'usd' | 'ceiling' | 'always'> | null | undefined, threshold: Spending, o: CostShown = {}): string | null {
  if (e && e.usd === 0 && !e.always) return null;
  const price = e ? priceWords(e) : 'no estimate';
  if (o.form || o.wait) return price;
  return `${price} · ${asksFirst(e, threshold, o) ? 'asks first' : 'starts at once'}`;
}

/** What a billed job's drawer says beside running: `at most ≈$10.88`, `≈$0.027`; null for one that bills nothing or has no estimate. */
export function drawerCost(e: Pick<Estimate, 'usd' | 'ceiling'> | null | undefined): string | null {
  if (!e?.usd) return null;
  return `${e.ceiling ? 'at most ' : ''}${amountWords(e.usd)}`;
}
