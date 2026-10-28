import { attemptBundles, withAttempts } from './classify.js';
import type { StoreOf } from './store.js';
import type { RunRecord } from './types.js';

/**
 * What `shadowlap rm`, `gc` and the terminal UI's `x` delete, as the dashboard's Delete does: each run
 * with the attempts bundled under it (`--repeat`, blame's probes, verify's attempts, a golden's
 * repeats in one test session, an error-path preset's attempts), so none is left behind as a run of
 * its own.
 */

export interface DeletionPlan {
  /** The runs asked for (with `forks`, the runs made from them after each), less those left alone. */
  runs: string[];
  /** The attempts bundled under those runs, at any depth, which go with them. */
  attempts: string[];
  /** Runs left alone, with why; the attempts bundled under them stay with them. */
  held: Array<{ runId: string; why: string }>;
}

/**
 * What deleting `runIds` (full ids) deletes. A run still recording is left alone, and so is one a run
 * in progress reads from (a replay, a fork or an attempt of it serves its answers from it), and one
 * with an attempt still running, or still replayed from. An attempt asked for along with the run it
 * is bundled under is one of that run's attempts; asked for alone, it is a run like any other.
 * `live` is the runs in progress, as `recordingRuns` tells them, when the caller has asked already
 * (`gc` asks once, as of its own now).
 */
export function deletionPlan(store: StoreOf<'recording'>, runIds: readonly string[], o: { forks?: boolean; live?: readonly RunRecord[] } = {}): DeletionPlan {
  const all = store.allRuns();
  const bundles = attemptBundles(all);
  const children = new Map<string, string[]>();
  for (const r of all) {
    if (!r.parentRunId) continue;
    const list = children.get(r.parentRunId);
    if (list) list.push(r.runId);
    else children.set(r.parentRunId, [r.runId]);
  }
  const known = new Set(all.map((r) => r.runId));
  const asked: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (seen.has(id) || !known.has(id)) return;
    seen.add(id);
    asked.push(id);
    if (o.forks) for (const child of children.get(id) ?? []) add(child);
  };
  for (const id of runIds) add(id);

  const under = new Set(asked.flatMap((id) => withAttempts(bundles, id)));
  // As the dashboard's Delete decides it, in the same words: the run itself in progress, then an
  // attempt of it, then a replay in progress reading from it or from one of its attempts.
  const live = o.live ?? store.recordingRuns().live.map((r) => r.run);
  const liveIds = new Set(live.map((r) => r.runId));
  const readFrom = new Set(live.flatMap((r) => (r.parentRunId ? [r.parentRunId] : [])));
  const holdOf = (id: string): string | null => {
    const self = live.find((r) => r.runId === id);
    if (self) return self.mode === 'record' ? 'still recording' : 'still running';
    const bundle = withAttempts(bundles, id);
    if (bundle.some((a) => liveIds.has(a))) return 'an attempt of it is still running';
    if (readFrom.has(id) || bundle.some((a) => readFrom.has(a))) return 'a replay of it is still running';
    return null;
  };
  const runs: string[] = [];
  const held: DeletionPlan['held'] = [];
  for (const id of asked) {
    if (under.has(id)) continue;
    const why = holdOf(id);
    if (why) held.push({ runId: id, why });
    else runs.push(id);
  }
  const going = new Set(runs);
  const attempts: string[] = [];
  for (const id of runs) {
    for (const a of withAttempts(bundles, id)) {
      if (going.has(a)) continue;
      going.add(a);
      attempts.push(a);
    }
  }
  return { runs, attempts, held };
}
