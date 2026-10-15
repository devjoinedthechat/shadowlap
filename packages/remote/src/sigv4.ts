import { createHash, createHmac } from 'node:crypto';
import { encodeRfc3986 } from './url.js';

/**
 * AWS Signature Version 4, for Amazon S3, Cloudflare R2, other S3-compatible stores, Google Cloud
 * Storage's HMAC interop and AWS STS. Written from the specification and checked against AWS's
 * published test suite and the S3 reference's examples (test/sigv4.test.ts), so no AWS SDK is needed.
 */

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const ALGORITHM = 'AWS4-HMAC-SHA256';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** When temporary credentials expire, ms. */
  expiresAt?: number;
  /** Where they came from, in words: `AWS_ACCESS_KEY_ID`, `AWS profile northwind`. */
  source: string;
}

export interface SignableRequest {
  method: string;
  /** The path as sent: percent-encoded segments. */
  path: string;
  /** The query as sent, without the '?'. */
  query: string;
  /** Headers to sign, any case. A header sent several times is an array, in order. */
  headers: Record<string, string | readonly string[]>;
  /** Hex SHA-256 of the body, UNSIGNED-PAYLOAD, or a streaming literal. */
  payloadHash: string;
}

export interface SigningScope {
  region: string;
  service: string;
  date: Date;
  credentials: AwsCredentials;
  /** Remove dot segments and repeated slashes from the path (every service but S3). */
  normalizePath?: boolean;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** `20150830T123600Z`. */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Each path segment encoded once (after decoding what was already encoded); dot segments resolved when normalising. */
export function canonicalUri(path: string, normalize: boolean): string {
  const raw = path === '' ? '/' : path;
  let segments = raw.split('/').map(safeDecode);
  if (normalize) {
    const out: string[] = [];
    const trailing = segments.length > 1 && (segments.at(-1) === '' || segments.at(-1) === '.' || segments.at(-1) === '..');
    for (const s of segments) {
      if (s === '' || s === '.') continue;
      if (s === '..') out.pop();
      else out.push(s);
    }
    return '/' + out.map(encodeRfc3986).join('/') + (out.length && trailing ? '/' : '');
  }
  segments = segments.map((s) => encodeRfc3986(s));
  const joined = segments.join('/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

/** The query's parameters, each name and value encoded, sorted by name then value. */
export function canonicalQuery(query: string): string {
  if (!query) return '';
  const pairs = query
    .split('&')
    .filter((p) => p !== '')
    .map((p) => {
      const i = p.indexOf('=');
      const k = i < 0 ? p : p.slice(0, i);
      const v = i < 0 ? '' : p.slice(i + 1);
      return [encodeRfc3986(safeDecode(k)), encodeRfc3986(safeDecode(v))] as const;
    });
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function trimValue(value: string): string {
  return value.replace(/\s*\n\s*/g, ',').trim().replace(/\s+/g, ' ');
}

/** Header lines (`name:value\n`, names lower-cased and sorted) and the signed-header list. */
export function canonicalHeaders(headers: SignableRequest['headers']): { lines: string; signed: string } {
  const merged = new Map<string, string[]>();
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    const list = merged.get(key) ?? [];
    for (const v of typeof value === 'string' ? [value] : value) list.push(trimValue(v));
    merged.set(key, list);
  }
  const names = [...merged.keys()].sort();
  return { lines: names.map((n) => `${n}:${merged.get(n)!.join(',')}\n`).join(''), signed: names.join(';') };
}

export function canonicalRequest(req: SignableRequest, normalize: boolean): { text: string; signedHeaders: string } {
  const { lines, signed } = canonicalHeaders(req.headers);
  return { text: [req.method.toUpperCase(), canonicalUri(req.path, normalize), canonicalQuery(req.query), lines, signed, req.payloadHash].join('\n'), signedHeaders: signed };
}

function credentialScope(scope: SigningScope): string {
  return `${amzDate(scope.date).slice(0, 8)}/${scope.region}/${scope.service}/aws4_request`;
}

export function stringToSign(canonical: string, scope: SigningScope): string {
  return [ALGORITHM, amzDate(scope.date), credentialScope(scope), sha256Hex(canonical)].join('\n');
}

export function signingKey(secret: string, date8: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date8), region), service), 'aws4_request');
}

function signatureOf(text: string, scope: SigningScope): string {
  const key = signingKey(scope.credentials.secretAccessKey, amzDate(scope.date).slice(0, 8), scope.region, scope.service);
  return createHmac('sha256', key).update(text, 'utf8').digest('hex');
}

export interface HeaderSignature {
  /** Headers to add to the request: x-amz-date, x-amz-security-token when there is one, authorization. */
  add: Record<string, string>;
  signature: string;
  canonicalRequest: string;
  stringToSign: string;
}

/**
 * Signs a request in the Authorization header. `req.headers` must hold every header to sign (host,
 * and for S3 x-amz-content-sha256); x-amz-date and the session token are added and signed here.
 */
export function signRequest(req: SignableRequest, scope: SigningScope): HeaderSignature {
  const add: Record<string, string> = { 'x-amz-date': amzDate(scope.date) };
  if (scope.credentials.sessionToken) add['x-amz-security-token'] = scope.credentials.sessionToken;
  const headers = { ...req.headers, ...add };
  const canon = canonicalRequest({ ...req, headers }, scope.normalizePath ?? false);
  const sts = stringToSign(canon.text, scope);
  const signature = signatureOf(sts, scope);
  add.authorization = `${ALGORITHM} Credential=${scope.credentials.accessKeyId}/${credentialScope(scope)}, SignedHeaders=${canon.signedHeaders}, Signature=${signature}`;
  return { add, signature, canonicalRequest: canon.text, stringToSign: sts };
}

export interface QuerySignature {
  /** The query to send: the request's own parameters and the X-Amz-* ones, the signature last. */
  query: string;
  signature: string;
  canonicalRequest: string;
  stringToSign: string;
}

/**
 * Signs a request in its query string: a presigned URL anyone can use until it expires. The
 * session token, when there is one, is signed with the rest, as S3 requires.
 */
export function presignRequest(req: SignableRequest, scope: SigningScope, expiresSeconds: number): QuerySignature {
  const { signed } = canonicalHeaders(req.headers);
  const auth: Array<[string, string]> = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${scope.credentials.accessKeyId}/${credentialScope(scope)}`],
    ['X-Amz-Date', amzDate(scope.date)],
    ['X-Amz-Expires', String(expiresSeconds)],
    ...(scope.credentials.sessionToken ? ([['X-Amz-Security-Token', scope.credentials.sessionToken]] as Array<[string, string]>) : []),
    ['X-Amz-SignedHeaders', signed],
  ];
  const query = [req.query, ...auth.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)].filter(Boolean).join('&');
  const canon = canonicalRequest({ ...req, query }, scope.normalizePath ?? false);
  const sts = stringToSign(canon.text, scope);
  const signature = signatureOf(sts, scope);
  return { query: `${query}&X-Amz-Signature=${signature}`, signature, canonicalRequest: canon.text, stringToSign: sts };
}
