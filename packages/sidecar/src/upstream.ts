import { request as httpRequest, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pipeline, Readable, type Transform } from 'node:stream';
import * as zlib from 'node:zlib';

/**
 * A response body decoded as fetch decodes one: gzip, deflate, brotli, and zstd where this Node has
 * it. `decoded` is false for an encoding it can't decode: the body is passed on as it came, with its
 * `content-encoding`, for the agent's client to decode as it asked to.
 */
export function decodedBody(body: Readable, encoding: string | null | undefined): { body: Readable; decoded: boolean } {
  const coding = (encoding ?? '').trim().toLowerCase();
  if (coding === '' || coding === 'identity') return { body, decoded: true };
  // Flushed as fetch flushes: a stream answer's events come out as they arrive.
  const flush = { flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH };
  const zstd = (zlib as { createZstdDecompress?: () => Transform }).createZstdDecompress;
  const decoder: Transform | null =
    coding === 'gzip' || coding === 'x-gzip'
      ? zlib.createGunzip(flush)
      : coding === 'deflate'
        ? zlib.createInflate(flush)
        : coding === 'br'
          ? zlib.createBrotliDecompress({ flush: zlib.constants.BROTLI_OPERATION_FLUSH, finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH })
          : coding === 'zstd' && zstd
            ? zstd()
            : null;
  if (!decoder) return { body, decoded: false };
  // An error on either side ends the stream with it, so a reader sees a broken body as one.
  pipeline(body, decoder, () => {});
  return { body: decoder, decoded: true };
}

/** An upstream's answer as a fetch Response: its headers (less a `content-encoding` its body no longer has) and its body as it arrives. */
export function asResponse(status: number, headers: Headers, body: Readable | null): Response {
  if (body === null) return new Response(null, { status, headers });
  const { body: decoded, decoded: done } = decodedBody(body, headers.get('content-encoding'));
  if (done) headers.delete('content-encoding');
  return new Response(Readable.toWeb(decoded) as ReadableStream<Uint8Array>, { status, headers });
}

/**
 * A request to an upstream over HTTP/1.1, with no time limit of its own. fetch() gives up on a
 * response whose headers take more than five minutes, and so does its body between two chunks: a
 * non-streaming request to a slow model does both, a local model writing a long answer or a
 * reasoning model at high effort. A proxy in the request path must not end a call sooner than its
 * client would; the client's own timeout still governs its request to Shadowlap, and `signal` ends
 * this one when that client has gone. A compressed body is decoded, as fetch did (decodedBody).
 * `inFlight` holds the request until it has ended, so whoever owns the set can end it sooner
 * (Sidecar.close).
 */
export function requestUpstream(url: string, method: string, headers: Record<string, string>, body: Buffer | null, inFlight?: Set<ClientRequest>, signal?: AbortSignal): Promise<Response> {
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(target, { method, headers: { ...headers, ...(body ? { 'content-length': String(body.length) } : {}) }, ...(signal ? { signal } : {}) }, (res) => {
      try {
        const status = res.statusCode ?? 502;
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out.set(k, Array.isArray(v) ? v.join(', ') : v);
        if (method === 'HEAD' || status === 204 || status === 304) {
          res.resume();
          return resolve(asResponse(status, out, null));
        }
        resolve(asResponse(status, out, res));
      } catch (err) {
        // A status or header no Response can carry: the upstream's answer is no answer.
        res.destroy();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', reject);
    if (inFlight) {
      inFlight.add(req);
      // A request closes once its response has ended, a streamed body included, or it failed.
      req.once('close', () => inFlight.delete(req));
    }
    req.end(body ?? undefined);
  });
}
