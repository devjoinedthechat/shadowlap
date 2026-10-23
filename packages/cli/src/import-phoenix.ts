import { epochMs, epochNs, isObject, maybeJson, providerRequest, str, type Trace } from './import-trace.js';
import { fetchJson, type TraceStoreOptions } from './import-fetch.js';
import { readStoredSpans, type StoredSpan } from './import-otel.js';

/**
 * A trace from Arize Phoenix, read from its REST API (`GET /v1/projects/{project}/spans`, filtered
 * by the trace's id, a page at a time) with the API key on this machine when Phoenix asks for one.
 * The API takes no order for spans, so they come as Phoenix keeps them, and are put in the order
 * they started once read (importTrace). Phoenix keeps OpenInference's conventions, so its spans are
 * read as an OpenInference trace in a file is (import-otel.ts). The API moves two things out of a
 * span's attributes, and this puts them back: the span's kind, and which instrumentation logged it,
 * which says when `input.value` is the provider's own request.
 */

/** Phoenix on this machine, as `phoenix serve` starts it. */
export const PHOENIX_HOST = 'http://localhost:6006';
/** The project Phoenix files a trace under when the instrumentation names none. */
export const PHOENIX_PROJECT = 'default';

export interface PhoenixOptions extends TraceStoreOptions {
  /** PHOENIX_API_KEY, for a Phoenix with authentication on (Phoenix Cloud always). */
  apiKey: string | null;
  /** The project's name or id. */
  project: string;
}

/** Spans per page, the most the API gives, and the most read for one trace: a larger trace is refused, not cut. */
const PAGE = 1000;
const MAX_SPANS = 20_000;

/**
 * Phoenix's address as its own client finds it, and the variable that held it: PHOENIX_ENDPOINT,
 * then the address traces are sent to (which may end in the OTLP path), then PHOENIX_BASE_URL.
 */
export function phoenixHostFromEnv(env: NodeJS.ProcessEnv): { host: string; from: string } | undefined {
  for (const name of ['PHOENIX_ENDPOINT', 'PHOENIX_COLLECTOR_ENDPOINT', 'PHOENIX_BASE_URL']) {
    const v = env[name]?.trim();
    if (v) return { host: v.replace(/\/v1\/traces\/?$/, ''), from: name };
  }
  return undefined;
}

/** The project as Phoenix's own client reads it: PHOENIX_PROJECT, then PHOENIX_PROJECT_NAME, its older name. */
export function phoenixProjectFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env.PHOENIX_PROJECT?.trim() || env.PHOENIX_PROJECT_NAME?.trim() || undefined;
}

/** Fetches a trace's spans. Throws with the reason when Phoenix refuses, or holds no such trace. */
export async function fetchPhoenixSpans(traceId: string, o: PhoenixOptions): Promise<Array<Record<string, unknown>>> {
  const where = new URL(o.host).host;
  const headers: Record<string, string> = { accept: 'application/json', ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}) };
  const refusals = {
    401: o.apiKey ? 'Phoenix refused the API key (401): check PHOENIX_API_KEY' : 'Phoenix asks for an API key (401): set PHOENIX_API_KEY (it is in the settings of your Phoenix, or of your space in Phoenix Cloud)',
    403: 'Phoenix refused the API key (403): it has no access to this project',
    404: `Phoenix on ${where} has no project ${o.project}: give the trace's project with --project`,
  };
  const spans: Array<Record<string, unknown>> = [];
  // A Phoenix older than 13.9 ignores the filter and lists every span in the project.
  let others = 0;
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ trace_id: traceId, limit: String(PAGE) });
    if (cursor) query.set('cursor', cursor);
    const res = await fetchJson(o, `/v1/projects/${encodeURIComponent(o.project)}/spans?${query}`, { headers }, refusals);
    if (!isObject(res) || !Array.isArray(res.data)) throw new Error(`${where} answered with something that is not a list of spans: is ${o.host} Phoenix's address?`);
    for (const s of res.data) {
      if (isObject(s) && isObject(s.context) && s.context.trace_id === traceId) spans.push(s);
      else others++;
    }
    cursor = str(res.next_cursor);
  } while (cursor && spans.length + others < MAX_SPANS);
  if (others && (cursor || !spans.length)) throw new Error(`Phoenix on ${where} lists every span instead of the trace's: it is older than 13.9, which reads spans by trace. Update Phoenix, or export the trace as OTLP JSON and use shadowlap import otel`);
  if (!spans.length) throw new Error(`Phoenix on ${where} has no trace ${traceId} in project ${o.project}`);
  // Cut short, a trace would miss the spans listed last: in Phoenix 20, its oldest, where a replay starts.
  if (cursor) throw new Error(`the trace has more than ${MAX_SPANS} spans, more than an import reads from Phoenix: export it as OTLP JSON and use shadowlap import otel`);
  return spans;
}

/**
 * The instrumentation that logged a span. Phoenix's API leaves it out, so an LLM span from OpenAI
 * or Anthropic whose input is a request in the provider's own shape is read as one from
 * OpenInference's OpenAI or Anthropic instrumentation, which log the request whole: it rebuilds
 * exactly. Any other span is read from its messages.
 */
function scopeOf(attrs: Record<string, unknown>): string {
  const provider = str(attrs['llm.provider']) ?? str(attrs['llm.system']);
  if (attrs['openinference.span.kind'] !== 'LLM' || (provider !== 'openai' && provider !== 'anthropic')) return '';
  if (attrs['input.mime_type'] !== undefined && attrs['input.mime_type'] !== 'application/json') return '';
  const input = maybeJson(attrs['input.value']);
  return isObject(input) && providerRequest(input) ? `openinference.instrumentation.${provider}` : '';
}

function storedSpan(raw: Record<string, unknown>): StoredSpan | null {
  const context = isObject(raw.context) ? raw.context : {};
  const traceId = str(context.trace_id);
  const spanId = str(context.span_id);
  if (!traceId || !spanId) return null;
  const attrs: Record<string, unknown> = isObject(raw.attributes) ? { ...raw.attributes } : {};
  const kind = str(raw.span_kind);
  if (kind && attrs['openinference.span.kind'] === undefined) attrs['openinference.span.kind'] = kind;
  const events = (Array.isArray(raw.events) ? raw.events : []).filter(isObject).map((e) => ({ name: String(e.name ?? ''), time: epochMs(e.timestamp), attrs: isObject(e.attributes) ? e.attributes : {} }));
  return {
    traceId,
    spanId,
    parentSpanId: str(raw.parent_id),
    name: String(raw.name ?? ''),
    scope: scopeOf(attrs),
    start: epochMs(raw.start_time),
    end: epochMs(raw.end_time),
    startNs: epochNs(raw.start_time),
    attrs,
    events,
    error: raw.status_code === 'ERROR' ? (str(raw.status_message) ?? 'error') : null,
  };
}

/** Reads the spans fetched for a trace into its calls. */
export function readPhoenix(spans: Array<Record<string, unknown>>, traceId: string): Trace {
  const stored = spans.map(storedSpan).filter((s): s is StoredSpan => s !== null);
  const trace = readStoredSpans(stored).traces.find((t) => t.id === traceId);
  return { id: traceId, calls: trace?.calls ?? [], spans: stored.length, skipped: trace?.skipped ?? [], ...(trace?.parents ? { parents: trace.parents } : {}) };
}
