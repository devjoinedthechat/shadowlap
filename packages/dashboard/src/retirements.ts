import { isReservedScope, type RetirementNotice, retirementOf, type StoreOf } from '@shadowlap/engine';
import type { GoldenSource } from './tests.js';

/*
 * The models the project's goldens are recorded on that retire, by the table that ships with
 * Shadowlap: one reading for Changes' retirements list and Needs a look's rows, so the two can't
 * drift apart.
 */

/** A model that retires, with the goldens whose recordings call it. */
export type RetiringModel = RetirementNotice & { goldens: string[]; scopes: string[] };

/** A model a recording calls: the scopes its calls were made in, and how many calls it made. */
type Model = { provider: string | null; model: string; scopes: string[]; calls: number };

/**
 * The models each golden's recording calls, by run, kept per store: a finished recording never
 * changes, so its calls are read once, not on every look. Shadowlap's own calls (its judge's) are no
 * model the agent uses.
 */
const modelsRead = new WeakMap<object, Map<string, Model[]>>();

export function modelsOf(store: StoreOf<'recording'>, runId: string): Model[] {
  const kept = modelsRead.get(store) ?? new Map<string, Model[]>();
  modelsRead.set(store, kept);
  const known = kept.get(runId);
  if (known) return known;
  const seen = new Map<string, Model>();
  for (const c of store.getCalls(runId)) {
    if (c.kind !== 'api' || isReservedScope(c.meta.scope)) continue;
    const model = c.end?.meta.model ?? c.meta.model ?? null;
    if (!model) continue;
    const provider = c.meta.provider ?? c.end?.meta.provider ?? null;
    const key = `${String(provider)}\u0000${model}`;
    const m = seen.get(key) ?? { provider, model, scopes: [], calls: 0 };
    m.calls += 1;
    // The scopes its calls were made in (the agent's own, or a subagent's), for Migrate's start page.
    if (typeof c.meta.scope === 'string' && c.meta.scope && !m.scopes.includes(c.meta.scope)) m.scopes.push(c.meta.scope);
    seen.set(key, m);
  }
  const models = [...seen.values()];
  if (store.getRun(runId)?.status !== 'running') kept.set(runId, models);
  return models;
}

/** The soonest first (a model with no date last), then the one the most goldens use. */
export const soonestFirst = (a: RetiringModel, b: RetiringModel): number => (a.days ?? Number.MAX_SAFE_INTEGER) - (b.days ?? Number.MAX_SAFE_INTEGER) || b.goldens.length - a.goldens.length;

/**
 * Each model the goldens' recordings call that retires, by provider and model, with the goldens that
 * use it, the soonest first. A golden not in the store yet (never tested here) can't be read, and is
 * left out.
 */
export function retiringModels(store: StoreOf<'recording'>, goldens: readonly GoldenSource[], now: number): RetiringModel[] {
  const byModel = new Map<string, RetiringModel>();
  for (const g of goldens) {
    if (!g.runId || !store.getRun(g.runId)) continue;
    for (const m of modelsOf(store, g.runId)) {
      const key = `${String(m.provider)}\u0000${m.model}`;
      const known = byModel.get(key);
      const notice = known ?? (() => {
        const n = retirementOf(m.provider, m.model, { now });
        return n ? { ...n, goldens: [] as string[], scopes: [] as string[] } : null;
      })();
      if (!notice) continue;
      notice.goldens.push(g.path);
      notice.scopes = [...new Set([...notice.scopes, ...m.scopes])];
      byModel.set(key, notice);
    }
  }
  return [...byModel.values()].sort(soonestFirst);
}
