import { useSyncExternalStore } from 'react';
import type { TraceGroup } from './groups.js';

/**
 * Calls' folds, kept for the session per run, in memory and not in the address, by their groups'
 * keys (groups.ts): a group is open unless folded, but a batch's item past the third, until it is
 * folded or opened, or a selection opens it, which then stays open. Written in a handler or an
 * effect, never while a list draws; a run's folds are a new map at each change, so the page that
 * reads them (`useFolds`) draws again.
 */

export type Folds = ReadonlyMap<string, boolean>;

const NONE: Folds = new Map();
const kept = new Map<string, Folds>();
const listeners = new Set<() => void>();

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/** Whether a group is open in a run's folds: as folded or opened, else open but a batch's item past the third. */
export const openIn = (folds: Folds, g: TraceGroup): boolean => folds.get(g.key) ?? !g.shut;

/** Whether a run's group is open. */
export function isOpen(runId: string, g: TraceGroup): boolean {
  return openIn(kept.get(runId) ?? NONE, g);
}

/** Folds or opens groups of a run; nothing draws again when none changes. */
export function setFolds(runId: string, keys: readonly string[], open: boolean): void {
  const was = kept.get(runId) ?? NONE;
  if (keys.every((key) => was.get(key) === open)) return;
  const next = new Map(was);
  for (const key of keys) next.set(key, open);
  kept.set(runId, next);
  for (const l of listeners) l();
}

/** A run's folds, drawn again as they change. */
export function useFolds(runId: string): Folds {
  return useSyncExternalStore(subscribe, () => kept.get(runId) ?? NONE);
}

/** Every run's folds forgotten, for tests. */
export function forgetFolds(): void {
  kept.clear();
  for (const l of listeners) l();
}
