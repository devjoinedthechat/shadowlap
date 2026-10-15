import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { noProxyMatches, proxyFetch, proxyFor, send } from '@shadowlap/remote';

/**
 * A company network that reaches the clouds only through a proxy: which requests go through it
 * (HTTPS_PROXY, HTTP_PROXY, NO_PROXY, never this machine or a metadata service), and requests
 * through a proxy in process: plain http as a request to the proxy, https through a CONNECT
 * tunnel to a TLS server with a certificate made for the test, kept open between requests.
 */

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
}

let target: Server;
let secure: TlsServer | null = null;
let ca: Buffer | null = null;
let proxy: Server;
const seen: Seen[] = [];
const dir = mkdtempSync(join(tmpdir(), 'sl-proxy-'));
let refuse = false;
const tunnels = new Set<import('node:net').Socket>();

const port = (s: Server | TlsServer) => (s.address() as AddressInfo).port;

function echo(req: IncomingMessage, res: import('node:http').ServerResponse, scheme: string): void {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    if (req.url === '/missing') {
      res.writeHead(404, { 'x-amz-error': 'NoSuchKey' });
      res.end('<Error><Code>NoSuchKey</Code></Error>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'x-scheme': scheme, 'set-cookie': ['a=1', 'b=2'] });
    res.end(`${scheme} ${req.method} ${req.url} ${req.headers['content-length'] ?? '-'} ${body}`);
  });
}

beforeAll(async () => {
  target = createServer((req, res) => echo(req, res, 'http'));
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '2', '-nodes', '-subj', '/CN=bucket.example', '-addext', 'subjectAltName=DNS:bucket.example'], { stdio: 'ignore' });
    ca = readFileSync(join(dir, 'cert.pem'));
    secure = createTlsServer({ key: readFileSync(join(dir, 'key.pem')), cert: ca }, (req, res) => echo(req, res, 'https'));
    await new Promise<void>((r) => secure!.listen(0, '127.0.0.1', r));
  } catch {
    secure = null; // no openssl here: the tunnel test is skipped
  }
  // The proxy forwards everything to this machine's servers, whatever host a request names, so the
  // tests can use names that resolve nowhere: only the proxy would need DNS.
  proxy = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers['proxy-authorization'] });
    const up = request({ host: '127.0.0.1', port: port(target), method: req.method, path: new URL(req.url ?? '/').pathname + new URL(req.url ?? '/').search, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    req.pipe(up);
  });
  proxy.on('connect', (req: IncomingMessage, socket: import('node:net').Socket, head: Buffer) => {
    seen.push({ method: 'CONNECT', url: req.url ?? '', auth: req.headers['proxy-authorization'] });
    if (refuse || !secure) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    tunnels.add(socket);
    const up = connect(port(secure), '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
});

afterAll(async () => {
  // Kept-alive connections and open tunnels would hold the servers open until they idle out.
  for (const s of tunnels) s.destroy();
  for (const s of [proxy, target, secure]) s?.closeAllConnections();
  await new Promise((r) => proxy.close(r));
  await new Promise((r) => target.close(r));
  if (secure) await new Promise((r) => secure!.close(r));
  rmSync(dir, { recursive: true, force: true });
});

describe('which requests go through a proxy', () => {
  it('reads HTTPS_PROXY, falls back to HTTP_PROXY, and keeps this machine and metadata services off it', () => {
    const env = { HTTPS_PROXY: 'http://proxy.corp:3128', HTTP_PROXY: 'http://plain.corp:8080' };
    expect(proxyFor('https://s3.eu-central-1.amazonaws.com/b', env)?.href).toBe('http://proxy.corp:3128/');
    expect(proxyFor('http://minio.internal:9000/b', env)?.href).toBe('http://plain.corp:8080/');
    expect(proxyFor('https://storage.googleapis.com/x', { http_proxy: 'plain.corp:8080' })?.href).toBe('http://plain.corp:8080/');
    expect(proxyFor('https://storage.googleapis.com/x', {})).toBeNull();
    for (const local of ['http://127.0.0.1:9000/b', 'http://localhost:10000/devstoreaccount1', 'http://[::1]:9000/', 'http://169.254.169.254/latest/api/token', 'http://169.254.170.2/v2/credentials', 'http://metadata.google.internal/computeMetadata/v1/']) {
      expect(proxyFor(local, env)).toBeNull();
    }
    expect(proxyFor('https://s3.amazonaws.com/', { HTTPS_PROXY: 'socks5://proxy.corp:1080' })).toBeNull();
  });

  it('skips the hosts NO_PROXY lists, as curl reads it', () => {
    const env = { HTTPS_PROXY: 'http://proxy.corp:3128', NO_PROXY: '.internal, blob.core.windows.net,10.0.0.7 storage.googleapis.com:8443' };
    expect(proxyFor('https://minio.internal/b', env)).toBeNull();
    expect(proxyFor('https://northwindruns.blob.core.windows.net/c', env)).toBeNull();
    expect(proxyFor('https://blob.core.windows.net/c', env)).toBeNull();
    expect(proxyFor('https://10.0.0.7/b', env)).toBeNull();
    expect(proxyFor('https://storage.googleapis.com/x', env)).not.toBeNull(); // only :8443 is listed
    expect(proxyFor('https://storage.googleapis.com:8443/x', env)).toBeNull();
    expect(proxyFor('https://s3.amazonaws.com/', { ...env, no_proxy: '*', NO_PROXY: undefined })).toBeNull();
    expect(noProxyMatches('*.example.com', 'a.example.com', '443')).toBe(true);
    expect(noProxyMatches('example.com', 'notexample.com', '443')).toBe(false);
  });
});

describe('a request through a proxy', () => {
  it('sends plain http to the proxy, body and credentials included', async () => {
    seen.length = 0;
    const viaProxy = proxyFetch(new URL(`http://dana:s%40cret@127.0.0.1:${port(proxy)}`));
    const put = await viaProxy('http://minio.example:9000/bucket/key?x=1', { method: 'PUT', headers: { 'content-type': 'application/gzip' }, body: new Uint8Array(Buffer.from('hello')) });
    expect(put.status).toBe(200);
    expect(await put.text()).toBe('http PUT /bucket/key?x=1 5 hello');
    expect(put.headers.get('x-scheme')).toBe('http');
    expect(seen).toEqual([{ method: 'PUT', url: 'http://minio.example:9000/bucket/key?x=1', auth: `Basic ${Buffer.from('dana:s@cret').toString('base64')}` }]);
    const head = await viaProxy('http://minio.example:9000/bucket/key', { method: 'HEAD', headers: {} });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const missing = await viaProxy('http://minio.example:9000/missing', { method: 'GET', headers: {} });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-amz-error')).toBe('NoSuchKey');
  });

  it('tunnels https with TLS end to end, one tunnel for several requests', async (ctx) => {
    if (!secure || !ca) return ctx.skip(); // no openssl to make the test's certificate
    seen.length = 0;
    const viaProxy = proxyFetch(new URL(`http://127.0.0.1:${port(proxy)}`), { ca });
    for (const n of [1, 2, 3]) {
      const res = await viaProxy(`https://bucket.example/object-${n}`, { method: 'GET', headers: {} });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(`https GET /object-${n} - `);
    }
    expect(seen).toEqual([{ method: 'CONNECT', url: 'bucket.example:443', auth: undefined }]);
    // A certificate that isn't the host's is refused, proxy or not.
    const untrusted = proxyFetch(new URL(`http://127.0.0.1:${port(proxy)}`));
    await expect(untrusted('https://bucket.example/x', { method: 'GET', headers: {} })).rejects.toMatchObject({ cause: expect.objectContaining({ code: expect.stringMatching(/SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/) }) });
  });

  it('says when the proxy refuses the tunnel, and that it may want credentials', async () => {
    refuse = true;
    try {
      const viaProxy = proxyFetch(new URL(`http://127.0.0.1:${port(proxy)}`));
      await expect(viaProxy('https://bucket.example/x', { method: 'GET', headers: {} })).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/refused to open a tunnel to bucket\.example:443 \(407: it wants credentials/) }) });
    } finally {
      refuse = false;
    }
  });

  it('is what the drivers use when the environment names a proxy', async () => {
    seen.length = 0;
    const before = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = `http://127.0.0.1:${port(proxy)}`;
    try {
      const res = await send({ method: 'GET', url: 'http://minio.example:9000/bucket/through' }, { attempts: 1 });
      expect(res.status).toBe(200);
      expect(res.body.toString()).toBe('http GET /bucket/through - ');
      expect(seen.map((s) => s.url)).toEqual(['http://minio.example:9000/bucket/through']);
    } finally {
      if (before === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = before;
    }
  });
});
