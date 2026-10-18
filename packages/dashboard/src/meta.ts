import type { Store } from '@shadowlap/engine';
import { countRuns } from './runs-list.js';
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

/**
 * Runs recording now, with their calls so far. A run whose recording process is gone (killed, or
 * on a machine that went down) is not one, though its status still says running until gc marks it
 * interrupted. Asked fresh each time: a process can end without anything in the store changing.
 */
export function liveRuns(store: Store): LiveRun[] {
  return store.recordingRuns().live.map(({ run }) => {
    const row = store.query(`SELECT COUNT(*) AS events, COALESCE(SUM(phase = 'start'), 0) AS calls FROM call_events WHERE run_id = ?`, run.runId)[0];
    return { runId: run.runId, calls: Number(row?.calls ?? 0), events: Number(row?.events ?? 0) };
  });
}

export function metaView(store: Store, input: MetaInput): MetaView {
  return {
    version: input.version,
    dbPath: input.dbPath,
    actions: input.actions,
    readOnly: input.readOnly,
    readOnlyReason: input.readOnlyReason,
    address: input.address,
    // As SQLite counts the store, which Settings shows too; the files on disk can be larger for a while.
    storeBytes: input.dbPath && input.dbPath !== ':memory:' ? store.size().bytes : null,
    // Counted as the Runs page counts them: attempts bundled under their run, test replays as runs.
    counts: countRuns(store),
    live: liveRuns(store),
    jobKinds: input.jobKinds,
    uploadLimit: input.uploadLimit,
    project: input.project,
  };
}
