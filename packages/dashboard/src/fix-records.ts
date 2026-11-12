import { type FixRecords, fixRecords, type StoreOf } from '@shadowlap/engine';

/**
 * Every fix's records, read once for each change to fixes: the store's `fixes` counter moves whenever
 * a fix, a blame, a repair, a verdict or a pull request's state is written, so a page polled while
 * runs record parses no report again. Fixes' list (fixes-view.ts) and Runs' issues (issues.ts) read
 * them so.
 */
const recordsRead = new WeakMap<object, { n: number; records: FixRecords[] }>();

export function keptFixRecords(store: StoreOf<'activity' | 'fixes'>): FixRecords[] {
  const n = store.changeCounts().fixes;
  const kept = recordsRead.get(store);
  if (kept && n !== undefined && kept.n === n) return kept.records;
  const records = store.listFixes().map((f) => fixRecords(store, f));
  if (n !== undefined) recordsRead.set(store, { n, records });
  return records;
}
