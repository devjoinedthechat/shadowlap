import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { canonicalRequest, signingKey, stringToSign } from '../../src/sigv4.js';
import { createHmac } from 'node:crypto';

/**
 * An S3 API subset in process, for the tests: ListObjectsV2, GetObject, HeadObject, PutObject (with
 * If-Match, If-None-Match and Content-MD5), DeleteObject, bucket versioning, Object Lock and
 * encryption, and presigned GETs. A bucket with Object Lock and a default retention refuses a write
 * without Content-MD5, as S3 does.
 * Every request's SigV4 signature is checked against the request as it arrived on the wire (method,
 * raw path, raw query, the signed headers' values, the payload hash), so a request signed one way
 * and sent another fails here as it would on S3.
 */

export interface FakeObject {
  body: Buffer;
  etag: string;
  contentType: string;
  modified: number;
  versionId: string | null;
}

export interface FakeS3Options {
  /** access key id → secret */
  keys: Record<string, string>;
  /** session tokens a key must come with, when it is temporary */
  tokens?: Record<string, string>;
  bucket: string;
  region?: string;
  versioning?: 'Enabled' | 'Suspended' | null;
  encryption?: string | null;
  /** Object Lock: on with a default retention, on without one, or off (the default). */
  objectLock?: { mode: 'GOVERNANCE' | 'COMPLIANCE'; days: number } | 'no-default' | null;
  /** Answer 403 to these operations. */
  deny?: Array<'list' | 'get' | 'put' | 'delete' | 'versioning' | 'encryption' | 'object-lock'>;
  /** A store without conditional writes: If-Match and If-None-Match get 501. */
  noConditional?: boolean;
  /** Page size for ListObjectsV2. */
  pageSize?: number;
  now?: () => number;
}

export interface FakeS3 {
  url: string;
  objects: Map<string, FakeObject>;
  requests: Array<{ method: string; path: string; query: string; status: number }>;
  close(): Promise<void>;
}

function xml(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/xml', ...headers });
  res.end(body);
}

function error(res: ServerResponse, status: number, code: string, message = code): void {
  xml(res, status, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseAmzDate(s: string): Date {
  return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
}

function verifyHeaderAuth(opts: FakeS3Options, req: IncomingMessage, rawPath: string, rawQuery: string, body: Buffer): string | null {
  const auth = req.headers.authorization ?? '';
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m) return 'AccessDenied';
  const [, keyId, , region, signedHeaders, signature] = m;
  const secret = opts.keys[keyId!];
  if (!secret) return 'InvalidAccessKeyId';
  const token = opts.tokens?.[keyId!];
  if (token && req.headers['x-amz-security-token'] !== token) return 'InvalidToken';
  const payloadHash = String(req.headers['x-amz-content-sha256'] ?? '');
  if (payloadHash !== 'UNSIGNED-PAYLOAD' && payloadHash !== createHash('sha256').update(body).digest('hex')) return 'XAmzContentSHA256Mismatch';
  const headers: Record<string, string> = {};
  for (const name of signedHeaders!.split(';')) {
    const v = req.headers[name];
    if (v === undefined) return 'SignatureDoesNotMatch';
    headers[name] = Array.isArray(v) ? v.join(',') : v;
  }
  const date = parseAmzDate(String(req.headers['x-amz-date'] ?? ''));
  const scope = { region: region!, service: 's3', date, credentials: { accessKeyId: keyId!, secretAccessKey: secret, source: 'fake' } };
  const canon = canonicalRequest({ method: req.method!, path: rawPath, query: rawQuery, headers, payloadHash }, false);
  const expected = createHmac('sha256', signingKey(secret, m[2]!, region!, 's3')).update(stringToSign(canon.text, scope)).digest('hex');
  return expected === signature ? null : 'SignatureDoesNotMatch';
}

function verifyQueryAuth(opts: FakeS3Options, req: IncomingMessage, rawPath: string, rawQuery: string): string | null {
  const params = new URLSearchParams(rawQuery);
  const credential = params.get('X-Amz-Credential') ?? '';
  const [keyId, day, region] = credential.split('/');
  const secret = opts.keys[keyId ?? ''];
  if (!secret) return 'InvalidAccessKeyId';
  const date = parseAmzDate(params.get('X-Amz-Date') ?? '');
  const expires = Number(params.get('X-Amz-Expires'));
  if (!(expires > 0 && expires <= 604800)) return 'AuthorizationQueryParametersError';
  if ((opts.now?.() ?? Date.now()) > date.getTime() + expires * 1000) return 'AccessDenied';
  const signature = params.get('X-Amz-Signature');
  const withoutSig = rawQuery
    .split('&')
    .filter((p) => !p.startsWith('X-Amz-Signature='))
    .join('&');
  const headers: Record<string, string> = {};
  for (const name of (params.get('X-Amz-SignedHeaders') ?? '').split(';')) headers[name] = String(req.headers[name] ?? '');
  const scope = { region: region!, service: 's3', date, credentials: { accessKeyId: keyId!, secretAccessKey: secret, source: 'fake' } };
  const canon = canonicalRequest({ method: req.method!, path: rawPath, query: withoutSig, headers, payloadHash: 'UNSIGNED-PAYLOAD' }, false);
  const expected = createHmac('sha256', signingKey(secret, day!, region!, 's3')).update(stringToSign(canon.text, scope)).digest('hex');
  return expected === signature ? null : 'SignatureDoesNotMatch';
}

export async function startFakeS3(opts: FakeS3Options): Promise<FakeS3> {
  const objects = new Map<string, FakeObject>();
  const requests: FakeS3['requests'] = [];
  let versionSeq = 0;
  let etagSeq = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const raw = req.url ?? '/';
      const q = raw.indexOf('?');
      const rawPath = q < 0 ? raw : raw.slice(0, q);
      const rawQuery = q < 0 ? '' : raw.slice(q + 1);
      const params = new URLSearchParams(rawQuery);
      const send = (status: number) => requests.push({ method: req.method ?? '', path: decodeURIComponent(rawPath), query: rawQuery, status });
      const fail = (status: number, code: string) => {
        send(status);
        error(res, status, code);
      };
      const presigned = params.has('X-Amz-Signature');
      const problem = presigned ? verifyQueryAuth(opts, req, rawPath, rawQuery) : verifyHeaderAuth(opts, req, rawPath, rawQuery, body);
      if (problem) return fail(problem === 'XAmzContentSHA256Mismatch' || problem === 'AuthorizationQueryParametersError' ? 400 : 403, problem);
      const segments = rawPath.split('/').slice(1).map(decodeURIComponent);
      const bucket = segments.shift();
      const key = segments.join('/');
      if (bucket !== opts.bucket) return fail(404, 'NoSuchBucket');
      const denied = (op: NonNullable<FakeS3Options['deny']>[number]) => opts.deny?.includes(op);
      if (!key) {
        if (req.method !== 'GET') return fail(405, 'MethodNotAllowed');
        if (params.has('versioning')) {
          if (denied('versioning')) return fail(403, 'AccessDenied');
          send(200);
          return xml(res, 200, `<VersioningConfiguration>${opts.versioning ? `<Status>${opts.versioning}</Status>` : ''}</VersioningConfiguration>`);
        }
        if (params.has('object-lock')) {
          if (denied('object-lock')) return fail(403, 'AccessDenied');
          if (!opts.objectLock) return fail(404, 'ObjectLockConfigurationNotFoundError');
          const rule = opts.objectLock === 'no-default' ? '' : `<Rule><DefaultRetention><Mode>${opts.objectLock.mode}</Mode><Days>${opts.objectLock.days}</Days></DefaultRetention></Rule>`;
          send(200);
          return xml(res, 200, `<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled>${rule}</ObjectLockConfiguration>`);
        }
        if (params.has('encryption')) {
          if (denied('encryption')) return fail(403, 'AccessDenied');
          if (!opts.encryption) return fail(404, 'ServerSideEncryptionConfigurationNotFoundError');
          send(200);
          return xml(res, 200, `<ServerSideEncryptionConfiguration><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>${opts.encryption}</SSEAlgorithm></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>`);
        }
        if (params.get('list-type') === '2') {
          if (denied('list')) return fail(403, 'AccessDenied');
          const prefix = params.get('prefix') ?? '';
          const after = params.get('continuation-token') ?? '';
          const size = Math.min(Number(params.get('max-keys') ?? 1000), opts.pageSize ?? 1000);
          const all = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
          const page = all.slice(0, size);
          const truncated = all.length > size;
          send(200);
          return xml(
            res,
            200,
            `<ListBucketResult><Name>${opts.bucket}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${page
              .map((k) => `<Contents><Key>${esc(k)}</Key><Size>${objects.get(k)!.body.length}</Size><ETag>${esc(objects.get(k)!.etag)}</ETag><LastModified>${new Date(objects.get(k)!.modified).toISOString()}</LastModified></Contents>`)
              .join('')}${truncated ? `<NextContinuationToken>${esc(page.at(-1)!)}</NextContinuationToken>` : ''}</ListBucketResult>`,
          );
        }
        return fail(400, 'InvalidRequest');
      }
      const existing = objects.get(key);
      switch (req.method) {
        case 'GET':
        case 'HEAD': {
          if (denied('get')) return fail(403, 'AccessDenied');
          if (!existing) return fail(404, 'NoSuchKey');
          send(200);
          res.writeHead(200, { 'content-type': existing.contentType, etag: existing.etag, 'content-length': String(existing.body.length), 'last-modified': new Date(existing.modified).toUTCString() });
          return res.end(req.method === 'GET' ? existing.body : undefined);
        }
        case 'PUT': {
          if (denied('put')) return fail(403, 'AccessDenied');
          const ifMatch = req.headers['if-match'];
          const ifNone = req.headers['if-none-match'];
          if ((ifMatch || ifNone) && opts.noConditional) return fail(501, 'NotImplemented');
          if (ifNone === '*' && existing) return fail(412, 'PreconditionFailed');
          if (ifMatch && (!existing || existing.etag !== ifMatch)) return fail(412, 'PreconditionFailed');
          const md5 = req.headers['content-md5'];
          if (md5 !== undefined && md5 !== createHash('md5').update(body).digest('base64')) return fail(400, 'BadDigest');
          if (md5 === undefined && opts.objectLock && opts.objectLock !== 'no-default') return fail(400, 'InvalidRequest');
          const etag = `"${createHash('md5').update(body).digest('hex')}-${++etagSeq}"`;
          const versionId = opts.versioning === 'Enabled' ? `v${++versionSeq}` : null;
          objects.set(key, { body, etag, contentType: String(req.headers['content-type'] ?? 'application/octet-stream'), modified: opts.now?.() ?? Date.now(), versionId });
          send(200);
          res.writeHead(200, { etag, 'x-amz-server-side-encryption': opts.encryption ?? 'AES256', ...(versionId ? { 'x-amz-version-id': versionId } : {}) });
          return res.end();
        }
        case 'DELETE': {
          if (denied('delete')) return fail(403, 'AccessDenied');
          objects.delete(key);
          send(204);
          res.writeHead(204);
          return res.end();
        }
        default:
          return fail(405, 'MethodNotAllowed');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    objects,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
