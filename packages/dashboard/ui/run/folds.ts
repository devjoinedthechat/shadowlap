import { useSyncExternalStore } from 'react';
import type { TraceGroup } from './groups.js';

/**
 * Calls' folds, kept for the session per run, in memory and not in the address, by their groups'
 * keys (groups.ts): a group is open unless folded, but a batch's item past the third, until it is
 * folded or opened, or a selection opens it, which then stays open. Written in a handler or an
 * effect, never while a list draws; the page draws again as they change (`useFolds`).
 */

const kept = new Map<string, Map<string, boolean>>();
const listeners = new Set<() => void>();
let version = 0;

const changed = () => {
  version++;
  for (const l of listeners) l();
};

/** Whether a run's group is open: as folded or opened, else open but a batch's item past the third. */
export function isOpen(runId: string, g: TraceGroup): boolean {
  return kept.get(runId)?.get(g.key) ?? !g.shut;
}

/** Folds or opens groups of a run; nothing draws again when none changes. */
export function setFolds(runId: string, keys: readonly string[], open: boolean): void {
  let run = kept.get(runId);
  let any = false;
  for (const key of keys) {
    if (run?.get(key) === open) continue;
    if (!run) kept.set(runId, (run = new Map<string, boolean>()));
    run.set(key, open);
    any = true;
  }
  if (any) changed();
}

/** The folds' version, for a page to draw again as they change. */
export function useFolds(): number {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => version,
  );
}

/** Every run's folds forgotten, for tests. */
export function forgetFolds(): void {
  kept.clear();
  changed();
}
