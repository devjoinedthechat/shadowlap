import { statSync } from 'node:fs';
import type { Store } from '@shadowlap/engine';
import { runIndex } from './run-index.js';
import type { LiveRun, MetaView, ProjectView } from './views.js';

/** `GET /api/meta` as a plain function: the store and what the server knows about itself. */

export interface MetaInput {
  version: string | null;
  dbPath: string | null;
  actions: boolean;
  readOnly: boolean;
  readOnlyReason: string | null;
  address: string | null;
  jobKinds: string[];
  uploadLimit: number | null;
  project: ProjectView | null;
}

/** Runs recording now, with their calls so far. */
export function liveRuns(store: Store): LiveRun[] {
  return runIndex(store).live.map((r) => ({ runId: r.runId, calls: store.countCalls(r.runId) }));
}

/** The store's size on disk: the database and its write-ahead log. Null in memory or when it cannot be read. */
export function storeBytes(dbPath: string | null): number | null {
  if (!dbPath || dbPath === ':memory:') return null;
  let total: number;
  try {
    total = statSync(dbPath).size;
  } catch {
    return null;
  }
  try {
    total += statSync(`${dbPath}-wal`).size;
  } catch {
    // no write-ahead log right now
  }
  return total;
}

export function metaView(store: Store, input: MetaInput): MetaView {
  const index = runIndex(store);
  return {
    version: input.version,
    dbPath: input.dbPath,
    actions: input.actions,
    readOnly: input.readOnly,
    readOnlyReason: input.readOnlyReason,
    address: input.address,
    storeBytes: storeBytes(input.dbPath),
    counts: { runs: index.runs.length - index.attempts, attempts: index.attempts },
    live: liveRuns(store),
    jobKinds: input.jobKinds,
    uploadLimit: input.uploadLimit,
    project: input.project,
  };
}
