import { countAttempts, type RunRecord, type Store } from '@shadowlap/engine';

/**
 * Every run, read once per change to the runs table: the activity feed scans it, and between
 * changes its pages share one reading. A recording that only
 * grows (new calls) does not change the runs table, so polling during one reads nothing again.
 */
export interface CachedRuns {
  /** The runs table's write counter when this was read. */
  version: number;
  /** Newest first. */
  runs: RunRecord[];
  byId: Map<string, RunRecord>;
  /**
   * Attempts bundled under a run in the store, by the engine's one rule (run-roles.ts): left out of
   * the run count, as the run index, the status bar and an exported copy count them.
   */
  attempts: number;
}

const cache = new WeakMap<Store, CachedRuns>();

/** Which runs are attempts, and how many of some runs are bundled: the engine's one rule (run-roles.ts). */
export { countAttempts, isAttempt } from '@shadowlap/engine';

export function cachedRuns(store: Store): CachedRuns {
  const version = store.changeCounts().runs ?? 0;
  const cached = cache.get(store);
  if (cached && cached.version === version) return cached;
  const runs = store.allRuns();
  const read: CachedRuns = {
    version,
    runs,
    byId: new Map(runs.map((r) => [r.runId, r])),
    attempts: countAttempts(runs).attempts,
  };
  cache.set(store, read);
  return read;
}
