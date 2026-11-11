import { type CallRecord, identifiersOf, type RunRecord, type StoreOf, type UntrustedView } from '@shadowlap/engine';

/**
 * What Find cause… asks about, on a recorded run: each write the run really made after an untrusted
 * read, the reads before it, and the read its dialog starts on. Never on an injection attempt or a
 * clean replay (a test's own run), nor while the run records.
 */

export interface CauseFacts {
  /** The write, by its call number. */
  write: number;
  name: string;
  /** The untrusted reads before it, by call number, in call order. */
  reads: number[];
  /** The read the dialog starts on: the one whose result holds a value the write sends, else the last before it. */
  pick: number;
  /** That value, where a read's result holds one: `its result holds refunds@…, which #28 sends`. */
  holds: string | null;
}

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
function resultText(store: StoreOf<'recording'>, call: CallRecord): string {
  const ref = call.end?.responseRef;
  const body = ref ? store.getJson<{ result?: unknown }>(ref) : null;
  return body?.result === undefined ? '' : (JSON.stringify(body.result) ?? '');
}

/** Find cause…'s facts for each live write after an untrusted read of `run`. */
export function causeFacts(store: StoreOf<'recording'>, run: RunRecord, calls: readonly CallRecord[], untrusted: readonly UntrustedView[]): CauseFacts[] {
  if (run.status === 'running' || run.meta?.injection || !untrusted.length) return [];
  const byNo = new Map(calls.map((c) => [c.callNo, c]));
  const texts = new Map<number, string>();
  const textOf = (n: number) => {
    if (!texts.has(n)) texts.set(n, byNo.has(n) ? resultText(store, byNo.get(n)!) : '');
    return texts.get(n)!;
  };
  const out: CauseFacts[] = [];
  for (const c of calls) {
    if (c.kind !== 'tool' || c.effect !== 'write' || c.origin !== 'live') continue;
    const reads = untrusted.filter((r) => r.callNo < c.callNo).map((r) => r.callNo);
    if (!reads.length) continue;
    const sent = sentValues(store, c);
    let held: { read: number; value: string } | null = null;
    for (const read of [...reads].reverse()) {
      const value = sent.find((v) => textOf(read).includes(JSON.stringify(v).slice(1, -1)));
      if (value) {
        held = { read, value };
        break;
      }
    }
    out.push({ write: c.callNo, name: c.name, reads, pick: held?.read ?? reads[reads.length - 1]!, holds: held?.value ?? null });
  }
  return out;
}
