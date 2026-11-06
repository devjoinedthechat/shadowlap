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

/** Whether a value is a threshold Spending can hold: a whole number of cents, $0 or more, or null. */
export function validSpending(v: unknown): v is Spending {
  if (v === null) return true;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.abs(Math.round(v * 100) - v * 100) < 1e-6;
}

/** A threshold in dollars, as the setting says it: `$0.50`, `$2`, `$1,000`. */
export function spendingUsd(v: number): string {
  const whole = Math.abs(v - Math.round(v)) < 1e-9;
  return `$${v.toLocaleString('en-US', whole ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

/** An amount to the cent, as a page's own figure gives it and the ask that shows it says it: `≈$0.35`. */
export function centsWords(usd: number): string {
  return `≈$${usd.toFixed(2)}`;
}

/** The amount as shown, which is what Spending holds a job to: "≈$0.50" never asks above $0.50. */
export function heldAmount(usd: number): number {
  return usd > 0 ? Number(formatUsd(usd).replace(/[^\d.]/g, '')) : 0;
}

/** What a job is held to: its estimate, or the budget it stops at where that is less. */
const stopped = (usd: number, stops: number | undefined): number => (stops !== undefined && stops < usd ? stops : usd);

/** The budget a job stops at, to the cent, as the field that sets it holds it: `$2.00`, `$25.00`, `$1,000.00`. */
const stopUsd = (v: number): string => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** An estimate's price in words: `≈$0.027`, `At most ≈$10.88`, `≈$0.012 an attempt`, `Stops at $2.00`, `Free`; `no estimate` without one. */
export function priceWords(e: Pick<Estimate, 'usd' | 'ceiling' | 'per' | 'stops'>): string {
  if (e.usd === null) return 'no estimate';
  if (e.usd === 0) return 'Free';
  if (e.stops !== undefined && e.stops < e.usd) return `Stops at ${stopUsd(e.stops)}`;
  return `${e.ceiling ? 'At most ' : ''}${amountWords(e.usd)}${e.per ? ` ${e.per}` : ''}`;
}

/**
 * An ask's cost line, price first and its parts after it: `≈$0.054, twice as recorded · live from #3,
 * writes fenced`; for a job with no estimate, who bills it, then its parts, which end on why: `Billed
 * by your provider · live from there, writes blocked · no estimate until it has run once`.
 */
export function costLine(e: Pick<Estimate, 'usd' | 'ceiling' | 'note' | 'parts' | 'per' | 'recurs' | 'stops'>): string[] {
  if (e.usd === null) return ['Billed by your provider', ...e.parts];
  return [`${priceWords(e)}${e.recurs ? ` ${e.recurs}` : ''}${e.note ? `, ${e.note}` : ''}`, ...e.parts];
}

/** How a button that starts a job is drawn: `form`, it opens a dialog that asks what to run; `wait`, it waits on another job or the server. */
export interface CostShown {
  form?: boolean;
  wait?: boolean;
}

/**
 * Whether a job asks before it starts at this threshold: one with no estimate, one that asks for what
 * it does (`always`), one priced by the unit (`per`) and a form always do; one that bills nothing
 * never does; else one whose amount as shown is above the threshold. Never ask asks only of a job
 * with no estimate.
 */
export function asksFirst(e: Pick<Estimate, 'usd' | 'always' | 'per' | 'stops'> | null | undefined, threshold: Spending, o: CostShown = {}): boolean {
  if (!e || e.usd === null || e.always || e.per || o.form) return true;
  if (e.usd === 0 || threshold === null) return false;
  return heldAmount(stopped(e.usd, e.stops)) > threshold;
}

/**
 * Whether the threshold is why a job asks, so its ask says so beside the way to change it (`Asks above
 * $0.50 · Change`): it asks at this threshold for its amount alone. Not for a job with no estimate, one
 * that asks for what it does (`always`), one priced by the unit (`per`) or a form, which ask on every
 * setting, nor for one that starts on click.
 */
export function askedOverThreshold(e: Pick<Estimate, 'usd' | 'always' | 'per' | 'stops'> | null | undefined, threshold: Spending, o: CostShown = {}): boolean {
  if (!e || e.usd === null || e.always || e.per || o.form) return false;
  return asksFirst(e, threshold, o);
}

/**
 * The line a button's card says under its sentence: `≈$0.027 · starts at once`, `At most ≈$10.88 ·
 * asks first`, `Free · asks first`, `no estimate · asks first`; a form's, or a button's that waits,
 * the amount alone. Null for a job that bills nothing and asks nothing first: it has no line.
 */
export function costWords(e: Pick<Estimate, 'usd' | 'ceiling' | 'always' | 'per' | 'stops'> | null | undefined, threshold: Spending, o: CostShown = {}): string | null {
  if (e && e.usd === 0 && !e.always && !e.per) return null;
  const price = e ? priceWords(e) : 'no estimate';
  if (o.form || o.wait) return price;
  return `${price} · ${asksFirst(e, threshold, o) ? 'asks first' : 'starts at once'}`;
}

/** What a billed job's drawer says beside running: `at most ≈$10.88`, `≈$0.027`; null for one that bills nothing, has no estimate, or is priced by the unit. */
export function drawerCost(e: Pick<Estimate, 'usd' | 'ceiling' | 'per' | 'stops'> | null | undefined): string | null {
  if (!e?.usd || e.per) return null;
  if (e.stops !== undefined && e.stops < e.usd) return amountWords(e.stops);
  return `${e.ceiling ? 'at most ' : ''}${amountWords(e.usd)}`;
}
