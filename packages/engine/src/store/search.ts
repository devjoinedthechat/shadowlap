/**
 * The search index as the store keeps it: the documents (search_docs, full text), which of them are
 * each run's (search_rows), and how far each run is indexed (search_state). search.ts decides what
 * goes in and reads it out.
 */
import { CACHE_WAIT_MS, StorePart } from './core.js';

/** How much of a run the search index covers (search.ts): a row of `search_state`. */
export interface SearchState {
  /** Calls indexed. */
  calls: number;
  /** The run's status when they were. */
  status: string;
  /** Where indexing stopped, as search.ts writes it; null for a row that covers its run whole. */
  progress: string | null;
}

export abstract class Search extends StorePart {
  /** A run deleted (store/recording.ts) takes its documents and how far it was indexed with it. */
  protected override onRunDeleted(runId: string): void {
    this.deleteSearchDocs(runId);
    this.db.prepare(`DELETE FROM search_state WHERE run_id = ?`).run(runId);
  }

  /**
   * A run's documents out of the search index, found by the rows that map them (search_rows), not by
   * reading every document. `all` reads every document after all, for a run indexed again from its
   * start (rare): an earlier Shadowlap may have written some of its documents without their rows.
   */
  private deleteSearchDocs(runId: string, all = false): void {
    if (all) this.db.prepare(`DELETE FROM search_docs WHERE run_id = ?`).run(runId);
    else this.db.prepare(`DELETE FROM search_docs WHERE rowid IN (SELECT doc FROM search_rows WHERE run_id = ?)`).run(runId);
    this.db.prepare(`DELETE FROM search_rows WHERE run_id = ?`).run(runId);
  }

  /** A run's documents into the search index, each mapped to the run. */
  private insertSearchDocs(runId: string, docs: ReadonlyArray<{ callNo: number; field: string; text: string }>): void {
    const insert = this.db.prepare(`INSERT INTO search_docs (text, run_id, call_no, field) VALUES (?, ?, ?, ?)`);
    const map = this.db.prepare(`INSERT INTO search_rows (run_id, doc) VALUES (?, ?)`);
    for (const d of docs) map.run(runId, insert.run(d.text, runId, d.callNo, d.field).lastInsertRowid);
  }

  /**
   * How much of a run the search index covers: the calls indexed, the run's status then, and where
   * indexing stopped (search.ts), or null for a row that covers the run whole.
   */
  searchState(runId: string): SearchState | null {
    const row = this.db.prepare(`SELECT calls, status, progress FROM search_state WHERE run_id = ?`).get(runId);
    return row ? searchStateOf(row) : null;
  }

  /** Every run's search state, by run: one read to tell which runs the index is behind on. */
  searchStates(): Map<string, SearchState> {
    return new Map(this.db.prepare(`SELECT run_id, calls, status, progress FROM search_state`).all().map((r) => [String(r.run_id), searchStateOf(r)]));
  }

  /** Replaces a run's search documents. */
  replaceSearchDocs(runId: string, calls: number, status: string, docs: Array<{ callNo: number; field: string; text: string }>): void {
    this.transaction(() => {
      this.deleteSearchDocs(runId, true);
      this.insertSearchDocs(runId, docs);
      this.db.prepare(`INSERT OR REPLACE INTO search_state (run_id, calls, status, progress) VALUES (?, ?, ?, NULL)`).run(runId, calls, status);
    });
  }

  /**
   * Adds a batch of a run's search documents and moves its state on to `next`, in one write, if its
   * state is still `expected`: another process indexing the same run meanwhile wins, and this batch
   * is dropped (false). `fresh` drops the run's documents first, for a run indexed again from its start.
   * `briefly` waits for another command's write lock a moment only, as saveRunStats does, not the
   * 10 s anything else waits: a dashboard indexes on the thread that answers its pages. Then it is
   * 'busy' while that command writes (gc's VACUUM, a pull), and nothing is written.
   */
  addSearchDocs(runId: string, o: { expected: SearchState | null; next: SearchState; docs: Array<{ callNo: number; field: string; text: string }>; fresh?: boolean; briefly?: boolean }): boolean | 'busy' {
    const write = () =>
      this.transaction(() => {
        const now = this.searchState(runId);
        const same = now === null || o.expected === null ? now === o.expected : now.calls === o.expected.calls && now.status === o.expected.status && now.progress === o.expected.progress;
        if (!same) return false;
        if (o.fresh && now !== null) this.deleteSearchDocs(runId, true);
        this.insertSearchDocs(runId, o.docs);
        this.db.prepare(`INSERT OR REPLACE INTO search_state (run_id, calls, status, progress) VALUES (?, ?, ?, ?)`).run(runId, o.next.calls, o.next.status, o.next.progress);
        return true;
      }, 'immediate');
    if (!o.briefly) return write();
    const wait = Number((this.db.prepare('PRAGMA busy_timeout').get() as { timeout?: number } | undefined)?.timeout ?? 10_000);
    this.db.exec(`PRAGMA busy_timeout = ${Math.min(wait, CACHE_WAIT_MS)}`);
    try {
      return write();
    } catch (err) {
      // SQLITE_BUSY, its extended codes included: the lock was not free in time.
      if (((err as { errcode?: number }).errcode ?? 0) % 256 === 5) return 'busy';
      throw err;
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${wait}`);
    }
  }

  /** Full-text matches, best first. `match` is an FTS5 expression; snippets mark matches with characters 1 and 2. */
  searchDocs(match: string, limit: number, runId?: string): Array<{ runId: string; callNo: number; field: string; snippet: string }> {
    const sql = `SELECT run_id, call_no, field, snippet(search_docs, 0, char(1), char(2), '…', 14) AS snip FROM search_docs WHERE search_docs MATCH ?${runId ? ' AND run_id = ?' : ''} ORDER BY rank LIMIT ?`;
    const rows = this.db.prepare(sql).all(...(runId ? [match, runId, limit] : [match, limit]));
    return rows.map((r) => ({ runId: String(r.run_id), callNo: Number(r.call_no), field: String(r.field), snippet: String(r.snip) }));
  }
}

function searchStateOf(row: Record<string, unknown>): SearchState {
  return { calls: Number(row.calls), status: String(row.status), progress: typeof row.progress === 'string' ? row.progress : null };
}
