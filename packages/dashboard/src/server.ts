import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectError, tildePath, type Normalizer, type Price, type ProjectHost, type Store } from '@shadowlap/engine';
import type { ProjectConfig, RouteContext } from './context.js';
import { HttpError, json, sameToken } from './http.js';
import { JobManager, type JobPlace, type SpawnCli } from './jobs.js';
import { Router, routeRequest } from './router.js';
import { registerRoutes, type RouteModule } from './routes/index.js';
import { UploadStore } from './uploads.js';
import type { ProjectView } from './views.js';

export type { SpawnCli, SpawnCliOptions } from './jobs.js';

/**
 * `shadowlap dashboard`: a local web UI over the store. The server binds to loopback, answers only
 * requests addressed to localhost (DNS rebinding), and serves data only with the session token
 * that `shadowlap dashboard` puts in the URL fragment (never logged, never sent as a Referer).
 * Requests that change something must come from the page itself, and a read-only dashboard refuses
 * them all. Actions run the CLI itself, as the terminal UI does: the browser names a job kind and
 * its fields, the server builds the command line.
 *
 * This file is the HTTP plumbing; the endpoints are registered by feature from `routes/`.
 */

export interface DashboardOptions {
  /** The store it serves. With `projects`, each project's store comes from there instead. */
  store?: Store;
  /**
   * Several projects behind one dashboard, as `shadowlap dashboard` serves them: the project list,
   * which one is current, and each one's store, config and folder (the engine's `ProjectHost`).
   * Every route reads the current project's store and config, and every job runs in its folder,
   * against its store; switching projects swaps them all at once. Without it the dashboard serves
   * `store` and `project` alone.
   */
  projects?: ProjectHost<ProjectConfig>;
  /** Shown in the status bar; its size on disk is reported too. */
  dbPath?: string;
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  token?: string;
  /** Runs the CLI for jobs. Without it the dashboard is read-only, unless `readOnly: false` says otherwise. */
  spawnCli?: SpawnCli;
  prices?: Record<string, Price>;
  /**
   * Applied to a run downloaded as one HTML file, as `shadowlap export html` applies the project's
   * rules: a file made to be shared must not carry what the project decided never leaves it. With
   * `loadConfig`, the config's current rules are used instead.
   */
  redact?: Normalizer[];
  version?: string;
  /** The built UI; defaults to dist/ui next to this module. */
  uiDir?: string;
  log?: (line: string) => void;
  /**
   * Every page shows and nothing changes: actions, labels, notes, uploads and deletes are refused
   * with the reason (`shadowlap dashboard --read-only`). Defaults to true without `spawnCli`.
   */
  readOnly?: boolean;
  /** The project folder: jobs run in it, and uploads and the files jobs report stay inside it. */
  project?: { name?: string; path: string };
  /** Reads the project's shadowlap.config.json, fresh on every call, as the CLI does. */
  loadConfig?: () => ProjectConfig;
  /** The most one upload may hold, in bytes (64 MB). */
  uploadLimit?: number;
  /** How long an upload no job used is kept, in milliseconds (an hour). */
  uploadMaxIdleMs?: number;
  /** How long a stopped job has to end before it is killed, in milliseconds (5 s). */
  jobStopGraceMs?: number;
  /** Route modules registered after the built-in ones in routes/index.ts: for tests, and for embedding the server elsewhere. */
  routes?: RouteModule[];
}

export interface Dashboard {
  /** Origin, e.g. http://127.0.0.1:4777 */
  url: string;
  /** The URL to open: origin plus the token in the fragment. */
  openUrl: string;
  /** The link that opens a run directly. */
  runUrl(runId: string, callNo?: number): string;
  token: string;
  /** Nothing can be changed from this dashboard. */
  readOnly: boolean;
  /**
   * Stops the server. Running jobs are stopped with their agents and waited for (killed after the
   * grace time), then uploads are deleted. `now` kills the running jobs at once: for a second Ctrl-C
   * while a close waits for them. Every call returns the same close.
   */
  close(options?: { now?: boolean }): Promise<void>;
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** What the dashboard serves right now: the current project, its store, and its config. */
interface Current {
  /** The project's id in the list; null for a dashboard that serves one store. */
  id: string | null;
  store: Store;
  dbPath: string | null;
  project: ProjectView | null;
  /** The project's config as the CLI reads it; an HttpError naming the file when it can't be read. */
  config(): ProjectConfig;
}

function readConfig(load: () => ProjectConfig): ProjectConfig {
  try {
    return load();
  } catch (err) {
    throw new HttpError(500, `could not read the project's shadowlap.config.json: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The options as route modules read them, on a dashboard that serves several projects: the store,
 * its path, the project folder and its config are the current project's, read each time, so a
 * module written for one store follows a switch without knowing about projects.
 */
function followingOptions(opts: DashboardOptions, current: () => Current): DashboardOptions {
  const options: DashboardOptions = { ...opts };
  Object.defineProperties(options, {
    store: { get: () => current().store, enumerable: true, configurable: true },
    dbPath: { get: () => current().dbPath ?? undefined, enumerable: true, configurable: true },
    project: { get: () => current().project ?? undefined, enumerable: true, configurable: true },
    loadConfig: { value: () => current().config(), enumerable: true, configurable: true },
    prices: { get: () => pricesOf(current) ?? undefined, enumerable: true, configurable: true },
  });
  return options;
}

/** The current project's price table, from its config; none while the config can't be read (its pages say why). */
function pricesOf(current: () => Current): Record<string, Price> | null {
  try {
    return current().config().prices ?? null;
  } catch {
    return null;
  }
}

export async function startDashboard(opts: DashboardOptions): Promise<Dashboard> {
  const projects = opts.projects ?? null;
  if (!projects && !opts.store) throw new Error('startDashboard needs a store, or projects');
  const token = opts.token ?? randomBytes(24).toString('base64url');
  const host = opts.host ?? '127.0.0.1';
  const uiDir = opts.uiDir ?? fileURLToPath(new URL('./ui/', import.meta.url));
  const log = opts.log ?? (() => {});
  const readOnly = opts.readOnly ?? !opts.spawnCli;
  const readOnlyReason = !readOnly ? null : opts.readOnly ? 'this dashboard is read-only (started with --read-only): it shows runs and changes nothing' : 'this dashboard is read-only: start it with shadowlap dashboard to change runs and run actions';
  const projectPath = opts.project ? resolve(opts.project.path) : null;
  const project = projectPath ? { name: opts.project?.name ?? basename(projectPath), path: projectPath } : null;
  const singleConfig = (): ProjectConfig => (opts.loadConfig ? readConfig(opts.loadConfig) : { normalize: [], redact: opts.redact ?? [], ...(opts.prices ? { prices: opts.prices } : {}) });

  // With several projects, everything below asks for the current one each time: a switch (here, or
  // another dashboard or the CLI changing the list) moves the store, config and folder together.
  const current = (): Current => {
    if (!projects) return { id: null, store: opts.store!, dbPath: opts.dbPath ?? null, project, config: singleConfig };
    try {
      const c = projects.current();
      const entry = projects.registry.get(c.id);
      const project = { id: c.id, name: c.name, path: c.path, display: tildePath(c.path, projects.registry.realHome), settingUp: entry ? entry.setup.stage !== 'done' : false };
      return { id: c.id, store: c.store(), dbPath: c.dbPath, project, config: () => readConfig(() => c.config()) };
    } catch (err) {
      // The current project's folder is gone, or its store can't be opened: the switcher still works.
      if (err instanceof ProjectError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };
  const currentProject = (): ProjectView | null => {
    try {
      return current().project;
    } catch {
      return null;
    }
  };
  const options = projects ? followingOptions(opts, current) : opts;
  const uploads = new UploadStore({
    get project() {
      return currentProject();
    },
    limit: opts.uploadLimit,
    maxIdleMs: opts.uploadMaxIdleMs,
    readOnly,
  });
  const place = (): JobPlace => {
    const c = current();
    return { store: c.store, project: c.project, dbPath: c.dbPath, projectId: c.id };
  };
  const jobs = new JobManager({ store: opts.store ?? current().store, spawnCli: opts.spawnCli, project, uploads, log, stopGraceMs: opts.jobStopGraceMs, ...(projects ? { place } : {}) });
  let port = 0;

  const address = () => `${host === '::1' ? '[::1]' : host}:${port}`;
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  // A route module that keeps the store or the project from registration would serve the first
  // project forever after a switch: with several projects, reading them then is refused.
  let registering = true;
  const live = (what: string) => {
    if (registering && projects) throw new Error(`a route module read ctx.${what} while registering: read it inside each handler, as it changes when the project does`);
  };
  const boot = randomBytes(6).toString('hex');
  const ctx: RouteContext = {
    get store() {
      live('store');
      return current().store;
    },
    options,
    jobs,
    uploads,
    get read() {
      const prices = projects ? pricesOf(current) : (opts.prices ?? null);
      return prices ? { prices } : {};
    },
    get project() {
      live('project');
      return current().project;
    },
    config: () => current().config(),
    readOnly,
    readOnlyReason,
    requireWritable: () => {
      if (readOnlyReason) throw new HttpError(403, readOnlyReason);
    },
    address,
    // Cursors carry it: what the browser learned from another project's store no longer holds once
    // the project changes, as after a restart.
    get instance() {
      if (!projects) return boot;
      let dbPath = '';
      try {
        dbPath = projects.current().dbPath;
      } catch {
        // the list can't be read: a tag of its own
      }
      return `${boot}.${createHash('sha1').update(dbPath).digest('base64url').slice(0, 10)}`;
    },
  };
  const router = new Router();
  try {
    registerRoutes(router, ctx);
    for (const m of opts.routes ?? []) m.register(router, ctx);
  } finally {
    registering = false;
  }

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

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const given = req.headers['x-shadowlap-token'];
    if (typeof given !== 'string' || !sameToken(given, token)) throw new HttpError(401, 'missing or wrong session token: open the link shadowlap dashboard printed');
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && !allowedHosts().has(origin.replace(/^https?:\/\//, ''))) throw new HttpError(403, 'cross-origin request refused');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'cross-origin request refused');
    }
    const match = router.match(method, url.pathname.slice('/api'.length));
    if (match.write) ctx.requireWritable();
    await match.handler(routeRequest(req, res, url, match.params));
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
      // A change to the project list that can't be made says why, with its own status.
      const status = err instanceof HttpError || err instanceof ProjectError ? err.status : 500;
      if (status === 500) log(`error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      if (res.headersSent) return res.destroy();
      // A body refused part way is not read to its end: close the connection so the client stops sending it.
      json(res, status, { error: err instanceof Error ? err.message : String(err) }, status === 413 ? { connection: 'close' } : {});
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
  const url = `http://${address()}`;

  let closing: Promise<void> | null = null;
  return {
    url,
    openUrl: `${url}/#token=${token}`,
    runUrl: (runId, callNo) => `${url}/#token=${token}&open=/run/${runId}${callNo ? `/call/${callNo}` : ''}`,
    token,
    readOnly,
    close: (o = {}) => {
      if (o.now) jobs.kill();
      return (closing ??= (async () => {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections?.();
        // Running jobs are stopped and waited for (killed after the grace time), so none outlives the
        // dashboard and none leaves a run recording; their uploads go with them, then the rest.
        await jobs.close();
        uploads.close();
        await closed;
      })());
    },
  };
}
