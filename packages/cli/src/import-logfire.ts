import { epochMs, epochNs, isObject, maybeJson, str, type Trace } from './import-trace.js';
import { fetchJson, type TraceStoreOptions } from './import-fetch.js';
import { readStoredSpans, type StoredSpan } from './import-otel.js';

/**
 * A trace from Pydantic Logfire, read with a read token from its query API: one SQL query for the
 * trace's spans in the `records` table (`POST /v2/query`). Logfire's spans are OpenTelemetry's,
 * with the GenAI conventions its LLM instrumentations and Pydantic AI write, so they are read as a
 * file's are (import-otel.ts), with the functions `@logfire.instrument` wrapped read as tool calls.
 */

/** Logfire's regions. A read token names its own (`pylf_v1_eu_…`); one from before regions is in the US. */
export const LOGFIRE_REGIONS = { us: 'https://logfire-us.pydantic.dev', eu: 'https://logfire-eu.pydantic.dev' } as const;

/** The query API a read token belongs to, as Logfire's own client finds it. */
export function logfireHost(token: string): string {
  return /^pylf_v\d+_([a-z]+)_/.exec(token)?.[1] === 'eu' ? LOGFIRE_REGIONS.eu : LOGFIRE_REGIONS.us;
}

export interface LogfireOptions extends TraceStoreOptions {
  /** LOGFIRE_READ_TOKEN. */
  token: string;
  /** The query covers spans that started from here on: Logfire's API asks for a start. */
  since: Date;
}

/** The most rows one query returns. */
const LIMIT = 10_000;

/** The columns of a span the import reads, as Logfire's SQL reference names them. */
const COLUMNS = ['trace_id', 'span_id', 'parent_span_id', 'span_name', 'start_timestamp', 'end_timestamp', 'attributes', 'otel_scope_name', 'otel_events', 'otel_status_code', 'otel_status_message', 'exception_message'];

/** A trace id as OpenTelemetry writes it, which is all that goes into the query. */
export const TRACE_ID = /^[0-9a-f]{32}$/;

/** Fetches a trace's spans. Throws with the reason when Logfire refuses, or has no such trace since `since`. */
export async function fetchLogfireRecords(traceId: string, o: LogfireOptions): Promise<Array<Record<string, unknown>>> {
  if (!TRACE_ID.test(traceId)) throw new Error(`not a trace id: "${traceId}" (Logfire's are 32 hex characters)`);
  const where = new URL(o.host).host;
  const sql = `SELECT ${COLUMNS.join(', ')} FROM records WHERE trace_id = '${traceId}' AND kind = 'span' ORDER BY start_timestamp`;
  const res = await fetchJson(
    o,
    '/v2/query',
    // The read token goes as Logfire's own query client sends it: the whole header, with no scheme.
    { method: 'POST', headers: { authorization: o.token, accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ sql, min_timestamp: o.since.toISOString(), limit: LIMIT }) },
    {
      401: `Logfire refused the read token (401): check LOGFIRE_READ_TOKEN, and that ${where} is the token's region`,
      403: "Logfire refused the read token (403): it can't read this project",
      429: 'Logfire is busy, or the project has used its query budget for the day (429): try again in a moment',
    },
  );
  const rows = rowsOf(res);
  if (!rows) throw new Error(`${where} answered with something that is not query results: is ${o.host} Logfire's API?`);
  if (!rows.length) throw new Error(`Logfire has no trace ${traceId} that started since ${o.since.toISOString().slice(0, 10)}: for an older one, give --since`);
  if (rows.length >= LIMIT) throw new Error(`the trace has ${LIMIT} spans or more, more than one query returns`);
  return rows;
}

/** Query results as rows: `{ schema, data }` as the API answers JSON, or a client's `{ columns, rows }`. */
function rowsOf(res: unknown): Array<Record<string, unknown>> | null {
  if (!isObject(res)) return null;
  const rows = Array.isArray(res.data) ? res.data : Array.isArray(res.rows) ? res.rows : null;
  return rows ? rows.filter(isObject) : null;
}

function storedSpan(row: Record<string, unknown>): StoredSpan | null {
  const traceId = str(row.trace_id);
  const spanId = str(row.span_id);
  if (!traceId || !spanId) return null;
  // JSON columns arrive as JSON, or as text holding it.
  const attrs = maybeJson(row.attributes);
  const events = maybeJson(row.otel_events);
  const failed = row.otel_status_code === 'ERROR' || row.otel_status_code === 'STATUS_CODE_ERROR';
  return {
    traceId,
    spanId,
    parentSpanId: str(row.parent_span_id),
    name: String(row.span_name ?? ''),
    scope: str(row.otel_scope_name) ?? '',
    start: epochMs(row.start_timestamp),
    end: epochMs(row.end_timestamp),
    startNs: epochNs(row.start_timestamp),
    attrs: isObject(attrs) ? attrs : {},
    events: (Array.isArray(events) ? events : []).filter(isObject).map((e) => ({ name: String(e.name ?? ''), time: epochMs(e.timestamp), attrs: isObject(e.attributes) ? e.attributes : {} })),
    error: failed ? (str(row.otel_status_message) ?? str(row.exception_message) ?? 'error') : null,
  };
}

/** Reads the rows fetched for a trace into its calls. */
export function readLogfire(rows: Array<Record<string, unknown>>, traceId: string): Trace {
  const stored = rows.map(storedSpan).filter((s): s is StoredSpan => s !== null);
  const trace = readStoredSpans(stored).traces.find((t) => t.id === traceId);
  return { id: traceId, calls: trace?.calls ?? [], spans: stored.length, skipped: trace?.skipped ?? [], ...(trace?.parents ? { parents: trace.parents } : {}) };
}
