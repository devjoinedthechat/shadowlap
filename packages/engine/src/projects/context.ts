import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { messageOf } from '../message-of.js';
import { Store } from '../store.js';
import { countGoldens, listPacks } from './folders.js';
import { displayPath, projectDbPath } from './paths.js';
import { freeGoldenPath, planRecording, type RecordPlanResult } from './record.js';
import { madeFiles } from './recordings.js';
import { ProjectError, type AddedProject, type ProjectEntry, type ProjectRegistry, type RemovedProject } from './registry.js';
import { deriveSetup, emptyStoreFacts, storeFacts, type EffectiveSetup, type PackFact, type StoreFacts } from './setup.js';
import { readStoreFacts } from './store-reader.js';

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
  /**
   * Its store, opened on first use. A project whose folder is gone has none: this throws, also
   * when the folder went away (moved, deleted) after the store was opened.
   */
  store(): Store;
  /** Whether the store exists yet, without creating it. */
  hasStore(): boolean;
  /**
   * What the store says about runs and the setup; empty facts while there is no store. From the
   * open store when there is one, else read without opening it for writing: counting another
   * project's runs never migrates its store. `keep` is the setup's recording. A store that can't be
   * read (from a newer Shadowlap, or not a database) throws a `ProjectError` with code `store`.
   */
  facts(options?: { keep?: string | null }): StoreFacts;
  /** Goldens in the project's repository (packs under `goldens/`). */
  goldens(): number;
  /** Those packs with the runs each holds. */
  packs(): PackFact[];
  /** CLI arguments for a job in this project: its store first, so the job writes where it reads. */
  cliArgs(args: readonly string[]): string[];
  /** Closes the store; the next use opens it again. */
  close(): void;
}

class Context<C> implements ProjectContext<C> {
  private opened: Store | null = null;
  private cached: { key: string; value: C } | null = null;
  /**
   * The host let go of it (the project was removed, or its id now names another folder): its store
   * is never opened again, so nothing still holding the context, a dashboard's timer or a request
   * already under way, can bring back a store whose recordings were just deleted.
   */
  private retired = false;

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

  /**
   * The open store, while it is still where the project keeps it. One whose file went away while it
   * was open (the folder moved or deleted, the store deleted) is closed: what it holds is no longer
   * the project's, and what was written to it would be lost.
   */
  private stillOpen(): Store | null {
    if (!this.opened) return null;
    if (this.dbPath === ':memory:' || existsSync(this.dbPath)) return this.opened;
    this.close();
    return null;
  }

  store(): Store {
    if (this.retired) throw new ProjectError('not-found', `${this.name} is no longer in the dashboard.`);
    const open = this.stillOpen();
    if (open) return open;
    // Opening a store creates its folder; a project whose folder was deleted must not get it back.
    if (!existsSync(this.path)) throw new ProjectError('folder', `${this.path} doesn’t exist any more. Remove the project, or put the folder back.`);
    this.opened = this.openStore(this.dbPath);
    return this.opened;
  }

  hasStore(): boolean {
    return this.stillOpen() !== null || existsSync(this.dbPath);
  }

  facts(options: { keep?: string | null } = {}): StoreFacts {
    const open = this.stillOpen();
    if (open) return storeFacts(open, Date.now(), options);
    if (!existsSync(this.path)) return emptyStoreFacts();
    try {
      return readStoreFacts(this.dbPath, Date.now(), options);
    } catch (err) {
      throw new ProjectError('store', `Shadowlap can’t read ${this.name}’s store: ${messageOf(err)}`);
    }
  }

  goldens(): number {
    return countGoldens(this.path);
  }

  packs(): PackFact[] {
    return listPacks(this.path);
  }

  cliArgs(args: readonly string[]): string[] {
    return ['--db', this.dbPath, ...args];
  }

  close(): void {
    this.opened?.close();
    this.opened = null;
  }

  /** Closes the store for good: the host no longer serves this context. */
  retire(): void {
    this.close();
    this.retired = true;
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
  /**
   * The project for the start folder, kept in memory only, when the project list can't be read or
   * changed ({@link ProjectHost.open} sets it): the dashboard serves it with {@link notice} shown.
   */
  standIn?: ProjectEntry;
  /** Why the project list can't be used. */
  notice?: string;
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
  /**
   * Its setup shows ("setting up"): not finished, or finished with no runs left, which starts it
   * again (`deriveSetup`). While its store can't be read, what the list says.
   */
  settingUp: boolean;
  /** Why its store can't be read, or null: the switcher says so rather than "no runs yet". */
  unreadable: string | null;
  /**
   * Folders beside the store with what Shadowlap made from its runs (`.shadowlap/repairs`,
   * `.shadowlap/exports`), which deleting the recordings leaves: the Remove dialog says so.
   */
  madeFiles: string[];
}

export class ProjectHost<C = unknown> {
  private readonly contexts = new Map<string, Context<C>>();
  private currentId: string;
  /** The store `--db` named, by project id, with the folder it was named for. */
  private readonly customDb = new Map<string, { path: string; dbPath: string }>();
  /** What else holds the projects' stores, each to let go of one as its project is removed ({@link holdStores}). */
  private readonly holders = new Set<(dbPath: string) => Promise<void>>();

  constructor(private readonly options: ProjectHostOptions<C>) {
    const entry = this.entry(options.current);
    if (!entry) throw new ProjectError('not-found', `No project ${options.current}.`);
    this.currentId = options.current;
    for (const [id, dbPath] of Object.entries(options.dbPaths ?? {})) {
      const p = id === entry.id ? entry : this.entry(id);
      if (p) this.customDb.set(id, { path: p.path, dbPath });
    }
  }

  /**
   * The host for a dashboard started in `folder`: the folder becomes a project if it isn't one
   * (it was chosen in a terminal, so the dashboard's limits on adding don't apply) and is current.
   * `dbPath` is the store `--db` named, if any. When the project list can't be read (it isn't valid
   * JSON) or changed (a newer Shadowlap wrote it) and the folder isn't in it, the dashboard still
   * opens on the folder, as it always did, with {@link notice} saying why it lists nothing else.
   */
  static open<C>(folder: string, options: Omit<ProjectHostOptions<C>, 'current' | 'startFolder' | 'standIn' | 'notice'> & { dbPath?: string }): ProjectHost<C> {
    const { dbPath, ...rest } = options;
    const db = dbPath ? { dbPath } : {};
    let entry: ProjectEntry;
    let fallback: { standIn: ProjectEntry; notice: string } | null = null;
    try {
      entry = options.registry.ensure(folder, db);
    } catch (err) {
      if (!(err instanceof ProjectError) || err.code !== 'registry') throw err;
      entry = options.registry.unlisted(folder, db);
      fallback = { standIn: entry, notice: `${err.message} Until it is fixed and the dashboard started again, it shows ${displayPath(entry.path, options.registry.home)} only, and can’t add or remove projects or keep a setup’s progress.` };
    }
    const dbPaths = { ...(options.dbPaths ?? {}), ...(dbPath && resolve(dbPath) !== projectDbPath(entry.path) ? { [entry.id]: resolve(dbPath) } : {}) };
    return new ProjectHost<C>({ ...rest, dbPaths, current: entry.id, startFolder: entry.path, ...(fallback ?? {}) });
  }

  get registry(): ProjectRegistry {
    return this.options.registry;
  }

  /**
   * Why the project list can't be used, when it can't: the dashboard shows it as a notice. The
   * stand-in's while the dashboard serves one; else why the list can't be changed now (a newer
   * Shadowlap wrote it), or null.
   */
  get notice(): string | null {
    return this.options.notice ?? this.options.registry.problem();
  }

  /** The projects, in the order they were added; with the stand-in first when the list can't be used. */
  list(): ProjectEntry[] {
    return this.entries();
  }

  private entries(): ProjectEntry[] {
    const standIn = this.options.standIn;
    let listed: ProjectEntry[];
    try {
      listed = this.options.registry.list();
    } catch (err) {
      if (standIn) return [standIn];
      throw err;
    }
    // Once the list has the start folder (fixed, and the folder added), its own entry serves it.
    return standIn && !listed.some((p) => p.path === standIn.path) ? [standIn, ...listed] : listed;
  }

  private entry(id: string): ProjectEntry | null {
    return this.entries().find((p) => p.id === id) ?? null;
  }

  private need(id: string): ProjectEntry {
    const entry = this.entry(id);
    if (!entry) throw new ProjectError('not-found', `No project ${id}.`);
    return entry;
  }

  /** Changes to a project go to the list: the stand-in for a list that can't be used has none to go to. */
  private writable(id: string): void {
    const standIn = this.options.standIn;
    if (!standIn || standIn.id !== id) return;
    let listed = false;
    try {
      listed = this.options.registry.get(id)?.path === standIn.path;
    } catch {
      // still unreadable
    }
    if (!listed) throw new ProjectError('registry', this.options.notice ?? 'The project list can’t be changed.');
  }

  /** The current project's id. When it left the list (another dashboard or the CLI removed it), the first project left becomes current. */
  currentProject(): string {
    if (this.entry(this.currentId)) return this.currentId;
    const standIn = this.options.standIn;
    const listed = standIn ? this.entries().find((p) => p.path === standIn.path) : undefined;
    const first = listed ?? this.entries()[0] ?? (this.options.startFolder ? this.options.registry.ensure(this.options.startFolder) : null);
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
    const entry = this.entry(id);
    const known = this.contexts.get(id);
    if (!entry) {
      known?.retire();
      this.contexts.delete(id);
      throw new ProjectError('not-found', `No project ${id}.`);
    }
    if (known && known.path === entry.path) return known;
    known?.retire();
    const custom = this.customDb.get(id);
    const dbPath = custom && custom.path === entry.path ? custom.dbPath : projectDbPath(entry.path);
    const ctx = new Context<C>(entry, dbPath, this.options.loadConfig, this.options.openStore ?? ((p) => Store.open(p)), this.options.configFile ?? 'shadowlap.config.json');
    this.contexts.set(id, ctx);
    return ctx;
  }

  /** Makes a project current. The stores of the others stay as they are: their counts are read without opening them. */
  switchTo(id: string): ProjectContext<C> {
    const ctx = this.context(id);
    this.currentId = id;
    return ctx;
  }

  /**
   * Runs, attempts and goldens for every project, whether its setup shows, and what deleting its
   * recordings would leave, for the switcher and the Remove dialog. A store that can't be read
   * counts nothing and says why (`unreadable`); the switcher still lists the project. `facts` are
   * what stores said read elsewhere, by project id (a dashboard reads them beside its server, since
   * they read every run): a project without them has its store read here.
   */
  stats(o: { facts?: Readonly<Record<string, StoreFacts>> } = {}): Record<string, ProjectCounts> {
    const out: Record<string, ProjectCounts> = {};
    for (const p of this.entries()) out[p.id] = this.counts(p, o.facts?.[p.id]);
    return out;
  }

  /** One project's counts, as {@link stats} gives every project's: for the Remove dialog, which needs only its own. */
  statsOf(id: string): ProjectCounts {
    return this.counts(this.need(id));
  }

  private counts(p: ProjectEntry, read?: StoreFacts): ProjectCounts {
    const missing = !existsSync(p.path);
    let facts: StoreFacts = emptyStoreFacts();
    let unreadable: string | null = null;
    if (!missing) {
      try {
        facts = read ?? this.context(p.id).facts();
      } catch (err) {
        // a store from a newer version, or one that isn't a database
        unreadable = messageOf(err);
      }
    }
    // As `deriveSetup` has it: done only once finished with runs; a finished project with none left starts again.
    const settingUp = unreadable ? p.setup.stage !== 'done' : !(p.setup.stage === 'done' && facts.runs > 0);
    return { runs: facts.runs, attempts: facts.attempts, goldens: missing ? 0 : countGoldens(p.path), missing, settingUp, unreadable, madeFiles: missing ? [] : madeFiles(p.path) };
  }

  /**
   * Where a project's setup is, from the list, its store and the goldens in its repository. `facts`:
   * what its store said read elsewhere, keeping the setup's recording (`keep`), as {@link stats} takes them.
   */
  setup(id: string, o: { facts?: StoreFacts } = {}): EffectiveSetup {
    const entry = this.need(id);
    const ctx = this.context(id);
    return deriveSetup(entry.setup, o.facts ?? ctx.facts({ keep: entry.setup.runId }), { packs: existsSync(entry.path) ? ctx.packs() : [] });
  }

  /**
   * The golden's path the setup's last step offers: `goldens/<project>`, or the first free one
   * after it when a golden from an earlier setup is there (`freeGoldenPath`). The one the setup
   * kept, once it kept one. `facts` as {@link setup} takes them.
   */
  suggestGolden(id: string, o: { facts?: StoreFacts } = {}): string {
    const entry = this.need(id);
    const setup = this.setup(id, o);
    return setup.golden ?? freeGoldenPath(entry.path, entry.id, setup.run?.runId ?? null);
  }

  /**
   * Recording from a project's setup: what typing `line` runs in its folder ({@link planRecording}),
   * with the commands already confirmed there and the model server `init` found. The job runs
   * `context.cliArgs(plan.args)` in `plan.cwd` with `plan.env` added; when `plan.confirm` is set,
   * ask first, then {@link confirmCommand}.
   */
  planRecording(id: string, line: string): RecordPlanResult {
    const entry = this.need(id);
    return planRecording(entry, line, { home: this.options.registry.home, modelServer: entry.setup.findings?.modelServer ?? null });
  }

  /** The person confirmed a planned recording: the same command, through the same model server, runs there again without asking. */
  confirmCommand(id: string, plan: { argv: readonly string[]; upstream: string | null }): ProjectEntry {
    this.writable(id);
    return this.options.registry.confirmCommand(id, plan.argv, { upstream: plan.upstream });
  }

  /**
   * Skip setup, or Go to Overview: the project is set up (see `ProjectRegistry.finishSetup`),
   * with the recording, golden and steps the setup found. The setup offers both only once its first
   * recording has finished with calls in it, so this refuses before then: a request can't skip
   * recording.
   */
  finishSetup(id: string): ProjectEntry {
    const setup = this.setup(id);
    if (setup.stage === 'done') return this.need(id);
    if (!setup.run || setup.live || !setup.steps.recorded) throw new ProjectError('setup', 'Record a first run before finishing the setup.');
    this.writable(id);
    return this.options.registry.finishSetup(id, { runId: setup.run.runId, golden: setup.golden, skipped: !setup.steps.tested });
  }

  /** Adds a folder picked in the dashboard (see `ProjectRegistry.add`) and returns its context too. */
  add(folder: string): AddedProject & { context: ProjectContext<C> } {
    const added = this.options.registry.add(folder);
    return { ...added, context: this.context(added.project.id) };
  }

  /**
   * Has `letGo` let go of a project's store as the project is removed ({@link remove}), done once
   * nothing it holds is open on the store: a dashboard reads and writes its stores on threads of its
   * own, each through a connection of its own. Returns what stops it.
   */
  holdStores(letGo: (dbPath: string) => Promise<void>): () => void {
    this.holders.add(letGo);
    return () => {
      this.holders.delete(letGo);
    };
  }

  /**
   * Removes a project (see `ProjectRegistry.remove`). Its store is closed first, and is never opened
   * from here again once the project is off the list; what else holds it ({@link holdStores}) lets
   * go of it then, and only after that are the recordings deleted. So deleting them never pulls a
   * file from under an open connection, and no connection opened late makes an empty store in its
   * place, as a dashboard's thread did. When it was current, the first remaining project becomes
   * current.
   */
  async remove(id: string, options: { deleteRecordings?: boolean; typedName?: string } = {}): Promise<RemovedProject & { current: string }> {
    const entry = this.entry(id);
    this.writable(id);
    const custom = this.customDb.get(id);
    if (options.deleteRecordings && entry && custom && custom.path === entry.path) throw new ProjectError('store', `This project’s store is ${custom.dbPath}, outside its folder. Delete it yourself if you mean to.`);
    const dbPath = entry ? this.context(id).dbPath : null;
    this.contexts.get(id)?.close();
    const project = this.options.registry.removeFromList(id, options);
    this.contexts.get(id)?.retire();
    this.contexts.delete(id);
    this.customDb.delete(id);
    // One that fails to let go still has the recordings deleted, and a file that can't be says so.
    if (dbPath) await Promise.allSettled([...this.holders].map((letGo) => letGo(dbPath)));
    return { project, deleted: options.deleteRecordings ? this.options.registry.deleteRecordingsOf(project) : [], current: this.currentProject() };
  }

  /** Closes every store, for good. */
  close(): void {
    for (const ctx of this.contexts.values()) ctx.retire();
    this.contexts.clear();
  }
}
