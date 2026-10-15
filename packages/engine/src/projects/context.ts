import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../store.js';
import { countGoldens } from './folders.js';
import { projectDbPath } from './paths.js';
import { planRecording, type RecordPlanResult } from './record.js';
import { ProjectError, type AddedProject, type ProjectEntry, type ProjectRegistry, type RemovedProject } from './registry.js';
import { deriveSetup, emptyStoreFacts, stageAtLeast, storeFacts, type EffectiveSetup, type StoreFacts } from './setup.js';

/**
 * Several projects behind one dashboard. A {@link ProjectContext} is everything the server needs to
 * serve one project: its folder, its store (opened the first time it is needed and kept open), its
 * configuration, and the folder its actions run in. The {@link ProjectHost} keeps one per project
 * and knows which is current; switching projects swaps the context, so every read comes from the
 * chosen project's store and every action runs in its folder, against its store.
 */

export interface ProjectContext<C = unknown> {
  readonly id: string;
  readonly name: string;
  /** The project's folder. */
  readonly path: string;
  /** Its store: `<folder>/.shadowlap/shadowlap.db`, or the one `--db` named for the project the dashboard started in. */
  readonly dbPath: string;
  /** Where its actions run: the project's folder, as if the command were typed there. */
  readonly cwd: string;
  /** Its configuration, read through the loader the host was given, and again when the file changes. */
  config(): C;
  /** Its store, opened on first use. A project whose folder is gone has none: this throws. */
  store(): Store;
  /** Whether the store exists yet, without creating it. */
  hasStore(): boolean;
  /** What the store says about runs and the setup; empty facts while there is no store. `keep` is the setup's recording. */
  facts(options?: { keep?: string | null }): StoreFacts;
  /** Goldens in the project's repository (packs under `goldens/`). */
  goldens(): number;
  /** CLI arguments for a job in this project: its store first, so the job writes where it reads. */
  cliArgs(args: readonly string[]): string[];
  /** Closes the store; the next use opens it again. */
  close(): void;
}

class Context<C> implements ProjectContext<C> {
  private opened: Store | null = null;
  private cached: { key: string; value: C } | null = null;

  constructor(
    private readonly entry: ProjectEntry,
    readonly dbPath: string,
    private readonly loader: (cwd: string) => C,
    private readonly openStore: (dbPath: string) => Store,
    private readonly configFile: string,
  ) {}

  get id(): string {
    return this.entry.id;
  }
  get name(): string {
    return this.entry.name;
  }
  get path(): string {
    return this.entry.path;
  }
  get cwd(): string {
    return this.entry.path;
  }

  config(): C {
    let key = 'absent';
    try {
      const st = statSync(join(this.path, this.configFile));
      key = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      // no config file: the loader's defaults
    }
    if (this.cached?.key === key) return this.cached.value;
    const value = this.loader(this.path);
    this.cached = { key, value };
    return value;
  }

  store(): Store {
    if (this.opened) return this.opened;
    // Opening a store creates its folder; a project whose folder was deleted must not get it back.
    if (!existsSync(this.path)) throw new ProjectError('folder', `${this.path} doesn’t exist any more. Remove the project, or put the folder back.`);
    this.opened = this.openStore(this.dbPath);
    return this.opened;
  }

  hasStore(): boolean {
    return this.opened !== null || existsSync(this.dbPath);
  }

  facts(options: { keep?: string | null } = {}): StoreFacts {
    return this.hasStore() ? storeFacts(this.store(), Date.now(), options) : emptyStoreFacts();
  }

  goldens(): number {
    return countGoldens(this.path);
  }

  cliArgs(args: readonly string[]): string[] {
    return ['--db', this.dbPath, ...args];
  }

  close(): void {
    this.opened?.close();
    this.opened = null;
  }
}

export interface ProjectHostOptions<C> {
  registry: ProjectRegistry;
  /** Reads a project's configuration from its folder: the CLI's `loadConfig`. */
  loadConfig: (cwd: string) => C;
  /** The project the dashboard opens on. */
  current: string;
  /** Stores somewhere else than in the project's folder, by project id: the one `--db` named. */
  dbPaths?: Record<string, string>;
  openStore?: (dbPath: string) => Store;
  /** The file whose changes make the configuration be read again. */
  configFile?: string;
  /** The folder the dashboard started in: added again if the list loses every project. */
  startFolder?: string;
}

/** What the switcher and the Remove dialog count for a project (the dashboard's `ProjectStats`). */
export interface ProjectCounts {
  /** Runs, attempts left out. */
  runs: number;
  attempts: number;
  /** Goldens in the project's repository. */
  goldens: number;
  /** The folder is gone from disk. */
  missing: boolean;
}

export class ProjectHost<C = unknown> {
  private readonly contexts = new Map<string, Context<C>>();
  private currentId: string;
  /** The store `--db` named, by project id, with the folder it was named for. */
  private readonly customDb = new Map<string, { path: string; dbPath: string }>();

  constructor(private readonly options: ProjectHostOptions<C>) {
    const entry = options.registry.get(options.current);
    if (!entry) throw new ProjectError('not-found', `No project ${options.current}.`);
    this.currentId = options.current;
    for (const [id, dbPath] of Object.entries(options.dbPaths ?? {})) {
      const p = id === entry.id ? entry : options.registry.get(id);
      if (p) this.customDb.set(id, { path: p.path, dbPath });
    }
  }

  /**
   * The host for a dashboard started in `folder`: the folder becomes a project if it isn't one
   * (it was chosen in a terminal, so the dashboard's limits on adding don't apply) and is current.
   * `dbPath` is the store `--db` named, if any.
   */
  static open<C>(folder: string, options: Omit<ProjectHostOptions<C>, 'current' | 'startFolder'> & { dbPath?: string }): ProjectHost<C> {
    const entry = options.registry.ensure(folder, options.dbPath ? { dbPath: options.dbPath } : {});
    const { dbPath, ...rest } = options;
    const dbPaths = { ...(options.dbPaths ?? {}), ...(dbPath && resolve(dbPath) !== projectDbPath(entry.path) ? { [entry.id]: resolve(dbPath) } : {}) };
    return new ProjectHost<C>({ ...rest, dbPaths, current: entry.id, startFolder: entry.path });
  }

  get registry(): ProjectRegistry {
    return this.options.registry;
  }

  /** The projects, in the order they were added. */
  list(): ProjectEntry[] {
    return this.options.registry.list();
  }

  /** The current project's id. When it left the list (another dashboard or the CLI removed it), the first project left becomes current. */
  currentProject(): string {
    if (this.options.registry.get(this.currentId)) return this.currentId;
    const first = this.list()[0] ?? (this.options.startFolder ? this.options.registry.ensure(this.options.startFolder) : null);
    if (!first) throw new ProjectError('not-found', `No project ${this.currentId}.`);
    this.currentId = first.id;
    return this.currentId;
  }

  current(): ProjectContext<C> {
    return this.context(this.currentProject());
  }

  /**
   * The context for any project, current or not. The list is shared with the CLI and other
   * dashboards, so it is read each time: a project removed elsewhere is gone here too, and an id
   * that now names another folder gets a context of its own.
   */
  context(id: string): ProjectContext<C> {
    const entry = this.options.registry.get(id);
    const known = this.contexts.get(id);
    if (!entry) {
      known?.close();
      this.contexts.delete(id);
      throw new ProjectError('not-found', `No project ${id}.`);
    }
    if (known && known.path === entry.path) return known;
    known?.close();
    const custom = this.customDb.get(id);
    const dbPath = custom && custom.path === entry.path ? custom.dbPath : projectDbPath(entry.path);
    const ctx = new Context<C>(entry, dbPath, this.options.loadConfig, this.options.openStore ?? ((p) => Store.open(p)), this.options.configFile ?? 'shadowlap.config.json');
    this.contexts.set(id, ctx);
    return ctx;
  }

  /** Makes a project current. The stores of the others stay open for the switcher's counts. */
  switchTo(id: string): ProjectContext<C> {
    const ctx = this.context(id);
    this.currentId = id;
    return ctx;
  }

  /** Runs, attempts and goldens for every project, for the switcher and the Remove dialog. A store that can't be read counts nothing. */
  stats(): Record<string, ProjectCounts> {
    const out: Record<string, ProjectCounts> = {};
    for (const p of this.list()) {
      const missing = !existsSync(p.path);
      let facts: StoreFacts = emptyStoreFacts();
      if (!missing) {
        try {
          facts = this.context(p.id).facts();
        } catch {
          // a store from a newer version, or one that isn't a database: the switcher still lists it
        }
      }
      out[p.id] = { runs: facts.runs, attempts: facts.attempts, goldens: missing ? 0 : countGoldens(p.path), missing };
    }
    return out;
  }

  /** Where a project's setup is, from the list and its store. */
  setup(id: string): EffectiveSetup {
    const entry = this.options.registry.get(id);
    if (!entry) throw new ProjectError('not-found', `No project ${id}.`);
    return deriveSetup(entry.setup, this.context(id).facts({ keep: entry.setup.runId }));
  }

  /**
   * Recording from a project's setup: what typing `line` runs in its folder ({@link planRecording}),
   * with the commands already confirmed there and the model server `init` found. The job runs
   * `context.cliArgs(plan.args)` in `plan.cwd` with `plan.env` added; when `plan.confirm` is set,
   * ask first, then `registry.confirmCommand(id, plan.argv)`.
   */
  planRecording(id: string, line: string): RecordPlanResult {
    const entry = this.options.registry.get(id);
    if (!entry) throw new ProjectError('not-found', `No project ${id}.`);
    return planRecording(entry, line, { home: this.options.registry.home, modelServer: entry.setup.findings?.modelServer ?? null });
  }

  /**
   * Skip the rest, or Go to the overview: the project is set up (see `ProjectRegistry.finishSetup`).
   * The setup offers both only once its first recording has finished, so this refuses before then:
   * a request can't skip recording.
   */
  finishSetup(id: string): ProjectEntry {
    const setup = this.setup(id);
    if (setup.stage === 'done') return this.options.registry.get(id)!;
    if (!setup.run || setup.live || !stageAtLeast(setup.stage, 'recorded')) throw new ProjectError('setup', 'Record a first run before finishing the setup.');
    return this.options.registry.finishSetup(id, { runId: setup.run.runId });
  }

  /** Adds a folder picked in the dashboard (see `ProjectRegistry.add`) and returns its context too. */
  add(folder: string): AddedProject & { context: ProjectContext<C> } {
    const added = this.options.registry.add(folder);
    return { ...added, context: this.context(added.project.id) };
  }

  /**
   * Removes a project (see `ProjectRegistry.remove`). Its store is closed first, so deleting the
   * recordings never pulls a file from under an open connection, and when it was current, the
   * first remaining project becomes current.
   */
  remove(id: string, options: { deleteRecordings?: boolean; typedName?: string } = {}): RemovedProject & { current: string } {
    const entry = this.options.registry.get(id);
    const custom = this.customDb.get(id);
    if (options.deleteRecordings && entry && custom && custom.path === entry.path) throw new ProjectError('store', `This project’s store is ${custom.dbPath}, outside its folder. Delete it yourself if you mean to.`);
    this.contexts.get(id)?.close();
    const removed = this.options.registry.remove(id, options);
    this.contexts.delete(id);
    this.customDb.delete(id);
    return { ...removed, current: this.currentProject() };
  }

  /** Closes every store. */
  close(): void {
    for (const ctx of this.contexts.values()) ctx.close();
    this.contexts.clear();
  }
}
