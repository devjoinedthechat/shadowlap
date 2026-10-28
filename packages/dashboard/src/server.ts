import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectError, Store, messageOf, tildePath, type Normalizer, type Price, type ProjectContext, type ProjectHost } from '@shadowlap/engine';
import type { ProjectConfig, RouteContext } from './context.js';
import { exportsEnded } from './export-apart.js';
import { HttpError, json, sameToken } from './http.js';
import { JobManager, type JobKind, type JobNotice, type JobPlace, type SpawnCli } from './jobs.js';
import { answeringRequest } from './idle.js';
import { storeKeeper } from './keeper.js';
import { LocalReads, ReadPool, type ReadModels } from './read-pool.js';
import { previewsEnded } from './redaction-preview.js';
import { Router, routeRequest } from './router.js';
import { LocalSearch, SearchIndexer, type SearchIndex } from './search-index.js';
import { ROUTE_MODULES, type RouteModule } from './routes/index.js';
import type { GoldenSource } from './tests.js';
import type { TrainingOptions } from './training.js';
import { countRuns } from './runs-list.js';
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
  /**
   * The project's goldens, read fresh on every call: the packs in its goldens folder and those its
   * config's `tests` name, as `projectGoldens` in the CLI lists them. Tests shows them, and its jobs
   * take only these; the Overview counts their passing and failing tests, and Find the commit (on the
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

function readConfig(load: () => ProjectConfig): ProjectConfig {
  try {
    return load();
  } catch (err) {
    throw new HttpError(500, `could not read the project's shadowlap.config.json: ${messageOf(err)}`);
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
   * Why the project's store can't be opened (its folder is gone, even one that went away while it
   * was served, or the store is from a newer Shadowlap): its pages show an empty stand-in until it
   * can, so the switcher and the Remove dialog still work, and its jobs and uploads are refused with
   * this reason. Asked again on every request.
   */
  problem: string | null;
  /** What its modules listen to (`jobs.onJob`): stopped when the instance is replaced or the project removed. */
  listening: Array<() => void>;
  /** Modules that failed to register for this project, with why: their pages answer 404 here. */
  failed: string[];
  /** How many times the project's store file was found replaced and opened again: a new one gets a new instance. */
  generation: number;
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
  /** A project's store, or why it can't be opened (its folder named as the switcher names it), with the status that goes with it. */
  const storeOf = (pc: ProjectContext<ProjectConfig>): Store => {
    try {
      return pc.store();
    } catch (err) {
      const why = err instanceof ProjectError ? err.message : `Shadowlap can’t open ${pc.name}’s store: ${messageOf(err)}`;
      throw new HttpError(err instanceof ProjectError ? err.status : 409, why.split(pc.path).join(tildePath(pc.path, projects!.registry.realHome)));
    }
  };
  const projectView = (pc: ProjectContext<ProjectConfig>): ProjectView => {
    const entry = projects!.list().find((p) => p.id === pc.id);
    return { id: pc.id, name: pc.name, path: pc.path, display: tildePath(pc.path, projects!.registry.realHome), settingUp: entry ? entry.setup.stage !== 'done' : false };
  };

  /**
   * The read models of each store served, worked out beside the server's thread (read-pool.ts): one
   * set of threads per store file, shared by a project's route instances; a store in memory works
   * them out here. What the threads work out to keep (run totals, what users asked), a thread of its
   * own writes, with a connection of its own (keeper.ts): this one only hands the rows over. While
   * another command holds the store's write lock (a batch of the search index, gc's VACUUM, a pull)
   * the rows wait there, and are written once it lets go.
   */
  const pools = new Map<string, ReadPool>();
  const keepers = new Map<string, ReturnType<typeof storeKeeper>>();

  /**
   * Each store file served, by its path: the device and inode it was when the dashboard first read it.
   * A store deleted while served (its folder removed, the file replaced by another) went on being read
   * through the connections open to the old file, each its own state: the status bar said 0 runs and
   * Runs 10,000, and the search index's thread spun on the deleted file. Asked on every request, and
   * every few seconds for the threads.
   */
  const files = new Map<string, string>();
  const identity = (path: string): string | null => {
    try {
      const st = statSync(path);
      return `${st.dev}:${st.ino}`;
    } catch {
      return null;
    }
  };
  /** Whether the store at `path` is still the file the dashboard read: 'deleted', 'replaced' by another, or null. */
  const moved = (path: string | null | undefined): 'deleted' | 'replaced' | null => {
    if (!path || path === ':memory:') return null;
    const now = identity(path);
    const was = files.get(path);
    if (was === undefined) {
      if (now) files.set(path, now);
      return null;
    }
    return now === null ? 'deleted' : now === was ? null : 'replaced';
  };
  /** How many times each store file was opened again after it was replaced. */
  const generations = new Map<string, number>();
  /** Lets go of the threads reading the store at `path`, which would go on reading the old file. */
  const letGo = (path: string): void => {
    const pool = pools.get(path);
    if (pool) {
      pools.delete(path);
      void pool.close();
    }
    void keepers.get(path)?.close();
    keepers.delete(path);
    const indexer = indexers.get(path);
    if (indexer) {
      indexers.delete(path);
      void indexer.close();
    }
  };
  /** What the pages say of a store moved from under the dashboard. */
  const movedWords = (how: 'deleted' | 'replaced', path: string, name: string | null): string =>
    how === 'deleted'
      ? `${name ? `${name}’s store` : 'The store'} (${tildePath(path, projects?.registry.realHome ?? '')}) was deleted while the dashboard served it: record a run to make a new one${projects ? '' : ', then start the dashboard again'}`
      : `The store (${tildePath(path, projects?.registry.realHome ?? '')}) was replaced by another file while the dashboard served it: start the dashboard again to read it`;
  // The threads of a store deleted or replaced stop reading it, requests or none.
  const watch = setInterval(() => {
    for (const path of new Set([...pools.keys(), ...indexers.keys()])) if (moved(path)) letGo(path);
  }, 5000);
  watch.unref();
  const locals = new Set<LocalReads>();
  const readsFor = (dbPath: string | null | undefined, store: () => Store): ReadModels => {
    moved(dbPath);
    if (!dbPath || dbPath === ':memory:') {
      const local = new LocalReads(store);
      locals.add(local);
      return local;
    }
    let pool = pools.get(dbPath);
    if (!pool) {
      const keep = storeKeeper(dbPath, { log });
      void keepers.get(dbPath)?.close();
      keepers.set(dbPath, keep);
      pool = new ReadPool({ dbPath, keep, log });
      pools.set(dbPath, pool);
    }
    return pool;
  };

  /**
   * Each store's search index, brought up to date beside the requests (search-index.ts): on a thread
   * of its own per store file, shared by a project's route instances; a store in memory on this one,
   * while it answers no request.
   */
  const indexers = new Map<string, SearchIndexer>();
  const searchFor = (dbPath: string | null | undefined, store: () => Store): SearchIndex => {
    if (!dbPath || dbPath === ':memory:') return new LocalSearch(store);
    let indexer = indexers.get(dbPath);
    if (!indexer) indexers.set(dbPath, (indexer = new SearchIndexer({ dbPath, log })));
    return indexer;
  };

  /** What a project whose store can't be opened is served from: empty, in memory, shared by every such project. */
  let standIn: Store | null = null;
  const standInStore = (): Store => (standIn ??= Store.open(':memory:'));
  /**
   * Why a project's store can't be served now, or null: asked on every request, so a folder moved or
   * deleted while it was served is seen at once. A store file deleted is said to be; one replaced by
   * another file (a new store made where it was) is let go of and opened anew, with threads of its own.
   */
  const problemOf = (pc: ProjectContext<ProjectConfig>): string | null => {
    // A folder gone with its store says so as it always did, and its store is the same file once it is back.
    const how = existsSync(pc.path) ? moved(pc.dbPath) : null;
    if (how) {
      letGo(pc.dbPath);
      pc.close();
      if (how === 'deleted') return movedWords('deleted', pc.dbPath, pc.name);
      files.set(pc.dbPath, identity(pc.dbPath)!);
      generations.set(pc.dbPath, (generations.get(pc.dbPath) ?? 0) + 1);
    }
    try {
      storeOf(pc);
      return null;
    } catch (err) {
      return messageOf(err);
    }
  };

  const uploads = new UploadStore({
    // Uploads go to the folder of the project current when they arrive, as its jobs run there; one
    // that can't be served now refuses them with the reason.
    get project() {
      if (!projects) return project;
      try {
        const pc = currentContext();
        const problem = problemOf(pc);
        return { ...projectView(pc), ...(problem ? { problem } : {}) };
      } catch {
        return null;
      }
    },
    limit: opts.uploadLimit,
    maxIdleMs: opts.uploadMaxIdleMs,
    readOnly,
  });
  /** Where a job starting now runs: the current project, against its store, to the end. One whose store can't be opened runs nothing. */
  const place = (): JobPlace => {
    const pc = currentContext();
    const problem = problemOf(pc);
    if (problem) throw new HttpError(409, problem);
    return { store: storeOf(pc), project: projectView(pc), dbPath: pc.dbPath, projectId: pc.id };
  };
  // With several projects every job asks `place`; the store given here is never used then.
  const jobs = new JobManager({ store: opts.store ?? standInStore(), spawnCli: opts.spawnCli, project, uploads, log, stopGraceMs: opts.jobStopGraceMs, ...(projects ? { place } : {}) });

  /** Each kind the job manager knows hands the build to the instance of the project the job runs in. */
  const dispatching = new Set<string>();
  const served = new Map<string, Served>();
  const ownKind = (projectId: string | null, kind: string): JobKind | undefined => (projectId === null ? undefined : served.get(projectId)?.kinds.get(kind));
  const currentId = (): string | null => {
    try {
      return projects?.currentProject() ?? null;
    } catch {
      return null;
    }
  };
  const jobsFor = (projectId: string, s: Pick<Served, 'kinds' | 'listening'>): JobManager =>
    new Proxy(jobs, {
      get(target, prop) {
        if (prop === 'registerJobKind')
          return (kind: string, def: JobKind): void => {
            if (s.kinds.has(kind)) throw new Error(`job kind "${kind}" is registered twice`);
            if (!dispatching.has(kind)) {
              target.registerJobKind(kind, {
                // Asked as the job starts, in the project current then: the one its build runs in.
                title: (req) => (ownKind(currentId(), kind) ?? def).title(req),
                build: (req, b) => {
                  const own = ownKind(b.projectId, kind);
                  return own ? own.build(req, b) : { error: `this project has no job kind "${kind}"`, status: 409 };
                },
              });
              dispatching.add(kind);
            }
            s.kinds.set(kind, def);
          };
        // A listener hears the jobs that run in its own project, while its instance serves it.
        if (prop === 'onJob')
          return (listener: (notice: JobNotice) => void) => {
            const off = target.onJob((n) => (n.projectId === projectId ? listener(n) : undefined));
            s.listening.push(off);
            return off;
          };
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });

  /** The route context of one project: its store, folder and config, whichever project is current later. */
  const contextOf = (pc: ProjectContext<ProjectConfig>, s: Pick<Served, 'kinds' | 'listening' | 'failed' | 'problem'>): RouteContext => {
    const problem = s.problem;
    const store = problem ? standInStore : () => storeOf(pc);
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
      jobs: jobsFor(pc.id, s),
      uploads,
      get read() {
        const prices = pricesFrom(config);
        return prices ? { prices } : {};
      },
      reads: problem ? readsFor(null, standInStore) : readsFor(pc.dbPath, () => storeOf(pc)),
      search: problem ? searchFor(null, standInStore) : searchFor(pc.dbPath, () => storeOf(pc)),
      get project() {
        const notice = s.failed.length ? `Part of the dashboard couldn’t start for ${pc.name}: ${s.failed.join('; ')}. Its pages there say they aren’t found.` : null;
        return { ...projectView(pc), ...(problem ? { problem, ...(existsSync(pc.path) ? {} : { missing: true }) } : {}), ...(notice ? { notice } : {}) };
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
  const modules: RouteModule[] = [...ROUTE_MODULES, ...(opts.routes ?? [])];
  /**
   * Registers every module with a context. For the project the dashboard opens on (and a dashboard
   * that serves one store) a module that fails stops it starting, as before; for a project opened
   * later it is logged, left out and named in that project's meta (`project.notice`), so the
   * switcher and the rest still serve that project.
   */
  const registerAll = (router: Router, ctx: RouteContext, later: { name: string; failed: string[] } | null = null) => {
    for (const m of modules) {
      if (!later) {
        m.register(router, ctx);
        continue;
      }
      try {
        m.register(router, ctx);
      } catch (err) {
        const why = messageOf(err);
        later.failed.push(why);
        log(`a route module could not register for ${later.name}: ${why}`);
      }
    }
  };
  /** An instance that no longer serves its project stops hearing its jobs. */
  const retire = (s: Served) => {
    for (const off of s.listening.splice(0)) off();
  };
  /** The project the dashboard opens on is served strictly: a module's mistake shows when it starts. */
  let opened = false;
  /** The instance serving a project: made the first time it is current, again when its context changes or its store can (or can't) be opened. */
  const serve = (pc: ProjectContext<ProjectConfig>): Served => {
    const problem = problemOf(pc);
    const generation = generations.get(pc.dbPath) ?? 0;
    const known = served.get(pc.id);
    if (known && known.source === pc && known.problem === problem && known.generation === generation) return known;
    if (known) retire(known);
    const s: Served = { source: pc, router: new Router(), kinds: new Map(), problem, listening: [], failed: [], generation };
    registerAll(s.router, contextOf(pc, s), opened ? { name: pc.name, failed: s.failed } : null);
    opened = true;
    served.set(pc.id, s);
    // Uploads a dashboard that stopped without closing left in this project's folder go now.
    if (!problem) uploads.adopt(pc.path);
    return s;
  };
  /** Instances of projects no longer on the list stop listening and go, whenever the list changes. */
  let listed: unknown = null;
  const prune = () => {
    let list: ReturnType<ProjectHost<ProjectConfig>['list']>;
    try {
      list = projects!.list();
    } catch {
      return;
    }
    if (list === listed) return;
    listed = list;
    const ids = new Set(list.map((p) => p.id));
    for (const [id, s] of served) {
      if (ids.has(id)) continue;
      retire(s);
      served.delete(id);
    }
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
      reads: readsFor(opts.dbPath, () => opts.store!),
      search: searchFor(opts.dbPath, () => opts.store!),
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
  // The status bar's counts (/api/meta, on every page) come from the run index: read now, before the
  // page asks, so its first look doesn't wait for every run to be read and classified. The run
  // totals the read models keep later change nothing it reads, so it stays read while they warm.
  try {
    countRuns(projects ? storeOf(currentContext()) : opts.store!);
  } catch {
    // a store that can't be read now says so on its pages
  }
  /** What the dashboard serves now: its store's routes, or the current project's instance with its id and name. */
  const servingNow = (): { router: Router; current: { id: string; name: string } | null } => {
    if (single) {
      // A store the caller opened can't be opened anew here: what reads it stops, and the pages say why.
      const how = moved(opts.dbPath);
      if (how) {
        letGo(opts.dbPath!);
        throw new HttpError(409, movedWords(how, opts.dbPath!, null));
      }
      return { router: single, current: null };
    }
    prune();
    const pc = currentContext();
    return { router: serve(pc).router, current: { id: pc.id, name: pc.name } };
  };

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
    const now = servingNow();
    const match = now.router.match(method, url.pathname.slice('/api'.length));
    if (match.write) requireWritable();
    // A page still showing another project than the current one (switched to elsewhere since: in
    // another tab, or another window) names the one it shows, and what it asks for is done nowhere:
    // it would land in the project switched to. Reads answer with the current project, which the
    // page then turns to; routes that name what they act on (a project, a job) take any.
    const shown = req.headers['x-shadowlap-project'];
    if (now.current && method !== 'GET' && method !== 'HEAD' && !match.anyProject && typeof shown === 'string' && shown && shown !== now.current.id) {
      const was = projects?.list().find((p) => p.id === shown)?.name ?? shown.slice(0, 64);
      return json(res, 409, { error: `The dashboard switched to ${now.current.name} elsewhere, so nothing was done in ${was}.`, current: now.current });
    }
    await match.handler(routeRequest(req, res, url, match.params));
  }

  const server: Server = createServer((req, res) => {
    // Counted until its answer has gone: what a store in memory does while the server is idle waits meanwhile (idle.ts).
    const answered = answeringRequest();
    res.once('finish', answered);
    res.once('close', answered);
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
      const error = messageOf(err);
      // A read of something the store doesn't hold (a run or a fix a link names) from the page, which
      // says so itself: asked that way (`x-shadowlap-not-found: answer`), it is answered 200 with
      // `notFound`, so the browser logs no failed load for it. Any other client gets the 404.
      if (status === 404 && req.method === 'GET' && req.headers['x-shadowlap-not-found'] === 'answer') return json(res, 200, { error, notFound: true });
      // A body refused part way is not read to its end: close the connection so the client stops sending it.
      const confirm = err instanceof HttpError && err.confirm !== undefined ? { confirm: err.confirm } : {};
      json(res, status, { error, ...confirm }, status === 413 ? { connection: 'close' } : {});
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      // A taken default port is not fatal: take any free one. So is one the system keeps for itself
      // (EACCES: on Windows a port in a range Hyper-V or WinNAT reserves; elsewhere one below 1024).
      if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && opts.port !== 0 && opts.port !== undefined) {
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
    port,
    openUrl: `${url}/#token=${token}`,
    runUrl: (runId, callNo) => `${url}/#token=${token}&open=/run/${runId}${callNo ? `/call/${callNo}` : ''}`,
    token,
    readOnly,
    close: (o = {}) => {
      if (o.now) jobs.kill();
      return (closing ??= (async () => {
        clearInterval(watch);
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections?.();
        // Running jobs are stopped and waited for (killed after the grace time), so none outlives the
        // dashboard and none leaves a run recording; their uploads go with them, then the rest.
        await jobs.close();
        uploads.close();
        // The read models' threads close their connections to the store before they end.
        await Promise.all([...pools.values(), ...locals, ...indexers.values()].map((r) => r.close()));
        // What the keepers' threads hold is written, as far as the store lets it, before they end.
        await Promise.all([...keepers.values()].map((keep) => keep.close()));
        standIn?.close();
        await closed;
        // A redaction preview's thread, or one making an HTML download, holds the store's file until it has ended.
        await Promise.all([previewsEnded(), exportsEnded()]);
      })());
    },
  };
}
