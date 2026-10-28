import type { StoreOf } from '@shadowlap/engine';
import { headerMap, importCaptured, parseBody, type Captured, type CapturedCall, type ImportResult, type Skip } from './import-capture.js';

/**
 * HAR: what mitmproxy, Charles, Proxyman, a browser's devtools and Polly.js all write. A format
 * adapter only — {@link ../import-capture.js} turns these into a recording.
 *
 * What HAR cannot carry: SSE event boundaries. A streamed response replays in one piece rather than
 * at its recorded pacing.
 */

export interface HarEntry {
  startedDateTime?: string;
  time?: number;
  request?: { method?: string; url?: string; headers?: Array<{ name?: string; value?: string | null }>; postData?: { text?: string; mimeType?: string } };
  response?: { status?: number; headers?: Array<{ name?: string; value?: string | null }>; content?: { text?: string; encoding?: string; mimeType?: string } };
}

const pairsOf = (list: Array<{ name?: string; value?: string | null }> | undefined): Array<[string, string]> =>
  (list ?? []).filter((h): h is { name: string; value?: string | null } => typeof h.name === 'string').map((h) => [h.name, h.value ?? ''] as [string, string]);

const epoch = (iso: unknown): number | undefined => {
  if (typeof iso !== 'string' || !iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const textOrNone = (v: unknown) => v === undefined || typeof v === 'string';

function headersProblem(list: unknown, where: string): string | null {
  if (list === undefined) return null;
  if (!Array.isArray(list)) return `${where} isn't a list`;
  for (const [i, h] of list.entries()) {
    if (!isObject(h) || !textOrNone(h.name) || !(textOrNone(h.value) || h.value === null)) return `${where}[${i}] isn't a name and a value in text`;
  }
  return null;
}

/**
 * What is wrong with an entry's shape, or null: a HAR is a file from anywhere, and an entry whose
 * fields aren't what the format says is skipped with the reason, as one with a bad URL is.
 */
function entryProblem(e: unknown): string | null {
  if (!isObject(e)) return "it isn't an object";
  const { request, response } = e;
  if (request !== undefined && !isObject(request)) return "request isn't an object";
  if (response !== undefined && !isObject(response)) return "response isn't an object";
  if (request) {
    if (!textOrNone(request.url)) return "request.url isn't text";
    if (!textOrNone(request.method)) return "request.method isn't text";
    const headers = headersProblem(request.headers, 'request.headers');
    if (headers) return headers;
    const post = request.postData;
    if (post !== undefined && !isObject(post)) return "request.postData isn't an object";
    if (post && !textOrNone(post.text)) return "request.postData.text isn't text";
    if (post && !textOrNone(post.mimeType)) return "request.postData.mimeType isn't text";
  }
  if (response) {
    if (response.status !== undefined && !Number.isInteger(response.status)) return "response.status isn't a number";
    const headers = headersProblem(response.headers, 'response.headers');
    if (headers) return headers;
    const content = response.content;
    if (content !== undefined && !isObject(content)) return "response.content isn't an object";
    if (content && !textOrNone(content.text)) return "response.content.text isn't text";
    if (content && !textOrNone(content.encoding)) return "response.content.encoding isn't text";
    if (content && !textOrNone(content.mimeType)) return "response.content.mimeType isn't text";
  }
  return null;
}

/** Parses a HAR into captured calls. Throws only when the input is not a HAR at all. */
export function readHar(har: unknown): Captured {
  const log = (har as { log?: { entries?: HarEntry[] } })?.log;
  if (!log || !Array.isArray(log.entries)) throw new Error('not a HAR file: expected log.entries');

  const calls: CapturedCall[] = [];
  const skipped: Skip[] = [];
  for (const [i, raw] of (log.entries as unknown[]).entries()) {
    const problem = entryProblem(raw);
    if (problem) {
      const url = (raw as HarEntry | null)?.request?.url;
      skipped.push({ url: typeof url === 'string' && url ? url : `(entry ${i + 1})`, reason: `not a HAR entry: ${problem}` });
      continue;
    }
    const e = raw as HarEntry;
    const content = e.response?.content;
    calls.push({
      url: e.request?.url ?? '',
      method: e.request?.method ?? 'POST',
      requestHeaders: headerMap(pairsOf(e.request?.headers)),
      requestBody: parseBody(e.request?.postData?.text, e.request?.postData?.mimeType),
      status: e.response?.status ?? 200,
      responseHeaders: headerMap(pairsOf(e.response?.headers)),
      // No body captured leaves this empty, which the shared layer reports after the URL and host checks.
      responseBytes: content?.text === undefined ? Buffer.alloc(0) : Buffer.from(content.text, content.encoding === 'base64' ? 'base64' : 'utf8'),
      ...(epoch(e.startedDateTime) !== undefined ? { startedAt: epoch(e.startedDateTime)! } : {}),
      ...(typeof e.time === 'number' ? { timeMs: e.time } : {}),
    });
  }
  return { calls, skipped };
}

/** Reads a HAR and imports it as one run. */
export function importHar(store: StoreOf<'recording'>, source: unknown, opts: { source: string; cwd?: string }): ImportResult {
  return importCaptured(store, readHar(source), opts);
}
