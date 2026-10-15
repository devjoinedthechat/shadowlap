import {
  clean,
  epochMs,
  isObject,
  maybeJson,
  messagesOf,
  num,
  outputOf,
  providerRequest,
  providerResponse,
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
 * A LangSmith trace: every run in it, fetched with `POST /runs/query` and the API key on this
 * machine. A format adapter only: import-trace.ts turns the calls into a recording.
 *
 * `llm` runs are model calls. LangChain logs their messages serialized, with the tool definitions
 * and settings in `extra.invocation_params`; LangSmith's wrapped OpenAI and Anthropic clients log the
 * request itself and the response, which rebuild exactly. `tool` runs are tool calls, and replay when
 * they kept their inputs and outputs.
 */

export const LANGSMITH_HOST = 'https://api.smith.langchain.com';

export interface LangsmithOptions extends TraceStoreOptions {
  apiKey: string;
}

const PAGE = 100;
const MAX_RUNS = 10_000;

/** Fetches the runs of one trace, every page. Throws with the reason when LangSmith refuses or has none. */
export async function fetchLangsmithRuns(traceId: string, o: LangsmithOptions): Promise<Array<Record<string, unknown>>> {
  const runs: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  do {
    const res = await fetchJson(
      o,
      '/runs/query',
      { method: 'POST', headers: { 'x-api-key': o.apiKey, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ trace: traceId, limit: PAGE, ...(cursor ? { cursor } : {}) }) },
      {
        401: 'LangSmith refused the key (401): check LANGSMITH_API_KEY, and that the host is the region the workspace lives in',
        403: 'LangSmith refused the key (403): it has no access to this trace',
        404: `LangSmith has no trace ${traceId} on ${new URL(o.host).host}`,
        422: `LangSmith did not take ${traceId} as a trace id`,
      },
    );
    const page = isObject(res) && Array.isArray(res.runs) ? res.runs.filter(isObject) : [];
    append(runs, page);
    const cursors = isObject(res) && isObject(res.cursors) ? res.cursors : {};
    cursor = page.length ? str(cursors.next) : null;
  } while (cursor && runs.length < MAX_RUNS);
  if (!runs.length) throw new Error(`LangSmith has no runs for trace ${traceId} on ${new URL(o.host).host}`);
  return runs;
}

function usage(run: Record<string, unknown>, outputs: unknown): TraceUsage | null {
  // LangChain reports usage_metadata on the message; the run itself carries the totals LangSmith counted.
  let input = num(run.prompt_tokens);
  let output = num(run.completion_tokens);
  let cacheRead: number | undefined;
  let cacheWrite: number | undefined;
  const generations = isObject(outputs) && Array.isArray(outputs.generations) ? outputs.generations.flat() : [];
  for (const g of generations) {
    const message = isObject(g) && isObject(g.message) ? (isObject(g.message.kwargs) ? g.message.kwargs : g.message) : null;
    const meta = message && isObject(message.usage_metadata) ? message.usage_metadata : null;
    if (!meta) continue;
    input ??= num(meta.input_tokens);
    output ??= num(meta.output_tokens);
    const details = isObject(meta.input_token_details) ? meta.input_token_details : {};
    cacheRead ??= num(details.cache_read);
    cacheWrite ??= num(details.cache_creation);
  }
  if (input === undefined && output === undefined) return null;
  // LangChain and LangSmith count cached tokens as input.
  return { input: input ?? 0, output: output ?? 0, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}), inputIncludesCache: true };
}

function modelCall(run: Record<string, unknown>): TraceModelCall {
  const inputs = isObject(run.inputs) ? run.inputs : {};
  const outputs = run.outputs;
  const extra = isObject(run.extra) ? run.extra : {};
  const params = isObject(extra.invocation_params) ? extra.invocation_params : {};
  const metadata = isObject(extra.metadata) ? extra.metadata : {};
  const raw = providerRequest(inputs);
  const llmOutput = isObject(outputs) && isObject(outputs.llm_output) ? outputs.llm_output : {};
  const responseMeta = providerResponse(outputs);
  return {
    kind: 'model',
    what: `run ${clean(run.name ?? run.id)}`,
    provider: str(metadata.ls_provider) ?? (str(params._type)?.replace(/-chat$/, '') ?? null),
    model: str(params.model) ?? str(params.model_name) ?? str(metadata.ls_model_name) ?? str(inputs.model) ?? str(llmOutput.model_name) ?? null,
    messages: messagesOf(inputs) ?? [],
    tools: toolDefinitionsOf(params.tools ?? inputs.tools ?? params.functions),
    settings: settingsOf(params, metadata),
    stream: params.stream === true || inputs.stream === true,
    output: outputOf(outputs),
    usage: usage(run, outputs),
    error: str(run.error) === null ? null : clean(run.error, 500),
    ...(raw ? { rawRequest: raw } : {}),
    ...(responseMeta ? { rawResponse: responseMeta } : {}),
    responseId: responseMeta ? str(responseMeta.id) : null,
    startedAt: epochMs(run.start_time),
    endedAt: epochMs(run.end_time),
  };
}

/** A tool run's input: LangChain logs `{ input: "<the arguments as text>" }`, @traceable the arguments themselves. */
function toolArgs(inputs: unknown): unknown {
  if (!isObject(inputs)) return undefined;
  const keys = Object.keys(inputs);
  if (keys.length === 1 && keys[0] === 'input') return maybeJson(inputs.input);
  // A tool that takes no arguments logs {}.
  return inputs;
}

/** A tool run's output: `{ output: … }`, or LangChain's ToolMessage, whose content is what the model saw. */
function toolOutput(outputs: unknown): unknown {
  if (outputs === null || outputs === undefined) return undefined;
  let v: unknown = isObject(outputs) && 'output' in outputs ? outputs.output : outputs;
  if (isObject(v) && v.lc === 1 && isObject(v.kwargs)) v = v.kwargs.content;
  return maybeJson(v);
}

function toolCall(run: Record<string, unknown>): TraceToolCall {
  return {
    kind: 'tool',
    what: `run ${clean(run.name ?? run.id)}`,
    name: clean(run.name, 200),
    callId: null,
    args: toolArgs(run.inputs),
    output: toolOutput(run.outputs),
    error: str(run.error) === null ? null : clean(run.error, 500),
    startedAt: epochMs(run.start_time),
    endedAt: epochMs(run.end_time),
  };
}

/** Reads a trace's runs into its calls. */
export function readLangsmith(runs: Array<Record<string, unknown>>, traceId: string): Trace {
  const calls: TraceCall[] = [];
  for (const run of runs) {
    if (run.run_type === 'llm') calls.push(modelCall(run));
    else if (run.run_type === 'tool' && str(run.name)) calls.push(toolCall(run));
  }
  return { id: traceId, calls, spans: runs.length, skipped: [] };
}
