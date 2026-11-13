/**
 * The session each run's Decisions view shows, picked while the page is open: apart from the view,
 * so a new preview of one run can pick itself in its run's view once it ends, without loading the
 * view, and the view, shown or not, follows.
 */
const picked = new Map<string, string>();
const watchers = new Set<() => void>();

/** Calls `on` whenever a run's pick changes, until the function it returns is called. */
export function onPick(on: () => void): () => void {
  watchers.add(on);
  return () => void watchers.delete(on);
}

export const pickedSession = (runId: string): string | undefined => picked.get(runId);

export function pickSession(runId: string, sessionId: string): void {
  picked.set(runId, sessionId);
  for (const on of watchers) on();
}

/** Forgets the sessions picked, for tests. */
export function forgetDecisionsPick(): void {
  picked.clear();
}
