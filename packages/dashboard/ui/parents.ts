/**
 * Each run's parent, as the run details loaded so far name it. A run's page loads its detail; the top
 * bar's crumb reads the parent from here for a run the run list leaves out (an attempt bundled under
 * its run, or one older than the newest 500), so it never asks the server for the same detail again.
 * A run's parent never changes. No DOM here: the tests import it.
 */

const parents = new Map<string, string | null>();
const listeners = new Set<() => void>();

/** Notes the parent of a run, under each id it was asked for by (a short id, the full one). */
export function noteParent(runIds: readonly string[], parent: string | null): void {
  let changed = false;
  for (const id of runIds) {
    if (parents.has(id) && parents.get(id) === parent) continue;
    parents.set(id, parent);
    changed = true;
  }
  if (changed) for (const listener of [...listeners]) listener();
}

/** The parent of a run whose detail was loaded (null: it has none), or undefined when none was. */
export function knownParent(runId: string): string | null | undefined {
  return parents.get(runId);
}

/** Calls `listener` whenever a parent is noted; hands back the call that stops it. */
export function onParentNoted(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
