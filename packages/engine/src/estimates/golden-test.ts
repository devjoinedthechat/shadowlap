import type { CostReport } from '../injection.js';
import type { TestResultData } from '../store.js';
import { noEstimate, noPriceWords, type Estimate } from './estimate.js';

/*
 * What one golden's test bills, and what a test's results spent live: in a module of its own with
 * nothing of node in it, so the dashboard's Run test after a pack prices itself as the server does
 * (tests.ts re-exports it with the rest of Tests' estimates).
 */

/** A session's result for one golden, as the store keeps it: what its attempts and its judges spent live. */
export type SessionResult = { data: Pick<TestResultData, 'spent' | 'judge'> | null };

/** What an injection gate's test spent, as its report keeps it. */
export type GateSpend = Pick<CostReport, 'spent' | 'unknownModels'>;

/** What results spent live, their judges' calls with theirs, and the models among them with no price. */
export function spendOf(results: readonly SessionResult[], gates: readonly GateSpend[] = []): { usd: number; unpriced: string[] } {
  let usd = 0;
  const unpriced = new Set<string>();
  for (const r of results) {
    usd += (r.data?.spent ?? 0) + (r.data?.judge?.spent ?? 0);
    for (const m of r.data?.judge?.unknownModels ?? []) unpriced.add(m);
  }
  for (const g of gates) {
    usd += g.spent;
    for (const m of g.unknownModels) unpriced.add(m);
  }
  return { usd, unpriced: [...unpriced] };
}

/** Why a spend says nothing of what the next job bills: a model with no price among it, or nothing spent live (`nothing`); null when it says what it should. */
export function spendNone(spend: { usd: number; unpriced: readonly string[] }, nothing: string): string | null {
  if (spend.unpriced.length) return noPriceWords({ unpriced: spend.unpriced });
  return spend.usd > 0 ? null : nothing;
}

/** How a golden marked fork runs in a test, as its estimate's part says it. */
export const FORK_LIVE = 'live from there, writes blocked';

/**
 * Run test on one golden, as Not covered runs the golden a pack just made: one that replays is
 * replayed offline, Free; one marked fork runs live from where the agent parts from its recording
 * (the ask's lead says where: `live from there, writes blocked`), priced at what its last test spent
 * live, with no estimate until it has run once, nor when that spent nothing live.
 */
export function goldenTestEstimate(fork: boolean, last: SessionResult | null): Estimate {
  if (!fork) return { kind: 'tests', usd: 0, ceiling: false, parts: ['replays offline'] };
  const parts = [FORK_LIVE];
  if (!last?.data) return noEstimate('tests', 'no estimate until it has run once', parts);
  const spend = spendOf([last]);
  const none = spendNone(spend, 'its last test spent nothing live, so what this one bills is unknown');
  if (none) return noEstimate('tests', none, parts);
  return { kind: 'tests', usd: spend.usd, ceiling: false, note: 'as its last test spent', parts, last: { usd: spend.usd, attempts: null } };
}
