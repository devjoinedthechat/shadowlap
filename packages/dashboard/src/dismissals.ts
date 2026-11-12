import { stillDismissed, type StoreOf } from '@shadowlap/engine';
import type { NeedsLook } from './needs-look/index.js';

/**
 * Needs a look with what its owner put away (Dismiss, on advice only). Dismissals are kept in this
 * project's store alone, never pushed (engine dismissals.ts), so they are the owner's. An advice row
 * stays put away while every fact it states was among those kept, the engine's rule
 * (stillDismissed), so only a fact it didn't state then brings it back, and a dismissal outlives its
 * row. Rows put away stay in their place, for the page to fold; the count is what is left.
 *
 * The stamp is the store's dismissals counter, read before the list: never newer than the list it
 * goes with, so a page holding its own view of a Dismiss until a list at or past its write's counter
 * arrives never takes an older list for the newer one.
 */
export function withDismissals(look: Omit<NeedsLook, 'dismissals'>, store: StoreOf<'activity' | 'dismissals'>): NeedsLook {
  const dismissals = store.changeCounts().dismissals ?? 0;
  const kept = new Map(store.listDismissals().map((d) => [d.key, d]));
  const items = look.items.map((x) => (x.advice ? { ...x, advice: { ...x.advice, dismissed: stillDismissed(kept.get(x.advice.key) ?? null, x.advice.facts) } } : x));
  return { items, total: items.reduce((t, x) => t + (x.advice?.dismissed ? 0 : (x.more ?? 1)), 0), dismissals };
}
