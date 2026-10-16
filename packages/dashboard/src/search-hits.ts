import type { SearchHit } from '@shadowlap/engine';
import type { IndexedRun } from './run-index.js';

/**
 * What the palette's "In recorded data" gets from a search: each hit says whether its run is an
 * attempt bundled under another (`--repeat`, a blame probe, a verify attempt), and which. An attempt
 * replays the run it came from, so its text is mostly that run's, call for call: a blame of 37 probes
 * would otherwise fill the six hits with one snippet, and the recording, which is what to open, would
 * not make the list. No HTTP here: the tests call it with a run index.
 */

export interface RecordedHit extends SearchHit {
  /** The run this hit's run is an attempt of, bundled under it; null for a run of its own. */
  attemptOf: string | null;
}

/** How many hits a search asks the index for to rank `limit` of them: enough that attempts can't crowd runs out. */
export function searchDepth(limit: number): number {
  return Math.min(500, Math.max(limit, 1) * 5);
}

/**
 * The hits in the order the palette should see them: hits from runs of their own (recordings, forks,
 * tests, captures) first, then hits from attempts, each in the order the search ranked them, cut to
 * `limit`. An attempt whose run is gone is listed like any run, so it counts as a run of its own.
 */
export function rankRecorded(hits: readonly SearchHit[], byId: ReadonlyMap<string, Pick<IndexedRun, 'bundled' | 'attemptOf'>>, limit: number): RecordedHit[] {
  const marked = hits.map((h): RecordedHit => {
    const run = byId.get(h.runId);
    return { ...h, attemptOf: run?.bundled && run.attemptOf ? run.attemptOf : null };
  });
  return [...marked.filter((h) => !h.attemptOf), ...marked.filter((h) => h.attemptOf)].slice(0, Math.max(0, limit));
}
