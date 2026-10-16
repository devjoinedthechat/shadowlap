import { searchExpression, updateSearchIndex, type CallKind, type SearchHit, type Store } from '@shadowlap/engine';
import { loadRunIndex, type RunIndex } from './run-index.js';

/**
 * What the palette's "In recorded data" gets from a search. An attempt bundled under a run
 * (`--repeat`, a blame probe, a verify attempt) replays that run, so its text is mostly the run's,
 * call for call, and the index ranks the copies as high as the run's own: a blame of 37 probes would
 * otherwise fill the list with one snippet, and the recording, which is what to open, would not make
 * it. So the index is asked in two steps, neither cut at a fixed depth: first for runs of their own
 * (recordings, forks, tests, captures), then, among the rest, for attempts of runs that have no hit
 * of their own. Each step keeps a run's best few hits, so one long run can't fill the list either.
 * No HTTP here: the tests call it with a store.
 */

export interface RecordedHit extends SearchHit {
  /** The run this hit's run is an attempt of, bundled under it; null for a run of its own. */
  attemptOf: string | null;
}

/** The most hits a search gives one run, or the attempts of one run together: the palette shows two of a run. */
export const PER_RUN = 2;

// Each hit with its call's kind and name and its run's start; the snippet is worked out only for the
// hits kept.
const COLUMNS = `search_docs.run_id AS run, search_docs.call_no AS call, search_docs.field AS field,
       snippet(search_docs, 0, char(1), char(2), '…', 14) AS snip,
       (SELECT e.kind FROM call_events AS e WHERE e.run_id = search_docs.run_id AND e.call_no = search_docs.call_no AND e.phase = 'start' LIMIT 1) AS kind,
       (SELECT e.name FROM call_events AS e WHERE e.run_id = search_docs.run_id AND e.call_no = search_docs.call_no AND e.phase = 'start' LIMIT 1) AS name,
       (SELECT r.started_at FROM runs AS r WHERE r.run_id = search_docs.run_id) AS started`;

// Both bind the match, the match again, the runs (a JSON array), the most hits per run and the limit.

/** Runs of their own, best first: every run but the attempts named, each run's best PER_RUN hits. */
const OWN_SQL = `SELECT ${COLUMNS}
FROM search_docs
WHERE search_docs MATCH ? AND search_docs.rowid IN (
  SELECT id FROM (
    SELECT search_docs.rowid AS id, rank AS r, row_number() OVER (PARTITION BY search_docs.run_id ORDER BY rank) AS n
    FROM search_docs
    WHERE search_docs MATCH ? AND search_docs.run_id NOT IN (SELECT value FROM json_each(?))
  ) WHERE n <= ? ORDER BY r LIMIT ?
)
ORDER BY rank`;

/** The attempts named, best first, the best PER_RUN hits of each run's attempts together. */
const ATTEMPTS_SQL = `SELECT ${COLUMNS}
FROM search_docs
WHERE search_docs MATCH ? AND search_docs.rowid IN (
  SELECT id FROM (
    SELECT search_docs.rowid AS id, rank AS r, row_number() OVER (PARTITION BY p.parent_run_id ORDER BY rank) AS n
    FROM search_docs JOIN runs AS p ON p.run_id = search_docs.run_id
    WHERE search_docs MATCH ? AND search_docs.run_id IN (SELECT value FROM json_each(?))
  ) WHERE n <= ? ORDER BY r LIMIT ?
)
ORDER BY rank`;

function hits(store: Store, sql: string, match: string, runs: readonly string[], limit: number, attemptOf: (runId: string) => string | null): RecordedHit[] {
  const out: RecordedHit[] = [];
  for (const row of store.query(sql, match, match, JSON.stringify(runs), PER_RUN, limit)) {
    // A run or a call gone since the index was brought up to date is left out, as the engine's search does.
    if (typeof row.kind !== 'string' || typeof row.started !== 'number') continue;
    const runId = String(row.run);
    out.push({
      runId,
      callNo: Number(row.call),
      kind: row.kind as CallKind,
      name: String(row.name),
      field: String(row.field),
      snippet: String(row.snip),
      runStartedAt: row.started,
      attemptOf: attemptOf(runId),
    });
  }
  return out;
}

/**
 * Searches what runs recorded: prompts, responses, tool arguments and results. Hits from runs of
 * their own come first, best first; then hits from attempts whose run has no hit of its own, each
 * naming that run (`attemptOf`). At most PER_RUN hits of a run (of one run's attempts, together),
 * and `limit` in all. An attempt whose run is gone is listed like any run, so it is a run of its own.
 */
export function searchRecorded(store: Store, query: string, limit: number, index: RunIndex = loadRunIndex(store)): RecordedHit[] {
  const match = searchExpression(query);
  if (!match || limit < 1) return [];
  updateSearchIndex(store);
  const attempts = index.runs.filter((r) => r.bundled && r.attemptOf !== null);
  const own = hits(store, OWN_SQL, match, attempts.map((r) => r.runId), limit, () => null);
  // Short of the limit, every run of its own that matches is here: an attempt of any other run has
  // nothing of its run's to repeat.
  if (own.length >= limit) return own;
  const found = new Set(own.map((h) => h.runId));
  const of = new Map(attempts.filter((r) => !found.has(r.attemptOf!)).map((r) => [r.runId, r.attemptOf!]));
  if (!of.size) return own;
  return [...own, ...hits(store, ATTEMPTS_SQL, match, [...of.keys()], limit - own.length, (id) => of.get(id) ?? null)];
}
