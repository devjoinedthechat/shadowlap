import { spendingUsd, type Spending } from './spending.js';

/**
 * The Spending row's own words and field (Settings → Project), apart from the rule (spending.ts) every
 * billed control reads: the dashboard loads them with the page that draws the row, never up front.
 * The server says the refusal in the same words.
 */

/** The picks beside the amount: Always ask ($0), $0.50, $2, Never ask (no limit). */
export const SPENDING_PICKS: ReadonlyArray<{ label: string; value: Spending }> = [
  { label: 'Always ask', value: 0 },
  { label: '$0.50', value: 0.5 },
  { label: '$2', value: 2 },
  { label: 'Never ask', value: null },
];

/** What the field says when an amount typed is none: "An amount in dollars, such as 0.50". */
export const SPENDING_REFUSED = 'An amount in dollars, such as 0.50';

/**
 * An amount as typed in the field: a `$`, spaces and commas ignored, digits with a point before the
 * last of them or none (`12`, `0.50`, `.5`), rounded to whole cents, a half cent up (`0.505` is
 * $0.51); an empty field is no limit (Never ask). Anything else is refused with what to type.
 */
export function parseSpending(text: string): { ok: true; value: Spending } | { ok: false; why: string } {
  const bare = text.replace(/[\s$,]/g, '');
  if (!bare) return { ok: true, value: null };
  if (!/^\d*\.?\d+$/.test(bare)) return { ok: false, why: SPENDING_REFUSED };
  // Rounded from the digits as typed: 1.005 is $1.01, which 1.005 × 100 in floating point is not.
  const [whole = '', frac = ''] = bare.split('.');
  const cents = Number(whole) * 100 + Number(frac.slice(0, 2).padEnd(2, '0')) + (frac.charAt(2) >= '5' ? 1 : 0);
  return Number.isFinite(cents) ? { ok: true, value: cents / 100 } : { ok: false, why: SPENDING_REFUSED };
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
