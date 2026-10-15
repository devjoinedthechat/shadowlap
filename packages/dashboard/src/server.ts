import type { ChildProcess } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Normalizer, Price, Store } from '@shadowlap/engine';
import { searchCalls } from '@shadowlap/engine';
import { actionArgs, addNote, callDetail, changeLabels, lineage, compare, listRuns, lookupRun, runDetail } from './api.js';
import { exportHtml, withAncestors } from './static.js';
import { deleteRuns } from './runs-list.js';

/**
 * `shadowlap dashboard`: a local web UI over the store. The server binds to loopback, answers only
 * requests addressed to localhost (DNS rebinding), and serves data only with the session token
 * that `shadowlap dashboard` puts in the URL fragment (never logged, never sent as a Referer).
 * Actions run the CLI itself, as the terminal UI does; the browser names an action, the server
 * builds the command line.
 */

export type SpawnCli = (args: string[]) => ChildProcess;

export interface DashboardOptions {
  store: Store;
  /** Shown in the header. */
  dbPath?: string;
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  token?: string;
  spawnCli?: SpawnCli;
  prices?: Record<string, Price>;
  /**
   * Applied to a run downloaded as one HTML file, as `shadowlap export html` applies the project's
   * rules: a file made to be shared must not carry what the project decided never leaves it.
   */
  redact?: Normalizer[];
  version?: string;
  /** The built UI; defaults to dist/ui next to this module. */
  uiDir?: string;
  log?: (line: string) => void;
}

export interface Dashboard {
  /** Origin, e.g. http://127.0.0.1:4777 */
  url: string;
  /** The URL to open: origin plus the token in the fragment. */
  openUrl: string;
  /** The link that opens a run directly. */
  runUrl(runId: string, callNo?: number): string;
  token: string;
  close(): Promise<void>;
}

interface Job {
  id: string;
  args: string[];
  runId: string;
  opensRun: boolean;
  lines: string[];
  startedAt: number;
  done: boolean;
  code: number | null;
  newRunId: string | null;
  child: ChildProcess;
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const ANSI = /\x1b\[[0-9;]*m/g;
const RUN_LINE = /(?:recording|replaying) run ([0-9A-Z]{26})/;
const MAX_JOB_LINES = 2000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store', ...headers });
  res.end(text);
}

/** JSON with an ETag; answers 304 when the browser already has it. */
function jsonTagged(req: IncomingMessage, res: ServerResponse, body: unknown): void {
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

function readJson(req: IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function startDashboard(opts: DashboardOptions): Promise<Dashboard> {
  const store = opts.store;
  const token = opts.token ?? randomBytes(24).toString('base64url');
  const host = opts.host ?? '127.0.0.1';
  const uiDir = opts.uiDir ?? fileURLToPath(new URL('./ui/', import.meta.url));
  const log = opts.log ?? (() => {});
  const readOptions = opts.prices ? { prices: opts.prices } : {};
  const jobs = new Map<string, Job>();
  let port = 0;

  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  function serveStatic(res: ServerResponse, pathname: string): void {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = normalize(join(uiDir, rel));
    if (!file.startsWith(normalize(uiDir.endsWith(sep) ? uiDir : uiDir + sep)) || !existsSync(file)) {
      // Client-side routes all load the app.
      if (!extname(rel) && existsSync(join(uiDir, 'index.html'))) return serveStatic(res, '/');
      throw new HttpError(404, 'not found');
    }
    const body = readFileSync(file);
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': String(body.length),
      'cache-control': rel === 'index.html' ? 'no-store' : 'no-cache',
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cross-origin-opener-policy': 'same-origin',
    });
    res.end(body);
  }

  function startJob(runId: string, args: string[], opensRun: boolean): Job {
    if (!opts.spawnCli) throw new HttpError(501, 'actions are not available: start the dashboard with shadowlap dashboard');
    const child = opts.spawnCli(args);
    const job: Job = { id: randomBytes(8).toString('hex'), args, runId, opensRun, lines: [], startedAt: Date.now(), done: false, code: null, newRunId: null, child };
    let buffer = '';
    const push = (chunk: Buffer) => {
      buffer += chunk.toString('utf8').replace(ANSI, '');
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const p of parts) {
        const m = RUN_LINE.exec(p);
        if (m) job.newRunId = m[1]!;
        job.lines.push(p);
      }
      if (job.lines.length > MAX_JOB_LINES) job.lines.splice(0, job.lines.length - MAX_JOB_LINES);
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('error', (err) => {
      job.lines.push(`failed to start: ${err.message}`);
      job.done = true;
      job.code = 127;
    });
    child.on('close', (code) => {
      if (buffer) job.lines.push(buffer);
      job.done = true;
      job.code = code;
      log(`job ${job.id} (shadowlap ${args.join(' ')}) exited ${code}`);
    });
    jobs.set(job.id, job);
    // Keep the most recent jobs only.
    if (jobs.size > 50) for (const [id, j] of jobs) if (j.done && jobs.size > 50) jobs.delete(id);
    return job;
  }

  const jobView = (j: Job, after = 0) => ({ id: j.id, args: j.args, runId: j.runId, opensRun: j.opensRun, startedAt: j.startedAt, done: j.done, code: j.code, newRunId: j.newRunId, lines: j.lines.slice(after), total: j.lines.length });

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const given = req.headers['x-shadowlap-token'];
    if (typeof given !== 'string' || !sameToken(given, token)) throw new HttpError(401, 'missing or wrong session token: open the link shadowlap dashboard printed');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && !allowedHosts().has(origin.replace(/^https?:\/\//, ''))) throw new HttpError(403, 'cross-origin request refused');
    }
    const path = url.pathname.slice('/api/'.length).split('/').map(decodeURIComponent);
    const method = req.method ?? 'GET';

    if (method === 'GET' && path[0] === 'meta' && path.length === 1) return json(res, 200, { version: opts.version ?? null, dbPath: opts.dbPath ?? null, actions: !!opts.spawnCli });
    if (method === 'GET' && path[0] === 'runs' && path.length === 1) return jsonTagged(req, res, { runs: listRuns(store, readOptions) });
    if (path[0] === 'runs' && path.length === 2) {
      if (method === 'GET') {
        const d = runDetail(store, path[1]!, readOptions);
        if (!d) throw new HttpError(404, `no run ${path[1]}`);
        return jsonTagged(req, res, d);
      }
      if (method === 'DELETE') {
        // Changes to the store, like actions: only from a dashboard started with them enabled.
        if (!opts.spawnCli) throw new HttpError(403, 'this dashboard is read-only');
        // As the Runs page deletes: the attempts bundled under the run go with it, and a run still
        // recording, or one a replay in progress still serves answers from, is left alone.
        const out = deleteRuns(store, [path[1]!]);
        if ('error' in out) throw new HttpError(400, out.error);
        const skipped = out.skipped[0];
        if (skipped) throw skipped.reason === 'no such run' ? new HttpError(404, `no run ${path[1]}`) : new HttpError(409, `this run can't be deleted now: ${skipped.reason}`);
        return json(res, 200, { deleted: out.done[0], attempts: out.attempts, blobs: out.blobs, bytes: out.bytes });
      }
    }
    if (method === 'GET' && path[0] === 'search' && path.length === 1) {
      const q = (url.searchParams.get('q') ?? '').slice(0, 500);
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 30) || 30));
      return json(res, 200, { hits: searchCalls(store, q, { limit }) });
    }
    if (method === 'POST' && path[0] === 'runs' && (path[2] === 'labels' || path[2] === 'notes') && path.length === 3) {
      // Changes to the store, like actions: only from a dashboard started with them enabled.
      if (!opts.spawnCli) throw new HttpError(403, 'this dashboard is read-only');
      const body = (await readJson(req)) as { add?: unknown; remove?: unknown; callNo?: unknown; text?: unknown };
      const out = path[2] === 'labels' ? changeLabels(store, path[1]!, body.add, body.remove) : addNote(store, path[1]!, body.callNo, body.text);
      if ('error' in out) throw new HttpError(out.status, out.error);
      return json(res, 200, out);
    }
    // A run as one self-contained HTML file, for sharing. Read-only, so a read-only dashboard offers
    // it too. Its ancestors come along so a fork still shows what it parted from, and the project's
    // redaction rules apply, exactly as `shadowlap export html --lineage` does.
    if (method === 'GET' && path[0] === 'runs' && path[2] === 'export' && path.length === 3) {
      const run = lookupRun(store, path[1]!);
      if (!run) throw new HttpError(404, `no run ${path[1]}`);
      const out = exportHtml({ store, runIds: withAncestors(store, run.runId), ...(opts.prices ? { prices: opts.prices } : {}), ...(opts.redact?.length ? { redact: opts.redact } : {}), version: opts.version ?? null, ...(opts.uiDir ? { uiDir: opts.uiDir } : {}) });
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-disposition': `attachment; filename="shadowlap-${run.runId.slice(0, 10).toLowerCase()}.html"`,
        'x-shadowlap-redacted': opts.redact?.length ? 'yes' : 'no',
        'cache-control': 'no-store',
      });
      return void res.end(out.html);
    }
    if (method === 'GET' && path[0] === 'runs' && path[2] === 'lineage' && path.length === 3) {
      const nodes = lineage(store, path[1]!, readOptions);
      if (!nodes) throw new HttpError(404, `no run ${path[1]}`);
      return jsonTagged(req, res, { nodes });
    }
    if (method === 'GET' && path[0] === 'runs' && path[2] === 'calls' && path.length === 4) {
      const n = Number(path[3]);
      const d = Number.isInteger(n) ? callDetail(store, path[1]!, n, readOptions) : null;
      if (!d) throw new HttpError(404, `no call #${path[3]} in run ${path[1]}`);
      return jsonTagged(req, res, d);
    }
    if (method === 'POST' && path[0] === 'runs' && path[2] === 'actions' && path.length === 3) {
      const body = (await readJson(req)) as { key?: unknown; callNo?: unknown; value?: unknown };
      if (typeof body.key !== 'string') throw new HttpError(400, 'key is required');
      const callNo = typeof body.callNo === 'number' ? body.callNo : null;
      const built = actionArgs(store, path[1]!, callNo, body.key, typeof body.value === 'string' ? body.value : undefined);
      if ('error' in built) throw new HttpError(400, built.error);
      const job = startJob(path[1]!, built.args, built.opensRun);
      return json(res, 202, jobView(job));
    }
    if (method === 'GET' && path[0] === 'jobs' && path.length === 2) {
      const job = jobs.get(path[1]!);
      if (!job) throw new HttpError(404, 'no such job');
      return json(res, 200, jobView(job, Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0)));
    }
    if (method === 'GET' && path[0] === 'compare' && path.length === 1) {
      const a = url.searchParams.get('a');
      const b = url.searchParams.get('b');
      if (!a || !b) throw new HttpError(400, 'a and b are required');
      const c = compare(store, a, b);
      if (!c) throw new HttpError(404, 'one of the runs does not exist');
      return jsonTagged(req, res, c);
    }
    throw new HttpError(404, `no endpoint ${method} ${url.pathname}`);
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      // DNS rebinding: a page on some other name that resolves to 127.0.0.1 must not read this.
      if (!allowedHosts().has(String(req.headers.host ?? ''))) throw new HttpError(403, 'this dashboard only answers requests to localhost');
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/api/')) return api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      return serveStatic(res, url.pathname);
    })().catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log(`error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      if (res.headersSent) return res.destroy();
      json(res, status, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      // A taken default port is not fatal: take any free one.
      if (err.code === 'EADDRINUSE' && opts.port !== 0 && opts.port !== undefined) {
        server.off('error', onError);
        server.once('error', reject);
        server.listen(0, host, () => resolve());
        return;
      }
      reject(err);
    };
    server.once('error', onError);
    server.listen(opts.port ?? 0, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  const url = `http://${host === '::1' ? '[::1]' : host}:${port}`;

  return {
    url,
    openUrl: `${url}/#token=${token}`,
    runUrl: (runId, callNo) => `${url}/#token=${token}&open=/run/${runId}${callNo ? `/call/${callNo}` : ''}`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        for (const j of jobs.values()) if (!j.done) j.child.kill('SIGTERM');
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
