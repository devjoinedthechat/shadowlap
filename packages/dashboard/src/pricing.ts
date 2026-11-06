import { modelResolver, pricedCalls, type CallRecord, type Estimate, type Price, type PricedCall, type Store } from '@shadowlap/engine';
import { runCalls } from './run-calls.js';

/**
 * How the dashboard works out what a job bills, once an answer has the runs' calls: a run's next step
 * (next-step.ts) and the estimates a page asks for (estimates.ts), from the same reads, so the card,
 * the ask and the drawer say the same. Pricing a list's rows would read every run's.
 */

/** What a price reads: a run's calls, and its model calls priced as asked live. */
export interface Pricing {
  raw: (runId: string) => readonly CallRecord[];
  calls: (runId: string) => PricedCall[];
  prices: Record<string, Price> | undefined;
}

/** How to work out what a step bills. */
export interface Priced {
  price?: (p: Pricing) => Estimate | null | Promise<Estimate | null>;
  /** The runs whose calls its price reads: none for a price that reads none, which any answer can work out. */
  reads?: readonly string[];
}

/** The runs an answer keeps read and priced, the last it read: as many as its estimates read again, never every golden's of Tests. */
const KEEP = 4;

/** `read`, each run read once while it is among the last KEEP read, every reader given the same value. */
function keptRuns<T>(read: (runId: string) => T): (runId: string) => T {
  const kept = new Map<string, T>();
  return (runId) => {
    const had = kept.get(runId);
    kept.delete(runId);
    const value = had ?? read(runId);
    kept.set(runId, value);
    if (kept.size > KEEP) kept.delete(kept.keys().next().value!);
    return value;
  };
}

/**
 * The reads a price takes from `store`, at the config's `prices`, for one answer: a run's calls are
 * read and priced once, however many of its estimates read them (each fork menu row, a fix's repair
 * and blames), and every one gets the same calls, which none of them changes.
 */
export function pricingOf(store: Store, prices: Record<string, Price> | undefined): Pricing {
  const modelOf = modelResolver(store);
  const raw = keptRuns((id) => runCalls(store, id));
  const calls = keptRuns((id) => pricedCalls(raw(id), { modelOf, ...(prices ? { prices } : {}) }));
  return { raw, calls, prices };
}

/**
 * What a job bills. An estimate is a card's extra line, and what it reads can come from someone
 * else's pack: one that can't be worked out leaves the line out, never the answer.
 */
export async function estimateOf(price: NonNullable<Priced['price']>, pricing: Pricing): Promise<Estimate | null> {
  try {
    return await price(pricing);
  } catch {
    return null;
  }
}
