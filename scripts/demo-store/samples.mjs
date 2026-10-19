// Sample captures for `shadowlap import`, one per format the CLI reads, each made from the requests
// and responses of runs a demo agent made, exported as a HAR: the HTTP formats (HAR, nock, VCR,
// LiteLLM) as a proxy or a test library saves them, and the traces (OpenTelemetry, Langfuse,
// LangSmith) as each one's own instrumentation of the Anthropic client logs a model call, the
// request and response with it. Each is dated a given number of days back, so the runs imported
// from them spread over the calendar the way captured traffic would. nock and VCR keep no times:
// their runs are dated by the import.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const DAY = 86_400_000;

/** A moment `days` back from now, at a fixed time of day (UTC), so a capture lands inside one day. */
export function daysAgo(days, hour = 10, minute = 36) {
  const d = new Date(Date.now() - days * DAY);
  d.setUTCHours(hour, minute, 0, 0);
  return d.getTime();
}

/** The model calls of an exported HAR, with each response's body decoded. */
export function harEntries(file) {
  return JSON.parse(readFileSync(file, 'utf8')).log.entries.map((e) => ({
    method: e.request.method,
    url: e.request.url,
    requestHeaders: e.request.headers,
    requestBody: e.request.postData?.text ?? '',
    status: e.response.status,
    responseHeaders: e.response.headers,
    responseType: e.response.content.mimeType ?? 'application/json',
    responseBody: e.response.content.encoding === 'base64' ? Buffer.from(e.response.content.text ?? '', 'base64').toString('utf8') : (e.response.content.text ?? ''),
    time: e.time ?? 0,
  }));
}

const json = (value) => `${JSON.stringify(value, null, 1)}\n`;
const at = (start, i) => start + i * 2600;

/** A HAR, as a browser's devtools or a proxy saves one. */
export function har(entries, start) {
  return json({
    log: {
      version: '1.2',
      creator: { name: 'demo-store', version: '1' },
      entries: entries.map((e, i) => ({
        startedDateTime: new Date(at(start, i)).toISOString(),
        time: e.time,
        request: { method: e.method, url: e.url, httpVersion: 'HTTP/1.1', headers: e.requestHeaders, queryString: [], cookies: [], headersSize: -1, bodySize: e.requestBody.length, postData: { mimeType: 'application/json', text: e.requestBody } },
        response: { status: e.status, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: e.responseHeaders, cookies: [], content: { size: e.responseBody.length, mimeType: e.responseType, text: e.responseBody }, redirectURL: '', headersSize: -1, bodySize: e.responseBody.length },
        cache: {},
        timings: { send: 0, wait: e.time, receive: 0 },
      })),
    },
  });
}

/** What `nock.recorder.rec({ output_objects: true })` writes. */
export function nock(entries) {
  return json(
    entries.map((e) => {
      const u = new URL(e.url);
      const isJson = e.responseType.includes('json');
      return {
        scope: `${u.protocol}//${u.host}:443`,
        method: e.method,
        path: `${u.pathname}${u.search}`,
        body: JSON.parse(e.requestBody || '{}'),
        reqheaders: Object.fromEntries(e.requestHeaders.map((h) => [h.name, h.value])),
        status: e.status,
        response: isJson ? JSON.parse(e.responseBody) : [e.responseBody],
        rawHeaders: e.responseHeaders.flatMap((h) => [h.name, h.value]),
        responseIsBinary: false,
      };
    }),
  );
}

/** A VCR.py cassette with its JSON serializer. */
export function vcr(entries) {
  const listed = (headers) => Object.fromEntries(headers.map((h) => [h.name, [h.value]]));
  return json({
    version: 1,
    interactions: entries.map((e) => ({
      request: { method: e.method, uri: e.url, body: e.requestBody, headers: listed(e.requestHeaders) },
      response: { status: { code: e.status, message: 'OK' }, headers: listed(e.responseHeaders), body: { string: e.responseBody } },
    })),
  });
}

/**
 * What `shadowlap.litellm_callback` writes on a LiteLLM proxy: one line per call, the gateway's
 * own URL, a correlation id per agent run. A proxy runs several workers, each with a file of its
 * own, so the calls of one run alternate between the files given.
 */
export function litellm(entries, start, runKey, files) {
  const out = files.map(() => []);
  entries.forEach((e, i) => {
    const u = new URL(e.url);
    out[i % files.length].push(
      JSON.stringify({
        format: 'shadowlap-capture',
        v: 1,
        url: `http://litellm.internal:4000${u.pathname}`,
        method: e.method,
        requestHeaders: Object.fromEntries(e.requestHeaders.map((h) => [h.name, h.value])),
        requestBody: JSON.parse(e.requestBody || '{}'),
        status: e.status,
        responseHeaders: Object.fromEntries(e.responseHeaders.map((h) => [h.name, h.value])),
        responseBody: e.responseBody,
        startedAt: at(start, i),
        timeMs: e.time,
        runKey,
      }),
    );
  });
  return out.map((lines) => `${lines.join('\n')}\n`);
}

// ---- traces: what an instrumented Anthropic client logs of each model call ----

const hex = (seed, n) => createHash('sha256').update(seed).digest('hex').slice(0, n);
const uuid = (seed) => {
  const h = hex(seed, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const iso = (ms) => new Date(ms).toISOString();
const calls = (entries) =>
  entries.map((e) => {
    const request = JSON.parse(e.requestBody || '{}');
    const response = JSON.parse(e.responseBody || '{}');
    return { request, response, model: response.model ?? request.model, usage: response.usage ?? {}, time: e.time };
  });

/**
 * OTLP JSON as Arize Phoenix's Anthropic instrumentation (OpenInference) exports a trace: an agent
 * span and an LLM span per model call, whose input.value and output.value are the request the
 * client sent and the response it got.
 */
export function openinference(entries, start, service) {
  const traceId = hex(`${service}:${start}`, 32);
  const root = hex(`${traceId}:agent`, 16);
  const ns = (ms) => String(BigInt(Math.round(ms)) * 1_000_000n);
  const str = (key, value) => ({ key, value: { stringValue: value } });
  const int = (key, value) => ({ key, value: { intValue: String(value ?? 0) } });
  const llm = calls(entries).map((c, i) => ({
    traceId,
    spanId: hex(`${traceId}:${i}`, 16),
    parentSpanId: root,
    name: 'Messages',
    kind: 1,
    startTimeUnixNano: ns(at(start, i)),
    endTimeUnixNano: ns(at(start, i) + c.time),
    attributes: [
      str('openinference.span.kind', 'LLM'),
      str('llm.provider', 'anthropic'),
      str('llm.system', 'anthropic'),
      str('llm.model_name', c.model),
      str('llm.invocation_parameters', JSON.stringify({ model: c.request.model, max_tokens: c.request.max_tokens })),
      str('input.value', JSON.stringify(c.request)),
      str('input.mime_type', 'application/json'),
      str('output.value', JSON.stringify(c.response)),
      str('output.mime_type', 'application/json'),
      int('llm.token_count.prompt', c.usage.input_tokens),
      int('llm.token_count.completion', c.usage.output_tokens),
    ],
    status: { code: 1 },
  }));
  const agent = { traceId, spanId: root, name: service, kind: 1, startTimeUnixNano: ns(start), endTimeUnixNano: ns(at(start, entries.length)), attributes: [str('openinference.span.kind', 'AGENT')], status: { code: 1 } };
  return json({
    resourceSpans: [
      {
        resource: { attributes: [str('service.name', service)] },
        scopeSpans: [
          { scope: { name: 'openinference.instrumentation.anthropic', version: '0.1.19' }, spans: llm },
          { scope: { name: service }, spans: [agent] },
        ],
      },
    ],
  });
}

/**
 * A LangSmith trace of an agent whose Anthropic client is wrapped (`wrap_anthropic`): a root run and
 * an llm run per model call, its inputs the request and its outputs the response, as
 * `POST /runs/query` pages them.
 */
export function langsmith(entries, start, name) {
  const traceId = uuid(`langsmith:${name}:${start}`);
  const end = at(start, entries.length);
  const root = { id: traceId, name, run_type: 'chain', start_time: iso(start).slice(0, -1), end_time: iso(end).slice(0, -1), inputs: {}, outputs: {}, error: null, extra: {}, parent_run_id: null, trace_id: traceId, status: 'success' };
  const runs = calls(entries).map((c, i) => ({
    id: uuid(`${traceId}:${i}`),
    name: 'ChatAnthropic',
    run_type: 'llm',
    start_time: iso(at(start, i)).slice(0, -1),
    end_time: iso(at(start, i) + c.time).slice(0, -1),
    inputs: c.request,
    outputs: c.response,
    error: null,
    extra: { invocation_params: { model: c.request.model, max_tokens: c.request.max_tokens }, metadata: { ls_provider: 'anthropic', ls_model_type: 'chat', ls_model_name: c.request.model } },
    parent_run_id: traceId,
    trace_id: traceId,
    status: 'success',
    prompt_tokens: c.usage.input_tokens ?? 0,
    completion_tokens: c.usage.output_tokens ?? 0,
    total_tokens: (c.usage.input_tokens ?? 0) + (c.usage.output_tokens ?? 0),
  }));
  return { traceId, pages: [{ runs: [root, ...runs], cursors: { next: null } }] };
}

/**
 * A Langfuse trace as `GET /api/public/traces/<id>` answers it, from its Anthropic integration: a
 * generation per model call, its input the request's messages, system prompt and tools, its model
 * parameters, and the response as its output.
 */
export function langfuse(entries, start, name) {
  const id = uuid(`langfuse:${name}:${start}`);
  const observations = calls(entries).map((c, i) => ({
    id: uuid(`${id}:${i}`),
    traceId: id,
    type: 'GENERATION',
    name: 'anthropic.messages.create',
    startTime: iso(at(start, i)),
    endTime: iso(at(start, i) + c.time),
    model: c.request.model,
    modelParameters: { max_tokens: c.request.max_tokens },
    input: { system: c.request.system, messages: c.request.messages, tools: c.request.tools },
    output: c.response,
    usageDetails: { input: c.usage.input_tokens ?? 0, output: c.usage.output_tokens ?? 0 },
    metadata: { provider: 'anthropic' },
    level: 'DEFAULT',
  }));
  return { id, text: json({ id, name, timestamp: iso(start), observations }) };
}

