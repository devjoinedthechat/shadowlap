import { isObject } from '@shadowlap/engine';
import type { StoreOf } from '@shadowlap/engine';
import { epochMs, str } from './import-trace.js';
import { EXIT } from './exit-codes.js';
import { fetchJson, TraceStoreError, type TraceStoreOptions } from './import-fetch.js';
import { TRACE_ID } from './import-logfire.js';

/**
 * Many traces at once, for `shadowlap import langfuse|phoenix|logfire` without a trace id: the
 * traces that started in a window (`--since`, `--until`), newest first, up to `--limit`, those whose
 * name is `--trace-name` when it is given. Each store is asked through its own list or query API;
 * each trace is then read as a single import reads it.
 */

export interface BulkWindow {
  /** The traces that started from here on. */
  since: Date;
  /** ... and before here. */
  until: Date;
  /** The most traces to import, newest first. */
  limit: number;
  /** Only traces of this name (Langfuse's trace name, the root span's name in Phoenix and Logfire), or null for any. */
  name: string | null;
}

/** A trace a store listed: its id, when it started, and its name, where the store says. */
export interface FoundTrace {
  id: string;
  startedAt: number | null;
  name: string | null;
}

/** The most rows read while listing: a window that holds more than this is cut, newest first. */
const MAX_ROWS = 20_000;

/** A trace id as Langfuse writes them (a UUID, or 32 hex characters), as a single import takes one. */
const LANGFUSE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

/**
 * Keeps each trace once, in the order found, up to the limit; a trace already found keeps its first
 * sighting. An id that isn't one, which a URL or a query would carry, is left out.
 */
function collect(found: Map<string, FoundTrace>, t: FoundTrace, w: BulkWindow, idOk: RegExp): void {
  if (found.size >= w.limit || found.has(t.id) || !idOk.test(t.id)) return;
  // Every store filters the window itself; what it sends back outside it, an older version that
  // ignored a filter, is left out here too.
  if (t.startedAt !== null && (t.startedAt < w.since.getTime() || t.startedAt >= w.until.getTime())) return;
  if (w.name !== null && t.name !== null && t.name !== w.name) return;
  found.set(t.id, t);
}

// ---- Langfuse ----

export interface LangfuseListOptions extends TraceStoreOptions {
  publicKey: string;
  secretKey: string;
}

const langfuseAuth = (o: LangfuseListOptions) => ({ authorization: `Basic ${Buffer.from(`${o.publicKey}:${o.secretKey}`, 'utf8').toString('base64')}`, accept: 'application/json' });

const LANGFUSE_REFUSALS = {
  401: 'Langfuse refused the keys (401): check LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY, and that the host is the region the project lives in',
  403: 'Langfuse refused the keys (403): they have no access to this project',
};

/**
 * Langfuse's traces in the window, newest first: the root observations of the Observations API v2
 * (`GET /api/public/v2/observations`), whose `traceName` is the trace's name, a page of 1,000 at a
 * time. A Langfuse without that API (a self-hosted one older than it) answers 404, and is asked
 * with the traces list it has instead (`GET /api/public/traces`).
 */
export async function listLangfuseTraces(o: LangfuseListOptions, w: BulkWindow): Promise<FoundTrace[]> {
  const found = new Map<string, FoundTrace>();
  const filter = [
    { type: 'datetime', column: 'startTime', operator: '>=', value: w.since.toISOString() },
    { type: 'datetime', column: 'startTime', operator: '<', value: w.until.toISOString() },
    { type: 'boolean', column: 'isRootObservation', operator: '=', value: true },
    ...(w.name !== null ? [{ type: 'string', column: 'traceName', operator: '=', value: w.name }] : []),
  ];
  let cursor: string | null = null;
  let rows = 0;
  do {
    const q = new URLSearchParams({ fields: 'core,basic,trace_context', limit: '1000', fromStartTime: w.since.toISOString(), toStartTime: w.until.toISOString(), filter: JSON.stringify(filter) });
    if (cursor) q.set('cursor', cursor);
    let res: unknown;
    try {
      res = await fetchJson(o, `/api/public/v2/observations?${q}`, { headers: langfuseAuth(o) }, LANGFUSE_REFUSALS);
    } catch (err) {
      if (err instanceof TraceStoreError && err.status === 404 && rows === 0) return listLangfuseTracesV1(o, w);
      throw err;
    }
    const data = isObject(res) && Array.isArray(res.data) ? res.data : null;
    if (!data) throw new TraceStoreError(`${new URL(o.host).host} answered with something that is not a list of observations: is ${o.host} Langfuse's API?`, null, { exitCode: EXIT.usage });
    rows += data.length;
    for (const row of data) {
      if (!isObject(row)) continue;
      const id = str(row.traceId);
      // A root observation: no parent, or one the SDK marks a root.
      if (!id || (row.parentObservationId && row.isRootObservation !== true)) continue;
      collect(found, { id, startedAt: epochMs(row.startTime), name: str(row.traceName) }, w, LANGFUSE_ID);
    }
    cursor = isObject(res) && isObject(res.meta) ? str(res.meta.cursor) : null;
  } while (cursor && found.size < w.limit && rows < MAX_ROWS);
  return [...found.values()];
}

/** The traces list of a Langfuse without the Observations API v2: `GET /api/public/traces`, newest first, 100 a page. */
async function listLangfuseTracesV1(o: LangfuseListOptions, w: BulkWindow): Promise<FoundTrace[]> {
  const found = new Map<string, FoundTrace>();
  for (let page = 1; found.size < w.limit && (page - 1) * 100 < MAX_ROWS; page++) {
    const q = new URLSearchParams({ page: String(page), limit: '100', fromTimestamp: w.since.toISOString(), toTimestamp: w.until.toISOString(), orderBy: 'timestamp.desc' });
    if (w.name !== null) q.set('name', w.name);
    const res = await fetchJson(o, `/api/public/traces?${q}`, { headers: langfuseAuth(o) }, LANGFUSE_REFUSALS);
    const data = isObject(res) && Array.isArray(res.data) ? res.data : [];
    for (const t of data) if (isObject(t) && str(t.id)) collect(found, { id: String(t.id), startedAt: epochMs(t.timestamp), name: str(t.name) }, w, LANGFUSE_ID);
    const pages = isObject(res) && isObject(res.meta) && typeof res.meta.totalPages === 'number' ? res.meta.totalPages : page;
    if (!data.length || page >= pages) break;
  }
  return [...found.values()];
}

// ---- Phoenix ----

export interface PhoenixListOptions extends TraceStoreOptions {
  apiKey: string | null;
  project: string;
}

/**
 * Phoenix's traces in the window, newest first: the root spans of `GET /v1/projects/{project}/spans`
 * (`parent_id=null`, by start time, the name filtered with `name`), a page of 1,000 at a time. A
 * Phoenix that doesn't take a filter lists the spans it has: the roots in the window are picked here.
 */
export async function listPhoenixTraces(o: PhoenixListOptions, w: BulkWindow): Promise<FoundTrace[]> {
  const where = new URL(o.host).host;
  const headers: Record<string, string> = { accept: 'application/json', ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}) };
  const refusals = {
    401: o.apiKey ? 'Phoenix refused the API key (401): check PHOENIX_API_KEY' : 'Phoenix asks for an API key (401): set PHOENIX_API_KEY (it is in the settings of your Phoenix, or of your space in Phoenix Cloud)',
    403: 'Phoenix refused the API key (403): it has no access to this project',
    404: `Phoenix on ${where} has no project ${o.project}: give the project with --project`,
  };
  const found = new Map<string, FoundTrace>();
  let cursor: string | null = null;
  let rows = 0;
  do {
    const q = new URLSearchParams({ parent_id: 'null', start_time: w.since.toISOString(), end_time: w.until.toISOString(), sort: 'start_time', order: 'desc', limit: '1000' });
    if (w.name !== null) q.set('name', w.name);
    if (cursor) q.set('cursor', cursor);
    const res = await fetchJson(o, `/v1/projects/${encodeURIComponent(o.project)}/spans?${q}`, { headers }, refusals);
    if (!isObject(res) || !Array.isArray(res.data)) throw new TraceStoreError(`${where} answered with something that is not a list of spans: is ${o.host} Phoenix's address?`, null, { exitCode: EXIT.usage });
    rows += res.data.length;
    for (const s of res.data) {
      if (!isObject(s) || !isObject(s.context) || s.parent_id) continue;
      const id = str(s.context.trace_id)?.toLowerCase();
      if (id) collect(found, { id, startedAt: epochMs(s.start_time), name: str(s.name) }, w, TRACE_ID);
    }
    cursor = str(res.next_cursor);
  } while (cursor && found.size < w.limit && rows < MAX_ROWS);
  return [...found.values()];
}

// ---- Logfire ----

export interface LogfireListOptions extends TraceStoreOptions {
  token: string;
}

/** A name as an SQL string literal: quotes doubled, and nothing a query could not hold. */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Logfire's traces in the window, newest first: one SQL query over the `records` table for the root
 * spans that started in it, grouped by trace (`POST /v2/query`, `min_timestamp` and
 * `max_timestamp` bounding the scan), the name compared with each root span's `span_name`.
 */
export async function listLogfireTraces(o: LogfireListOptions, w: BulkWindow): Promise<FoundTrace[]> {
  const where = new URL(o.host).host;
  const named = w.name !== null ? ` AND span_name = ${sqlString(w.name)}` : '';
  const sql = `SELECT trace_id, MIN(start_timestamp) AS started, MIN(span_name) AS name FROM records WHERE parent_span_id IS NULL AND kind = 'span'${named} GROUP BY trace_id ORDER BY started DESC`;
  const res = await fetchJson(
    o,
    '/v2/query',
    { method: 'POST', headers: { authorization: o.token, accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ sql, min_timestamp: w.since.toISOString(), max_timestamp: w.until.toISOString(), limit: Math.min(w.limit, 10_000) }) },
    {
      401: `Logfire refused the read token (401): check LOGFIRE_READ_TOKEN, and that ${where} is the token's region`,
      403: "Logfire refused the read token (403): it can't read this project",
      429: 'Logfire is busy, or the project has used its query budget for the day (429): try again in a moment, or import fewer traces with --limit',
    },
  );
  const rows = isObject(res) ? (Array.isArray(res.data) ? res.data : Array.isArray(res.rows) ? res.rows : null) : null;
  if (!rows) throw new TraceStoreError(`${where} answered with something that is not query results: is ${o.host} Logfire's API?`, null, { exitCode: EXIT.usage });
  const found = new Map<string, FoundTrace>();
  for (const r of rows) if (isObject(r) && str(r.trace_id)) collect(found, { id: String(r.trace_id).toLowerCase(), startedAt: epochMs(r.started), name: str(r.name) }, w, TRACE_ID);
  return [...found.values()];
}

// ---- what is imported already ----

/**
 * The traces of one source this store holds an import of, by trace id, each with its run: an
 * import keeps the trace's id with the run (`meta.imported.key`), so an import of a window skips
 * what an earlier one, or the import of one trace, brought in. A run deleted since is no longer
 * there to skip.
 */
export function importedTraces(store: StoreOf<'recording'>, format: 'langfuse' | 'phoenix' | 'logfire'): Map<string, string> {
  const out = new Map<string, string>();
  for (const run of store.allRuns()) {
    const imported = run.meta?.imported;
    if (imported?.key && imported.from.startsWith(`${format}:`) && !out.has(imported.key)) out.set(imported.key, run.runId);
  }
  return out;
}
