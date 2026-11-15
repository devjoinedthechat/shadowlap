import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { ProjectError, messageOf, tildePath, type Price, type ProjectContext, type ProjectHost, type Store } from '@shadowlap/engine';
import type { ProjectConfig, RouteContext } from './context.js';
import { HttpError } from './http.js';
import type { JobKind, JobManager, JobNotice, JobPlace } from './jobs.js';
import { Router } from './router.js';
import type { RouteModule } from './routes/index.js';
import type { DashboardOptions } from './server.js';
import type { StoreFiles } from './store-files.js';
import type { UploadStore } from './uploads.js';
import type { ProjectView } from './views.js';

/**
 * The route modules of a dashboard, registered with the context they serve: the one store a
 * dashboard serves alone, or each project of several, which gets its own instance of every module.
 */

/** A project's shadowlap.config.json, or an error that says why it can't be read. */
export function readConfig(load: () => ProjectConfig): ProjectConfig {
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

/** What every route context of a dashboard shares, whichever store it serves. */
export interface RouteBase {
  opts: DashboardOptions;
  jobs: JobManager;
  uploads: UploadStore;
  modules: RouteModule[];
  log: (line: string) => void;
  readOnly: boolean;
  readOnlyReason: string | null;
  requireWritable: () => void;
  address: () => string;
  /** Different on every start, so cursors from before a restart are known for what they are. */
  boot: string;
}

/**
 * Registers every module with a context. For the project the dashboard opens on (and a dashboard
 * that serves one store) a module that fails stops it starting; for a project opened later it is
 * logged, left out and named in that project's meta (`project.notice`), so the switcher and the rest
 * still serve that project.
 */
export function registerAll(base: Pick<RouteBase, 'modules' | 'log'>, router: Router, ctx: RouteContext, later: { name: string; failed: string[] } | null = null): void {
  for (const m of base.modules) {
    if (!later) {
      m.register(router, ctx);
      continue;
    }
    try {
      m.register(router, ctx);
    } catch (err) {
      const why = messageOf(err);
      later.failed.push(why);
      base.log(`a route module could not register for ${later.name}: ${why}`);
    }
  }
}

/** Several projects behind one dashboard: the current one, its store, and how the shell names it. */
export class ProjectStores {
  constructor(
    readonly host: ProjectHost<ProjectConfig>,
    private readonly stores: StoreFiles,
  ) {}

  /** The current project in the host; a list that can't name one says why. */
  current(): ProjectContext<ProjectConfig> {
    try {
      return this.host.current();
    } catch (err) {
      if (err instanceof ProjectError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  currentId(): string | null {
    try {
      return this.host.currentProject() ?? null;
    } catch {
      return null;
    }
  }

  /** A project's store, or why it can't be opened (its folder named as the switcher names it), with the status that goes with it. */
  storeOf(pc: ProjectContext<ProjectConfig>): Store {
    try {
      return pc.store();
    } catch (err) {
      const why = err instanceof ProjectError ? err.message : `shadowlap can’t open ${pc.name}’s store: ${messageOf(err)}`;
      throw new HttpError(err instanceof ProjectError ? err.status : 409, why.split(pc.path).join(tildePath(pc.path, this.host.registry.realHome)));
    }
  }

  view(pc: ProjectContext<ProjectConfig>): ProjectView {
    const entry = this.host.list().find((p) => p.id === pc.id);
    return { id: pc.id, name: pc.name, path: pc.path, display: tildePath(pc.path, this.host.registry.realHome), settingUp: entry ? entry.setup.stage !== 'done' : false };
  }

  /**
   * Why a project's store can't be served now, or null: asked on every request, so a folder moved or
   * deleted while it was served is seen at once. A store file deleted is said to be; one replaced by
   * another file (a new store made where it was) is let go of and opened anew, with threads of its own.
   */
  problemOf(pc: ProjectContext<ProjectConfig>): string | null {
    // A folder gone with its store says so as it always did, and its store is the same file once it is back.
    const how = existsSync(pc.path) ? this.stores.moved(pc.dbPath) : null;
    if (how) {
      void this.stores.letGo(pc.dbPath);
      pc.close();
      if (how === 'deleted') return this.stores.movedWords('deleted', pc.dbPath, pc.name);
      this.stores.reopened(pc.dbPath);
    }
    try {
      this.storeOf(pc);
      return null;
    } catch (err) {
      return messageOf(err);
    }
  }

  /** The current project as an upload is put in it, with why it can't take one now; null when the list names none. */
  forUpload(): (ProjectView & { problem?: string }) | null {
    try {
      const pc = this.current();
      const problem = this.problemOf(pc);
      return { ...this.view(pc), ...(problem ? { problem } : {}) };
    } catch {
      return null;
    }
  }

  /** Where a job starting now runs: the current project, against its store, to the end. One whose store can't be opened runs nothing. */
  place(): JobPlace {
    const pc = this.current();
    const problem = this.problemOf(pc);
    if (problem) throw new HttpError(409, problem);
    return { store: this.storeOf(pc), project: this.view(pc), dbPath: pc.dbPath, projectId: pc.id };
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
   * was served, or the store is from a newer shadowlap): its pages show an empty stand-in until it
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

/** The route modules of each project a dashboard serves, an instance each (Served). */
export class ProjectRoutes {
  private readonly served = new Map<string, Served>();
  /** The kinds the job manager knows, each handing the build to the instance of the project the job runs in. */
  private readonly dispatching = new Set<string>();
  /** The project the dashboard opens on is served strictly: a module's mistake shows when it starts. */
  private opened = false;
  /** The project list as the instances were last pruned to it. */
  private listed: unknown = null;

  constructor(
    private readonly projects: ProjectStores,
    private readonly stores: StoreFiles,
    private readonly base: RouteBase,
  ) {}

  /** The instance serving a project: made the first time it is current, again when its context changes or its store can (or can't) be opened. */
  serve(pc: ProjectContext<ProjectConfig>): Served {
    const problem = this.projects.problemOf(pc);
    const generation = this.stores.generation(pc.dbPath);
    const known = this.served.get(pc.id);
    if (known && known.source === pc && known.problem === problem && known.generation === generation) return known;
    if (known) retire(known);
    const s: Served = { source: pc, router: new Router(), kinds: new Map(), problem, listening: [], failed: [], generation };
    registerAll(this.base, s.router, this.contextOf(pc, s), this.opened ? { name: pc.name, failed: s.failed } : null);
    this.opened = true;
    this.served.set(pc.id, s);
    // Uploads a dashboard that stopped without closing left in this project's folder go now.
    if (!problem) this.base.uploads.adopt(pc.path);
    return s;
  }

  /** Instances of projects no longer on the list stop listening and go, whenever the list changes. */
  prune(): void {
    let list: ReturnType<ProjectHost<ProjectConfig>['list']>;
    try {
      list = this.projects.host.list();
    } catch {
      return;
    }
    if (list === this.listed) return;
    this.listed = list;
    const ids = new Set(list.map((p) => p.id));
    for (const [id, s] of this.served) {
      if (ids.has(id)) continue;
      retire(s);
      this.served.delete(id);
    }
  }

  private ownKind(projectId: string | null, kind: string): JobKind | undefined {
    return projectId === null ? undefined : this.served.get(projectId)?.kinds.get(kind);
  }

  /** The job manager as one project's modules see it: the kinds they register are theirs, and so are the jobs they hear of. */
  private jobsFor(projectId: string, s: Pick<Served, 'kinds' | 'listening'>): JobManager {
    const { dispatching } = this;
    const ownKind = (id: string | null, kind: string) => this.ownKind(id, kind);
    const currentId = () => this.projects.currentId();
    return new Proxy(this.base.jobs, {
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
  }

  /** The route context of one project: its store, folder and config, whichever project is current later. */
  private contextOf(pc: ProjectContext<ProjectConfig>, s: Pick<Served, 'kinds' | 'listening' | 'failed' | 'problem'>): RouteContext {
    const { base, stores, projects } = this;
    const { opts } = base;
    const problem = s.problem;
    const store = problem ? () => stores.standInStore() : () => projects.storeOf(pc);
    const config = () => readConfig(() => pc.config());
    const options: DashboardOptions = { ...opts, ...(opts.projectOptions?.({ id: pc.id, name: pc.name, path: pc.path }) ?? {}) };
    Object.defineProperties(options, {
      store: { get: store, enumerable: true, configurable: true },
      dbPath: { value: pc.dbPath, enumerable: true, configurable: true },
      project: { get: () => projects.view(pc), enumerable: true, configurable: true },
      loadConfig: { value: config, enumerable: true, configurable: true },
      prices: { get: () => pricesFrom(config) ?? undefined, enumerable: true, configurable: true },
    });
    const standIn = () => stores.standInStore();
    return {
      get store() {
        return store();
      },
      options,
      jobs: this.jobsFor(pc.id, s),
      uploads: base.uploads,
      get read() {
        const prices = pricesFrom(config);
        return prices ? { prices } : {};
      },
      reads: problem ? stores.reads(null, standIn) : stores.reads(pc.dbPath, () => projects.storeOf(pc), () => pricesFrom(config) ?? undefined),
      search: problem ? stores.search(null, standIn) : stores.search(pc.dbPath, () => projects.storeOf(pc)),
      get project() {
        const notice = s.failed.length ? `Part of the dashboard couldn’t start for ${pc.name}: ${s.failed.join('; ')}. Its pages there say they aren’t found.` : null;
        return { ...projects.view(pc), ...(problem ? { problem, ...(existsSync(pc.path) ? {} : { missing: true }) } : {}), ...(notice ? { notice } : {}) };
      },
      config,
      readOnly: base.readOnly,
      readOnlyReason: base.readOnlyReason,
      requireWritable: base.requireWritable,
      address: base.address,
      // Cursors carry it: what the browser learned from another project's store no longer holds once
      // the project changes, as after a restart; nor does the stand-in's once the store opens.
      instance: `${base.boot}.${createHash('sha1').update(pc.dbPath).digest('base64url').slice(0, 10)}${problem ? '.0' : ''}`,
    };
  }
}

/** An instance that no longer serves its project stops hearing its jobs. */
function retire(s: Served): void {
  for (const off of s.listening.splice(0)) off();
}
