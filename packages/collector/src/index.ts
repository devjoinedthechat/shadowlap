import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MAX_BODY_BYTES, ValidationError, validateBatch } from './schema.js';
import { renderDashboard } from './dashboard.js';
import { CollectorStore, type Stats } from './store.js';

export { validateBatch, validateEvent, ValidationError } from './schema.js';
export type { ValidBatch, ValidEvent } from './schema.js';
export { CollectorStore } from './store.js';
export type { Stats } from './store.js';
export { formatCount, renderDashboard } from './dashboard.js';
export type { DashboardOptions } from './dashboard.js';

export interface CollectorOptions {
  port?: number;
  host?: string;
  /** SQLite path, or ':memory:'. */
  db: string;
  /** Requests per minute per client address before 429. */
  rateLimitPerMinute?: number;
  /** How long aggregates are reused between requests; ingesting a batch always refreshes them. */
  statsCacheMs?: number;
  /** Public origin for the dashboard's empty state; otherwise taken from the request. */
  publicOrigin?: string;
  log?: (line: string) => void;
}

export interface Collector {
  url: string;
  store: CollectorStore;
  close(): Promise<void>;
}

class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly perMinute: number) {}
  allow(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= this.perMinute) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.hits.clear(); // crude memory bound
    return true;
  }
}

/** Reads up to `limit` bytes. Over the limit the body is drained (so a 413 can still be answered) up to a hard cap, then the socket is dropped. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const hardCap = limit * 16;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > hardCap) {
        req.destroy();
        resolve(null);
        return;
      }
      if (size > limit) oversized = true;
      else chunks.push(c);
    });
    req.on('end', () => resolve(oversized ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: string, type = 'application/json', headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': type, 'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store', ...headers });
  res.end(body);
}

/** The dashboard runs no scripts; the policy says so to the browser, too. */
const DASHBOARD_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'cache-control': 'public, max-age=60',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export async function startCollector(opts: CollectorOptions): Promise<Collector> {
  const store = new CollectorStore(opts.db);
  const limiter = new RateLimiter(opts.rateLimitPerMinute ?? 60);
  const log = opts.log ?? (() => {});
  const cacheMs = opts.statsCacheMs ?? 60_000;
  let cached: { at: number; stats: Stats } | null = null;
  const stats = (): Stats => {
    const now = Date.now();
    if (!cached || now - cached.at >= cacheMs) cached = { at: now, stats: store.stats(now) };
    return cached.stats;
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://collector');
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, '{"ok":true}');
      if (req.method === 'GET' && url.pathname === '/v1/stats') return send(res, 200, JSON.stringify(stats()), 'application/json', { 'cache-control': 'public, max-age=60', 'access-control-allow-origin': '*' });
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0]!.trim();
        const origin = opts.publicOrigin ?? (req.headers.host ? `${proto}://${req.headers.host}` : undefined);
        return send(res, 200, renderDashboard(stats(), origin ? { origin } : {}), 'text/html; charset=utf-8', DASHBOARD_HEADERS);
      }
      if (req.method === 'POST' && url.pathname === '/v1/events') {
        const client = req.socket.remoteAddress ?? 'unknown';
        if (!limiter.allow(client)) return send(res, 429, '{"error":"rate limited"}');
        if (!(req.headers['content-type'] ?? '').includes('application/json')) return send(res, 415, '{"error":"send application/json"}');
        const body = await readBody(req, MAX_BODY_BYTES);
        if (body === null) return send(res, 413, '{"error":"body too large"}');
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          return send(res, 400, '{"error":"invalid JSON"}');
        }
        try {
          const n = store.ingest(validateBatch(parsed));
          cached = null;
          return send(res, 202, JSON.stringify({ accepted: n }));
        } catch (err) {
          if (err instanceof ValidationError) return send(res, 400, JSON.stringify({ error: err.message }));
          throw err;
        }
      }
      return send(res, 404, '{"error":"not found"}');
    })().catch((err: unknown) => {
      log(`error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) send(res, 500, '{"error":"internal"}');
      else res.destroy();
    });
  });
  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
    store,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          store.close();
          resolve();
        });
        server.closeAllConnections?.();
      }),
  };
}
