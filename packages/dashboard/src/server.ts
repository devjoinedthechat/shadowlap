import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectError, Store, tildePath, type Normalizer, type Price, type ProjectContext, type ProjectHost } from '@shadowlap/engine';
import type { ProjectConfig, RouteContext } from './context.js';
import { HttpError, json, sameToken } from './http.js';
import { JobManager, type JobKind, type JobNotice, type JobPlace, type SpawnCli } from './jobs.js';
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
  /**
   * Options that belong to a project's folder, such as how to list its goldens: asked once for each
   * project the dashboard serves (and for the folder of a dashboard that serves one store) and laid
   * over the rest, so each project's routes read their own. `id` is null with one store.
   */
  projectOptions?: (project: { id: string | null; name: string; path: string }) => Partial<DashboardOptions>;
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

function readConfig(load: () => ProjectConfig): ProjectConfig {
  try {
    return load();
  } catch (err) {
    throw new HttpError(500, `could not read the project's shadowlap.config.json: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A config's price table; none while the config can't be read (its pages say why). */
function pricesFrom(config: () => ProjectConfig): Record<string, Price> | null {
  try {
    return config().prices ?? null;
  } catch {
    return null;
  }
}

/**
 * One project as a dashboard with several serves it. Each project gets its own instance of every
 * route module, registered with a context fixed to that project (its store, folder, config and
 * prices) the first time it is current. So a module written for one store serves each project's
 * own, even one that keeps the store from registration, and caches keyed by the store stay apart.
 * The job manager knows each kind once, and each job is built by the kinds of the project it runs
 * in.
 */
interface Served {
  /** The host's context for the project: a new one (the folder added again, an id reused) gets a new instance. */
  source: ProjectContext<ProjectConfig>;
  router: Router;
  /** The job kinds this instance's modules registered, with builders that may hold its store or folder. */
  kinds: Map<string, JobKind>;
  /**
   * Why the project's store can't be opened (its folder is gone, or the store is from a newer
   * Shadowlap): its pages show an empty stand-in until it can, so the switcher and the Remove
   * dialog still work, and its jobs are refused with this reason.
   */
  problem: string | null;
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
  const requireWritable = () => {
    if (readOnlyReason) throw new HttpError(403, readOnlyReason);
  };
  const projectPath = opts.project ? resolve(opts.project.path) : null;
  const project = projectPath ? { name: opts.project?.name ?? basename(projectPath), path: projectPath } : null;
  const boot = randomBytes(6).toString('hex');
  let port = 0;
  const address = () => `${host === '::1' ? '[::1]' : host}:${port}`;
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  // ---- several projects: the current one's context, its store, and how the shell names it

  /** The current project in the host; a list that can't name one says why. */
  const currentContext = (): ProjectContext<ProjectConfig> => {
    try {
      return projects!.current();
    } catch (err) {
      if (err instanceof ProjectError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };
  /** A project's store, or why it can't be opened, with the status that goes with it. */
  const storeOf = (pc: ProjectContext<ProjectConfig>): Store => {
    try {
      return pc.store();
    } catch (err) {
      throw err instanceof ProjectError ? new HttpError(err.status, err.message) : new HttpError(409, `Shadowlap can’t open ${pc.name}’s store: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const projectView = (pc: ProjectContext<ProjectConfig>): ProjectView => {
    const entry = projects!.list().find((p) => p.id === pc.id);
    return { id: pc.id, name: pc.name, path: pc.path, display: tildePath(pc.path, projects!.registry.realHome), settingUp: entry ? entry.setup.stage !== 'done' : false };
  };

  const uploads = new UploadStore({
    // Uploads go to the folder of the project current when they arrive, as its jobs run there.
    get project() {
      if (!projects) return project;
      try {
        return projectView(currentContext());
      } catch {
        return null;
      }
    },
    limit: opts.uploadLimit,
    maxIdleMs: opts.uploadMaxIdleMs,
    readOnly,
  });
  /** Where a job starting now runs: the current project, against its store, to the end. */
  const place = (): JobPlace => {
    const pc = currentContext();
    return { store: storeOf(pc), project: projectView(pc), dbPath: pc.dbPath, projectId: pc.id };
  };
  const jobs = new JobManager({ store: opts.store ?? place().store, spawnCli: opts.spawnCli, project, uploads, log, stopGraceMs: opts.jobStopGraceMs, ...(projects ? { place } : {}) });

  /** Each kind the job manager knows hands the build to the instance of the project the job runs in. */
  const dispatching = new Set<string>();
  const served = new Map<string, Served>();
  const jobsFor = (projectId: string, kinds: Map<string, JobKind>): JobManager =>
    new Proxy(jobs, {
      get(target, prop) {
        if (prop === 'registerJobKind')
          return (kind: string, def: JobKind): void => {
            if (kinds.has(kind)) throw new Error(`job kind "${kind}" is registered twice`);
            if (!dispatching.has(kind)) {
              target.registerJobKind(kind, {
                title: (req) => def.title(req),
                build: (req, b) => {
                  const own = b.projectId === null ? undefined : served.get(b.projectId)?.kinds.get(kind);
                  return own ? own.build(req, b) : { error: `this project has no job kind "${kind}"`, status: 409 };
                },
              });
              dispatching.add(kind);
            }
            kinds.set(kind, def);
          };
        // A listener hears the jobs that run in its own project.
        if (prop === 'onJob') return (listener: (notice: JobNotice) => void) => target.onJob((n) => (n.projectId === projectId ? listener(n) : undefined));
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });

  let standIn: Store | null = null;
  /** The route context of one project: its store, folder and config, whichever project is current later. */
  const contextOf = (pc: ProjectContext<ProjectConfig>, kinds: Map<string, JobKind>, problem: string | null): RouteContext => {
    const store = problem ? () => (standIn ??= Store.open(':memory:')) : () => storeOf(pc);
    const config = () => readConfig(() => pc.config());
    const options: DashboardOptions = { ...opts, ...(opts.projectOptions?.({ id: pc.id, name: pc.name, path: pc.path }) ?? {}) };
    Object.defineProperties(options, {
      store: { get: store, enumerable: true, configurable: true },
      dbPath: { value: pc.dbPath, enumerable: true, configurable: true },
      project: { get: () => projectView(pc), enumerable: true, configurable: true },
      loadConfig: { value: config, enumerable: true, configurable: true },
      prices: { get: () => pricesFrom(config) ?? undefined, enumerable: true, configurable: true },
    });
    return {
      get store() {
        return store();
      },
      options,
      jobs: jobsFor(pc.id, kinds),
      uploads,
      get read() {
        const prices = pricesFrom(config);
        return prices ? { prices } : {};
      },
      get project() {
        return { ...projectView(pc), ...(problem ? { problem } : {}) };
      },
      config,
      readOnly,
      readOnlyReason,
      requireWritable,
      address,
      // Cursors carry it: what the browser learned from another project's store no longer holds once
      // the project changes, as after a restart; nor does the stand-in's once the store opens.
      instance: `${boot}.${createHash('sha1').update(pc.dbPath).digest('base64url').slice(0, 10)}${problem ? '.0' : ''}`,
    };
  };
  const registerAll = (router: Router, ctx: RouteContext) => {
    registerRoutes(router, ctx);
    for (const m of opts.routes ?? []) m.register(router, ctx);
  };
  /** The instance serving a project: made the first time it is current, again when its context or store changes. */
  const serve = (pc: ProjectContext<ProjectConfig>): Served => {
    let problem: string | null = null;
    try {
      storeOf(pc);
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
    const known = served.get(pc.id);
    if (known && known.source === pc && known.problem === problem) return known;
    const kinds = new Map<string, JobKind>();
    const router = new Router();
    registerAll(router, contextOf(pc, kinds, problem));
    const s: Served = { source: pc, router, kinds, problem };
    served.set(pc.id, s);
    return s;
  };

  // ---- one store: one context, as the terminal UI's and a read-only dashboard are

  let single: Router | null = null;
  if (!projects) {
    const singleConfig = (): ProjectConfig => (opts.loadConfig ? readConfig(opts.loadConfig) : { normalize: [], redact: opts.redact ?? [], ...(opts.prices ? { prices: opts.prices } : {}) });
    single = new Router();
    registerAll(single, {
      store: opts.store!,
      options: project && opts.projectOptions ? { ...opts, ...opts.projectOptions({ id: null, name: project.name, path: project.path }) } : opts,
      jobs,
      uploads,
      read: opts.prices ? { prices: opts.prices } : {},
      project,
      config: singleConfig,
      readOnly,
      readOnlyReason,
      requireWritable,
      address,
      instance: boot,
    });
  } else {
    // The project it opens on is served at once: a route module's mistake shows when it starts.
    serve(currentContext());
  }
  /** The routes of what the dashboard serves now: its store, or the current project's instance. */
  const routerNow = (): Router => single ?? serve(currentContext()).router;

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
    const match = routerNow().match(method, url.pathname.slice('/api'.length));
    if (match.write) requireWritable();
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
        standIn?.close();
        await closed;
      })());
    },
  };
}
