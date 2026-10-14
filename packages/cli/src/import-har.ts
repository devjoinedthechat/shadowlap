import type { Store } from '@shadowlap/engine';
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
  request?: { method?: string; url?: string; headers?: Array<{ name?: string; value?: string }>; postData?: { text?: string; mimeType?: string } };
  response?: { status?: number; headers?: Array<{ name?: string; value?: string }>; content?: { text?: string; encoding?: string; mimeType?: string } };
}

const pairsOf = (list: Array<{ name?: string; value?: string }> | undefined): Array<[string, string]> =>
  (list ?? []).filter((h): h is { name: string; value?: string } => typeof h.name === 'string').map((h) => [h.name, h.value ?? ''] as [string, string]);

const epoch = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
};

/** Parses a HAR into captured calls. Throws only when the input is not a HAR at all. */
export function readHar(har: unknown): Captured {
  const log = (har as { log?: { entries?: HarEntry[] } })?.log;
  if (!log || !Array.isArray(log.entries)) throw new Error('not a HAR file: expected log.entries');

  const calls: CapturedCall[] = [];
  const skipped: Skip[] = [];
  for (const e of log.entries) {
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
export function importHar(store: Store, source: unknown, opts: { source: string; cwd?: string }): ImportResult {
  return importCaptured(store, readHar(source), opts);
}
