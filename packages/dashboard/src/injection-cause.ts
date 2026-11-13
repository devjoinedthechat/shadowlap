import { type CallRecord, identifiersOf, isWrite, type RunRecord, type StoreOf, type UntrustedView } from '@shadowlap/engine';

/**
 * What Find cause… asks about, on a recorded run: each write the run really made after an untrusted
 * read a model call reads, a write as `injection --clean` counts one (isWrite: a tool that declares
 * no effect may be one), and the read its dialog starts on. The reads before a write are the
 * answer's own `untrusted`, so a write costs its few facts whatever the run's size, and a value it
 * sends is looked for in the NEAR reads nearest it. Never on an injection attempt or a clean replay
 * (a test's own run), nor while the run records.
 */

export interface CauseFacts {
  /** The write, by its call number. */
  write: number;
  name: string;
  /** The read the dialog starts on: of the NEAR reads nearest the write, the one whose result holds a value it sends, else the last before it. */
  pick: number;
  /** That value, where a read's result holds one: `its result holds refunds@…, which #28 sends`. */
  holds: string | null;
}

/** How many of the untrusted reads nearest a write are looked in for a value it sends: a run of thousands of reads looks in a few for each write. */
export const NEAR = 8;

/** A value short enough to be anyone's (`1`, `ok`) says nothing of where the write got it. */
const MIN_HELD = 3;

/** The values a write sends that identify it (identifiersOf: no prose, nothing made anew each run), as text a result could hold. */
function sentValues(store: StoreOf<'recording'>, call: CallRecord): string[] {
  const args = call.requestRef ? store.getJson<{ args?: unknown }>(call.requestRef)?.args : undefined;
  return identifiersOf(args)
    .map((i) => (typeof i.value === 'string' ? i.value : typeof i.value === 'number' ? String(i.value) : ''))
    .filter((v) => v.length >= MIN_HELD);
}

/** A read's recorded result as the text its JSON is. */
function resultText(store: StoreOf<'recording'>, call: CallRecord | undefined): string {
  const ref = call?.end?.responseRef;
  const body = ref ? store.getJson<{ result?: unknown }>(ref) : null;
  return body?.result === undefined ? '' : (JSON.stringify(body.result) ?? '');
}

/** The nearest read, of `near` (nearest first), whose result holds a value the write sends. */
function heldIn(near: readonly number[], sent: readonly string[], textOf: (read: number) => string): { read: number; value: string } | null {
  if (!sent.length) return null;
  for (const read of near) {
    const text = textOf(read);
    const value = sent.find((v) => text.includes(JSON.stringify(v).slice(1, -1)));
    if (value) return { read, value };
  }
  return null;
}

/** Find cause…'s facts for each live write after an untrusted read a model call reads, in one pass over `run`'s calls. */
export function causeFacts(store: StoreOf<'recording'>, run: RunRecord, calls: readonly CallRecord[], untrusted: readonly UntrustedView[]): CauseFacts[] {
  if (run.status === 'running' || run.meta?.injection) return [];
  // The reads a model call reads, in call order: one no model call follows brought no text in.
  const reads = untrusted.filter((r) => r.readAt !== null).map((r) => r.callNo);
  if (!reads.length) return [];
  const byNo = new Map(calls.map((c) => [c.callNo, c]));
  // Each read's text, read once and let go as the writes pass beyond its reach.
  const texts = new Map<number, string>();
  const textOf = (n: number): string => {
    let text = texts.get(n);
    if (text === undefined) texts.set(n, (text = resultText(store, byNo.get(n))));
    return text;
  };
  const out: CauseFacts[] = [];
  let before = 0;
  for (const c of calls) {
    for (; before < reads.length && reads[before]! < c.callNo; before += 1) texts.delete(reads[before - NEAR] ?? -1);
    if (!before || !isWrite(c) || c.origin !== 'live') continue;
    const held = heldIn(reads.slice(Math.max(0, before - NEAR), before).reverse(), sentValues(store, c), textOf);
    out.push({ write: c.callNo, name: c.name, pick: held?.read ?? reads[before - 1]!, holds: held?.value ?? null });
  }
  return out;
}
