import type { RunRecord, Store } from '@shadowlap/engine';

/**
 * Every run, read once per change to the runs table: the meta endpoint's counts, the live runs and
 * the activity feed all scan it, and between changes they share one reading. A recording that only
 * grows (new calls) does not change the runs table, so polling during one reads nothing again.
 */
export interface CachedRuns {
  /** The runs table's write counter when this was read. */
  version: number;
  /** Newest first. */
  runs: RunRecord[];
  byId: Map<string, RunRecord>;
  /** Runs recording now. */
  live: RunRecord[];
  /** Runs that are attempts of another (`--repeat`, blame probes, verify): left out of the run count. */
  attempts: number;
}

const cache = new WeakMap<Store, CachedRuns>();

/** An attempt of another run, bundled under it rather than counted as a run of its own. */
export function isAttempt(run: RunRecord): boolean {
  return !!(run.meta?.repeat || run.meta?.probe || run.meta?.verify);
}

export function cachedRuns(store: Store): CachedRuns {
  const version = store.changeCounts().runs ?? 0;
  const cached = cache.get(store);
  if (cached && cached.version === version) return cached;
  const runs = store.allRuns();
  const read: CachedRuns = {
    version,
    runs,
    byId: new Map(runs.map((r) => [r.runId, r])),
    live: runs.filter((r) => r.status === 'running'),
    attempts: runs.filter(isAttempt).length,
  };
  cache.set(store, read);
  return read;
}
