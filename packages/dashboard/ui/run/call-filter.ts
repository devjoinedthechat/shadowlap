import { callName } from '../format.js';
import { ORIGIN_NAME, ORIGINS, type Origin7 } from '../origins.js';
import type { CallRow } from '../types.js';
import { callDetail, originOf, resultLine } from './calls.js';
import { callKind, isKind, KINDS, kindWords, type Kind } from './kinds.js';
import type { PendingCall } from './paging.js';

/**
 * The call filter, which is the strip's key: all, then each kind (a recording or a capture) or origin
 * (a replay, a fork, a test) the run has, with its count. A pick shows only those calls in Calls and
 * dims the rest of the strip; it is kept from run to run where the next run has such calls. No DOM
 * here: the tests import it.
 */

export type CallFilter = 'all' | Origin7 | Kind;

/** Whether a call's origin or kind passes the filter; a call not read yet may know only its origin. */
function keyMatches(origin: Origin7 | null, kind: Kind | null, f: CallFilter): boolean {
  if (f === 'all') return true;
  return isKind(f) ? kind === f : origin === f;
}

/** A call not read yet passes on its origin or its kind alone, and no text filter: its words aren't there to match. */
export function pendingMatches(c: PendingCall, f: CallFilter, text: string): boolean {
  return !text && keyMatches(c.origin, c.kindKey ?? null, f);
}

export function matchesFilter(c: CallRow, f: CallFilter, text: string, asked?: string | null): boolean {
  if (!keyMatches(originOf(c), callKind(c), f)) return false;
  if (!text) return true;
  const d = callDetail(c, asked).text;
  const res = resultLine(c)?.text ?? '';
  return `${callName(c.kind, c.name)} ${c.name} ${d} ${res} ${c.model ?? ''} #${c.callNo}`.toLowerCase().includes(text.toLowerCase());
}

export interface KeyCounts {
  /** Every call counted, the `all` chip's. */
  total: number;
  /** By kind or by origin, as the key is. */
  counts: Readonly<Partial<Record<CallFilter, number>>>;
}

/**
 * The key's counts in one pass: of the run's whole `kinds` or `origins` string while a long run's
 * pages come (`codes`), else of the calls in the scope.
 */
export function keyCounts(calls: readonly CallRow[], codes: readonly CallFilter[] | null, kinds: boolean): KeyCounts {
  const counts: Partial<Record<CallFilter, number>> = {};
  if (codes) {
    for (const k of codes) counts[k] = (counts[k] ?? 0) + 1;
    return { total: codes.length, counts };
  }
  for (const c of calls) {
    const k = kinds ? callKind(c) : originOf(c);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return { total: calls.length, counts };
}

export interface KeyItem {
  key: CallFilter;
  /** Its swatch: none for `all`. */
  swatch: boolean;
  word: string;
  count: number;
}

/** The key's chips: all, then each kind or origin the run has, in the key's order. */
export function keyItems({ total, counts }: KeyCounts, kinds: boolean): KeyItem[] {
  const order: readonly (Kind | Origin7)[] = kinds ? KINDS : ORIGINS;
  const items: KeyItem[] = [{ key: 'all', swatch: false, word: 'all', count: total }];
  for (const k of order) {
    const n = counts[k];
    if (n) items.push({ key: k, swatch: true, word: isKind(k) ? kindWords(k, n) : ORIGIN_NAME[k], count: n });
  }
  return items;
}

/** The filter a run shows: the pick where the run has such calls, else all. */
export function shownFilter(pick: CallFilter, counts: KeyCounts['counts'], kinds: boolean): CallFilter {
  if (pick === 'all' || isKind(pick) !== kinds) return 'all';
  return counts[pick] ? pick : 'all';
}

/** The pick, kept from run to run as the reader left it. */
let picked: CallFilter = 'all';

export function pickedFilter(): CallFilter {
  return picked;
}

export function keepFilter(f: CallFilter): void {
  picked = f;
}

/** For tests: no pick kept. */
export function resetCallFilter(): void {
  picked = 'all';
}
