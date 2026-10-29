import { Agent as HttpAgent, request as httpRequest, type ClientRequestArgs, type IncomingMessage, type OutgoingHttpHeaders, type RequestOptions } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest, type AgentOptions } from 'node:https';
import { isIP, type Socket } from 'node:net';
import { Readable, type Duplex } from 'node:stream';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import type { FetchLike } from './http.js';

/**
 * A company network that reaches the internet only through a proxy: the proxy named by
 * HTTPS_PROXY (or HTTP_PROXY) and bypassed for the hosts NO_PROXY lists, as curl, the clouds' own
 * CLIs and Node's fetch with NODE_USE_ENV_PROXY read them. Node's fetch ignores these variables on
 * the Node versions Shadowlap supports, so requests that should go through a proxy go through this
 * client instead: https through a tunnel (CONNECT) with TLS end to end, plain http as a request to
 * the proxy. This machine (loopback) and the link-local metadata services never go through one.
 */

export interface ProxyEnv {
  HTTPS_PROXY?: string | undefined;
  https_proxy?: string | undefined;
  HTTP_PROXY?: string | undefined;
  http_proxy?: string | undefined;
  NO_PROXY?: string | undefined;
  no_proxy?: string | undefined;
}

const METADATA_HOSTS = new Set(['169.254.169.254', '169.254.170.2', '169.254.170.23', 'fd00:ec2::254', 'fd00:ec2::23', 'metadata.google.internal', 'metadata']);

function bare(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Whether NO_PROXY keeps a request to this host and port off the proxy. */
export function noProxyMatches(noProxy: string, host: string, port: string): boolean {
  for (const raw of noProxy.split(/[\s,]+/)) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    let entryPort: string | null = null;
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(entry);
    if (m) {
      entry = m[1]!;
      entryPort = m[2]!;
    }
    entry = bare(entry);
    if (entryPort !== null && entryPort !== port) continue;
    if (entry.startsWith('*.')) entry = entry.slice(1);
    if (entry.startsWith('.')) {
      if (host.endsWith(entry) || host === entry.slice(1)) return true;
    } else if (host === entry || (!isIP(entry) && host.endsWith(`.${entry}`))) {
      return true;
    }
  }
  return false;
}

/** The proxy a request to this URL goes through, or null for a direct one. */
export function proxyFor(url: string, env: ProxyEnv = process.env): URL | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  const host = bare(target.hostname);
  if (isLoopback(host) || METADATA_HOSTS.has(host) || host.startsWith('169.254.')) return null;
  const http = env.HTTP_PROXY || env.http_proxy;
  const raw = target.protocol === 'https:' ? env.HTTPS_PROXY || env.https_proxy || http : target.protocol === 'http:' ? http : undefined;
  if (!raw) return null;
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  if (noProxyMatches(env.NO_PROXY ?? env.no_proxy ?? '', host, port)) return null;
  try {
    const proxy = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    return proxy.protocol === 'http:' || proxy.protocol === 'https:' ? proxy : null;
  } catch {
    return null;
  }
}

function proxyAuthorization(proxy: URL): string | null {
  if (!proxy.username) return null;
  return `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
}

function proxyPort(proxy: URL): number {
  return Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
}

/**
 * A tunnel to host:port through the proxy: the socket once the proxy answered CONNECT with 200. An
 * https proxy is checked against the system's CAs.
 */
function openTunnel(proxy: URL, host: string, port: number): Promise<Socket> {
  const authority = `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
  const auth = proxyAuthorization(proxy);
  return new Promise((resolve, reject) => {
    const options: RequestOptions = { host: bare(proxy.hostname), port: proxyPort(proxy), method: 'CONNECT', path: authority, headers: { host: authority, ...(auth ? { 'proxy-authorization': auth } : {}) }, agent: false, timeout: 30_000 };
    const req = proxy.protocol === 'https:' ? httpsRequest(options) : httpRequest(options);
    req.once('connect', (res: IncomingMessage, socket: Socket, head: Buffer) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(Object.assign(new Error(`the proxy ${proxy.host} refused to open a tunnel to ${authority} (${res.statusCode!}${res.statusCode === 407 ? ': it wants credentials, given in the proxy URL as http://user:password@host' : ''})`), { code: 'EPROXY' }));
        return;
      }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    req.once('timeout', () => req.destroy(Object.assign(new Error(`the proxy ${proxy.host} didn't answer`), { code: 'ETIMEDOUT' })));
    req.once('error', reject);
    req.end();
  });
}

/** An https agent whose connections are tunnels through the proxy, kept open between requests. */
class TunnelAgent extends HttpsAgent {
  constructor(
    private readonly proxy: URL,
    private readonly tls: ConnectionOptions,
    options: AgentOptions,
  ) {
    super(options);
  }

  // The base Agent waits for the callback when this returns nothing: the tunnel takes a round trip.
  override createConnection(options: ClientRequestArgs, callback?: (err: Error | null, stream: Duplex) => void): Duplex | null | undefined {
    const host = bare(String(options.host ?? options.hostname ?? 'localhost'));
    const port = Number(options.port) || 443;
    openTunnel(this.proxy, host, port).then(
      (socket) => {
        const secure = tlsConnect({ ...(options as ConnectionOptions), ...this.tls, socket, ...(isIP(host) ? {} : { servername: host }) });
        callback?.(null, secure);
      },
      (err: unknown) => callback?.(err instanceof Error ? err : new Error(String(err)), undefined as unknown as Duplex),
    );
    return undefined;
  }
}

function headerRecord(init: RequestInit['headers']): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  new Headers(init ?? {}).forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

function toResponse(res: IncomingMessage, method: string): Response {
  const status = res.statusCode ?? 502;
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const empty = method === 'HEAD' || status === 204 || status === 304;
  if (empty) res.resume();
  return new Response(empty ? null : (Readable.toWeb(res)), { status, headers });
}

/**
 * A fetch through a proxy, for the drivers' requests: method, headers, a whole body, and an abort
 * signal that ends the request and its answer. Redirects are never followed, as the drivers ask.
 * `tls` is for tests (a CA to trust); otherwise the system's CAs, NODE_EXTRA_CA_CERTS included.
 */
export function proxyFetch(proxy: URL, tls: ConnectionOptions = {}): FetchLike {
  const tunnels = new TunnelAgent(proxy, tls, { keepAlive: true, maxSockets: 16, timeout: 60_000 });
  const plain = new HttpAgent({ keepAlive: true, maxSockets: 16, timeout: 60_000 });
  const auth = proxyAuthorization(proxy);
  return (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const target = new URL(input);
      const method = (init.method ?? 'GET').toUpperCase();
      const headers = headerRecord(init.headers);
      const body = init.body === undefined || init.body === null ? null : Buffer.from(init.body as Uint8Array);
      if (body && headers['content-length'] === undefined) headers['content-length'] = String(body.length);
      const options: RequestOptions =
        target.protocol === 'https:'
          ? { host: bare(target.hostname), port: Number(target.port) || 443, method, path: `${target.pathname}${target.search}`, headers: { ...headers, host: target.host }, agent: tunnels }
          : { host: bare(proxy.hostname), port: proxyPort(proxy), method, path: target.href, headers: { ...headers, host: target.host, ...(auth ? { 'proxy-authorization': auth } : {}) }, agent: plain };
      const req = (target.protocol === 'https:' ? httpsRequest : httpRequest)(options, (res) => resolve(toResponse(res, method)));
      const signal = init.signal;
      const onAbort = () => req.destroy(Object.assign(new Error('the request was aborted'), { name: 'AbortError' }));
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      req.once('error', (err) => reject(Object.assign(new TypeError('fetch failed'), { cause: err })));
      req.end(body ?? undefined);
    });
}
