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

/** The reads a price takes from `store`, at the config's `prices`. */
export function pricingOf(store: Store, prices: Record<string, Price> | undefined): Pricing {
  const modelOf = modelResolver(store);
  return { raw: (id) => runCalls(store, id), calls: (id) => pricedCalls(runCalls(store, id), { modelOf, ...(prices ? { prices } : {}) }), prices };
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
