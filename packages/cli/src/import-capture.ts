import { apiCallName, credentialFreeQuery, fingerprintApi, fingerprintTool, NO_COMMAND, normalizersHash, safeLine, storeApiRequest, type CallMeta, type Effect, type RunMeta, type RunRecord, type SerializedError, type StoreOf } from '@shadowlap/engine';
import { identityQuery, providers, withoutHeaderParameters, type Provider } from '@shadowlap/sidecar';

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
 *
 * Traces (import-trace.ts) write through the same {@link ImportWriter}: their model calls become
 * captured calls, and the tool calls a trace kept are added beside them.
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
  /** A model API call, or (from a trace) a tool call with the output the trace kept. */
  kind: 'api' | 'tool';
  name: string;
  /** The provider of a model call; null for a tool call. */
  provider: string | null;
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

/**
 * Appends every item to `to`. Never `to.push(...items)`: a file from anywhere can hold more entries
 * than a function call takes arguments (about 110,000), and the import would fail on the spread.
 */
export function append<T>(to: T[], items: Iterable<T>): void {
  for (const item of items) to.push(item);
}

/** Every imported run carries this label, so imports can be listed and filtered as one kind of run. */
export const IMPORTED_LABEL = 'imported';

export interface ImportOptions {
  /** Where the calls came from, kept on the run as its source (`meta.imported.from`): a file's name, or `langfuse:7f3a9c2e`. */
  source: string;
  cwd?: string;
  /** Labels besides `imported`: the trace source a trace came from (`otel`, `langfuse`, `langsmith`). */
  labels?: string[];
  /** Who imported it (resolveAuthor), stored as the run's author. */
  author?: string | null;
  /** A trace's id in the store it came from (`meta.imported.key`), by which a later import of the trace skips it. */
  key?: string;
}

/** A tool call a trace kept, with its arguments and what it returned. */
export interface ImportedToolCall {
  name: string;
  args: unknown;
  outcome: 'ok' | 'error';
  result?: unknown;
  error?: SerializedError;
  /** The trace says nothing about effects, so this is usually null. */
  effect?: Effect | null;
  startedAt?: number;
  timeMs?: number;
}

/**
 * Writes one imported run: a model call or a tool call at a time, numbered in the order given, with
 * the identity (fingerprint, occurrence) a live recording of the same calls would have had.
 */
export class ImportWriter {
  readonly run: RunRecord;
  readonly imported: ImportedCall[] = [];
  readonly skipped: Skip[] = [];
  private callNo = 1;
  private endedAt: number;
  /** When the capture started: the run's start once it has ended. */
  private readonly capturedAt: number;
  private readonly occurrences = new Map<string, number>();

  constructor(
    private readonly store: StoreOf<'recording'>,
    opts: ImportOptions & { startedAt: number; covers: NonNullable<RunMeta['covers']> },
  ) {
    const labels = [IMPORTED_LABEL, ...(opts.labels ?? []).filter((l) => l !== IMPORTED_LABEL)];
    // Started as of now while it is written, and given the capture's start when it ends: a run is
    // judged live by when the store last heard from it (its start or its latest call), and a capture
    // a month old would otherwise read as one its importer left while that is still writing it, for
    // gc to delete and push to send half of.
    this.run = store.createRun({
      mode: 'record',
      command: { argv: [NO_COMMAND], cwd: opts.cwd ?? process.cwd() },
      meta: {
        imported: { at: Date.now(), from: opts.source, ...(opts.key ? { key: opts.key } : {}) },
        normalizersHash: normalizersHash([], 'exact', false),
        covers: opts.covers,
        labels,
        ...(opts.author ? { author: opts.author } : {}),
      },
    });
    this.capturedAt = opts.startedAt;
    this.endedAt = opts.startedAt;
  }

  /** Occurrences are 1-based and counted per kind and fingerprint, as Session.nextOccurrence allocates them. */
  private occurrence(kind: string, fingerprint: string): number {
    const key = `${kind}\n${fingerprint}`;
    const n = (this.occurrences.get(key) ?? 0) + 1;
    this.occurrences.set(key, n);
    return n;
  }

  /** Adds a model API call. One Shadowlap can't replay is skipped, with the reason, and false is returned. */
  api(c: CapturedCall): boolean {
    let url: URL;
    try {
      if (typeof c.url !== 'string') throw new TypeError('not a URL');
      url = new URL(c.url);
    } catch {
      this.skipped.push({ url: (typeof c.url === 'string' && c.url) || '(no url)', reason: 'not a URL' });
      return false;
    }
    // The readers check each entry's shape; this is the last line, so a call of the wrong shape is a skip, never a raw error.
    const shape = callShapeProblem(c);
    if (shape) {
      this.skipped.push({ url: c.url, reason: shape });
      return false;
    }
    const provider = providerFor(url);
    if (!provider) {
      this.skipped.push({ url: c.url, reason: 'not a model API host' });
      return false;
    }
    if (!c.responseBytes.length) {
      this.skipped.push({ url: c.url, reason: 'no response body was captured' });
      return false;
    }

    const method = c.method.toUpperCase();
    const path = url.pathname;
    // Without the parameters its provider takes as headers (Bedrock's guardrail): nock and VCR keep
    // only the headers they were told to, so an import holds none, and a replay of it is matched
    // without them (RunMeta.headerParameters).
    const headers = withoutHeaderParameters(provider, strip(c.requestHeaders));
    const name = apiCallName(method, path);
    // As the sidecar fingerprints the call (Provider.matchPath, Provider.matchHeaders, its query without credentials), so a replay matches the stored fingerprint.
    const { fingerprint } = fingerprintApi({ method, path, headers: provider.matchHeaders?.(headers) ?? headers, body: c.requestBody, query: identityQuery(url.search) }, [], provider.fingerprintHeaders, undefined, { matchPath: provider.matchPath?.(path) });
    const occurrence = this.occurrence('api', fingerprint);

    const fingerprintHeaders: Record<string, string> = {};
    for (const h of provider.fingerprintHeaders) if (headers[h] !== undefined) fingerprintHeaders[h] = headers[h];

    const callNo = this.callNo++;
    const at = c.startedAt ?? this.capturedAt;
    const took = c.timeMs !== undefined && c.timeMs >= 0 ? Math.round(c.timeMs) : 0;
    const identity = { kind: 'api' as const, name, fingerprint, occurrence };
    this.store.appendCallStart({
      runId: this.run.runId,
      callNo,
      ...identity,
      origin: 'live',
      effect: null,
      requestRef: storeApiRequest(this.store, c.requestBody),
      // Its query as the sidecar keeps one, credentials left out: empty when it had none.
      meta: { provider: provider.id, fingerprintHeaders, retryCount: 0, query: credentialFreeQuery(url.search.replace(/^\?/, '')) ?? '' },
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
    this.store.appendCallEnd(identity, { runId: this.run.runId, callNo, attempt: 0, responseRef: this.store.putBlob(c.responseBytes), outcome, meta, at: at + took });

    this.endedAt = Math.max(this.endedAt, at + took);
    this.imported.push({ callNo, kind: 'api', name, provider: provider.id, model });
    return true;
  }

  /** Adds a tool call, stored as the SDKs record one: `{ args }` as the request, `{ result }` or `{ error }` as the response. */
  tool(t: ImportedToolCall): void {
    const name = safeLine(t.name).slice(0, 200);
    const args = t.args ?? null;
    const { fingerprint } = fingerprintTool(name, args, []);
    const occurrence = this.occurrence('tool', fingerprint);
    const callNo = this.callNo++;
    const at = t.startedAt ?? this.capturedAt;
    const took = t.timeMs !== undefined && t.timeMs >= 0 ? Math.round(t.timeMs) : 0;
    const identity = { kind: 'tool' as const, name, fingerprint, occurrence };
    this.store.appendCallStart({ runId: this.run.runId, callNo, ...identity, origin: 'live', effect: t.effect ?? null, requestRef: this.store.putJson({ args }), meta: {}, at });
    const error = t.error ?? { name: 'Error', message: 'the tool failed' };
    const payload = t.outcome === 'ok' ? { result: t.result ?? null } : { error };
    const meta: CallMeta = { ...(took ? { latencyMs: took } : {}), ...(t.outcome === 'error' ? { error } : {}) };
    this.store.appendCallEnd(identity, { runId: this.run.runId, callNo, attempt: 0, responseRef: this.store.putJson(payload), outcome: t.outcome, meta, at: at + took });
    this.endedAt = Math.max(this.endedAt, at + took);
    this.imported.push({ callNo, kind: 'tool', name, provider: null, model: null });
  }

  /** Deletes the run, for an import that failed part way: it leaves nothing behind. */
  discard(): void {
    this.store.deleteRun(this.run.runId);
  }

  /** Ends the run and returns what it holds. */
  finish(): ImportResult {
    this.store.transaction(() => {
      this.store.setRunStart(this.run.runId, this.capturedAt);
      this.store.endRun(this.run.runId, 'completed', this.endedAt);
    });
    return { run: this.store.getRun(this.run.runId)!, imported: this.imported, skipped: this.skipped };
  }
}

const isStrings = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');

/** What is wrong with a captured call's shape, or null. */
function callShapeProblem(c: CapturedCall): string | null {
  if (typeof c.method !== 'string') return "the call's method isn't text";
  if (!Number.isInteger(c.status)) return "the call's status isn't a number";
  if (!isStrings(c.requestHeaders)) return "the call's request headers aren't text";
  if (!isStrings(c.responseHeaders)) return "the call's response headers aren't text";
  if (!Buffer.isBuffer(c.responseBytes)) return "the call's response isn't bytes";
  if (c.startedAt !== undefined && !Number.isFinite(c.startedAt)) return "the call's start isn't a time";
  if (c.timeMs !== undefined && !Number.isFinite(c.timeMs)) return "the call's duration isn't a number";
  return null;
}

/**
 * Writes one run through an {@link ImportWriter} and finishes it. When writing throws part way, the
 * run it started is deleted before the error goes on: a failed import leaves no empty run marked
 * running behind.
 */
export function writeImport<T>(writer: ImportWriter, write: () => T): T {
  try {
    return write();
  } catch (err) {
    try {
      writer.discard();
    } catch {
      // the store itself failed: the error that stopped the import says more
    }
    throw err;
  }
}

/** Turns captured calls into one run in `store`. A capture of the network only ever saw model API calls. */
export function importCaptured(store: StoreOf<'recording'>, captured: Captured, opts: ImportOptions): ImportResult {
  const startedAt = captured.calls.find((c) => typeof c.startedAt === 'number' && Number.isFinite(c.startedAt))?.startedAt ?? Date.now();
  const writer = new ImportWriter(store, { ...opts, startedAt, covers: ['api'] });
  return writeImport(writer, () => {
    append(writer.skipped, captured.skipped);
    for (const c of captured.calls) writer.api(c);
    return writer.finish();
  });
}
