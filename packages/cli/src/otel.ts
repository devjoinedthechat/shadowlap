import { createHash } from 'node:crypto';
import type { CallRecord, RunRecord } from '@shadowlap/engine';
import { estimateCost, type Price } from '@shadowlap/engine';

/**
 * A run as an OpenTelemetry trace in OTLP/HTTP JSON: one span for the run, one child span per
 * call, with the GenAI semantic conventions for model and tool calls. No OpenTelemetry SDK is
 * needed to write or send it.
 */
type AttrValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } | { arrayValue: { values: AttrValue[] } };
interface Attr {
  key: string;
  value: AttrValue;
}

function attr(key: string, v: string | number | boolean | string[] | null | undefined): Attr | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return { key, value: { arrayValue: { values: v.map((s) => ({ stringValue: s })) } } };
  if (typeof v === 'boolean') return { key, value: { boolValue: v } };
  if (typeof v === 'number') return Number.isInteger(v) ? { key, value: { intValue: String(v) } } : { key, value: { doubleValue: v } };
  return { key, value: { stringValue: v } };
}

function attrs(pairs: Array<Attr | null>): Attr[] {
  return pairs.filter((a): a is Attr => a !== null);
}

const nanos = (ms: number) => `${Math.round(ms)}000000`;
const hex = (s: string, len: number) => createHash('sha256').update(s).digest('hex').slice(0, len);

/** Provider from the stored id, else from the request path recorded as the call name. */
export function providerOf(c: CallRecord): string | null {
  const stored = c.end?.meta.provider ?? c.meta.provider;
  if (typeof stored === 'string') return stored;
  if (c.kind !== 'api') return null;
  if (/\/v1\/messages/.test(c.name)) return 'anthropic';
  if (/\/v1\/(chat\/completions|responses|completions|embeddings)/.test(c.name)) return 'openai';
  if (/generateContent|\/v1beta\//.test(c.name)) return 'gemini';
  return null;
}

export interface OtelOptions {
  prices?: Record<string, Price>;
  serviceName?: string;
  version?: string;
}

export function runToOtlp(run: RunRecord, calls: CallRecord[], options: OtelOptions = {}): unknown {
  const traceId = hex(`trace:${run.runId}`, 32);
  const runSpanId = hex(`span:${run.runId}`, 16);
  const endedAt = run.endedAt ?? (calls.length ? Math.max(run.startedAt, ...calls.map((c) => c.end?.at ?? c.at)) : run.startedAt);
  let spent = 0;
  const spans: unknown[] = [];
  for (const c of calls) {
    const end = c.end;
    const model = end?.meta.model ?? c.meta.model ?? null;
    const usd = c.kind === 'api' ? estimateCost(model, end?.meta.usage, options.prices) : null;
    if (usd !== null && c.origin === 'live') spent += usd;
    const provider = providerOf(c);
    const name = c.kind === 'api' ? `chat ${model ?? c.name}` : c.kind === 'tool' ? `execute_tool ${c.name}` : `${c.kind} ${c.name}`;
    const status = end ? (end.outcome === 'error' ? { code: 2, message: end.meta.error?.message ?? `HTTP ${end.meta.status ?? '?'}` } : { code: 1 }) : { code: 0 };
    spans.push({
      traceId,
      spanId: hex(`span:${run.runId}:${c.callNo}`, 16),
      parentSpanId: runSpanId,
      name,
      kind: c.kind === 'api' ? 3 : 1, // CLIENT for model calls, INTERNAL otherwise
      startTimeUnixNano: nanos(c.at),
      endTimeUnixNano: nanos(end?.at ?? c.at),
      attributes: attrs([
        attr('shadowlap.call_no', c.callNo),
        attr('shadowlap.kind', c.kind),
        attr('shadowlap.origin', c.origin),
        attr('shadowlap.effect', c.effect),
        attr('shadowlap.fingerprint', c.fingerprint),
        attr('shadowlap.occurrence', c.occurrence),
        attr('shadowlap.replayed_from', end?.meta.replayedFrom),
        attr('gen_ai.operation.name', c.kind === 'api' ? 'chat' : c.kind === 'tool' ? 'execute_tool' : null),
        attr('gen_ai.system', c.kind === 'api' ? provider : null),
        attr('gen_ai.request.model', c.kind === 'api' ? model : null),
        attr('gen_ai.response.finish_reasons', end?.meta.stopReason ? [end.meta.stopReason] : null),
        attr('gen_ai.usage.input_tokens', end?.meta.usage ? end.meta.usage.inputTokens + (end.meta.usage.cacheReadInputTokens ?? 0) : null),
        attr('gen_ai.usage.output_tokens', end?.meta.usage?.outputTokens),
        attr('gen_ai.usage.cache_read_input_tokens', end?.meta.usage?.cacheReadInputTokens),
        attr('gen_ai.usage.cache_creation_input_tokens', end?.meta.usage?.cacheCreationInputTokens),
        attr('gen_ai.tool.name', c.kind === 'tool' ? c.name : null),
        attr('http.request.method', c.kind === 'api' ? c.name.split(' ')[0] : null),
        attr('http.response.status_code', end?.meta.status),
        attr('http.response.body.size', end?.meta.bytes),
        attr('shadowlap.cost_usd', usd),
        attr('shadowlap.retries', c.attempts.length || null),
        attr('error.type', end?.outcome === 'error' ? (end.meta.error?.name ?? `http.${end.meta.status ?? 'error'}`) : null),
      ]),
      status,
    });
  }
  const runSpan = {
    traceId,
    spanId: runSpanId,
    name: `shadowlap.${run.mode} ${run.command.argv.join(' ')}`.slice(0, 200),
    kind: 1,
    startTimeUnixNano: nanos(run.startedAt),
    endTimeUnixNano: nanos(endedAt),
    attributes: attrs([
      attr('shadowlap.run.id', run.runId),
      attr('shadowlap.run.mode', run.mode),
      attr('shadowlap.run.status', run.status),
      attr('shadowlap.run.parent_id', run.parentRunId),
      attr('shadowlap.run.code_version', run.codeVersion),
      attr('shadowlap.run.calls', calls.length),
      attr('shadowlap.run.divergence.call_no', run.divergence?.callNo),
      attr('shadowlap.run.divergence.type', run.divergence?.type),
      attr('shadowlap.run.cost_usd', spent),
      attr('process.command_args', run.command.argv),
    ]),
    status: run.status === 'failed' || run.status === 'crashed' ? { code: 2, message: run.status } : { code: 1 },
  };
  return {
    resourceSpans: [
      {
        resource: { attributes: attrs([attr('service.name', options.serviceName ?? 'shadowlap-agent'), attr('telemetry.sdk.name', 'shadowlap'), attr('telemetry.sdk.language', 'nodejs')]) },
        scopeSpans: [{ scope: { name: 'shadowlap', ...(options.version ? { version: options.version } : {}) }, spans: [runSpan, ...spans] }],
      },
    ],
  };
}

/** Parses OTEL_EXPORTER_OTLP_HEADERS (`k=v,k2=v2`). */
export function otlpHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** POSTs a trace to an OTLP/HTTP endpoint (`<endpoint>/v1/traces`, or as given when it already ends in /v1/traces). */
export async function sendOtlp(endpoint: string, payload: unknown, headers: Record<string, string>): Promise<void> {
  const url = /\/v1\/traces\/?$/.test(endpoint) ? endpoint : `${endpoint.replace(/\/$/, '')}/v1/traces`;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`OTLP export failed: ${res.status} ${res.statusText} from ${url}${res.status === 404 ? ' (is this the OTLP/HTTP endpoint, e.g. http://localhost:4318?)' : ''}`);
}
