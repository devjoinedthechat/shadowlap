import { createHash, createPublicKey, createVerify, randomBytes, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * A Cloud Storage JSON API subset in process: media upload (with ifGenerationMatch), media and
 * metadata reads, delete, listing page by page, the bucket's versioning and encryption, V4 signed
 * URLs (GOOG4-RSA-SHA256, checked against the service account's public key), and an OAuth token
 * endpoint that checks a service account's signed JWT. Every API request needs a bearer token it
 * issued or was given.
 */

export interface FakeGcsOptions {
  bucket: string;
  /** Bearer tokens accepted as they are (GOOGLE_OAUTH_ACCESS_TOKEN). */
  tokens?: string[];
  /** Service accounts whose JWTs the token endpoint accepts: email → public key PEM. */
  serviceAccounts?: Record<string, string>;
  versioning?: boolean;
  kmsKeyName?: string | null;
  /** Soft delete's retention, in seconds (Cloud Storage's default is 7 days; 0 turns it off). */
  softDeleteSeconds?: number;
  /** A retention policy (Bucket Lock), in seconds. */
  retentionSeconds?: number;
  /** Answer 403 to these. */
  deny?: Array<'get' | 'put' | 'delete' | 'list' | 'bucket'>;
  pageSize?: number;
  now?: () => number;
}

export interface FakeGcs {
  url: string;
  objects: Map<string, { body: Buffer; generation: number; contentType: string; updated: number }>;
  requests: Array<{ method: string; path: string; status: number }>;
  close(): Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function gcsError(res: ServerResponse, status: number, message: string): void {
  json(res, status, { error: { code: status, message, errors: [{ message, domain: 'global', reason: status === 404 ? 'notFound' : status === 412 ? 'conditionNotMet' : 'forbidden' }] } });
}

/** RFC 3986 encoding, written here rather than borrowed from the code under test. */
function enc(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function verifyJwt(assertion: string, accounts: Record<string, string>, now: number): string | null {
  const [h, c, sig] = assertion.split('.');
  if (!h || !c || !sig) return null;
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as { iss?: string; scope?: string; aud?: string; exp?: number; iat?: number };
  const pem = accounts[claims.iss ?? ''];
  if (!pem) return null;
  const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(createPublicKey(pem), Buffer.from(sig, 'base64url'));
  if (!ok || !claims.scope?.includes('devstorage') || !claims.exp || claims.exp * 1000 < now) return null;
  return claims.iss!;
}

/** Checks a V4 signed URL the way Cloud Storage does, with its own canonical request. */
function verifySignedUrl(req: IncomingMessage, rawPath: string, params: URLSearchParams, keys: Map<string, KeyObject>, now: number): boolean {
  const credential = params.get('X-Goog-Credential') ?? '';
  const email = credential.split('/')[0]!;
  const key = keys.get(email);
  if (!key || params.get('X-Goog-Algorithm') !== 'GOOG4-RSA-SHA256' || params.get('X-Goog-SignedHeaders') !== 'host') return false;
  const date = params.get('X-Goog-Date') ?? '';
  const signedAt = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
  if (!(now >= signedAt - 60_000 && now <= signedAt + Number(params.get('X-Goog-Expires')) * 1000)) return false;
  const query = [...params.entries()]
    .filter(([k]) => k !== 'X-Goog-Signature')
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = ['GET', rawPath, query, `host:${req.headers.host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['GOOG4-RSA-SHA256', date, credential.split('/').slice(1).join('/'), createHash('sha256').update(canonical).digest('hex')].join('\n');
  return createVerify('RSA-SHA256').update(toSign).verify(key, Buffer.from(params.get('X-Goog-Signature') ?? '', 'hex'));
}

export async function startFakeGcs(opts: FakeGcsOptions): Promise<FakeGcs> {
  const objects: FakeGcs['objects'] = new Map();
  const requests: FakeGcs['requests'] = [];
  const issued = new Set(opts.tokens ?? []);
  const signers = new Map(Object.entries(opts.serviceAccounts ?? {}).map(([email, pem]) => [email, createPublicKey(pem)]));
  let generation = 1000;
  const now = () => opts.now?.() ?? Date.now();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const raw = req.url ?? '/';
      const q = raw.indexOf('?');
      const rawPath = q < 0 ? raw : raw.slice(0, q);
      const params = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));
      const reply = (status: number) => requests.push({ method: req.method ?? '', path: decodeURIComponent(rawPath), status });
      const fail = (status: number, message: string) => {
        reply(status);
        gcsError(res, status, message);
      };

      // The OAuth token endpoint.
      if (rawPath === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(body.toString('utf8'));
        const who = form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer' ? verifyJwt(form.get('assertion') ?? '', opts.serviceAccounts ?? {}, now()) : null;
        if (!who) {
          reply(400);
          return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
        }
        const token = `ya29.${randomBytes(12).toString('hex')}`;
        issued.add(token);
        reply(200);
        return json(res, 200, { access_token: token, expires_in: 3599, token_type: 'Bearer' });
      }

      // A V4 signed URL: GET /<bucket>/<object>?X-Goog-…
      if (params.has('X-Goog-Signature')) {
        const [, bucket, ...rest] = rawPath.split('/');
        const key = rest.map(decodeURIComponent).join('/');
        if (decodeURIComponent(bucket ?? '') !== opts.bucket || !verifySignedUrl(req, rawPath, params, signers, now())) {
          reply(403);
          res.writeHead(403, { 'content-type': 'application/xml' });
          return res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
        }
        const o = objects.get(key);
        if (!o) return fail(404, `No such object: ${opts.bucket}/${key}`);
        reply(200);
        res.writeHead(200, { 'content-type': o.contentType, 'x-goog-generation': String(o.generation) });
        return res.end(o.body);
      }

      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token || !issued.has(token)) return fail(401, 'Invalid Credentials');
      const denied = (op: NonNullable<FakeGcsOptions['deny']>[number]) => opts.deny?.includes(op);

      const upload = /^\/upload\/storage\/v1\/b\/([^/]+)\/o$/.exec(rawPath);
      const object = /^\/storage\/v1\/b\/([^/]+)\/o\/(.+)$/.exec(rawPath);
      const listing = /^\/storage\/v1\/b\/([^/]+)\/o$/.exec(rawPath);
      const bucketGet = /^\/storage\/v1\/b\/([^/]+)$/.exec(rawPath);
      const bucketOf = (m: RegExpExecArray) => decodeURIComponent(m[1]!);
      const m = upload ?? object ?? listing ?? bucketGet;
      if (!m) return fail(404, 'Not Found');
      if (bucketOf(m) !== opts.bucket) return fail(404, 'The specified bucket does not exist.');

      if (upload && req.method === 'POST') {
        if (denied('put')) return fail(403, 'does not have storage.objects.create access');
        if (params.get('uploadType') !== 'media') return fail(400, 'uploadType');
        const name = params.get('name') ?? '';
        const existing = objects.get(name);
        const cond = params.get('ifGenerationMatch');
        if (cond !== null && (cond === '0' ? !!existing : existing?.generation !== Number(cond))) return fail(412, 'At least one of the pre-conditions you specified did not hold.');
        const o = { body, generation: ++generation, contentType: String(req.headers['content-type'] ?? 'application/octet-stream'), updated: now() };
        objects.set(name, o);
        reply(200);
        return json(res, 200, { name, bucket: opts.bucket, size: String(body.length), generation: String(o.generation), ...(opts.kmsKeyName ? { kmsKeyName: opts.kmsKeyName } : {}) });
      }
      if (object) {
        const name = decodeURIComponent(object[2]!);
        const o = objects.get(name);
        if (req.method === 'DELETE') {
          if (denied('delete')) return fail(403, 'does not have storage.objects.delete access');
          if (!o) return fail(404, `No such object: ${opts.bucket}/${name}`);
          objects.delete(name);
          reply(204);
          res.writeHead(204);
          return res.end();
        }
        if (req.method === 'GET') {
          if (denied('get')) return fail(403, 'does not have storage.objects.get access');
          if (!o) {
            reply(404);
            res.writeHead(404, { 'content-type': 'text/plain' });
            return res.end(`No such object: ${opts.bucket}/${name}`);
          }
          reply(200);
          if (params.get('alt') === 'media') {
            res.writeHead(200, { 'content-type': o.contentType, 'x-goog-generation': String(o.generation) });
            return res.end(o.body);
          }
          return json(res, 200, { size: String(o.body.length), generation: String(o.generation), updated: new Date(o.updated).toISOString() });
        }
      }
      if (listing && req.method === 'GET') {
        if (denied('list')) return fail(403, 'does not have storage.objects.list access');
        const prefix = params.get('prefix') ?? '';
        const after = params.get('pageToken') ?? '';
        const size = Math.min(Number(params.get('maxResults') ?? 1000), opts.pageSize ?? 1000);
        const all = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
        const page = all.slice(0, size);
        reply(200);
        return json(res, 200, {
          items: page.map((name) => ({ name, size: String(objects.get(name)!.body.length), generation: String(objects.get(name)!.generation), updated: new Date(objects.get(name)!.updated).toISOString() })),
          ...(all.length > size ? { nextPageToken: page.at(-1) } : {}),
        });
      }
      if (bucketGet && req.method === 'GET') {
        if (denied('bucket')) return fail(403, 'does not have storage.buckets.get access');
        reply(200);
        return json(res, 200, {
          versioning: { enabled: !!opts.versioning },
          ...(opts.kmsKeyName ? { encryption: { defaultKmsKeyName: opts.kmsKeyName } } : {}),
          ...(opts.retentionSeconds ? { retentionPolicy: { retentionPeriod: String(opts.retentionSeconds), isLocked: true } } : {}),
          softDeletePolicy: { retentionDurationSeconds: String(opts.softDeleteSeconds ?? 0) },
        });
      }
      return fail(405, 'Method not allowed');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, objects, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}
