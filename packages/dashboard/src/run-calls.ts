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
 * A run still recording only gains events: then only the calls they belong to are read, from the
 * first of them on, and every call before keeps the record read before (the same object), so what
 * is worked out from a call (its conversation, the tools its answer asked for) is not again.
 */

interface Kept {
  /** The store's counters when this was last found current. */
  store: string;
  /** The run's own newest call event and how many it has. */
  own: Stamp;
  calls: CallRecord[];
}

interface Stamp {
  /** The rowid of its newest call event. */
  last: number;
  events: number;
}

/** The runs kept per store: the one open, the one it was opened from, and the runs it links to. */
const KEEP = 4;

const kept = new WeakMap<Store, Map<string, Kept>>();

function ownStamp(store: Store, runId: string): Stamp {
  const row = store.query(`SELECT MAX(rowid) AS m, COUNT(*) AS n FROM call_events WHERE run_id = ?`, runId)[0];
  return { last: Number(row?.m ?? 0), events: Number(row?.n ?? 0) };
}

const sameStamp = (a: Stamp, b: Stamp) => a.last === b.last && a.events === b.events;

/**
 * The run's calls after events were added to it: the calls those events belong to, from the first
 * of them on, read again, after the calls before them as they were. Null when the run lost events
 * instead (calls deleted): it is read whole.
 */
function grown(store: Store, runId: string, had: Kept, now: Stamp): CallRecord[] | null {
  if (now.events <= had.own.events || now.last <= had.own.last) return null;
  // Events are numbered as they are written: the run's new ones come after the newest read before.
  // Looked up by that number (`+run_id` keeps SQLite on it), so the cost is what was written since.
  const from = store.query(`SELECT MIN(call_no) AS c FROM call_events WHERE rowid > ? AND +run_id = ?`, had.own.last, runId)[0]?.c;
  if (from === null || from === undefined) return null;
  const first = Number(from);
  let keep = had.calls.length;
  while (keep > 0 && had.calls[keep - 1]!.callNo >= first) keep--;
  return [...had.calls.slice(0, keep), ...store.getCalls(runId, { after: first - 1 })];
}

/** Every call of a run, in call order, read from the store only when it changed since the last read. Don't change the array. */
export function runCalls(store: Store, runId: string): readonly CallRecord[] {
  let byRun = kept.get(store);
  if (!byRun) {
    byRun = new Map();
    kept.set(store, byRun);
  }
  const counts = store.changeCounts();
  const now = `${counts.runs ?? 0}|${counts.calls ?? 0}`;
  const hit = byRun.get(runId);
  let entry: Kept;
  if (hit && hit.store === now) entry = hit;
  else {
    const own = ownStamp(store, runId);
    if (hit && sameStamp(hit.own, own)) entry = { ...hit, store: now };
    else entry = { store: now, own, calls: (hit && grown(store, runId, hit, own)) ?? store.getCalls(runId) };
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

/**
 * A run's calls as read before (`runCalls`), when they still stand; null when this thread hasn't read
 * them, or they changed since. Reads no call: a page answers from them when it can, and otherwise
 * reads only what it shows.
 */
export function keptCalls(store: Store, runId: string): readonly CallRecord[] | null {
  const hit = kept.get(store)?.get(runId);
  if (!hit) return null;
  const counts = store.changeCounts();
  if (hit.store === `${counts.runs ?? 0}|${counts.calls ?? 0}`) return hit.calls;
  return sameStamp(hit.own, ownStamp(store, runId)) ? hit.calls : null;
}
