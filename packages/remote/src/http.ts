import { proxyFetch, proxyFor } from './proxy.js';

/**
 * The one way the drivers talk to a cloud: fetch, with a timeout, a cap on how much of an answer is
 * read (a bucket is shared, so its contents are not trusted to be small), and retries for the
 * failures a retry fixes: a dropped connection, a 5xx, throttling. Behind a proxy (HTTPS_PROXY,
 * HTTP_PROXY, NO_PROXY), requests go through it; see proxy.ts.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Buffer;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  body: Buffer;
}

export interface SendOptions {
  fetch?: FetchLike;
  /** Largest body read; a larger answer fails. */
  maxBytes?: number;
  /** How long the answer may take to start (longer for a large upload), and to send its next chunk. */
  timeoutMs?: number;
  /** Attempts in all, the first included. */
  attempts?: number;
  /** The first wait between attempts; it triples each time. */
  retryDelayMs?: number;
}

export class HttpError extends Error {
  readonly network: boolean;
  constructor(message: string, network: boolean) {
    super(message);
    this.name = 'HttpError';
    this.network = network;
  }
}

const RETRY = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MAX = 512 * 1024 * 1024;
/** How long an answer may take to start, and to send its next chunk. */
const WAIT_MS = 120_000;

async function readCapped(res: Response, maxBytes: number, idleMs: number, controller: AbortController): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new HttpError(`the answer is ${declared} bytes, over the ${maxBytes}-byte limit`, false);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    // A slow transfer is fine; one that stops is not.
    const idle = setTimeout(() => controller.abort(), idleMs);
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } finally {
      clearTimeout(idle);
    }
    const { done, value } = chunk;
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError(`the answer is over the ${maxBytes}-byte limit`, false);
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, total);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const throughProxy = new Map<string, FetchLike>();

/** Node's fetch, or through the proxy the environment names for this URL: for any request Shadowlap makes to a service. */
export function envFetch(input: string, init: RequestInit): Promise<Response> {
  const proxy = proxyFor(input);
  if (!proxy) return fetch(input, init);
  let viaProxy = throughProxy.get(proxy.href);
  if (!viaProxy) throughProxy.set(proxy.href, (viaProxy = proxyFetch(proxy)));
  return viaProxy(input, init);
}

/**
 * Sends a request, retrying a dropped connection or a retryable status. `prepare` runs before each
 * attempt, so a signature can be made fresh for it.
 */
export async function send(request: HttpRequest | (() => HttpRequest | Promise<HttpRequest>), options: SendOptions = {}): Promise<HttpResponse> {
  const doFetch: FetchLike = options.fetch ?? envFetch;
  const attempts = Math.max(1, options.attempts ?? 4);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX;
  let delay = options.retryDelayMs ?? 250;
  let last: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    if (i) {
      await sleep(delay + Math.floor(Math.random() * delay * 0.25));
      delay *= 3;
    }
    const req = typeof request === 'function' ? await request() : request;
    const host = new URL(req.url).host;
    const idleMs = options.timeoutMs ?? WAIT_MS;
    // The answer must start within the wait, which an upload stretches to at least 50 kB a second.
    const controller = new AbortController();
    const startBy = setTimeout(() => controller.abort(), Math.max(idleMs, req.body ? Math.ceil(req.body.length / 50) : 0));
    let res: Response;
    try {
      res = await doFetch(req.url, {
        method: req.method,
        headers: req.headers ?? {},
        ...(req.body !== undefined ? { body: new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength) } : {}),
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      last = new HttpError(controller.signal.aborted ? `${host} didn't answer in time` : `couldn't reach ${host}: ${cause?.code ?? cause?.message ?? (err as Error).message}`, true);
      continue;
    } finally {
      clearTimeout(startBy);
    }
    if (RETRY.has(res.status) && i < attempts - 1) {
      await res.body?.cancel().catch(() => {});
      last = new HttpError(`${host} answered ${res.status}`, false);
      continue;
    }
    let body: Buffer;
    try {
      body = req.method === 'HEAD' ? Buffer.alloc(0) : await readCapped(res, maxBytes, idleMs, controller);
    } catch (err) {
      if (err instanceof HttpError) throw err; // too large: another attempt would be too
      last = new HttpError(controller.signal.aborted ? `${host} stopped sending its answer` : `the answer from ${host} was cut off: ${(err as Error).message}`, true);
      continue;
    }
    return { status: res.status, headers: res.headers, body };
  }
  throw last ?? new HttpError('the request failed', true);
}
