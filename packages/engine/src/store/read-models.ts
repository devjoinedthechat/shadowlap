/**
 * Read models: what the dashboard reads in SQL rather than by loading every call of every run (query,
 * and the counts of runs, tools and MCP servers across runs), and what it worked out about finished
 * runs, kept so the next read, in this process or the next, need not work it out again (run_stats,
 * run_asks).
 */
import type { Effect } from '../types.js';
import { CACHE_WAIT_MS, StorePart, type SqliteStatement, type SqlValue } from './core.js';

export abstract class ReadModels extends StorePart {
  // ---- read models (the dashboard's overview, run list and calendar) ----

  /** query's statements by their SQL: the store keeps them, one set per connection (store.ts). */
  protected declare readonly readStatements: Map<string, SqliteStatement>;

  /**
   * Runs one read-only statement and returns its rows, for read models that aggregate in SQL instead
   * of loading every call of every run. Callers pass fixed SQL and bind every value. SQLite itself
   * refuses a write here (`query_only`), whatever the SQL says; only the first statement runs. A
   * connection that was read-only before is left read-only.
   */
  query(sql: string, ...params: SqlValue[]): Record<string, unknown>[] {
    if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error('Store.query runs read-only SELECT statements');
    let statement = this.readStatements.get(sql);
    if (!statement) {
      // Read models use a handful of fixed statements: past that, nothing is worth keeping.
      if (this.readStatements.size >= 64) this.readStatements.clear();
      statement = this.db.prepare(sql);
      this.readStatements.set(sql, statement);
    }
    const readOnly = Number(this.stmts.queryOnly.get()?.query_only) === 1;
    if (!readOnly) this.db.exec('PRAGMA query_only = ON');
    try {
      return statement.all(...params);
    } finally {
      if (!readOnly) this.db.exec('PRAGMA query_only = OFF');
    }
  }

  /**
   * Keeps what a read model worked out about finished runs (`run_stats`), so no later read, in this
   * process or the next, reads their calls again. A run deleted meanwhile is skipped. Best effort:
   * false when the store can't be written just now, and the caller keeps its numbers in memory. It
   * waits a moment for the write lock, not the 10 s anything else waits: a dashboard saves these on
   * its only thread, which would stop answering while another command holds the store.
   */
  saveRunStats(rows: ReadonlyArray<{ runId: string; key: string; stats: string }>): boolean {
    if (!rows.length) return true;
    const wait = Number((this.db.prepare('PRAGMA busy_timeout').get() as { timeout?: number } | undefined)?.timeout ?? 10_000);
    this.db.exec(`PRAGMA busy_timeout = ${Math.min(wait, CACHE_WAIT_MS)}`);
    try {
      this.transaction(() => {
        const put = this.db.prepare(`INSERT OR REPLACE INTO run_stats (run_id, key, stats) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM runs WHERE run_id = ?)`);
        for (const r of rows) put.run(r.runId, r.key, r.stats, r.runId);
      });
      return true;
    } catch {
      return false;
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${wait}`);
    }
  }

  /**
   * Keeps what each finished recording's user asked first (`run_asks`), so the run index reads it
   * with the run, as `saveRunStats` keeps the rest: best effort, a short wait for the write lock,
   * false when the store can't be written just now. A run deleted meanwhile is skipped.
   */
  saveRunAsks(rows: ReadonlyArray<{ runId: string; key: string; ask: string | null }>): boolean {
    if (!rows.length) return true;
    const wait = Number((this.db.prepare('PRAGMA busy_timeout').get() as { timeout?: number } | undefined)?.timeout ?? 10_000);
    this.db.exec(`PRAGMA busy_timeout = ${Math.min(wait, CACHE_WAIT_MS)}`);
    try {
      this.transaction(() => {
        const put = this.db.prepare(`INSERT OR REPLACE INTO run_asks (run_id, key, ask) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM runs WHERE run_id = ?)`);
        for (const r of rows) put.run(r.runId, r.key, r.ask, r.runId);
      });
      return true;
    } catch {
      return false;
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${wait}`);
    }
  }

  /**
   * Every tool name called in any run, by the effect it was called with: how many calls, in how many
   * runs, and the latest. One query over all runs, for the Settings page's tools.
   */
  toolUsage(): Array<{ name: string; effect: Effect | null; calls: number; runs: number; lastAt: number }> {
    const rows = this.db
      .prepare(`SELECT name, effect, COUNT(*) AS calls, COUNT(DISTINCT run_id) AS runs, MAX(at) AS last_at FROM call_events WHERE phase = 'start' AND kind = 'tool' GROUP BY name, effect ORDER BY name`)
      .all();
    return rows.map((r) => ({ name: String(r.name), effect: (r.effect as Effect | null) ?? null, calls: Number(r.calls), runs: Number(r.runs), lastAt: Number(r.last_at) }));
  }

  /**
   * How many runs the store holds: `attempts` are the runs blame, verify, `replay --repeat` and the
   * error-path presets make (marked `probe`, `verify`, `repeat` or `chaos`), and `running` the runs
   * not ended yet.
   */
  runCounts(): { runs: number; attempts: number; running: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN json_valid(meta) THEN (json_type(meta, '$.probe') IS NOT NULL OR json_type(meta, '$.verify') IS NOT NULL OR json_type(meta, '$.repeat') IS NOT NULL OR json_type(meta, '$.chaos') IS NOT NULL) ELSE 0 END) AS attempts,
                SUM(status = 'running') AS running
         FROM runs`,
      )
      .get();
    const total = Number(row?.total ?? 0);
    const attempts = Number(row?.attempts ?? 0);
    return { runs: total - attempts, attempts, running: Number(row?.running ?? 0) };
  }

  /**
   * The MCP servers recorded tool calls came through (`shadowlap mcp` names each in the call's
   * `meta.mcp`): per server, its calls, the latest, and the tools it offered when last listed,
   * with their effects, or null when no call carried the list. One query over all runs.
   */
  mcpServerUsage(): Array<{ transport: string; server: string; calls: number; lastAt: number; tools: Array<{ name: string; effect: Effect }> | null; called: Array<{ name: string; effect: Effect | null }> }> {
    // CASE, so a meta that isn't JSON is never handed to json_type, whatever order SQLite tries the terms in.
    const where = `phase = 'start' AND kind = 'tool' AND (CASE WHEN json_valid(meta) THEN json_type(meta, '$.mcp.server') END) = 'text'`;
    const servers = new Map<string, { transport: string; server: string; calls: number; lastAt: number; tools: Array<{ name: string; effect: Effect }> | null; called: Array<{ name: string; effect: Effect | null }> }>();
    const key = (transport: unknown, server: unknown) => `${String(transport)}\u0000${String(server)}`;
    for (const r of this.db
      .prepare(`SELECT json_extract(meta, '$.mcp.transport') AS transport, json_extract(meta, '$.mcp.server') AS server, name, effect, COUNT(*) AS calls, MAX(at) AS last_at FROM call_events WHERE ${where} GROUP BY transport, server, name, effect ORDER BY name`)
      .all()) {
      const k = key(r.transport, r.server);
      const s = servers.get(k) ?? { transport: String(r.transport), server: String(r.server), calls: 0, lastAt: 0, tools: null, called: [] };
      s.calls += Number(r.calls);
      s.lastAt = Math.max(s.lastAt, Number(r.last_at));
      s.called.push({ name: String(r.name), effect: (r.effect as Effect | null) ?? null });
      servers.set(k, s);
    }
    // The tools each server offered, from the latest call that listed them.
    for (const r of this.db
      .prepare(
        `SELECT transport, server, tools FROM (
           SELECT json_extract(meta, '$.mcp.transport') AS transport, json_extract(meta, '$.mcp.server') AS server, json_extract(meta, '$.mcp.tools') AS tools,
                  ROW_NUMBER() OVER (PARTITION BY json_extract(meta, '$.mcp.transport'), json_extract(meta, '$.mcp.server') ORDER BY at DESC, run_id DESC, call_no DESC) AS latest
           FROM call_events WHERE ${where} AND (CASE WHEN json_valid(meta) THEN json_type(meta, '$.mcp.tools') END) = 'array'
         ) WHERE latest = 1`,
      )
      .all()) {
      const s = servers.get(key(r.transport, r.server));
      if (!s) continue;
      try {
        const listed = JSON.parse(String(r.tools)) as unknown[];
        s.tools = listed.flatMap((t) => (typeof t === 'object' && t !== null && typeof (t as { name?: unknown }).name === 'string' && ['pure', 'read', 'write'].includes(String((t as { effect?: unknown }).effect)) ? [{ name: (t as { name: string }).name, effect: (t as { effect: Effect }).effect }] : []));
      } catch {
        s.tools = null;
      }
    }
    return [...servers.values()].sort((a, b) => a.server.localeCompare(b.server));
  }
}
