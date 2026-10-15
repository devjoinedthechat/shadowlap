import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * An Azure Blob REST subset in process, addressed like Azurite (the account in the path): Put Blob
 * (with If-Match and If-None-Match), Get Blob, Get Blob Properties, Delete Blob, List Blobs with a
 * marker, Get User Delegation Key, and reads through SAS URLs. It checks Shared Key signatures,
 * service SAS and user delegation SAS signatures with string-to-sign code of its own, written from
 * the REST reference, so the driver is checked against a second implementation; and bearer tokens
 * it was given.
 */

export interface FakeAzureOptions {
  account: string;
  /** The account key, base64. */
  key: string;
  container: string;
  /** Bearer tokens accepted (an Entra sign-in). */
  tokens?: string[];
  versioning?: boolean;
  pageSize?: number;
  now?: () => number;
  /** The Entra sign-in may get a user delegation key (a role with generateUserDelegationKey on the account). Default true. */
  delegator?: boolean;
  /** The container's immutability, as Get Container Properties reports it. */
  immutability?: { versionLevel?: boolean; policy?: boolean; legalHold?: boolean };
}

export interface FakeAzure {
  /** The blob endpoint: http://127.0.0.1:port/<account>. */
  endpoint: string;
  blobs: Map<string, { body: Buffer; etag: string; contentType: string; modified: number }>;
  requests: Array<{ method: string; path: string; status: number; auth: 'key' | 'sas' | 'bearer' | 'none' }>;
  /** A container SAS (sr=c) with the given permissions, signed with the account key, as `az storage container generate-sas` makes one. */
  containerSas(permissions: string, expiresAt: number): string;
  close(): Promise<void>;
}

const VERSION = '2021-08-06';

function xml(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/xml', ...headers });
  res.end(body);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Shared Key, Blob service, versions 2015-02-21 and later: the string to sign, from the REST reference. */
function sharedKeyString(req: IncomingMessage, account: string, rawPath: string, params: URLSearchParams): string {
  const h = (name: string) => {
    const v = req.headers[name];
    return v === undefined ? '' : Array.isArray(v) ? v.join(',') : v;
  };
  const length = h('content-length');
  const standard = [
    req.method ?? '',
    h('content-encoding'),
    h('content-language'),
    length === '0' ? '' : length,
    h('content-md5'),
    h('content-type'),
    h('date'),
    h('if-modified-since'),
    h('if-match'),
    h('if-none-match'),
    h('if-unmodified-since'),
    h('range'),
  ];
  const ms = Object.keys(req.headers)
    .filter((k) => k.startsWith('x-ms-'))
    .sort()
    .map((k) => `${k}:${h(k).trim()}\n`)
    .join('');
  const grouped = new Map<string, string[]>();
  for (const [k, v] of params) grouped.set(k.toLowerCase(), [...(grouped.get(k.toLowerCase()) ?? []), v]);
  let resource = `/${account}${rawPath}`;
  for (const k of [...grouped.keys()].sort()) resource += `\n${k}:${grouped.get(k)!.sort().join(',')}`;
  return `${standard.join('\n')}\n${ms}${resource}`;
}

interface DelegationKey {
  oid: string;
  tid: string;
  start: string;
  expiry: string;
  value: Buffer;
}

/** Service SAS (sv 2020-12-06+) or user delegation SAS: the signature it should carry. */
function sasSignature(params: URLSearchParams, account: string, resourcePath: string, key: Buffer, delegation: DelegationKey | null): string {
  const g = (k: string) => params.get(k) ?? '';
  const resource = `/blob/${account}${resourcePath}`;
  const fields = delegation
    ? [g('sp'), g('st'), g('se'), resource, g('skoid'), g('sktid'), g('skt'), g('ske'), g('sks'), g('skv'), g('saoid'), g('suoid'), g('scid'), g('sip'), g('spr'), g('sv'), g('sr'), g('sst'), g('ses'), g('rscc'), g('rscd'), g('rsce'), g('rscl'), g('rsct')]
    : [g('sp'), g('st'), g('se'), resource, g('si'), g('sip'), g('spr'), g('sv'), g('sr'), g('sst'), g('ses'), g('rscc'), g('rscd'), g('rsce'), g('rscl'), g('rsct')];
  return createHmac('sha256', delegation ? delegation.value : key).update(fields.join('\n'), 'utf8').digest('base64');
}

export async function startFakeAzure(opts: FakeAzureOptions): Promise<FakeAzure> {
  const blobs: FakeAzure['blobs'] = new Map();
  const requests: FakeAzure['requests'] = [];
  const accountKey = Buffer.from(opts.key, 'base64');
  const delegations: DelegationKey[] = [];
  let seq = 0;
  let versionSeq = 0;
  const now = () => opts.now?.() ?? Date.now();
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const raw = req.url ?? '/';
      const q = raw.indexOf('?');
      const rawPath = q < 0 ? raw : raw.slice(0, q);
      const params = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));
      let auth: FakeAzure['requests'][number]['auth'] = 'none';
      const fail = (status: number, code: string, message = code) => {
        requests.push({ method: req.method ?? '', path: decodeURIComponent(rawPath), status, auth });
        xml(res, status, `<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>${esc(message)}\nRequestId:fake</Message></Error>`, { 'x-ms-error-code': code });
      };
      const ok = (status: number) => requests.push({ method: req.method ?? '', path: decodeURIComponent(rawPath), status, auth });

      // /<account>/<container>/<blob…>, or /<account>/ for the service.
      const segments = rawPath.split('/').slice(1);
      if (decodeURIComponent(segments[0] ?? '') !== opts.account) return fail(400, 'InvalidUri');
      const path = `/${segments.slice(1).join('/')}`;
      const container = decodeURIComponent(segments[1] ?? '');
      const name = segments.slice(2).map(decodeURIComponent).join('/');

      const header = req.headers.authorization ?? '';
      if (params.has('sig')) {
        auth = 'sas';
        const delegation = params.has('skoid') ? (delegations.find((d) => d.oid === params.get('skoid') && d.start === params.get('skt')) ?? null) : null;
        const resourcePath = params.get('sr') === 'c' ? `/${container}` : `/${container}/${name}`;
        const expected = sasSignature(params, opts.account, resourcePath, accountKey, delegation);
        const expiry = Date.parse(params.get('se') ?? '');
        const start = params.get('st') ? Date.parse(params.get('st')!) : 0;
        if (params.has('skoid') && !delegation) return fail(403, 'AuthenticationFailed', 'unknown delegation key');
        if (params.get('sig') !== expected) return fail(403, 'AuthenticationFailed', 'Signature did not match');
        if (!(now() >= start && now() <= expiry)) return fail(403, 'AuthenticationFailed', 'Signed expiry time has passed');
        const allowed = params.get('sp') ?? '';
        const need = req.method === 'GET' || req.method === 'HEAD' ? (params.get('comp') === 'list' ? 'l' : 'r') : req.method === 'PUT' ? 'w' : req.method === 'DELETE' ? 'd' : '?';
        if (!allowed.includes(need)) return fail(403, 'AuthorizationPermissionMismatch');
      } else if (header.startsWith('SharedKey ')) {
        auth = 'key';
        const [account, signature] = header.slice('SharedKey '.length).split(':');
        const expected = createHmac('sha256', accountKey).update(sharedKeyString(req, opts.account, rawPath, params), 'utf8').digest('base64');
        if (account !== opts.account || signature !== expected) return fail(403, 'AuthenticationFailed', 'The MAC signature found in the HTTP request is not the same as any computed signature.');
      } else if (header.startsWith('Bearer ')) {
        auth = 'bearer';
        if (!(opts.tokens ?? []).includes(header.slice(7))) return fail(401, 'InvalidAuthenticationInfo', 'Server failed to authenticate the request.');
      } else {
        return fail(403, 'NoAuthenticationInformation');
      }
      if (auth !== 'sas' && req.headers['x-ms-version'] !== VERSION) return fail(400, 'InvalidHeaderValue', 'x-ms-version');

      // Get User Delegation Key: POST /<account>/?restype=service&comp=userdelegationkey
      if (path === '/' && req.method === 'POST' && params.get('comp') === 'userdelegationkey') {
        if (auth !== 'bearer') return fail(403, 'AuthenticationFailed', 'A user delegation key needs an Entra token');
        // The action is granted per storage account: a role on the container alone doesn't carry it.
        if (opts.delegator === false) return fail(403, 'AuthorizationPermissionMismatch', 'This request is not authorized to perform this operation using this permission.');
        const text = body.toString('utf8');
        const start = /<Start>(.*?)<\/Start>/.exec(text)?.[1] ?? iso(now());
        const expiry = /<Expiry>(.*?)<\/Expiry>/.exec(text)?.[1] ?? iso(now() + 3600_000);
        // As Azure does, by its own clock: a key ends within 7 days.
        if (Date.parse(expiry) > now() + 7 * 86_400_000) return fail(400, 'InvalidXmlNodeValue', 'The value for one of the XML nodes is not in the correct format.');
        const d: DelegationKey = { oid: `oid-${++seq}`, tid: 'tenant-1', start, expiry, value: randomBytes(32) };
        delegations.push(d);
        ok(200);
        return xml(
          res,
          200,
          `<?xml version="1.0" encoding="utf-8"?><UserDelegationKey><SignedOid>${d.oid}</SignedOid><SignedTid>${d.tid}</SignedTid><SignedStart>${d.start}</SignedStart><SignedExpiry>${d.expiry}</SignedExpiry><SignedService>b</SignedService><SignedVersion>${VERSION}</SignedVersion><Value>${d.value.toString('base64')}</Value></UserDelegationKey>`,
        );
      }

      if (container !== opts.container) return fail(404, 'ContainerNotFound', 'The specified container does not exist.');

      if (!name && req.method === 'GET' && params.get('restype') === 'container' && params.get('comp') === 'list') {
        const prefix = params.get('prefix') ?? '';
        const after = params.get('marker') ?? '';
        const size = Math.min(Number(params.get('maxresults') ?? 5000), opts.pageSize ?? 5000);
        const all = [...blobs.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
        const page = all.slice(0, size);
        ok(200);
        return xml(
          res,
          200,
          `<?xml version="1.0" encoding="utf-8"?><EnumerationResults ServiceEndpoint="http://fake/" ContainerName="${opts.container}"><Prefix>${esc(prefix)}</Prefix><Blobs>${page
            .map((k) => {
              const b = blobs.get(k)!;
              return `<Blob><Name>${esc(k)}</Name><Properties><Last-Modified>${new Date(b.modified).toUTCString()}</Last-Modified><Etag>${b.etag}</Etag><Content-Length>${b.body.length}</Content-Length><BlobType>BlockBlob</BlobType></Properties></Blob>`;
            })
            .join('')}</Blobs><NextMarker>${all.length > size ? esc(page.at(-1)!) : ''}</NextMarker></EnumerationResults>`,
        );
      }
      if (!name && req.method === 'GET' && params.get('restype') === 'container' && !params.has('comp')) {
        const im = opts.immutability ?? {};
        ok(200);
        res.writeHead(200, {
          etag: '"0xCONTAINER"',
          'x-ms-has-immutability-policy': String(!!im.policy),
          'x-ms-has-legal-hold': String(!!im.legalHold),
          'x-ms-immutable-storage-with-versioning-enabled': String(!!im.versionLevel),
        });
        return res.end();
      }
      if (!name) return fail(400, 'InvalidQueryParameterValue');

      const existing = blobs.get(name);
      switch (req.method) {
        case 'PUT': {
          if (req.headers['x-ms-blob-type'] !== 'BlockBlob') return fail(400, 'MissingRequiredHeader', 'x-ms-blob-type');
          if (req.headers['if-none-match'] === '*' && existing) return fail(409, 'BlobAlreadyExists', 'The specified blob already exists.');
          if (req.headers['if-match'] && existing?.etag !== req.headers['if-match']) return fail(412, 'ConditionNotMet', 'The condition specified using HTTP conditional header(s) is not met.');
          const etag = `"0x${createHash('md5').update(body).digest('hex').slice(0, 12).toUpperCase()}${++seq}"`;
          blobs.set(name, { body, etag, contentType: String(req.headers['content-type'] ?? 'application/octet-stream'), modified: now() });
          ok(201);
          res.writeHead(201, { etag, 'x-ms-request-server-encrypted': 'true', ...(opts.versioning ? { 'x-ms-version-id': `2026-10-15T10:00:00.${String(++versionSeq).padStart(7, '0')}Z` } : {}) });
          return res.end();
        }
        case 'GET':
        case 'HEAD': {
          if (!existing) return fail(404, 'BlobNotFound', 'The specified blob does not exist.');
          ok(200);
          res.writeHead(200, { 'content-type': existing.contentType, etag: existing.etag, 'content-length': String(existing.body.length), 'last-modified': new Date(existing.modified).toUTCString() });
          return res.end(req.method === 'GET' ? existing.body : undefined);
        }
        case 'DELETE': {
          if (!existing) return fail(404, 'BlobNotFound', 'The specified blob does not exist.');
          blobs.delete(name);
          ok(202);
          res.writeHead(202);
          return res.end();
        }
        default:
          return fail(405, 'UnsupportedHttpVerb');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    endpoint: `http://127.0.0.1:${port}/${opts.account}`,
    blobs,
    requests,
    containerSas(permissions, expiresAt) {
      const p = new URLSearchParams({ sv: VERSION, se: iso(expiresAt), sr: 'c', sp: permissions, spr: 'https,http' });
      p.set('sig', sasSignature(p, opts.account, `/${opts.container}`, accountKey, null));
      return p.toString();
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
