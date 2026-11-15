import { isObject, type StoreOf } from '@shadowlap/engine';
import { headerMap, importCaptured, parseBody, type Captured, type CapturedCall, type ImportResult, type Skip } from './import-capture.js';

/**
 * VCR cassettes, in their JSON serialization. A format adapter only —
 * {@link ../import-capture.js} turns these into a recording.
 *
 * VCR.py writes YAML by default and JSON on request (`vcr.VCR(serializer='json')`, or
 * `--record-mode` with a JSON cassette library). shadowlap reads the JSON form, so that no YAML
 * parser has to be trusted with a cassette from anywhere; converting an existing YAML cassette is a
 * one-liner with any YAML tool.
 *
 * What a cassette cannot carry: SSE event boundaries, and any call that did not cross the network.
 */

export interface VcrInteraction {
  request?: { method?: string; uri?: string; url?: string; body?: unknown; headers?: Record<string, unknown> };
  response?: { status?: { code?: number } | number; headers?: Record<string, unknown>; body?: unknown };
}

/** VCR headers are name → list of values; a lone string is accepted too. */
const vcrHeaders = (h: unknown): Record<string, string> =>
  headerMap(Object.entries(isObject(h) ? h : {}).map(([k, v]) => [k, Array.isArray(v) ? v.map(String).join(', ') : String(v ?? '')] as [string, string]));

/** A body is a string, `{ string }`, or `{ base64_string }`. */
function bodyText(body: unknown): { text: string | undefined; base64: boolean } {
  if (body === undefined || body === null) return { text: undefined, base64: false };
  if (typeof body === 'string') return { text: body, base64: false };
  if (typeof body === 'object') {
    const b = body as { string?: unknown; base64_string?: unknown };
    if (typeof b.base64_string === 'string') return { text: b.base64_string, base64: true };
    if (typeof b.string === 'string') return { text: b.string, base64: false };
  }
  return { text: JSON.stringify(body), base64: false };
}

const statusOf = (status: VcrInteraction['response'] extends undefined ? never : NonNullable<VcrInteraction['response']>['status']): number => {
  if (typeof status === 'number') return status;
  if (status && typeof status === 'object' && typeof status.code === 'number') return status.code;
  return 200;
};

/** Parses a JSON VCR cassette into captured calls. Throws only when the input is not one at all. */
export function readVcr(cassette: unknown): Captured {
  const interactions = (cassette as { interactions?: unknown })?.interactions;
  if (!Array.isArray(interactions)) {
    throw new Error('not a JSON VCR cassette: expected an "interactions" array. A YAML cassette has to be converted, or recorded with VCR\'s json serializer');
  }

  const calls: CapturedCall[] = [];
  const skipped: Skip[] = [];
  for (const raw of interactions) {
    // A cassette is a file from anywhere: an interaction that isn't an object has no uri either.
    const i = (typeof raw === 'object' && raw !== null ? raw : {}) as VcrInteraction;
    const uri = i.request?.uri ?? i.request?.url;
    if (typeof uri !== 'string') {
      skipped.push({ url: '(no uri)', reason: 'not a VCR interaction: needs request.uri' });
      continue;
    }
    if (i.request?.method !== undefined && typeof i.request.method !== 'string') {
      skipped.push({ url: uri, reason: "not a VCR interaction: request.method isn't text" });
      continue;
    }
    const requestHeaders = vcrHeaders(i.request?.headers);
    const requestBody = bodyText(i.request?.body);
    const responseHeaders = vcrHeaders(i.response?.headers);
    const response = bodyText(i.response?.body);
    calls.push({
      url: uri,
      method: i.request?.method ?? 'POST',
      requestHeaders,
      requestBody: parseBody(requestBody.text, requestHeaders['content-type']),
      status: statusOf(i.response?.status),
      responseHeaders,
      responseBytes: response.text === undefined ? Buffer.alloc(0) : Buffer.from(response.text, response.base64 ? 'base64' : 'utf8'),
    });
  }
  return { calls, skipped };
}

/** Reads a JSON VCR cassette and imports it as one run. */
export function importVcr(store: StoreOf<'recording'>, cassette: unknown, opts: { source: string; cwd?: string }): ImportResult {
  return importCaptured(store, readVcr(cassette), opts);
}
