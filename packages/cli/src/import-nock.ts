import type { Store } from '@shadowlap/engine';
import { headerMap, importCaptured, type Captured, type CapturedCall, type ImportResult, type Skip } from './import-capture.js';

/**
 * nock recordings, as `nock.recorder.rec({ output_objects: true })` writes them: an array of
 * objects, or an object with a `nockDefs`-style array inside. A format adapter only —
 * {@link ../import-capture.js} turns these into a recording.
 *
 * nock stores a parsed body rather than raw bytes, so a streamed response arrives as the array of
 * chunks nock collected; they are rejoined here. Event boundaries and their timing are not
 * recoverable, so a streamed response replays in one piece.
 */

export interface NockDef {
  scope?: string;
  method?: string;
  path?: string;
  body?: unknown;
  reqheaders?: Record<string, unknown>;
  status?: number;
  response?: unknown;
  rawHeaders?: unknown[];
  headers?: Record<string, unknown>;
}

/** `rawHeaders` is a flat [name, value, name, value] list. */
function headersOf(def: NockDef): Record<string, string> {
  if (Array.isArray(def.rawHeaders)) {
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i + 1 < def.rawHeaders.length; i += 2) pairs.push([String(def.rawHeaders[i]), String(def.rawHeaders[i + 1])]);
    return headerMap(pairs);
  }
  return headerMap(Object.entries(def.headers ?? {}).map(([k, v]) => [k, String(v)] as [string, string]));
}

/**
 * nock's `response` is whatever it parsed: a string, an object, or — for a stream — the array of
 * chunks. Rejoin it into the bytes the client saw.
 */
function bytesOf(response: unknown, contentType: string | undefined): Buffer {
  if (response === undefined || response === null) return Buffer.alloc(0);
  if (typeof response === 'string') return Buffer.from(response, 'utf8');
  if (Array.isArray(response)) {
    // Chunks of a streamed response: strings as they came, anything else as its JSON.
    if (response.every((c) => typeof c === 'string')) return Buffer.from(response.join(''), 'utf8');
    // A hex-encoded stream, which nock writes for a non-utf8 body.
    if (response.every((c) => typeof c === 'string' || typeof c === 'number')) return Buffer.from(response.map(String).join(''), 'utf8');
  }
  // An object body, or an array of objects: JSON, which is what a non-streamed model response is.
  if (contentType && !/json/i.test(contentType)) return Buffer.from(String(response), 'utf8');
  return Buffer.from(JSON.stringify(response), 'utf8');
}

/** Parses a nock recording into captured calls. Throws only when the input is not one at all. */
export function readNock(recording: unknown): Captured {
  const defs: unknown[] = Array.isArray(recording)
    ? recording
    : Array.isArray((recording as { nockDefs?: unknown[] })?.nockDefs)
      ? (recording as { nockDefs: unknown[] }).nockDefs
      : [];
  if (!defs.length && !Array.isArray(recording)) throw new Error('not a nock recording: expected an array of definitions, or { nockDefs: [...] }');

  const calls: CapturedCall[] = [];
  const skipped: Skip[] = [];
  for (const raw of defs) {
    const def = raw as NockDef;
    if (typeof def?.scope !== 'string' || typeof def.path !== 'string') {
      skipped.push({ url: '(no scope or path)', reason: 'not a nock definition: needs scope and path' });
      continue;
    }
    // `scope` is an origin, sometimes with an explicit port: https://api.anthropic.com:443
    const origin = def.scope.replace(/:443$/, '').replace(/:80$/, '');
    const url = `${origin}${def.path}`;
    // A recording is a file from anywhere: a definition of the wrong shape is skipped with the reason.
    const problem = def.method !== undefined && typeof def.method !== 'string' ? "method isn't text" : def.status !== undefined && !Number.isInteger(def.status) ? "status isn't a number" : null;
    if (problem) {
      skipped.push({ url, reason: `not a nock definition: ${problem}` });
      continue;
    }
    const responseHeaders = headersOf(def);
    calls.push({
      url,
      method: def.method ?? 'POST',
      requestHeaders: headerMap(Object.entries(def.reqheaders ?? {}).map(([k, v]) => [k, String(v)] as [string, string])),
      requestBody: def.body === undefined ? null : def.body,
      status: def.status ?? 200,
      responseHeaders,
      responseBytes: bytesOf(def.response, responseHeaders['content-type']),
    });
  }
  return { calls, skipped };
}

/** Reads a nock recording and imports it as one run. */
export function importNock(store: Store, source: unknown, opts: { source: string; cwd?: string }): ImportResult {
  return importCaptured(store, readNock(source), opts);
}
