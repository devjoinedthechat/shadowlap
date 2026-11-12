import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectError, Store, messageOf, type Normalizer, type Price, type ProjectHost } from '@shadowlap/engine';
import type { ProjectConfig } from './context.js';
import { exportsEnded } from './export-apart.js';
import { HttpError, json, sameToken } from './http.js';
import { JobManager, type SpawnCli } from './jobs.js';
import { answeringRequest } from './idle.js';
import { previewsEnded } from './redaction-preview.js';
import { Router, routeRequest } from './router.js';
import { ProjectRoutes, ProjectStores, readConfig, registerAll, type RouteBase } from './project-routes.js';
import { ROUTE_MODULES, type RouteModule } from './routes/index.js';
import type { GoldenSource } from './tests.js';
import type { TrainingOptions } from './training.js';
import type { EditorOptions } from './editor.js';
import { countRuns } from './runs-list.js';
import { StoreFiles } from './store-files.js';
import { UploadStore } from './uploads.js';

export type { SpawnCli, SpawnCliOptions } from './jobs.js';

/**
 * `shadowlap dashboard`: a local web UI over the store. The server binds to loopback, answers only
 * requests addressed to localhost (DNS rebinding), and serves data only with the session token
 * that `shadowlap dashboard` puts in the URL fragment (never logged, never sent as a Referer).
 * Requests that change something must come from the page itself, and a read-only dashboard refuses
 * them all. Actions run the CLI itself, as the terminal UI does: the browser names a job kind and
 * its fields, the server builds the command line.
 *
 * This file is the HTTP plumbing; the endpoints are registered by feature from `routes/`, with the
 * context of the store they serve (project-routes.ts), each store read beside the server's thread
 * (store-files.ts).
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
  /**
   * The project's goldens, read fresh on every call: the packs in its goldens folder and those its
   * config's `tests` name, as `projectGoldens` in the CLI lists them. Tests shows them, and its jobs
   * take only these; the Overview counts their passing and failing tests, and Find breaking commit (on the
   * Runs calendar and a run's page) starts from them. Without it the project has no goldens.
   */
  goldens?: () => GoldenSource[];
  /** The most one upload may hold, in bytes (64 MB). */
  uploadLimit?: number;
  /** How long an upload no job used is kept, in milliseconds (an hour). */
  uploadMaxIdleMs?: number;
  /** How long a stopped job has to end before it is killed, in milliseconds (5 s). */
  jobStopGraceMs?: number;
  /** Route modules registered after the built-in ones in routes/index.ts: for tests, and for embedding the server elsewhere. */
  routes?: RouteModule[];
  /**
   * Options that belong to a project's folder, such as how to list its goldens: asked once for each
   * project the dashboard serves (and for the folder of a dashboard that serves one store) and laid
   * over the rest, so each project's routes read their own. `id` is null with one store.
   */
  projectOptions?: (project: { id: string | null; name: string; path: string }) => Partial<DashboardOptions>;
  /** Training (#/training): the CLI's tasks loader, and how Score a model lists models (training.ts). */
  training?: TrainingOptions;
  /** Open in editor's environment, platform and spawner (editor.ts): the server's own unless a test gives them. */
  editor?: EditorOptions;
}

export interface Dashboard {
  /** Origin, e.g. http://127.0.0.1:4777 */
  url: string;
  /** The port it listens on: the one asked for, or the one the system gave for port 0 (or for a taken default). */
  port: number;
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

export async function startDashboard(opts: DashboardOptions): Promise<Dashboard> {
  const projects = opts.projects ?? null;
  if (!projects && !opts.store) throw new Error('startDashboard needs a store, or projects');
  const token = opts.token ?? randomBytes(24).toString('base64url');
  const host = opts.host ?? '127.0.0.1';
  const uiDir = opts.uiDir ?? fileURLToPath(new URL('./ui/', import.meta.url));
  const log = opts.log ?? (() => {});
  const readOnly = opts.readOnly ?? !opts.spawnCli;
  const readOnlyReason = !readOnly ? null : opts.readOnly ? 'this dashboard is read-only (started with --read-only): it shows runs and changes nothing' : 'this dashboard is read-only: start it with shadowlap dashboard to change runs and run actions';
  const requireWritable = () => {
    if (readOnlyReason) throw new HttpError(403, readOnlyReason);
  };
  const projectPath = opts.project ? resolve(opts.project.path) : null;
  const project = projectPath ? { name: opts.project?.name ?? basename(projectPath), path: projectPath } : null;
  let port = 0;
  const address = () => `${host === '::1' ? '[::1]' : host}:${port}`;
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  const stores = new StoreFiles({ log, realHome: projects?.registry.realHome ?? '', several: !!projects });
  const several = projects ? new ProjectStores(projects, stores) : null;
  // A project removed here has every thread on its store let go of it before its recordings are deleted.
  const unhold = projects?.holdStores((dbPath) => stores.letGo(dbPath));
  const uploads = new UploadStore({
    // Uploads go to the folder of the project current when they arrive, as its jobs run there; one
    // that can't be served now refuses them with the reason.
    get project() {
      return several ? several.forUpload() : project;
    },
    limit: opts.uploadLimit,
    maxIdleMs: opts.uploadMaxIdleMs,
    readOnly,
  });
  // With several projects every job asks `place`; the store given here is never used then.
  const jobs = new JobManager({ store: opts.store ?? stores.standInStore(), spawnCli: opts.spawnCli, project, uploads, log, stopGraceMs: opts.jobStopGraceMs, ...(several ? { place: () => several.place() } : {}) });
  const base: RouteBase = { opts, jobs, uploads, modules: [...ROUTE_MODULES, ...(opts.routes ?? [])], log, readOnly, readOnlyReason, requireWritable, address, boot: randomBytes(6).toString('hex') };
  const servingNow = several ? servingProjects(several, new ProjectRoutes(several, stores, base)) : servingOne(opts, project, stores, base);
  // The status bar's counts (/api/meta, on every page) come from the run index: read now, before the
  // page asks, so its first look doesn't wait for every run to be read and classified. The run
  // totals the read models keep later change nothing it reads, so it stays read while they warm.
  try {
    countRuns(several ? several.storeOf(several.current()) : opts.store!);
  } catch {
    // a store that can't be read now says so on its pages
  }

  const server: Server = createServer((req, res) => answer(req, res, { uiDir, log, allowedHosts, api: (url) => api(req, res, url, { token, allowedHosts, servingNow, requireWritable, projects }) }));
  await listen(server, host, opts.port);
  port = (server.address() as AddressInfo).port;
  const url = `http://${address()}`;

  let closing: Promise<void> | null = null;
  return {
    url,
    port,
    openUrl: `${url}/#token=${token}`,
    runUrl: (runId, callNo) => `${url}/#token=${token}&open=/run/${runId}${callNo ? `/call/${callNo}` : ''}`,
    token,
    readOnly,
    close: (o = {}) => {
      if (o.now) jobs.kill();
      return (closing ??= (async () => {
        unhold?.();
        stores.stopWatching();
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections?.();
        // Running jobs are stopped and waited for (killed after the grace time), so none outlives the
        // dashboard and none leaves a run recording; their uploads go with them, then the rest.
        await jobs.close();
        uploads.close();
        await stores.close();
        await closed;
        // A redaction preview's thread, or one making an HTML download, holds the store's file until it has ended.
        await Promise.all([previewsEnded(), exportsEnded()]);
      })());
    },
  };
}

/** What the dashboard serves now: its routes, and the project they are the current one's of, with several. */
type ServingNow = () => { router: Router; current: { id: string; name: string } | null };

/** A dashboard of several projects serves the current one's instance. The project it opens on is served at once: a route module's mistake shows when it starts. */
function servingProjects(projects: ProjectStores, routes: ProjectRoutes): ServingNow {
  routes.serve(projects.current());
  return () => {
    routes.prune();
    const pc = projects.current();
    return { router: routes.serve(pc).router, current: { id: pc.id, name: pc.name } };
  };
}

/** One store: one context, as the terminal UI's and a read-only dashboard are. */
function servingOne(opts: DashboardOptions, project: { name: string; path: string } | null, stores: StoreFiles, base: RouteBase): ServingNow {
  const store = opts.store!;
  const single = new Router();
  registerAll(base, single, {
    store,
    options: project && opts.projectOptions ? { ...opts, ...opts.projectOptions({ id: null, name: project.name, path: project.path }) } : opts,
    jobs: base.jobs,
    uploads: base.uploads,
    read: opts.prices ? { prices: opts.prices } : {},
    reads: stores.reads(opts.dbPath, () => store),
    search: stores.search(opts.dbPath, () => store),
    project,
    config: (): ProjectConfig => (opts.loadConfig ? readConfig(opts.loadConfig) : { normalize: [], redact: opts.redact ?? [], ...(opts.prices ? { prices: opts.prices } : {}) }),
    readOnly: base.readOnly,
    readOnlyReason: base.readOnlyReason,
    requireWritable: base.requireWritable,
    address: base.address,
    instance: base.boot,
  });
  return () => {
    // A store the caller opened can't be opened anew here: what reads it stops, and the pages say why.
    const how = stores.moved(opts.dbPath);
    if (how) {
      void stores.letGo(opts.dbPath!);
      throw new HttpError(409, stores.movedWords(how, opts.dbPath!, null));
    }
    return { router: single, current: null };
  };
}

/** Listens on `port` (0: any free one) of `host`. A taken port asked for is not fatal: any free one is taken. */
function listen(server: Server, host: string, port: number | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      // A taken default port is not fatal: take any free one. So is one the system keeps for itself
      // (EACCES: on Windows a port in a range Hyper-V or WinNAT reserves; elsewhere one below 1024).
      if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && port !== 0 && port !== undefined) {
        server.off('error', onError);
        server.once('error', reject);
        server.listen(0, host, () => resolve());
        return;
      }
      reject(err);
    };
    server.once('error', onError);
    server.listen(port ?? 0, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/** Answers one request: the API, or the UI's files, and an error as JSON with its status. */
function answer(req: IncomingMessage, res: ServerResponse, d: { uiDir: string; log: (line: string) => void; allowedHosts: () => Set<string>; api: (url: URL) => Promise<void> }): void {
  // Counted until its answer has gone: what a store in memory does while the server is idle waits meanwhile (idle.ts).
  const answered = answeringRequest();
  res.once('finish', answered);
  res.once('close', answered);
  void (async () => {
    // DNS rebinding: a page on some other name that resolves to 127.0.0.1 must not read this.
    if (!d.allowedHosts().has(String(req.headers.host ?? ''))) throw new HttpError(403, 'this dashboard only answers requests to localhost');
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) return d.api(url);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    return serveStatic(d.uiDir, res, url.pathname);
  })().catch((err: unknown) => {
    // A change to the project list that can't be made says why, with its own status.
    const status = err instanceof HttpError || err instanceof ProjectError ? err.status : 500;
    if (status === 500) d.log(`error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    if (res.headersSent) return res.destroy();
    const error = messageOf(err);
    // A read of something the store doesn't hold (a run or a fix a link names) from the page, which
    // says so itself: asked that way (`x-shadowlap-not-found: answer`), it is answered 200 with
    // `notFound`, so the browser logs no failed load for it. Any other client gets the 404.
    if (status === 404 && req.method === 'GET' && req.headers['x-shadowlap-not-found'] === 'answer') return json(res, 200, { error, notFound: true });
    // A body refused part way is not read to its end: close the connection so the client stops sending it.
    const confirm = err instanceof HttpError && err.confirm !== undefined ? { confirm: err.confirm, ...(err.live !== undefined ? { live: err.live } : {}) } : {};
    json(res, status, { error, ...confirm }, status === 413 ? { connection: 'close' } : {});
  });
}

function serveStatic(uiDir: string, res: ServerResponse, pathname: string): void {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = normalize(join(uiDir, rel));
  if (!file.startsWith(normalize(uiDir.endsWith(sep) ? uiDir : uiDir + sep)) || !existsSync(file)) {
    // Client-side routes all load the app.
    if (!extname(rel) && existsSync(join(uiDir, 'index.html'))) return serveStatic(uiDir, res, '/');
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

/** An API request: with the session token, from the page itself when it changes something, to the routes served now. */
async function api(req: IncomingMessage, res: ServerResponse, url: URL, d: { token: string; allowedHosts: () => Set<string>; servingNow: ServingNow; requireWritable: () => void; projects: ProjectHost<ProjectConfig> | null }): Promise<void> {
  const given = req.headers['x-shadowlap-token'];
  if (typeof given !== 'string' || !sameToken(given, d.token)) throw new HttpError(401, 'missing or wrong session token: open the link shadowlap dashboard printed');
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && !d.allowedHosts().has(origin.replace(/^https?:\/\//, ''))) throw new HttpError(403, 'cross-origin request refused');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'cross-origin request refused');
  }
  const now = d.servingNow();
  const match = now.router.match(method, url.pathname.slice('/api'.length));
  if (match.write) d.requireWritable();
  // A page still showing another project than the current one (switched to elsewhere since: in
  // another tab, or another window) names the one it shows, and what it asks for is done nowhere:
  // it would land in the project switched to. Reads answer with the current project, which the
  // page then turns to; routes that name what they act on (a project, a job) take any.
  const shown = req.headers['x-shadowlap-project'];
  if (now.current && method !== 'GET' && method !== 'HEAD' && !match.anyProject && typeof shown === 'string' && shown && shown !== now.current.id) {
    const was = d.projects?.list().find((p) => p.id === shown)?.name ?? shown.slice(0, 64);
    return json(res, 409, { error: `The dashboard switched to ${now.current.name} elsewhere, so nothing was done in ${was}.`, current: now.current });
  }
  await match.handler(routeRequest(req, res, url, match.params));
}
