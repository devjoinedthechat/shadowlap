import { retirementTable, type Store } from '@shadowlap/engine';
import { checkedWords, newestMigrationsFrom } from './migrate-applied.js';
import { answer, type ReadTable } from './read-registry.js';
import { modelsOf, retiringModels, type RetiringModel } from './retirements.js';
import type { GoldenSource } from './tests.js';

/**
 * What Changes › Migrate opens on, as `GET /api/migrate/start` answers it: how many goldens the
 * project has, each model their recordings call that retires (its notice, the goldens and scopes that
 * call it, its platform's name and owner, and whether a migration from it checked it), and the models
 * the goldens call, most used first, for Switch from. A pooled read: it reads every golden's calls,
 * kept per run once a run has ended.
 */

export type MigrateStartJob = { kind: 'migrate-start'; goldens: GoldenSource[] };

/** A retiring model as the start page shows it. `checked`: the newest migration from it, and how it came out (null once applied with none waiting). */
export type MigrateRetiring = RetiringModel & { platformName: string | null; owner: string | null; checked: { sessionId: string; words: string | null } | null };

/** A model the goldens call: how many calls and goldens. */
export interface MigrateUse {
  model: string;
  provider: string | null;
  calls: number;
  goldens: number;
}

export interface MigrateStartView {
  goldens: number;
  retiring: MigrateRetiring[];
  use: MigrateUse[];
}

export function migrateStart(store: Store, goldens: readonly GoldenSource[], now: number): MigrateStartView {
  const retiring = retiringModels(store, goldens, now);
  const checked = newestMigrationsFrom(store, [...new Set(retiring.map((n) => n.model))]);
  const platforms = retirementTable().platforms;
  const use = new Map<string, MigrateUse>();
  for (const g of goldens) {
    if (!g.runId || !store.getRun(g.runId)) continue;
    const calls = store.getCalls(g.runId);
    for (const m of modelsOf(store, g.runId)) {
      const key = `${String(m.provider)}\u0000${m.model}`;
      const u = use.get(key) ?? { model: m.model, provider: m.provider, calls: 0, goldens: 0 };
      u.goldens += 1;
      u.calls += calls.filter((c) => c.kind === 'api' && (c.end?.meta.model ?? c.meta.model) === m.model).length;
      use.set(key, u);
    }
  }
  return {
    goldens: goldens.length,
    retiring: retiring.map((n) => {
      const m = checked.get(n.model);
      const platform = platforms[n.platform];
      return { ...n, platformName: platform?.name ?? null, owner: platform?.owner ?? null, checked: m ? { sessionId: m.sessionId, words: checkedWords(store, m) } : null };
    }),
    use: [...use.values()].sort((a, b) => b.calls - a.calls || b.goldens - a.goldens || a.model.localeCompare(b.model)),
  };
}

export const MIGRATE_READS: ReadTable<MigrateStartJob> = {
  'migrate-start': (store, job) => answer(migrateStart(store, job.goldens, Date.now()), { tagged: true }),
};
