/**
 * A request as the sidecar reads it: its body, whole or not at all, and as JSON; its headers, lower
 * case, as they go upstream, and the few Shadowlap reads (a scope, a percent-encoded value); and the
 * host it names.
 */
import type { IncomingMessage } from 'node:http';
import { BodyTooLarge, MODEL_BODY_LIMIT, parseJsonExact, readBody as readWholeBody } from '@shadowlap/engine';
import { HOP_BY_HOP, HttpError } from './answers.js';

/** A request's whole body, at most MODEL_BODY_LIMIT: past it, a 413, and none of it read. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return readWholeBody(req, { limit: MODEL_BODY_LIMIT }).catch((err: unknown) => {
    throw err instanceof BodyTooLarge ? new HttpError(413, err.message) : err;
  });
}

/** A request's JSON body; `exact` keeps each number as written (parseJsonExact), for what is stored and served back. */
export async function readJson(req: IncomingMessage, exact = false): Promise<unknown> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    return exact ? parseJsonExact(raw.toString('utf8')) : JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

export function lowerHeaders(h: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

/**
 * A request's headers as they go upstream: without its hop-by-hop headers (a WebSocket handshake
 * keeps `connection` and `upgrade`), pseudo-headers, the host and length, and Shadowlap's own.
 * Everything else goes as the agent sent it: a signed request (AWS SigV4) signs what it carries.
 */
export function forwardedHeaders(headers: Readonly<Record<string, string>>, handshake = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith(':') || k === 'host' || k === 'content-length' || k.startsWith('x-shadowlap-')) continue;
    if (HOP_BY_HOP.has(k) && !(handshake && (k === 'connection' || k === 'upgrade'))) continue;
    out[k] = v;
  }
  return out;
}

export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value ? value : undefined;
}

/** A percent-encoded header value as text, printable and at most 200 characters, or undefined. */
export function decodeHeader(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let text = value;
  try {
    text = decodeURIComponent(value);
  } catch {
    // sent as it is
  }
  return text && !/[\u0000-\u001f\u007f]/.test(text) ? text.slice(0, 200) : undefined;
}

/**
 * The SDKs' `scope()`, from x-shadowlap-scope: printable, at most 200 characters, or none. Clients
 * percent-encode `%` and what isn't printable ASCII, so a name in any language fits a header; a value
 * that doesn't decode is taken as it was sent.
 */
export function scopeOf(req: IncomingMessage): string | undefined {
  const raw = req.headers['x-shadowlap-scope'];
  let value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (value?.includes('%')) {
    try {
      value = decodeURIComponent(value).trim();
    } catch {
      // not percent-encoded: a client from before scopes were encoded
    }
  }
  if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

/** A host name as a Host header or a URL names it, lower case and without an IPv6 address's brackets. */
export function bareHost(host: string): string {
  return host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
}

/** A path segment decoded, or as it is when it doesn't decode. */
export function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** An upstream as a run's summary names it: its origin, never a path or a password it may carry. */
export function originOf(upstream: string): string {
  try {
    return new URL(upstream).origin;
  } catch {
    return 'its upstream';
  }
}
