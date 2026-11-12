/**
 * The session each run's Decisions view shows, picked while the page is open: apart from the view,
 * so a new preview of one run can drop its run's pick without loading the view, and the newest,
 * that preview once it ends, shows.
 */
const picked = new Map<string, string>();

export const pickedSession = (runId: string): string | undefined => picked.get(runId);

export function pickSession(runId: string, sessionId: string): void {
  picked.set(runId, sessionId);
}

/** A preview of this one run started: its view shows the newest again. */
export function dropPick(runId: string): void {
  picked.delete(runId);
}

/** Forgets the sessions picked, for tests. */
export function forgetDecisionsPick(): void {
  picked.clear();
}
