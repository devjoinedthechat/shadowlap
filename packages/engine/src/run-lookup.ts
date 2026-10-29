import type { StoreOf } from './store.js';
import type { RunRecord } from './types.js';

/**
 * A run by its full id or, as the CLI prints and accepts them, a unique prefix; null for none, for a
 * prefix several runs share, and for what can't be a run id at all.
 */
export function lookupRun(store: StoreOf<'recording'>, idOrPrefix: string): RunRecord | null {
  if (!/^[0-9A-Za-z]{1,26}$/.test(idOrPrefix)) return null;
  try {
    return store.findRun(idOrPrefix);
  } catch {
    return null; // ambiguous
  }
}
