import {
  calledToolNames,
  clean,
  isObject,
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
import { fetchJson, type TraceStoreOptions } from './import-fetch.js';

/**
 * A Langfuse trace, fetched from its public API with the project's keys
 * (`GET /api/public/traces/{id}`, and the observations list when the trace leaves them out). A
 * format adapter only: import-trace.ts turns the calls into a recording.
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

/** Observations per page of `/api/public/observations`, and the most read for one trace. */
const PAGE = 100;
const MAX_OBSERVATIONS = 10_000;

/** Fetches a trace and its observations. Throws with the reason when Langfuse refuses or has no such trace. */
export async function fetchLangfuseTrace(traceId: string, o: LangfuseOptions): Promise<Record<string, unknown>> {
  const auth = `Basic ${Buffer.from(`${o.publicKey}:${o.secretKey}`, 'utf8').toString('base64')}`;
  const get = (path: string) =>
    fetchJson(o, path, { headers: { authorization: auth, accept: 'application/json' } }, {
      401: 'Langfuse refused the keys (401): check LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY, and that the host is the region the project lives in',
      403: 'Langfuse refused the keys (403): they have no access to this trace',
      404: `Langfuse has no trace ${traceId} on ${new URL(o.host).host}`,
    });
  const trace = await get(`/api/public/traces/${encodeURIComponent(traceId)}`);
  if (!isObject(trace)) throw new Error('Langfuse answered with something that is not a trace');
  if (Array.isArray(trace.observations) && trace.observations.every(isObject)) return trace;
  // Some deployments list observation ids only; the observations endpoint has them whole.
  const observations: unknown[] = [];
  for (let page = 1; observations.length < MAX_OBSERVATIONS; page++) {
    const res = await get(`/api/public/observations?traceId=${encodeURIComponent(traceId)}&page=${page}&limit=${PAGE}`);
    const data = isObject(res) && Array.isArray(res.data) ? res.data : [];
    append(observations, data);
    const meta = isObject(res) && isObject(res.meta) ? res.meta : {};
    const pages = num(meta.totalPages) ?? 1;
    if (!data.length || page >= pages) break;
  }
  return { ...trace, observations };
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

/** Reads a fetched trace into its calls, in the order it lists its observations. */
export function readLangfuse(trace: Record<string, unknown>): Trace {
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
  return { id: String(trace.id ?? ''), calls, spans: observations.length, skipped: [], parents };
}
