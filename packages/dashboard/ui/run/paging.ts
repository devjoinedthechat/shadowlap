import type { CallRow, CallsPage, RunDetail } from '../api.js';
import type { Origin7 } from '../origins.js';
import type { Kind } from './kinds.js';

/**
 * A run's calls a page at a time (contract 8). A run's page comes with the first page of its calls,
 * how many it has (`callsTotal`), where the next page starts (`callsNext`) and, when more are to come,
 * every call's origin (`origins`); the rest come from `GET /api/runs/:id/calls?from=`. The page lists
 * every call from the start, a placeholder for each not read yet, and reads the page that holds a
 * call as it comes into view or is asked for (a link, the fork, j and k), then the rest in order. A
 * recording's page is read the same way, the calls it makes read as they come (paged-run.ts). No DOM
 * here: the tests import it.
 */

/** At most this many calls come in a page: the server's `CALLS_PAGE`. */
export const PAGE = 500;
/** A page read for a call asked for starts this many calls before it, so the rows around it come with it. */
const BEFORE = 100;

/** A call not read yet: its number, and its origin and what it was when the run's page said them. */
export interface PendingCall {
  callNo: number;
  pending: true;
  origin: Origin7 | null;
  /** What it was (kinds.ts), as the strip draws it; not its `kind`, which a read call names `api` or `tool`. */
  kindKey?: Kind | null;
}

export type ListedCall = CallRow | PendingCall;

export const isPending = (c: ListedCall): c is PendingCall => 'pending' in c;

/** The calls read so far with a page more: in call order, each once, the later read of a call kept. */
export function withPage(had: readonly CallRow[], page: readonly CallRow[]): CallRow[] {
  if (!page.length) return had as CallRow[];
  const last = had.at(-1);
  if (!last || page[0]!.callNo > last.callNo) return [...had, ...page];
  const byNo = new Map(had.map((c) => [c.callNo, c]));
  for (const c of page) byNo.set(c.callNo, c);
  return [...byNo.values()].sort((a, b) => a.callNo - b.callNo);
}

/** Call numbers read, as ranges from one call to another, `to` Infinity for one that reaches the run's end. */
export type Read = ReadonlyArray<readonly [number, number]>;

/** The ranges with one more, merged where they meet or overlap. */
export function withRange(read: Read, from: number, to: number): Array<[number, number]> {
  const all = [...read.map(([a, b]) => [a, b] as [number, number]), [from, to] as [number, number]].sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of all) {
    const prev = out.at(-1);
    if (prev && a <= prev[1] + 1) prev[1] = Math.max(prev[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** What a page answered for says is read: from the call it was asked from up to where the next one starts, or to the end. */
export function rangeOf(from: number, page: Pick<CallsPage, 'callsNext'>): [number, number] {
  return [from, page.callsNext === null ? Infinity : page.callsNext - 1];
}

export const isRead = (read: Read, n: number): boolean => read.some(([a, b]) => n >= a && n <= b);

/**
 * The calls to read next: around `wanted` when it isn't read yet (from a little before it, within the
 * gap it is in), else from the first call not read. Null when every call is read.
 */
export function nextRead(read: Read, wanted: number | null): { from: number; limit: number } | null {
  const gapAt = (n: number): [number, number] => {
    let lo = 1;
    let hi = Infinity;
    for (const [a, b] of read) {
      if (b < n) lo = Math.max(lo, b + 1);
      else if (a > n) hi = Math.min(hi, a - 1);
    }
    return [lo, hi];
  };
  if (wanted !== null && wanted >= 1 && !isRead(read, wanted)) {
    const [lo, hi] = gapAt(wanted);
    const from = Math.max(lo, wanted - BEFORE);
    return { from, limit: Math.max(1, Math.min(PAGE, hi - from + 1)) };
  }
  // The first call not read: after the range that starts at the first call, or the first call itself.
  const first = read.find(([a]) => a <= 1);
  const from = first ? first[1] + 1 : 1;
  if (from === Infinity) return null;
  const [, hi] = gapAt(from);
  return { from, limit: Math.max(1, Math.min(PAGE, hi - from + 1)) };
}

/** Every call of the run in order: those read, and a placeholder for each of the rest, with its origin and kind when known. */
export function listedCalls(have: readonly CallRow[], total: number, origins: readonly Origin7[] | null, kinds: readonly Kind[] | null = null): ListedCall[] {
  if (have.length >= total) return have as CallRow[];
  const out: ListedCall[] = [];
  let i = 0;
  for (let n = 1; n <= total; n++) {
    while (i < have.length && have[i]!.callNo < n) out.push(have[i++]!);
    if (i < have.length && have[i]!.callNo === n) out.push(have[i++]!);
    else out.push({ callNo: n, pending: true, origin: origins?.[n - 1] ?? null, kindKey: kinds?.[n - 1] ?? null });
  }
  while (i < have.length) out.push(have[i++]!);
  return out;
}

/**
 * A page that holds a recording whole, with the calls after those it came with, read a page at a time
 * to its end: what a recording followed whole made since the page last asked, when that is more than
 * a page. Its origins and its judge's calls go: its calls hold them.
 */
export async function followPages(client: { calls(id: string, from: number, limit?: number): Promise<CallsPage> }, d: RunDetail): Promise<RunDetail> {
  let calls = d.calls;
  let total = d.callsTotal;
  let next = d.callsNext;
  while (next !== null) {
    const page = await client.calls(d.run.runId, next);
    calls = withPage(calls, page.calls);
    total = page.callsTotal;
    // A page that moves on no further ends it, whatever it says.
    next = page.callsNext !== null && page.callsNext > next ? page.callsNext : null;
  }
  const { origins: _origins, kinds: _kinds, judgeCalls: _judge, ...rest } = d;
  void _origins;
  void _kinds;
  void _judge;
  return { ...rest, calls, callsTotal: Math.max(total, calls.length), callsNext: null };
}
