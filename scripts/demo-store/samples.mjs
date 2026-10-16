// Sample captures for `shadowlap import`, one per format the CLI reads. The HTTP formats (HAR, nock,
// VCR, LiteLLM) are made from the requests and responses of runs the demo recorded, exported as a
// HAR; the traces (OpenTelemetry, Langfuse, LangSmith) are the fixtures the CLI's own tests import.
// Each is dated a given number of days back, so the runs imported from them spread over the calendar
// the way captured traffic would. nock and VCR keep no times: their runs are dated by the import.
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

const ISO = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z?)/g;
const NANOS = /("(?:start|end|observed)?[Tt]ime(?:UnixNano)?"\s*:\s*")(\d{16,})(")/g;

/**
 * A trace fixture moved in time: every ISO date and every nanosecond timestamp shifted by the
 * same amount, so its first moment lands at `start` and the trace keeps its own pacing.
 */
export function redate(text, start) {
  const firsts = [];
  for (const m of text.matchAll(ISO)) firsts.push(Date.parse(`${m[1]}${m[2] ?? ''}Z`));
  for (const m of text.matchAll(NANOS)) firsts.push(Number(BigInt(m[2]) / 1_000_000n));
  const first = Math.min(...firsts.filter(Number.isFinite));
  const shift = start - first;
  return text
    .replace(ISO, (_all, base, frac = '', z) => {
      const moved = new Date(Date.parse(`${base}${frac}Z`) + shift).toISOString();
      const [day, time] = moved.split('T');
      const whole = time.slice(0, 8);
      const digits = frac ? `.${moved.slice(20, 23).padEnd(frac.length - 1, '0')}` : '';
      return `${day}T${whole}${digits}${z}`;
    })
    .replace(NANOS, (_all, before, nanos, after) => `${before}${BigInt(nanos) + BigInt(shift) * 1_000_000n}${after}`);
}
