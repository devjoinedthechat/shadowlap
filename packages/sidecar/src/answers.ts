/**
 * The sidecar's side of an answer: the error a request ends in (HttpError), the agent's connection as
 * it watches it (ClientWatch), the answers it gives an agent itself in place of a provider's or a
 * host's (sendOwn, providerError), and how it breaks a connection as a provider's or a host's broke.
 * The headers a connection's own (HOP_BY_HOP) and those no answer passes on (RESPONSE_DROP) are here
 * too, for what is forwarded either way.
 */
import type { ServerResponse } from 'node:http';
import { awsErrorType, type CallMeta, type SerializedError } from '@shadowlap/engine';
import type { Provider } from './providers.js';

export const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

// No content-encoding: requestUpstream drops it once it has decoded the body, and an encoding it
// can't decode goes on to the agent with its body as it came. No `location` either: a model API
// never redirects, and a client that follows one sends every header again, its key among them, to
// wherever it points (Node's fetch does), so a provider's answer is passed on and recorded without
// it, and a recording that kept one is served without it.
export const RESPONSE_DROP = new Set([...HOP_BY_HOP, 'content-length', 'location']);

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A call's attempt that ended without an answer because the agent's connection closed first. */
export const clientLeft = (when: string): SerializedError => ({ name: 'ClientDisconnected', message: `the client closed the connection ${when}` });

/**
 * The agent's side of a request: whether it has gone, its connection closed before its answer was
 * whole, and the signal that ends whatever is still upstream for it when it does. Watched from the
 * moment the request arrives, so a client that times out before the headers is seen as well.
 */
export class ClientWatch {
  gone = false;
  private readonly controller = new AbortController();
  private readonly onGone: Array<() => void> = [];

  constructor(res: ServerResponse) {
    // Over HTTP/2 a response the client reset reads as finished, but never as ended by the sidecar.
    res.once('close', () => {
      if (!res.writableEnded || !res.writableFinished) this.leave();
    });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Calls `f` once the agent has gone; at once when it has. */
  whenGone(f: () => void): void {
    if (this.gone) f();
    else this.onGone.push(f);
  }

  private leave(): void {
    if (this.gone) return;
    this.gone = true;
    this.controller.abort(new Error('the client closed the connection'));
    for (const f of this.onGone.splice(0)) f();
  }
}

/**
 * An answer the sidecar gives an agent itself, in place of the provider's or the host's: a refused
 * intervention or key, a failure a flag asked for, a call that may not go out. `body` is sent as
 * JSON; `headers` go with it besides its content type (the error type AWS clients read), and
 * `origin` is what `x-shadowlap-origin` says.
 */
export interface OwnAnswer {
  status: number;
  body: unknown;
  origin: string;
  headers?: Record<string, string>;
}

/**
 * Sends an answer of the sidecar's own: one helper for every one, so each goes out as JSON with its
 * length, and comes back with the bytes and the headers as the agent got them, for the recording to
 * keep (without `x-shadowlap-origin`, which a replay sets to its own).
 */
export function sendOwn(res: ServerResponse, own: OwnAnswer): { bytes: Buffer; headers: Record<string, string> } {
  const bytes = jsonBytes(own.body);
  const headers = { 'content-type': 'application/json', ...(own.headers ?? {}) };
  res.writeHead(own.status, { ...headers, 'content-length': String(bytes.length), 'x-shadowlap-origin': own.origin });
  res.end(bytes);
  return { bytes, headers };
}

/**
 * An error in the provider's own shape, so its client shows the message: AWS clients read a
 * top-level message and the error's type from a header (and branch on it, ThrottlingException);
 * the others read `error.message`, with `type` the kind of answer it is.
 */
export function providerError(provider: Provider, status: number, type: string, message: string, origin: string): OwnAnswer {
  return provider.id === 'bedrock' ? { status, body: { message }, origin, headers: { 'x-amzn-errortype': awsErrorType(status) } } : { status, body: { type: 'error', error: { type, message } }, origin };
}

/** A value's JSON as bytes, as `Store.putJson` stores it. */
export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

export function json(res: ServerResponse, status: number, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(bytes.length) });
  res.end(bytes);
}

/**
 * Breaks the agent's connection with no more of an answer, as a provider's or a host's that failed
 * breaks it: over HTTP/1.1 its socket closes, and over HTTP/2 its stream is reset with an error,
 * which its client reads as one (a stream that is merely closed reads as a whole answer).
 */
export function breakConnection(res: ServerResponse, why: string): void {
  res.destroy(new Error(why));
}

/**
 * Breaks the agent's connection as a recorded call's broke. Where its client left (its own timeout,
 * say), the connection is held first for as long as the client waited then (`latencyMs`, counted
 * from `since`), so the agent's client times out as it did, or, waiting longer now, sees the
 * connection cut where it was; one the client leaves meanwhile has nothing left to break.
 */
export function breakAsRecorded(res: ServerResponse, meta: CallMeta, since: number, why: string): void {
  const wait = meta.error?.name === 'ClientDisconnected' && typeof meta.latencyMs === 'number' ? meta.latencyMs - (Date.now() - since) : 0;
  if (wait <= 0) return breakConnection(res, why);
  const timer = setTimeout(() => breakConnection(res, why), wait);
  res.once('close', () => clearTimeout(timer));
}
