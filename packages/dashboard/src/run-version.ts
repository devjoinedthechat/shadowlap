import { createHash } from 'node:crypto';
import type { RunRecord, StoreOf } from '@shadowlap/engine';
import { loadRunIndex, type RunIndex } from './run-index.js';
import { bundleOf, runState } from './runs-list.js';

/**
 * Where a run's page answer (`GET /api/runs/:id`) stands, worked out without building it: the rows
 * of the family the answer reads (the run, the runs it came from, its children, the attempts filed
 * with it), the attempts bundled under it at any depth (its Delete names how many go with it), the
 * calls of the run and of its parent (how many, and their call events, as the run index counts
 * them), the run's state as the run list works it out (a run its recorder left reads interrupted
 * though nothing is written), and the fixes. Another run starting, recording or ending moves none of
 * it. The page asks again whenever runs move, and a long run's answer is megabytes worked out from
 * every call: from this, an answer the page already has is a 304 at the cost of a few small reads.
 */

const FORMAT = 'v3';

/** As far back as the answer looks for the tools a replay's recording kept off the record. */
const ANCESTORS = 16;

/**
 * Where a run's calls stand, as the run index counts them: the calls it started, and its call events,
 * which move with every call it starts or ends. Counted here, a fork of 100,000 calls and its parent
 * held the server's thread 0.4 s while a Compare read them on another.
 */
function callsStamp(index: RunIndex, runId: string): string {
  const r = index.byId.get(runId);
  return `${String(r?.calls ?? 0)}:${String(r?.callEvents ?? 0)}`;
}

function familyRows(store: StoreOf<'recording'>, run: RunRecord): RunRecord[] {
  const rows: RunRecord[] = [run];
  const seen = new Set([run.runId]);
  for (let at = run.parentRunId; at && !seen.has(at) && seen.size <= ANCESTORS; ) {
    seen.add(at);
    const up = store.getRun(at);
    if (!up) break;
    rows.push(up);
    at = up.parentRunId;
  }
  rows.push(...store.childRuns(run.runId));
  // An attempt's checks count every attempt filed with it: its siblings under the same run.
  if (run.parentRunId && (run.meta?.repeat?.group || run.meta?.test?.session)) rows.push(...store.childRuns(run.parentRunId));
  return rows;
}

/** An ETag for a run's page answer as it stands now; `extra` names what else it depends on (the prices, the part asked for). */
export function runVersionTag(store: StoreOf<'recording' | 'readModels' | 'activity'>, run: RunRecord, extra: string): string {
  const index = loadRunIndex(store);
  const parts = [
    FORMAT,
    JSON.stringify(familyRows(store, run)),
    callsStamp(index, run.runId),
    run.parentRunId ? callsStamp(index, run.parentRunId) : '',
    JSON.stringify(runState(store, run.runId)),
    bundleOf(index, run.runId)
      .map((a) => a.runId)
      .join(','),
    String(store.changeCounts().fixes ?? 0),
    extra,
  ];
  return `"r${createHash('sha1').update(parts.join('\n')).digest('base64url')}"`;
}
