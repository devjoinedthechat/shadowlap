import { type Estimate, migrateEstimate, recordedChecks, recordedRole, type Price, type Store } from '@shadowlap/engine';
import type { ConfigVerifyRule } from './estimates.js';
import { sameSwitch } from './migrate-applied.js';
import { estimateOf, pricingOf } from './pricing.js';
import { answer, type ReadAnswer, type ReadTable } from './read-registry.js';
import { parseWork, type OutcomeWork } from './run-outcome.js';
import type { GoldenSource } from './tests.js';

/**
 * What Migrate to <model> bills, as `GET /api/migrate/estimate` answers it: migrate's ceiling over the
 * goldens and runs it asks (migrateEstimate: the switched calls asked again, then each verified, one
 * whose recording fails its checks up to the gate's most attempts, one that passes in pairs), and the
 * newest preview of the same switch, which the dialog names. A pooled read: it judges each recording
 * by its checks and reads its calls.
 */

/** `GET /api/migrate/estimate`'s answer: migrate's ceiling, and the newest preview of the same switch, which asked these already. */
export interface MigrateEstimateView {
  estimate: Estimate | null;
  preview: { sessionId: string; verified: boolean } | null;
}

/** `goldens`, the goldens it asks; `runs`, the runs of the store it asks by id, judged by the checks of the recording each comes from, as the job judges them. */
export type MigrateEstimateJob = { kind: 'migrate-estimate'; to: string; from: string[]; goldens: GoldenSource[]; runs?: string[]; work: OutcomeWork | null; rule: ConfigVerifyRule; prices?: Record<string, Price> };

/**
 * The newest preview of the same switch (`sameSwitch`) that asked every run the migration asks, which
 * the dialog says asked these already, and whether verify ran on it.
 */
export function newestPreviewOf(store: Store, to: string, from: readonly string[], runs: readonly string[]): { sessionId: string; verified: boolean } | null {
  for (const row of store.listDecisionSessions({ kind: 'decisions', limit: 200 })) {
    const kept = store.decisionReport(row.sessionId) ?? {};
    if (!sameSwitch(kept, { to, from })) continue;
    const asked = new Set(store.decisionRunIds(row.sessionId));
    if (!runs.every((id) => asked.has(id))) continue;
    const verify = kept.verify as { verdict?: unknown } | null | undefined;
    return { sessionId: row.sessionId, verified: !!verify && verify.verdict !== 'not-run' };
  }
  return null;
}

async function migrateEstimates(store: Store, job: MigrateEstimateJob): Promise<ReadAnswer> {
  const entries = parseWork(job.work)?.entries ?? [];
  const goldens = job.goldens.flatMap((g) => {
    const run = g.runId ? store.getRun(g.runId) : null;
    return run ? [{ golden: g.path, run }] : [];
  });
  const runs = (job.runs ?? []).flatMap((id) => {
    const run = store.getRun(id);
    return run ? [{ golden: null, run }] : [];
  });
  const live = [...goldens, ...runs];
  const estimate = await estimateOf(
    (p) =>
      migrateEstimate(
        live.map(({ golden, run }) => ({ calls: p.calls(run.runId), failed: recordedRole(store, run, recordedChecks(entries, store, run, job.work?.dir ?? process.cwd(), golden)?.spec ?? null, job.prices) === 'target' })),
        { to: job.to, from: job.from, rule: job.rule, ...(job.prices ? { prices: job.prices } : {}) },
      ),
    pricingOf(store, job.prices),
  );
  const view: MigrateEstimateView = { estimate, preview: newestPreviewOf(store, job.to, job.from, live.map(({ run }) => run.runId)) };
  return answer(view, { tagged: true });
}

export const MIGRATE_ESTIMATE_READS: ReadTable<MigrateEstimateJob> = {
  'migrate-estimate': (store, job) => migrateEstimates(store, job),
};
