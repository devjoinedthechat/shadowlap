import type { StoreOf, StoredBlame } from './store.js';
import type { BlameRecord } from './types.js';

/** A blame a repair reuses: the run unrescued, or the call that lost it with the fork that passed from there. */
export type ReusedBlame =
  | { stored: BlameRecord & { outcome: 'unrescuable' }; kept: StoredBlame }
  | { stored: BlameRecord & { outcome: 'blamed'; callNo: number; rescuedRunId: string }; kept: StoredBlame };

/**
 * The blame `shadowlap repair` reuses on failing run `runId` rather than search again: the one stored
 * on the run (`meta.blame`), with the one kept with its fix, when the stored one searched under the
 * same check (`oracle`), rescue (`fields`) and scope, and found something to build on: the run
 * unrescued, or the call that lost it with the fork that passed from there, still in the store. Null
 * for none, and for one stopped part way or whose fork is gone, which the repair blames again; Run
 * repair's estimate prices a blame of each such run (estimates/repair.ts).
 */
export function reusedBlame(store: StoreOf<'recording' | 'fixes'>, runId: string, o: { oracle: readonly string[]; fields: Record<string, unknown>; scope: string | null }): ReusedBlame | null {
  const stored = store.getRun(runId)?.meta?.blame;
  const kept = store.blamesOfRun(runId).at(-1);
  if (!stored || !kept || JSON.stringify(stored.oracle) !== JSON.stringify(o.oracle) || JSON.stringify(stored.fields ?? {}) !== JSON.stringify(o.fields) || (stored.scope ?? null) !== o.scope) return null;
  if (stored.outcome === 'unrescuable') return { stored: { ...stored, outcome: 'unrescuable' }, kept };
  if (stored.outcome !== 'blamed' || stored.callNo === null || !stored.rescuedRunId || !store.getRun(stored.rescuedRunId)) return null;
  return { stored: { ...stored, outcome: 'blamed', callNo: stored.callNo, rescuedRunId: stored.rescuedRunId }, kept };
}
