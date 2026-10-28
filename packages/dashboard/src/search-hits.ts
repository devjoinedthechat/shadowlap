import { indexSearch, searchExpression, searchIndexBehind, type CallKind, type SearchHit, type SearchIndexRun, type Store, type StoreOf } from '@shadowlap/engine';
import { serverIdle } from './idle.js';
import { keepingIndex, loadRunIndex, type RunIndex } from './run-index.js';

/**
 * What the palette's "In recorded data" gets from a search. An attempt bundled under a run
 * (`--repeat`, a blame probe, a verify attempt) replays that run, so its text is mostly the run's,
 * call for call, and the index ranks the copies as high as the run's own: a blame of 37 probes would
 * otherwise fill the list with one snippet, and the recording, which is what to open, would not make
 * it. So the index is asked in two steps, neither cut at a fixed depth: first for runs of their own
 * (recordings, forks, tests, captures), then, among the rest, for attempts of runs that have no hit
 * of their own. Each step keeps a run's best few hits, so one long run can't fill the list either.
 * No HTTP here: the tests call it with a store.
 *
 * A search answers from what the index holds: building it reads every call's request and answer, a
 * minute of work for a store of thousands of runs, and the dashboard answers every tab from one
 * thread. So the index is brought up to date beside the requests, in slices, each waiting a moment at
 * most for another command's write: for a store with a file on a thread of its own with a connection
 * of its own (search-index.ts), and for a store in memory, which no other thread can open, on the
 * server's thread while it answers no request (`catchUpSearch`). A search made before it caught up
 * says how many runs it has yet to cover (`searchBehind`). A run still recording is indexed from
 * where the last slice stopped, never again from its first call.
 */

export interface RecordedHit extends SearchHit {
  /** The run this hit's run is an attempt of, bundled under it; null for a run of its own. */
  attemptOf: string | null;
}

/** What `GET /api/search` answers: the hits, and while the index is behind, how many runs it has yet to cover of how many. */
export interface SearchAnswer {
  hits: RecordedHit[];
  indexing?: { runs: number; of: number };
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

function hits(store: StoreOf<'readModels'>, sql: string, match: string, runs: readonly string[], limit: number, attemptOf: (runId: string) => string | null): RecordedHit[] {
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

// ---- the index, brought up to date beside the requests ----

/** A slice on a thread of its own: it answers what a search asks of it between two. */
export const SLICE_MS = 100;

/** Runs as the index needs them, from the run index: no other read. */
function indexRuns(runs: RunIndex['runs']): SearchIndexRun[] {
  return runs.map((r) => ({ runId: r.runId, status: r.status, calls: r.calls }));
}

/** How many runs the index has yet to cover: runs new or ended since it looked, or with calls it hasn't read. */
export function searchBehind(store: Store, index: RunIndex = loadRunIndex(store)): number {
  return searchIndexBehind(store, indexRuns(index.runs));
}

/**
 * About `budgetMs` of bringing the index up to date, newest runs first: how many runs it is still
 * behind on after, and whether it stopped because another command was writing the store (`busy`:
 * gc's VACUUM, a pull, an import), which it waits a moment for at most, never the 10 s a write
 * waits otherwise. Writing the index changes nothing the run index reads, so the run index read
 * before stays current.
 */
export function indexSearchSlice(store: Store, budgetMs = SLICE_MS): { behind: number; busy: boolean } {
  const index = loadRunIndex(store);
  const done = keepingIndex(store, () => indexSearch(store, { budgetMs, runs: indexRuns(index.runs), briefly: true }));
  return { behind: done.behind, busy: done.busy === true };
}

/**
 * What the runs still recording said since the index last looked, taken in before a search answers,
 * for about 20 ms at most and waiting for the store's write lock a moment only, as the slices do. A
 * recording makes a call or two between two searches: an answer without them, saying the index is
 * behind on the run, would have the palette ask again every second for as long as it records. What
 * doesn't fit in the time is left to the slices, and the answer says the index is behind.
 */
export function indexRecordings(store: Store, index: RunIndex = loadRunIndex(store)): void {
  const live = index.runs.filter((r) => r.status === 'running');
  if (!live.length) return;
  keepingIndex(store, () => indexSearch(store, { budgetMs: RECORDING_MS, runs: indexRuns(live), briefly: true }));
}

/** A slice on the server's thread: what a request that arrives during one waits at most. */
const IDLE_SLICE_MS = 20;
const RECORDING_MS = 20;
/** Between two slices on the server's thread: time for whatever else it has to do. */
const GAP_MS = 20;
/** After a slice found the store busy, or failed: the first wait before the next, doubled each time after, up to the last. */
export const RETRY_MS = 1000;
export const RETRY_MAX_MS = 8000;
const catching = new WeakSet<Store>();

/** A store closed under the slices: the dashboard stopped, or serves another project's store now. */
export const closedStore = (err: unknown) => (err as { code?: unknown } | null)?.code === 'ERR_INVALID_STATE';

/**
 * Brings the index of a store in memory up to date on the server's thread, unless that is under way
 * already: a slice of about 20 ms whenever the server answers no request, then 20 ms for whatever
 * else it has to do, until it covers every run. While another command writes the store, it tries
 * again a second later, then two, up to eight, leaving the store to that command meanwhile, and stops
 * only once the store is closed. A store with a file is indexed on a thread of its own instead
 * (search-index.ts). The dashboard starts it when it starts and again with each search, which then
 * finds what has arrived since.
 */
export function catchUpSearch(store: Store): void {
  if (catching.has(store)) return;
  catching.add(store);
  let retry = RETRY_MS;
  const slice = () => {
    // A request is being answered: its answer goes first.
    if (!serverIdle()) {
      setTimeout(slice, GAP_MS).unref();
      return;
    }
    let wait: number | null;
    try {
      const { behind, busy } = indexSearchSlice(store, IDLE_SLICE_MS);
      wait = busy ? retry : behind > 0 ? GAP_MS : null;
      retry = busy ? Math.min(retry * 2, RETRY_MAX_MS) : RETRY_MS;
    } catch (err) {
      // Anything but a closed store (a read SQLite refused for a moment) is tried again later.
      wait = closedStore(err) ? null : retry;
      retry = Math.min(retry * 2, RETRY_MAX_MS);
    }
    if (wait === null) catching.delete(store);
    else setTimeout(slice, wait).unref();
  };
  setTimeout(slice, 0).unref();
}
