import { createHash } from 'node:crypto';
import type { CallRecord, Normalizer, RunRecord } from '@shadowlap/engine';
import { estimateCost, redactArgv, rewriteText, type Price } from '@shadowlap/engine';

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
  /**
   * Redaction rules. A trace carries no prompt text, tool arguments or results, so path rules have
   * nothing to reach; the rules without a path apply to what it does carry from the run: span
   * names, the command line, model and tool names, and error messages.
   */
  redact?: Normalizer[];
}

/** Attributes Shadowlap writes itself (ids, hashes, fixed vocabularies), which no rule should rewrite. */
const OWN_ATTRIBUTES = new Set([
  'shadowlap.run.id',
  'shadowlap.run.parent_id',
  'shadowlap.run.mode',
  'shadowlap.run.status',
  'shadowlap.run.code_version',
  'shadowlap.run.divergence.type',
  'shadowlap.kind',
  'shadowlap.origin',
  'shadowlap.effect',
  'shadowlap.fingerprint',
  'shadowlap.replayed_from',
  'gen_ai.operation.name',
  'http.request.method',
  'service.name',
  'telemetry.sdk.name',
  'telemetry.sdk.language',
]);

/** The command line, which runToOtlp masks as one text before it writes it (redactArgv). */
const COMMAND_ATTRIBUTES = new Set(['process.command_args']);

function redactAttrs(list: Attr[], text: (s: string) => string): Attr[] {
  const value = (v: AttrValue): AttrValue => ('stringValue' in v ? { stringValue: text(v.stringValue) } : 'arrayValue' in v ? { arrayValue: { values: v.arrayValue.values.map(value) } } : v);
  return list.map((a) => (OWN_ATTRIBUTES.has(a.key) || COMMAND_ATTRIBUTES.has(a.key) ? a : { key: a.key, value: value(a.value) }));
}

/** What redaction reads and rewrites in a span; the rest (ids, times, kind) is Shadowlap's own. */
interface Span {
  name: string;
  attributes: Attr[];
  status: { code: number; message?: string };
  [field: string]: unknown;
}

/** The trace with the rules without a path applied to everything it carries from the run. */
function redactTrace(spans: Span[], rules: Normalizer[]): void {
  const text = (s: string) => rewriteText(s, rules);
  for (const span of spans) {
    span.name = text(span.name);
    span.attributes = redactAttrs(span.attributes, text);
    if (span.status.message !== undefined) span.status.message = text(span.status.message);
  }
}

export function runToOtlp(run: RunRecord, calls: CallRecord[], options: OtelOptions = {}): unknown {
  const traceId = hex(`trace:${run.runId}`, 32);
  const runSpanId = hex(`span:${run.runId}`, 16);
  const endedAt = run.endedAt ?? (calls.length ? Math.max(run.startedAt, ...calls.map((c) => c.end?.at ?? c.at)) : run.startedAt);
  let spent = 0;
  const spans: Span[] = [];
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
  // The command line masked as one text, as every copy masks it: a rule sees `--api-key sk-…` across two arguments.
  const rules = options.redact ?? [];
  const argv = rules.length ? redactArgv(run.command.argv, rules) : run.command.argv;
  const runSpan: Span = {
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
      attr('process.command_args', argv),
    ]),
    status: run.status === 'failed' || run.status === 'crashed' ? { code: 2, message: run.status } : { code: 1 },
  };
  if (rules.length) redactTrace([runSpan, ...spans], rules);
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

/**
 * A trace that never got an answer from the collector: nothing listening, a host that doesn't
 * resolve, a connection cut, an address that isn't one. `code` is the system's (`ECONNREFUSED`), when
 * there is one. An answer that refuses the trace is an error of its own (its status).
 */
export class OtlpUnreachable extends Error {
  constructor(
    readonly url: string,
    readonly reason: string,
    readonly code: string | null,
  ) {
    super(`couldn't send the trace to ${url}: ${reason}`);
    this.name = 'OtlpUnreachable';
  }
}

/** Why fetch got no answer, in a few words with the system's code: `connection refused (ECONNREFUSED)`. */
function unreachable(err: unknown): { reason: string; code: string | null } {
  const e = err as { name?: string; message?: string; cause?: { code?: unknown; message?: unknown } } | null;
  const code = typeof e?.cause?.code === 'string' ? e.cause.code : null;
  const words: Record<string, string> = {
    ECONNREFUSED: 'connection refused',
    ENOTFOUND: 'no such host',
    EAI_AGAIN: 'its host name could not be looked up',
    ECONNRESET: 'the connection was reset',
    EHOSTUNREACH: 'the host cannot be reached',
    ENETUNREACH: 'the network cannot be reached',
    ETIMEDOUT: 'it did not answer in time',
    UND_ERR_CONNECT_TIMEOUT: 'it did not answer in time',
  };
  if (code && words[code]) return { reason: `${words[code]} (${code})`, code };
  const message = typeof e?.cause?.message === 'string' && e.cause.message ? e.cause.message : (e?.message ?? String(err));
  return { reason: code ? `${message} (${code})` : message, code };
}

/** POSTs a trace to an OTLP/HTTP endpoint (`<endpoint>/v1/traces`, or as given when it already ends in /v1/traces). */
export async function sendOtlp(endpoint: string, payload: unknown, headers: Record<string, string>): Promise<void> {
  const url = /\/v1\/traces\/?$/.test(endpoint) ? endpoint : `${endpoint.replace(/\/$/, '')}/v1/traces`;
  if (!/^https?:$/.test(URL.parse(url)?.protocol ?? '')) throw new OtlpUnreachable(url, 'that is not an http or https address, such as http://localhost:4318', null);
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
  } catch (err) {
    const why = unreachable(err);
    throw new OtlpUnreachable(url, why.reason, why.code);
  }
  if (!res.ok) throw new Error(`OTLP export failed: ${res.status} ${res.statusText} from ${url}${res.status === 404 ? ' (is this the OTLP/HTTP endpoint, e.g. http://localhost:4318?)' : ''}`);
}
