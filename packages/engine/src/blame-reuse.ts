import { unsettledFirst } from './blame.js';
import { canonicallySame } from './canonical.js';
import type { StoreOf, StoredBlame } from './store.js';
import type { BlameRecord } from './types.js';

/** A blame a repair reuses: the run unrescued, or the call that lost it with the fork that passed from there. */
export type ReusedBlame =
  | { stored: BlameRecord & { outcome: 'unrescuable' }; kept: StoredBlame }
  | { stored: BlameRecord & { outcome: 'blamed'; callNo: number; rescuedRunId: string }; kept: StoredBlame };

/** What a search was made under: its check (`oracle`), its rescue (`fields`, a model among them) and its scope. */
interface Search {
  oracle: readonly string[];
  fields: Record<string, unknown>;
  scope: string | null;
}

/** Whether a blame searched as `o` asks: the same check, the same rescue, whatever order its fields were set in, and the same scope. */
const searchedAs = (b: { oracle: readonly string[]; fields?: Record<string, unknown> | undefined; scope?: string | null | undefined }, o: Search): boolean =>
  JSON.stringify(b.oracle) === JSON.stringify(o.oracle) && canonicallySame(b.fields ?? {}, o.fields) && (b.scope ?? null) === o.scope;

/** A kept blame as a run keeps its own (`meta.blame`), as the CLI's blame writes it. */
function recordOf(kept: StoredBlame): BlameRecord {
  const r = kept.report;
  return {
    at: kept.at,
    outcome: r.outcome,
    ...(unsettledFirst(r) ? { unsettled: true } : {}),
    callNo: r.blamed?.callNo ?? null,
    confidence: r.confidence,
    range: r.range ?? null,
    errorBound: r.errorBound ?? null,
    rescuedRunId: r.contrast?.rescuedRunId ?? null,
    fields: r.rescue?.fields ?? {},
    ...(kept.scope ? { scope: kept.scope } : {}),
    oracle: r.oracle,
    probes: r.probes.map((x) => ({ callNo: x.callNo, passes: x.passes, attempts: x.attempts.length, rescued: x.rescued })),
    spent: r.spent,
  };
}

/** What a blame found to build on: the run unrescued, or the call that lost it with its fork still in the store; null for one stopped part way, or whose fork is gone. */
function builtOn(store: StoreOf<'recording'>, stored: BlameRecord, kept: StoredBlame): ReusedBlame | null {
  if (stored.outcome === 'unrescuable') return { stored: { ...stored, outcome: 'unrescuable' }, kept };
  if (stored.outcome !== 'blamed' || stored.callNo === null || !stored.rescuedRunId || !store.getRun(stored.rescuedRunId)) return null;
  return { stored: { ...stored, outcome: 'blamed', callNo: stored.callNo, rescuedRunId: stored.rescuedRunId }, kept };
}

/**
 * The blame `shadowlap repair` reuses on failing run `runId` rather than search again: the one stored
 * on the run (`meta.blame`), with the one kept with its fix, when the stored one searched under the
 * same check (`oracle`), rescue (`fields`) and scope, and found something to build on: the run
 * unrescued, or the call that lost it with the fork that passed from there, still in the store. Where
 * the run was blamed here another way since, as with a stronger model, it is the newest search of it
 * made here and kept with a fix under that check, rescue and scope. Null for none, and for one stopped
 * part way or whose fork is gone, which the repair blames again; Run repair's estimate prices a blame
 * of each such run (estimates/repair.ts).
 */
export function reusedBlame(store: StoreOf<'recording' | 'fixes'>, runId: string, o: Search): ReusedBlame | null {
  const stored = store.getRun(runId)?.meta?.blame;
  const kept = store.blamesOfRun(runId);
  const last = kept.at(-1);
  if (!stored || !last) return null;
  if (searchedAs(stored, o)) return builtOn(store, stored, last);
  const earlier = [...kept].reverse().find((b) => !b.pulled && searchedAs({ oracle: b.report.oracle, fields: b.report.rescue?.fields, scope: b.scope }, o));
  return earlier ? builtOn(store, recordOf(earlier), earlier) : null;
}

/**
 * The blame a repair ends with on a failing run, as it blames one (repair-run.ts `blameRun`): the one
 * it reuses under its rescue, then, where that rescued the run from no call and the repair was given
 * a stronger model (`--stronger`), the one it reuses under that model. Null where it would blame
 * afresh.
 */
export function repairReuse(store: StoreOf<'recording' | 'fixes'>, runId: string, o: Search & { stronger: string | null }): ReusedBlame | null {
  const first = reusedBlame(store, runId, o);
  if (first?.stored.outcome !== 'unrescuable' || !o.stronger) return first;
  return reusedBlame(store, runId, { ...o, fields: { ...o.fields, model: o.stronger } });
}
