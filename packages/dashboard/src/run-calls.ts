import type { CallRecord, Store } from '@shadowlap/engine';

/**
 * A run's calls as the store holds them now, read once and kept while they stay the same: the run
 * page asks for a run and then each call the inspector shows, and every call's details are worked
 * out from the whole run (its conversations, where the prompt cache stopped hitting). Reading a long
 * run's calls again for each of them made a call's details cost as much as the run is long.
 *
 * A run's calls change only when call events are added to it (or it is deleted), so what was read
 * stands while the store's call-events counter and runs counter stay where they were; when they
 * moved (another run recording, say), the run's own newest event and count tell whether it did.
 */

interface Kept {
  /** The store's counters when this was last found current. */
  store: string;
  /** The run's own newest call event and how many it has. */
  own: string;
  calls: CallRecord[];
}

/** The runs kept per store: the one open, the one it was opened from, and the runs it links to. */
const KEEP = 4;

const kept = new WeakMap<Store, Map<string, Kept>>();

function ownStamp(store: Store, runId: string): string {
  const row = store.query(`SELECT MAX(rowid) AS m, COUNT(*) AS n FROM call_events WHERE run_id = ?`, runId)[0];
  return `${String(row?.m ?? 0)}:${String(row?.n ?? 0)}`;
}

/** Every call of a run, in call order, read from the store only when it changed since the last read. Don't change the array. */
export function runCalls(store: Store, runId: string): readonly CallRecord[] {
  let byRun = kept.get(store);
  if (!byRun) kept.set(store, (byRun = new Map()));
  const counts = store.changeCounts();
  const now = `${counts.runs ?? 0}|${counts.calls ?? 0}`;
  const hit = byRun.get(runId);
  let entry: Kept;
  if (hit && hit.store === now) entry = hit;
  else {
    const own = ownStamp(store, runId);
    entry = hit && hit.own === own ? { ...hit, store: now } : { store: now, own, calls: store.getCalls(runId) };
  }
  // The one used last goes last: a Map iterates in the order entries were set.
  byRun.delete(runId);
  byRun.set(runId, entry);
  for (const key of byRun.keys()) {
    if (byRun.size <= KEEP) break;
    byRun.delete(key);
  }
  return entry.calls;
}
