import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import { resolveAuthor } from '../author.js';
import { recordEvent, type RecordEventInput } from '../events.js';
import { Store } from '../store.js';
import { writeFileAtomic, withFileLock } from './files.js';
import { checkFolder, countGoldens, projectRoots, type ProjectRoots } from './folders.js';
import { displayPath, expandHome, projectDbPath, realpathOrNull, shadowlapHome } from './paths.js';
import { RecordingsError, deleteRecordings, storeFilesToDelete } from './recordings.js';
import { sameArgv } from './record.js';
import { emptyStoreFacts, initialSetup, isSetupStage, laterStage, stageAtLeast, storeFacts, unwrappedTools, type SetupFindings, type SetupStage, type StoreFacts } from './setup.js';

/**
 * The projects opened in the dashboard on this machine: `projects.json` in Shadowlap's home folder
 * (`~/.shadowlap`, or `SHADOWLAP_HOME`). Each project is a folder with its own store in it, so the
 * list holds only what the folder doesn't: where the project is, how far its setup got, and the
 * commands confirmed for recording there. Removing a project forgets the folder; adding it again
 * brings its runs back, because they never left it.
 *
 * The file is written atomically and owner-only (0600), one writer at a time, and kept as JSON a
 * person can read: unknown keys are preserved, so a newer version's additions survive an older
 * one's write. Adding, finishing the setup of, and removing a project are recorded as activity
 * (`project.added`, `project.setup`, `project.removed`) in that project's own store.
 */

export const REGISTRY_FILE = 'projects.json';
export const REGISTRY_VERSION = 1;
/** Confirmed commands kept per project; the oldest go first. */
const MAX_CONFIRMED = 20;
const MAX_TOOLS = 200;
const MAX_WRAP_CHARS = 20_000;

/** How far a project's setup got, and what it made on the way. */
export interface ProjectSetup {
  stage: SetupStage;
  /** The setup's recording (step 2), once there is one. */
  runId: string | null;
  /** The command it recorded, as arguments. */
  command: string[] | null;
  /** Tools that weren't wrapped when it was recorded: their calls aren't in the recording. */
  unwrappedAtRecord: string[];
  /** What `shadowlap init` found, the last time it ran in the folder. */
  findings: SetupFindings | null;
  /** What calibrate added to make the replay clean; an empty list when it was clean as recorded. */
  calibration: { added: Array<{ path: string; why: string | null }> } | null;
  /** The golden kept as a test (step 4), relative to the folder. */
  golden: string | null;
  /** Finished with Skip the rest, before a golden was kept. */
  skipped: boolean;
  updatedAt: number;
}

/** A command confirmed for recording in a project's folder: it runs there again without asking. */
export interface ConfirmedCommand {
  argv: string[];
  at: number;
}

export interface ProjectEntry {
  /** Unique in the list, safe in a URL: the folder's name, made unique (`agent`, `agent-2`). */
  id: string;
  /** The folder's name, as the switcher shows it. */
  name: string;
  /** The folder's real path. */
  path: string;
  addedAt: number;
  setup: ProjectSetup;
  confirmed: ConfirmedCommand[];
}

export type ProjectErrorCode = 'not-found' | 'exists' | 'only-project' | 'folder' | 'name-mismatch' | 'recording' | 'store' | 'registry';

const STATUS: Record<ProjectErrorCode, number> = { 'not-found': 404, exists: 409, 'only-project': 409, folder: 400, 'name-mismatch': 400, recording: 409, store: 409, registry: 500 };

/** A change to the project list that can't be made, with the HTTP status the dashboard answers it with. */
export class ProjectError extends Error {
  readonly status: number;
  constructor(
    readonly code: ProjectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectError';
    this.status = STATUS[code];
  }
}

export interface AddedProject {
  project: ProjectEntry;
  /** The folder was a project here before: its runs come back with it. */
  again: boolean;
  /** Runs already in its store. */
  runs: number;
}

export interface RemovedProject {
  project: ProjectEntry;
  /** Store files deleted with it, relative to its folder; empty unless its recordings were deleted. */
  deleted: string[];
}

export interface RegistryOptions {
  env?: NodeJS.ProcessEnv;
  /** The user's home folder: `~` in paths, and the folders suggestions and adds may reach. */
  home?: string;
  /** Where `projects.json` lives; defaults to `SHADOWLAP_HOME`, else `~/.shadowlap`. */
  dir?: string;
  now?: () => number;
  /** Who adds and removes projects, for the activity log; resolveAuthor in the folder by default. */
  actor?: (folder: string) => string | null;
  /** How long to wait for another process to finish changing the list. */
  lockTimeoutMs?: number;
}

type Raw = Record<string, unknown>;
interface State {
  raw: Raw;
  projects: ProjectEntry[];
}

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function emptySetup(at: number): ProjectSetup {
  return { stage: 'added', runId: null, command: null, unwrappedAtRecord: [], findings: null, calibration: null, golden: null, skipped: false, updatedAt: at };
}

function toSetup(raw: unknown, fallbackAt: number): ProjectSetup {
  const r = isObject(raw) ? raw : {};
  const calibration = isObject(r.calibration) && Array.isArray(r.calibration.added) ? { added: r.calibration.added.filter(isObject).map((a) => ({ path: String(a.path ?? ''), why: str(a.why) })) } : null;
  return {
    stage: isSetupStage(r.stage) ? r.stage : 'added',
    runId: str(r.runId),
    command: Array.isArray(r.command) ? strings(r.command) : null,
    unwrappedAtRecord: strings(r.unwrappedAtRecord),
    findings: isObject(r.findings) ? (r.findings as unknown as SetupFindings) : null,
    calibration,
    golden: str(r.golden),
    skipped: r.skipped === true,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : fallbackAt,
  };
}

/** A project as read from the file, or null for an entry this version can't use (kept as it is on write). */
function toEntry(raw: unknown): ProjectEntry | null {
  if (!isObject(raw)) return null;
  const id = str(raw.id);
  const path = str(raw.path);
  if (!id || id.length > 100 || /[/\\?#%\s]/.test(id) || !path || !isAbsolute(path)) return null;
  const addedAt = typeof raw.addedAt === 'number' ? raw.addedAt : 0;
  return {
    id,
    name: str(raw.name) ?? (basename(path) || path),
    path,
    addedAt,
    setup: toSetup(raw.setup, addedAt),
    confirmed: Array.isArray(raw.confirmed) ? raw.confirmed.filter(isObject).map((c) => ({ argv: strings(c.argv), at: typeof c.at === 'number' ? c.at : 0 })).filter((c) => c.argv.length > 0) : [],
  };
}

/** A folder name as an id: lowercase letters, digits, dots, dashes and underscores. */
export function projectSlug(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48);
  return s || 'project';
}

function uniqueId(name: string, taken: readonly ProjectEntry[]): string {
  const base = projectSlug(name);
  let id = base;
  for (let n = 2; taken.some((p) => p.id === id); n++) id = `${base}-${n}`;
  return id;
}

/** Findings as kept in the list: bounded, whatever a project holds. */
function boundedFindings(f: SetupFindings): SetupFindings {
  return { ...f, tools: f.tools.slice(0, MAX_TOOLS), wrap: f.wrap.map((w) => ({ ...w, code: w.code.length > MAX_WRAP_CHARS ? `${w.code.slice(0, MAX_WRAP_CHARS)}\n…` : w.code })) };
}

export type SetupPatch = Partial<Omit<ProjectSetup, 'updatedAt'>>;

export class ProjectRegistry {
  /** The folder the list lives in. */
  readonly dir: string;
  /** `projects.json`. */
  readonly file: string;
  readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly actor: (folder: string) => string | null;
  private readonly lockTimeoutMs: number;

  constructor(options: RegistryOptions = {}) {
    this.env = options.env ?? process.env;
    this.home = options.home ?? homedir();
    this.dir = options.dir ?? shadowlapHome(this.env, this.home);
    this.file = join(this.dir, REGISTRY_FILE);
    this.now = options.now ?? Date.now;
    this.actor = options.actor ?? ((folder) => resolveAuthor({ env: this.env, cwd: folder }));
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
  }

  // ---- reading ----

  /** Every project, in the order they were added. */
  list(): ProjectEntry[] {
    return this.read().projects;
  }

  get(id: string): ProjectEntry | null {
    return this.list().find((p) => p.id === id) ?? null;
  }

  /** The project in a folder, by its real path (`~` and symbolic links resolved). */
  find(folder: string): ProjectEntry | null {
    const abs = resolve(expandHome(folder, this.home));
    const real = realpathOrNull(abs) ?? abs;
    return this.list().find((p) => p.path === real || p.path === abs || realpathOrNull(p.path) === real) ?? null;
  }

  /** Folders suggestions and adds may reach: the home folder, `roots` in the file, `SHADOWLAP_PROJECT_ROOTS`. */
  roots(): ProjectRoots {
    return projectRoots({ home: this.home, configured: this.configuredRoots() });
  }

  /**
   * Roots as configured, before they are vetted: the file's `roots` (a list of paths) and
   * `SHADOWLAP_PROJECT_ROOTS` (separated like PATH). Pass them to `suggestFolders` as `roots`.
   */
  configuredRoots(): string[] {
    let fromFile: string[] = [];
    try {
      fromFile = strings(this.read().raw.roots);
    } catch {
      // an unreadable list has no roots to add
    }
    const fromEnv = (this.env.SHADOWLAP_PROJECT_ROOTS ?? '')
      .split(delimiter)
      .map((s) => s.trim())
      .filter(Boolean);
    return [...fromFile, ...fromEnv];
  }

  /** How a folder shows in the dashboard: `~/support-agent`. */
  display(folder: string): string {
    return displayPath(folder, this.home);
  }

  isConfirmed(id: string, argv: readonly string[]): boolean {
    return this.need(this.list(), id).confirmed.some((c) => sameArgv(c.argv, argv));
  }

  // ---- changing ----

  /**
   * Adds a folder picked in the dashboard: it must be an existing folder with project files, under
   * the home folder or a configured root, not hidden or a system folder ({@link checkFolder}). A
   * folder that was a project before comes back with its runs, and with its setup finished if it
   * was; one that already has recordings and goldens counts as set up.
   */
  add(folder: string): AddedProject {
    const check = checkFolder(folder, { home: this.home, roots: this.configuredRoots(), requireProjectFiles: true });
    if (!check.ok) throw new ProjectError('folder', check.why);
    return this.addFolder(check.path);
  }

  /**
   * The project for a folder the user chose outside the dashboard (`shadowlap dashboard` started
   * there): added if it isn't in the list yet, without the dashboard's limits on where it may be.
   */
  ensure(folder: string): ProjectEntry {
    const existing = this.find(folder);
    if (existing) return existing;
    const abs = resolve(expandHome(folder, this.home));
    const real = realpathOrNull(abs);
    if (!real || !statSync(real).isDirectory()) throw new ProjectError('folder', `${this.display(abs)} isn’t a folder.`);
    try {
      return this.addFolder(real).project;
    } catch (err) {
      // Another process added it in between.
      const now = err instanceof ProjectError && err.code === 'exists' ? this.find(real) : null;
      if (now) return now;
      throw err;
    }
  }

  private addFolder(real: string): AddedProject {
    // The store is read before taking the lock: opening it may wait on SQLite.
    const facts = this.factsOf(real);
    const start = initialSetup(facts, countGoldens(real));
    const at = this.now();
    const project = this.mutate((state) => {
      if (state.projects.some((p) => p.path === real)) throw new ProjectError('exists', `${this.display(real)} is already in the dashboard.`);
      const entry: ProjectEntry = {
        id: uniqueId(basename(real), state.projects),
        name: basename(real) || real,
        path: real,
        addedAt: at,
        setup: { ...emptySetup(at), stage: start.stage, runId: start.runId, golden: start.golden },
        confirmed: [],
      };
      state.projects.push(entry);
      return entry;
    });
    const again = facts.addedBefore;
    this.activity(project, { kind: 'project.added', ref: project.id, data: { path: this.display(real), name: project.name, ...(again ? { again: true } : {}) } }, true);
    return { project, again, runs: facts.runs };
  }

  /**
   * Removes a project from the list. Its folder, store, config and goldens stay, so adding the folder
   * again brings everything back. With `deleteRecordings`, its store is deleted as well, once the
   * name typed to confirm matches the project's; goldens in the repository are never touched. The
   * only project can't be removed.
   */
  remove(id: string, options: { deleteRecordings?: boolean; typedName?: string } = {}): RemovedProject {
    const list = this.list();
    const project = this.need(list, id);
    if (list.length <= 1) throw new ProjectError('only-project', 'This is the only project. Add another one first.');
    if (options.deleteRecordings) {
      if ((options.typedName ?? '').trim() !== project.name) throw new ProjectError('name-mismatch', `Type ${project.name} to confirm deleting its recordings.`);
      // Everything that could stop the deletion is checked before the project leaves the list.
      try {
        storeFilesToDelete(project.path, this.now());
      } catch (err) {
        if (err instanceof RecordingsError) throw new ProjectError(err.code, err.message);
        throw err;
      }
    }
    this.mutate((state) => {
      const i = state.projects.findIndex((p) => p.id === id);
      if (i < 0) throw new ProjectError('not-found', `No project ${id}.`);
      if (state.projects.length <= 1) throw new ProjectError('only-project', 'This is the only project. Add another one first.');
      state.projects.splice(i, 1);
    });
    if (!options.deleteRecordings) {
      this.activity(project, { kind: 'project.removed', ref: project.id, data: { path: this.display(project.path), name: project.name } }, false);
      return { project, deleted: [] };
    }
    try {
      return { project, deleted: deleteRecordings(project.path, this.now()) };
    } catch (err) {
      if (err instanceof RecordingsError) throw new ProjectError(err.code, `${project.name} was removed, but its recordings were not deleted: ${err.message}`);
      throw err;
    }
  }

  /** Merges into a project's setup. The stage only moves forward. */
  updateSetup(id: string, patch: SetupPatch): ProjectEntry {
    const at = this.now();
    return this.mutate((state) => {
      const p = this.need(state.projects, id);
      const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as SetupPatch;
      p.setup = { ...p.setup, ...defined, stage: patch.stage ? laterStage(p.setup.stage, patch.stage) : p.setup.stage, updatedAt: at };
      return p;
    });
  }

  /** Step 1: `shadowlap init` ran in the folder (again, after "I wrapped them, check again"). */
  noteInspected(id: string, findings: SetupFindings): ProjectEntry {
    return this.updateSetup(id, { stage: 'inspected', findings: boundedFindings(findings) });
  }

  /** Step 2 started: the run recording now, and the tools whose calls it won't hold. */
  noteRecording(id: string, runId: string, argv: readonly string[]): ProjectEntry {
    const p = this.need(this.list(), id);
    return this.updateSetup(id, { runId, command: [...argv], unwrappedAtRecord: unwrappedTools(p.setup.findings).map((t) => t.name) });
  }

  /** Step 2 done: the recording finished. */
  noteRecorded(id: string, runId: string): ProjectEntry {
    return this.updateSetup(id, { stage: 'recorded', runId });
  }

  /** Step 3 done: calibrate made the replay clean, adding these normalizers (none when it was clean as recorded). */
  noteCalibrated(id: string, runId: string, added: Array<{ path: string; why?: string | null }>): ProjectEntry {
    return this.updateSetup(id, { stage: 'clean', runId, calibration: { added: added.map((a) => ({ path: a.path, why: a.why ?? null })) } });
  }

  /** Step 4 done: the golden was packed and its test passed. */
  noteTested(id: string, runId: string, golden: string): ProjectEntry {
    return this.updateSetup(id, { stage: 'tested', runId, golden });
  }

  /**
   * Go to the overview, or Skip the rest: the project is set up. Logged as `project.setup` in its
   * store, which is also what brings the finished setup back if the folder is added again. The
   * dashboard offers it only after the first recording; pass that run to keep it as the setup's.
   */
  finishSetup(id: string, options: { runId?: string | null } = {}): ProjectEntry {
    const before = this.need(this.list(), id);
    const skipped = !stageAtLeast(before.setup.stage, 'tested');
    const project = this.updateSetup(id, { stage: 'done', skipped, ...(options.runId ? { runId: options.runId } : {}) });
    if (before.setup.stage !== 'done') {
      this.activity(project, { kind: 'project.setup', runId: project.setup.runId, ref: project.id, data: { stage: 'done', name: project.name, skipped, golden: project.setup.golden } }, true);
    }
    return project;
  }

  /** The person confirmed recording this command in this project's folder: it won't ask again. */
  confirmCommand(id: string, argv: readonly string[]): ProjectEntry {
    if (!argv.length) throw new ProjectError('folder', 'No command to confirm.');
    const at = this.now();
    return this.mutate((state) => {
      const p = this.need(state.projects, id);
      if (!p.confirmed.some((c) => sameArgv(c.argv, argv))) p.confirmed = [...p.confirmed, { argv: [...argv], at }].slice(-MAX_CONFIRMED);
      return p;
    });
  }

  // ---- plumbing ----

  private need(list: readonly ProjectEntry[], id: string): ProjectEntry {
    const p = list.find((x) => x.id === id);
    if (!p) throw new ProjectError('not-found', `No project ${id}.`);
    return p;
  }

  private read(): State {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { raw: { version: REGISTRY_VERSION, projects: [] }, projects: [] };
      throw new ProjectError('registry', `Can’t read ${this.file}: ${(err as Error).message}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ProjectError('registry', `${this.file} isn’t valid JSON. Fix it, or move it away to start a new list; Shadowlap won’t overwrite it.`);
    }
    if (!isObject(raw)) throw new ProjectError('registry', `${this.file} isn’t a project list. Fix it, or move it away to start a new list.`);
    const projects: ProjectEntry[] = [];
    for (const r of Array.isArray(raw.projects) ? raw.projects : []) {
      const p = toEntry(r);
      if (p && !projects.some((x) => x.id === p.id)) projects.push(p);
    }
    return { raw, projects };
  }

  /** Reads, changes and writes the list under its lock. Unknown keys, and entries this version can't read, are kept. */
  private mutate<T>(fn: (state: State) => T): T {
    try {
      return withFileLock(this.file, this.lockTimeoutMs, () => {
        const state = this.read();
        if (typeof state.raw.version === 'number' && state.raw.version > REGISTRY_VERSION) throw new ProjectError('registry', `${this.file} was written by a newer Shadowlap. Upgrade Shadowlap to change the project list.`);
        const result = fn(state);
        const rawProjects = Array.isArray(state.raw.projects) ? state.raw.projects : [];
        const byId = new Map(state.projects.map((p) => [p.id, p]));
        const written = new Set<string>();
        const out: unknown[] = [];
        for (const r of rawProjects) {
          const known = toEntry(r);
          if (!known) {
            out.push(r);
            continue;
          }
          const p = byId.get(known.id);
          if (!p || written.has(p.id)) continue; // removed, or a duplicate
          out.push({ ...(r as Raw), ...p });
          written.add(p.id);
        }
        for (const p of state.projects) if (!written.has(p.id)) out.push(p);
        writeFileAtomic(this.file, `${JSON.stringify({ ...state.raw, version: REGISTRY_VERSION, projects: out }, null, 2)}\n`);
        return result;
      });
    } catch (err) {
      if (err instanceof ProjectError) throw err;
      throw new ProjectError('registry', (err as Error).message);
    }
  }

  /** What a folder's store says, without creating a store where there is none. */
  private factsOf(folder: string): StoreFacts {
    const db = projectDbPath(folder);
    if (!existsSync(db)) return emptyStoreFacts();
    try {
      const store = Store.open(db);
      try {
        return storeFacts(store, this.now());
      } finally {
        store.close();
      }
    } catch {
      return emptyStoreFacts();
    }
  }

  /** Records an activity event in the project's store. Never fails the change it describes. */
  private activity(project: ProjectEntry, event: RecordEventInput, createStore: boolean): void {
    const db = projectDbPath(project.path);
    if (!createStore && !existsSync(db)) return;
    try {
      const store = Store.open(db);
      try {
        recordEvent(store, { actor: this.actor(project.path), ...event });
      } finally {
        store.close();
      }
    } catch {
      // a read-only folder, or a store from a newer version: the list still changes
    }
  }
}
