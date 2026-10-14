import { apiCallName, fingerprintApi, NO_COMMAND, normalizersHash, safeLine, storeApiRequest, type CallMeta, type RunRecord, type Store } from '@shadowlap/engine';
import { providers, type Provider } from '@shadowlap/sidecar';

/**
 * Building a recording out of traffic something else captured.
 *
 * Every format Shadowlap imports (HAR, nock, and whatever comes next) is only a parser: it turns
 * its own shape into {@link CapturedCall}s, and this module does the rest identically — provider
 * detection, credential stripping, fingerprinting, occurrences, usage and stop reasons. That is why
 * a new format is an adapter of a few dozen lines rather than a second implementation of the parts
 * that have to be exactly right.
 *
 * What no capture of the network can carry: tool, clock and randomness calls, which never crossed
 * it. An imported run therefore declares itself partial (`meta.covers`), and a replay of it runs
 * those kinds live instead of treating their absence as a divergence.
 */

/** One request/response pair, however the source format spelled it. */
export interface CapturedCall {
  /** Absolute URL, as the client sent it. */
  url: string;
  method: string;
  /** Lower-cased request headers. Credentials are dropped here, so it does not matter if they are present. */
  requestHeaders: Record<string, string>;
  /** Parsed JSON, or a string for a non-JSON body. */
  requestBody: unknown;
  status: number;
  responseHeaders: Record<string, string>;
  /** The response exactly as it came off the wire. */
  responseBytes: Buffer;
  /** Epoch milliseconds, when the source recorded it. */
  startedAt?: number;
  /** Round-trip duration in milliseconds, when the source recorded it. */
  timeMs?: number;
}

export interface Skip {
  url: string;
  reason: string;
}

/** What a format adapter returns: the calls it could read, and the entries it could not. */
export interface Captured {
  calls: CapturedCall[];
  skipped: Skip[];
}

export interface ImportedCall {
  callNo: number;
  name: string;
  provider: string;
  model: string | null;
}

export interface ImportResult {
  run: RunRecord;
  imported: ImportedCall[];
  /**
   * Entries that could not become calls, with the reason: anything the format itself could not
   * parse, then, in source order, everything Shadowlap would not accept.
   */
  skipped: Skip[];
}

export { NO_COMMAND };

/** Never store a credential, whatever the capture kept. */
const CREDENTIALS = ['authorization', 'x-api-key', 'api-key', 'cookie', 'set-cookie', 'proxy-authorization', 'x-goog-api-key', 'x-amz-security-token'];

/**
 * A capture is a file from anywhere, so its header names and values are untrusted: they end up in a
 * run's metadata, which terminals and the dashboard render. Control characters are escaped here
 * rather than relied on to be escaped at every point of display, and lengths are bounded so a
 * pathological file cannot bloat the store. Real HTTP headers carry neither, so nothing legitimate
 * changes — including a fingerprint.
 */
const HEADER_NAME_MAX = 256;
const HEADER_VALUE_MAX = 8192;
const HEADERS_MAX = 100;

export const headerMap = (pairs: Iterable<[string, string]>): Record<string, string> => {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [name, value] of pairs) {
    if (n >= HEADERS_MAX) break;
    const key = safeLine(name).slice(0, HEADER_NAME_MAX).toLowerCase();
    if (!key) continue;
    out[key] = safeLine(value).slice(0, HEADER_VALUE_MAX);
    n++;
  }
  return out;
};

/** Parses a body as JSON when it plausibly is one, and leaves it alone when it is not. */
export function parseBody(text: string | undefined, mimeType?: string): unknown {
  if (text === undefined) return null;
  if (mimeType && !/json/i.test(mimeType)) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function providerFor(url: URL): Provider | null {
  return providers.find((p) => p.hosts.test(url.hostname)) ?? null;
}

const strip = (headers: Record<string, string>): Record<string, string> => {
  const out = { ...headers };
  for (const h of CREDENTIALS) delete out[h];
  return out;
};

/** Turns captured calls into one run in `store`. */
export function importCaptured(store: Store, captured: Captured, opts: { source: string; cwd?: string }): ImportResult {
  const skipped: Skip[] = [...captured.skipped];
  const startedAt = captured.calls.find((c) => c.startedAt !== undefined)?.startedAt ?? Date.now();

  const run = store.createRun({
    mode: 'record',
    command: { argv: [NO_COMMAND], cwd: opts.cwd ?? process.cwd() },
    startedAt,
    meta: {
      imported: { at: Date.now(), from: opts.source },
      normalizersHash: normalizersHash([], 'exact', false),
      // A capture of the network only ever saw API calls.
      covers: ['api'],
    },
  });

  const occurrences = new Map<string, number>();
  const imported: ImportedCall[] = [];
  let callNo = 1;
  let endedAt = startedAt;

  for (const c of captured.calls) {
    let url: URL;
    try {
      url = new URL(c.url);
    } catch {
      skipped.push({ url: c.url || '(no url)', reason: 'not a URL' });
      continue;
    }
    const provider = providerFor(url);
    if (!provider) {
      skipped.push({ url: c.url, reason: 'not a model API host' });
      continue;
    }
    if (!c.responseBytes.length) {
      skipped.push({ url: c.url, reason: 'no response body was captured' });
      continue;
    }

    const method = c.method.toUpperCase();
    const path = url.pathname;
    const headers = strip(c.requestHeaders);
    const name = apiCallName(method, path);
    const { fingerprint } = fingerprintApi({ method, path, headers, body: c.requestBody }, [], provider.fingerprintHeaders);

    // Occurrences are 1-based, as Session.nextOccurrence allocates them.
    const key = `api\n${fingerprint}`;
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);

    const fingerprintHeaders: Record<string, string> = {};
    for (const h of provider.fingerprintHeaders) if (headers[h] !== undefined) fingerprintHeaders[h] = headers[h];

    const at = c.startedAt ?? startedAt;
    const took = c.timeMs !== undefined && c.timeMs >= 0 ? Math.round(c.timeMs) : 0;
    const identity = { kind: 'api' as const, name, fingerprint, occurrence };
    store.appendCallStart({
      runId: run.runId,
      callNo,
      ...identity,
      origin: 'live',
      effect: null,
      requestRef: storeApiRequest(store, c.requestBody),
      meta: { provider: provider.id, fingerprintHeaders, retryCount: 0 },
      at,
    });

    const responseHeaders = strip(c.responseHeaders);
    const contentType = responseHeaders['content-type'];
    const model = provider.extractModel(path, c.requestBody);
    const meta: CallMeta = {
      status: c.status,
      headers: responseHeaders,
      provider: provider.id,
      bytes: c.responseBytes.length,
      ...(took ? { latencyMs: took } : {}),
      ...(model ? { model } : {}),
    };
    const usage = provider.extractUsage(c.responseBytes, contentType);
    if (usage) meta.usage = usage;
    const stopReason = provider.extractStopReason(c.responseBytes, contentType);
    if (stopReason) meta.stopReason = stopReason;

    const outcome = c.status >= 400 ? 'error' : 'ok';
    if (outcome === 'error') meta.error = { name: 'HTTPError', message: `HTTP ${c.status}` };
    store.appendCallEnd(identity, { runId: run.runId, callNo, attempt: 0, responseRef: store.putBlob(c.responseBytes), outcome, meta, at: at + took });

    endedAt = Math.max(endedAt, at + took);
    imported.push({ callNo, name, provider: provider.id, model });
    callNo++;
  }

  store.endRun(run.runId, 'completed', endedAt);
  return { run: store.getRun(run.runId)!, imported, skipped };
}
