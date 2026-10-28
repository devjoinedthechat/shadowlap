/**
 * A request's body, read whole or not at all: the one reader the sidecar, the CLI's servers (the MCP
 * proxy, a takeover, the tasks server) and the telemetry collector share. Its own module, with
 * nothing else of the engine's, so the collector loads it alone (`@shadowlap/engine/body`).
 */
import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';

/**
 * The most a model request may be, as the sidecar and a takeover read one: twice the largest single
 * upload a provider's files API takes (OpenAI's, 512 MB), where a body used to be read whatever its size.
 */
export const MODEL_BODY_LIMIT = 1024 * 1024 * 1024;

/** A size as a message gives it: 64 KB, 32 MB, 1 GB. */
function size(bytes: number): string {
  if (bytes >= 1024 ** 3 && bytes % 1024 ** 3 === 0) return `${bytes / 1024 ** 3} GB`;
  if (bytes >= 1024 ** 2 && bytes % 1024 ** 2 === 0) return `${bytes / 1024 ** 2} MB`;
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KB`;
  return `${bytes} bytes`;
}

/** A body over the limit its reader set: answered 413, and none of it read. */
export class BodyTooLarge extends Error {
  readonly status = 413;
  constructor(readonly limit: number) {
    super(`the request is over ${size(limit)}`);
    this.name = 'BodyTooLarge';
  }
}

export interface BodyLimits {
  /** The most the body may be, in bytes. */
  limit: number;
  /**
   * How far past `limit` a client may go on sending, what it sends thrown away, so the 413 goes back
   * on the same connection; past it the connection is dropped. `limit` by default: dropped at once.
   */
  drain?: number;
}

/**
 * A request's whole body, or why it has none: never a part of it. Past `limit` bytes it rejects with
 * BodyTooLarge (status 413) and keeps nothing; the rest is read and thrown away up to `drain`, then
 * the connection is dropped. A connection that fails, or a client that leaves before its body is all
 * sent, rejects with why.
 */
export function readBody(req: IncomingMessage | Http2ServerRequest, { limit, drain = limit }: BodyLimits): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let read = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(err);
    };
    req.on('data', (chunk: Buffer) => {
      read += chunk.length;
      if (read > limit) {
        fail(new BodyTooLarge(limit));
        if (read > drain) req.destroy();
        return;
      }
      if (!settled) chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    // A client that left part way through sending: Node says "aborted", or the body just never ends.
    const cutShort = (cause?: Error) => new Error('the client closed the connection before its request was all sent', cause ? { cause } : undefined);
    req.on('error', (err: Error) => fail(req.complete ? err : cutShort(err)));
    req.on('close', () => {
      if (!req.complete) fail(cutShort());
    });
  });
}
