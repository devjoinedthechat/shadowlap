import { isObject } from '@shadowlap/engine';
import {
  calledToolNames,
  clean,
  epochMs,
  maybeJson,
  messagesOf,
  num,
  outputOf,
  placed,
  settingsOf,
  str,
  toolDefinitionsOf,
  type Trace,
  type TraceCall,
  type TraceModelCall,
  type TraceToolCall,
  type TraceUsage,
} from './import-trace.js';
import { append } from './import-capture.js';
import { EXIT } from './exit-codes.js';
import { fetchJson, TraceStoreError, type TraceStoreOptions } from './import-fetch.js';

/**
 * A Langfuse trace, fetched from its public API with the project's keys: its observations from the
 * Observations API v2 (`GET /api/public/v2/observations?traceId=…`, a page of 1,000 at a time), or,
 * from a self-hosted Langfuse that has no v2 API yet, the trace itself (`GET /api/public/traces/{id}`,
 * and the observations list when the trace leaves them out). The trace's page in Langfuse is named
 * on the trace (`htmlPath`): read from the v2 API, the trace is asked for once more, after the
 * observations, and an import whose trace doesn't answer stands without the page. A format adapter
 * only: import-trace.ts turns the calls into a recording.
 *
 * Generations are model calls: their input (the messages, with the tool definitions when the
 * OpenAI integration logged them), model, model parameters, output and usage. A span is a tool call
 * when its type says TOOL, or when it is named after a tool a generation asked for; it replays when
 * it kept its input and output.
 */

export const LANGFUSE_HOST = 'https://cloud.langfuse.com';

export interface LangfuseOptions extends TraceStoreOptions {
  publicKey: string;
  secretKey: string;
}

/**
 * The most the trace's page link may take, a request of its own after the observations: the import
 * stands without it, so a slow answer leaves the run with no link to Langfuse rather than hold it up.
 */
export const PAGE_LINK_MS = 5_000;

/** Observations per page of `/api/public/observations`, and the most read for one trace. */
const PAGE = 100;
const MAX_OBSERVATIONS = 10_000;

/** The field groups of an observation the import reads from the v2 API: the core ones, input and output, the model and its parameters, usage, metadata. */
const V2_FIELDS = 'core,basic,io,model,usage,metadata';

/**
 * An input or output as the v2 API sends it, always as the text it was stored as, read as the v1
 * API reads it: the JSON it holds (an object, a list, a quoted string), else the text itself.
 */
function stored(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

/**
 * The trace's page in Langfuse, which is named on the trace alone: one more request after the
 * observations, PAGE_LINK_MS at most. The import doesn't need it to stand: without it, the run has
 * no link. It answers with the whole trace again, of which only the page is kept.
 */
async function pageOf(get: (path: string, within: Pick<LangfuseOptions, 'timeoutMs'>) => Promise<unknown>, traceId: string, timeoutMs: number | undefined): Promise<string | null> {
  const trace = await get(`/api/public/traces/${encodeURIComponent(traceId)}`, { timeoutMs: Math.min(timeoutMs ?? PAGE_LINK_MS, PAGE_LINK_MS) }).catch(() => null);
  return isObject(trace) ? str(trace.htmlPath) : null;
}

/** Fetches a trace and its observations. Throws with the reason when Langfuse refuses or has no such trace. */
export async function fetchLangfuseTrace(traceId: string, o: LangfuseOptions): Promise<Record<string, unknown>> {
  const auth = `Basic ${Buffer.from(`${o.publicKey}:${o.secretKey}`, 'utf8').toString('base64')}`;
  const refusals = {
    401: 'Langfuse refused the keys (401): check LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY, and that the host is the region the project lives in',
    403: 'Langfuse refused the keys (403): they have no access to this trace',
  };
  const get = (path: string, within: Pick<LangfuseOptions, 'timeoutMs'> = {}) => fetchJson({ ...o, ...within }, path, { headers: { authorization: auth, accept: 'application/json' } }, { ...refusals, 404: `Langfuse has no trace ${traceId} on ${new URL(o.host).host}` });
  // The Observations API v2: a Langfuse without it answers 404, and is read through the trace instead.
  const observations: unknown[] = [];
  let cursor: string | null = null;
  let v2 = true;
  do {
    const q = new URLSearchParams({ traceId, fields: V2_FIELDS, limit: '1000' });
    if (cursor) q.set('cursor', cursor);
    let res: unknown;
    try {
      res = await get(`/api/public/v2/observations?${q}`);
    } catch (err) {
      if (err instanceof TraceStoreError && err.status === 404 && !cursor) {
        v2 = false;
        break;
      }
      throw err;
    }
    const data = isObject(res) && Array.isArray(res.data) ? res.data : null;
    if (!data) throw new TraceStoreError('Langfuse answered with something that is not a list of observations', null, { exitCode: EXIT.usage });
    // Input and output come as the text they were stored as, model parameters and metadata may come as JSON text: read as the trace endpoint gives them.
    for (const row of data) if (isObject(row)) observations.push({ ...row, input: stored(row.input), output: stored(row.output), modelParameters: maybeJson(row.modelParameters), metadata: maybeJson(row.metadata) });
    cursor = isObject(res) && isObject(res.meta) ? str(res.meta.cursor) : null;
  } while (cursor && observations.length < MAX_OBSERVATIONS);
  if (v2) {
    if (!observations.length) throw new TraceStoreError(`Langfuse has no trace ${traceId} on ${new URL(o.host).host}`, 404, { ofTrace: true });
    // The API lists the newest first; the trace reader takes them in the order they started.
    observations.sort((a, b) => (epochMs((a as Record<string, unknown>).startTime) ?? 0) - (epochMs((b as Record<string, unknown>).startTime) ?? 0));
    const htmlPath = await pageOf(get, traceId, o.timeoutMs);
    return { id: traceId, observations, ...(htmlPath ? { htmlPath } : {}) };
  }
  const trace = await get(`/api/public/traces/${encodeURIComponent(traceId)}`).catch((err: unknown) => {
    throw err instanceof TraceStoreError && err.status === 404 ? new TraceStoreError(err.message, 404, { ofTrace: true }) : err;
  });
  if (!isObject(trace)) throw new TraceStoreError('Langfuse answered with something that is not a trace', null, { exitCode: EXIT.usage });
  if (Array.isArray(trace.observations) && trace.observations.every(isObject)) return trace;
  // Some deployments list observation ids only; the observations endpoint has them whole.
  const listed: unknown[] = [];
  for (let page = 1; listed.length < MAX_OBSERVATIONS; page++) {
    const res = await get(`/api/public/observations?traceId=${encodeURIComponent(traceId)}&page=${page}&limit=${PAGE}`);
    const data = isObject(res) && Array.isArray(res.data) ? res.data : [];
    append(listed, data);
    const meta = isObject(res) && isObject(res.meta) ? res.meta : {};
    const pages = num(meta.totalPages) ?? 1;
    if (!data.length || page >= pages) break;
  }
  return { ...trace, observations: listed };
}

function usage(o: Record<string, unknown>): TraceUsage | null {
  const details = isObject(o.usageDetails) ? o.usageDetails : {};
  const legacy = isObject(o.usage) ? o.usage : {};
  const input = num(details.input ?? legacy.input ?? o.promptTokens);
  const output = num(details.output ?? legacy.output ?? o.completionTokens);
  if (input === undefined && output === undefined) return null;
  const cacheRead = num(details.cache_read_input_tokens ?? details.input_cached_tokens ?? details.input_cache_read);
  const cacheWrite = num(details.cache_creation_input_tokens ?? details.input_cache_creation);
  // Langfuse keeps cached input apart from `input`, as Anthropic reports it.
  return { input: input ?? 0, output: output ?? 0, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}), inputIncludesCache: false };
}

function modelCall(o: Record<string, unknown>): TraceModelCall {
  const input = maybeJson(o.input);
  const params = isObject(o.modelParameters) ? o.modelParameters : {};
  const metadata = isObject(o.metadata) ? o.metadata : {};
  const failed = o.level === 'ERROR';
  return {
    kind: 'model',
    what: `generation ${clean(o.name ?? o.id)}`,
    provider: str(metadata.ls_provider) ?? str(metadata.provider) ?? null,
    model: str(o.model) ?? str(params.model) ?? (isObject(input) ? str(input.model) : null),
    messages: messagesOf(input) ?? [],
    tools: isObject(input) ? toolDefinitionsOf(input.tools ?? input.functions) : null,
    settings: settingsOf(params),
    stream: params.stream === true || params.stream === 'true',
    output: outputOf(o.output),
    usage: usage(o),
    error: failed ? clean(str(o.statusMessage) ?? 'error', 500) : null,
    responseId: null,
    ...placed(o.id, o.startTime, o.endTime),
  };
}

function toolCall(o: Record<string, unknown>): TraceToolCall {
  const failed = o.level === 'ERROR';
  return {
    kind: 'tool',
    what: `${clean(o.type ?? 'span', 20).toLowerCase()} ${clean(o.name ?? o.id)}`,
    name: clean(o.name, 200),
    callId: null,
    args: o.input === null || o.input === undefined ? undefined : maybeJson(o.input),
    output: o.output === null || o.output === undefined ? undefined : maybeJson(o.output),
    error: failed ? clean(str(o.statusMessage) ?? 'error', 500) : null,
    ...placed(o.id, o.startTime, o.endTime),
  };
}

/**
 * The trace's page in Langfuse: the `htmlPath` its trace gives (`/project/<project>/traces/<id>`) on
 * the host the API answered from. None for a path that would lead anywhere else.
 */
export function langfusePage(host: string, htmlPath: unknown): string | undefined {
  if (typeof htmlPath !== 'string' || !htmlPath.startsWith('/')) return undefined;
  try {
    const url = new URL(`${host}${htmlPath}`);
    return url.origin === new URL(host).origin && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Reads a fetched trace into its calls, in the order it lists its observations; with the host it came from, its page there. */
export function readLangfuse(trace: Record<string, unknown>, host?: string): Trace {
  const observations = (Array.isArray(trace.observations) ? trace.observations : []).filter(isObject);
  const found: Array<{ at: number; call: TraceCall }> = [];
  observations.forEach((o, at) => {
    if (o.type === 'GENERATION') found.push({ at, call: modelCall(o) });
    else if (o.type === 'TOOL' && str(o.name)) found.push({ at, call: toolCall(o) });
  });
  // A span named after a tool a generation asked for is that tool's call.
  const asked = calledToolNames(found.map((f) => f.call));
  observations.forEach((o, at) => {
    if (o.type === 'SPAN' && typeof o.name === 'string' && asked.has(o.name)) found.push({ at, call: toolCall(o) });
  });
  const calls = found.sort((a, b) => a.at - b.at).map((f) => f.call);
  const parents = new Map(observations.flatMap((o) => (str(o.id) && str(o.parentObservationId) ? [[String(o.id), String(o.parentObservationId)] as const] : [])));
  // Langfuse types an agent's observation AGENT, named for the agent.
  const agents = new Map(observations.flatMap((o) => (o.type === 'AGENT' && str(o.id) && str(o.name) ? [[String(o.id), String(o.name)] as const] : [])));
  const url = host === undefined ? undefined : langfusePage(host, trace.htmlPath);
  return { id: String(trace.id ?? ''), calls, spans: observations.length, skipped: [], parents, ...(agents.size ? { agents } : {}), ...(url ? { url } : {}) };
}
