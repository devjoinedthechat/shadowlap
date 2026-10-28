import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BodyTooLarge, readBody } from '@shadowlap/engine';

/** HTTP helpers every route shares: JSON answers, ETags, bodies with limits, and errors with a status. */

/**
 * An error the client caused or may see: its status and message are sent as `{ error }`, and a
 * question that asks a yes to a command line, its `confirm` with them (consent.ts).
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly confirm?: string,
  ) {
    super(message);
  }
}

/** JSON bodies are small: a label, a note, the fields of a job. Files go through `/api/uploads`. */
export const JSON_LIMIT = 256 * 1024;

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store', ...headers });
  res.end(text);
}

/** JSON with an ETag; answers 304 when the browser already has it. */
export function jsonTagged(req: IncomingMessage, res: ServerResponse, body: unknown): void {
  const text = JSON.stringify(body);
  const etag = `"${createHash('sha1').update(text).digest('base64url')}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache' });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), etag, 'cache-control': 'no-cache' });
  res.end(text);
}

export function formatLimit(bytes: number): string {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MB`;
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KB`;
  return `${bytes} bytes`;
}

/** The error for a body over its limit. The server closes the connection after answering it, so the client stops sending. */
export function tooLarge(limit: number, what = 'body'): HttpError {
  return new HttpError(413, `the ${what} is too large: at most ${formatLimit(limit)}`);
}

/** Refuses a body over `limit` before reading it, when the request says how long it is. */
export function refuseOversized(req: IncomingMessage, limit: number, what = 'body'): void {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw tooLarge(limit, what);
}

/**
 * The request body as JSON, refused past `limit` bytes. An empty body is `{}`. Read whole or not at
 * all by the engine's reader (body.ts), as every other server here reads one: past the limit the
 * rest is read and dropped, so the 413 reaches the client, and this far past it the connection is
 * cut; a client that leaves part way through is no body either.
 */
export async function readJson(req: IncomingMessage, limit = JSON_LIMIT): Promise<unknown> {
  refuseOversized(req, limit);
  let body: Buffer;
  try {
    body = await readBody(req, { limit, drain: 16 * limit });
  } catch (err) {
    if (err instanceof BodyTooLarge) throw tooLarge(limit);
    throw err;
  }
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

/** A JSON body that must be an object: what every write endpoint takes. */
export async function readObject(req: IncomingMessage, limit = JSON_LIMIT): Promise<Record<string, unknown>> {
  const body = await readJson(req, limit);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'the body must be a JSON object');
  return body as Record<string, unknown>;
}

/** Compares secrets in constant time. */
export function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * A file name safe in a `content-disposition` header and on any file system: ASCII letters, digits,
 * `.`, `_` and `-`, no leading dot, at most 100 characters with a short extension kept.
 */
export function safeFileName(name: string, fallback = 'file'): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const ascii = base
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/[._]+$/, '');
  const dot = ascii.lastIndexOf('.');
  const ext = dot > 0 && ascii.length - dot <= 12 ? ascii.slice(dot) : '';
  const stem = (ext ? ascii.slice(0, dot) : ascii).slice(0, 100 - ext.length).replace(/[._]+$/, '');
  return stem ? stem + ext : fallback;
}

/** Headers for a download: saved by the browser, never rendered. */
export function attachmentHeaders(name: string, bytes: number, type = 'application/octet-stream'): Record<string, string> {
  return {
    'content-type': type,
    'content-length': String(bytes),
    'content-disposition': `attachment; filename="${safeFileName(name)}"`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  };
}
