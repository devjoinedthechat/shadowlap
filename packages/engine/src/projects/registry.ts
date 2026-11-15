import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import { resolveAuthor } from '../author.js';
import { recordEvent, type RecordEventInput } from '../events.js';
import { messageOf } from '../message-of.js';
import { Store } from '../store.js';
import { writeFileAtomic, withFileLock } from './files.js';
import { checkFolder, countGoldens, projectRoots, type ProjectRoots } from './folders.js';
import { displayPath, expandHome, projectDbPath, realpathOrNull, shadowlapHome, shadowlapHomeProblem } from './paths.js';
import { RecordingsError, deleteRecordings, storeFilesToDelete } from './recordings.js';
import { isConfirmedCommand, modelServerFinding, type ModelServer } from './record.js';
import { earlierStage, emptyStoreFacts, initialSetup, isSetupStage, laterStage, stageAtLeast, unwrappedTools, type Inspection, type SetupFindings, type SetupStage, type StoreFacts } from './setup.js';
import { readStoreFacts } from './store-reader.js';
import { isObject } from '../is-object.js';

/**
 * The projects opened in the dashboard on this machine: `projects.json` in shadowlap's home folder
 * (`~/.shadowlap`, or `SHADOWLAP_HOME`). Each project is a folder with its own store in it, so the
 * list holds only what the folder doesn't: where the project is, how far its setup got, and the
 * commands confirmed for recording there. Removing a project takes it off the list and remembers
 * that part (`removed`); adding the folder again brings it all back, setup and confirmed commands
 * from the list and runs from the folder, which never left it, and so does the Undo of a removal
 * (`restore`), at the place it left. Deleting its recordings forgets it.
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
/** Removed projects remembered, so adding one again brings its setup back; the oldest go first. */
const MAX_REMOVED = 50;
const MAX_TOOLS = 200;
const MAX_WRAP_CHARS = 20_000;
/** Inspections kept per project, the newest; enough to tell what a recent recording was made with. */
const MAX_INSPECTIONS = 20;

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
  /** Each `init` in the folder (the newest {@link MAX_INSPECTIONS}): which tools weren't wrapped when, so a recording's own can be told. */
  inspections: Inspection[];
  /** What calibrate added to make the replay clean; an empty list when it was clean as recorded. */
  calibration: { added: Array<{ path: string; why: string | null }> } | null;
  /** The golden kept as a test (step 4), relative to the folder. */
  golden: string | null;
  /** Finished with Skip setup, before the golden's test passed (or before there was a golden). */
  skipped: boolean;
  updatedAt: number;
}

/**
 * A command confirmed for recording in a project's folder: it runs there again without asking, as
 * long as its model calls go where they went then.
 */
export interface ConfirmedCommand {
  argv: string[];
  /** The model server it was confirmed to record through (`SHADOWLAP_UPSTREAM_OPENAI`); null for the provider's API. */
  upstream: string | null;
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

export type ProjectErrorCode = 'not-found' | 'exists' | 'only-project' | 'folder' | 'name-mismatch' | 'recording' | 'store' | 'setup' | 'registry';

const STATUS: Record<ProjectErrorCode, number> = { 'not-found': 404, exists: 409, 'only-project': 409, folder: 400, 'name-mismatch': 400, recording: 409, store: 409, setup: 409, registry: 500 };

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
  /** The folder was a project here before: its runs come back with it, and its setup and confirmed commands when the list remembered them. */
  again: boolean;
  /** Runs already in its store. */
  runs: number;
}

/**
 * A project taken off the list, as the list remembers it: adding the folder again brings this back.
 * `place`: where it was among the projects listed, for an Undo that puts it back there.
 */
export type RemovedEntry = ProjectEntry & { removedAt: number; place?: number };

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

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function emptySetup(at: number): ProjectSetup {
  return { stage: 'added', runId: null, command: null, unwrappedAtRecord: [], findings: null, inspections: [], calibration: null, golden: null, skipped: false, updatedAt: at };
}

/**
 * The setup moves to another recording (recorded again, or one made in a terminal replaces the
 * first): what the list says it made for the old one, its calibration and golden, goes with it, and
 * the stage goes back to before the recording. The command typed last stays.
 */
function retarget(setup: ProjectSetup, runId: string): ProjectSetup {
  if (setup.runId === runId) return setup;
  return { ...setup, runId, stage: earlierStage(setup.stage, 'inspected'), unwrappedAtRecord: [], calibration: null, golden: null, skipped: false };
}

const EFFECTS = new Set(['pure', 'read', 'write']);

/**
 * Findings as read from the file, or null when they aren't usable (an older format, or a hand
 * edit). Each part is checked; keys this version doesn't know are kept.
 */
function toFindings(raw: unknown): SetupFindings | null {
  if (!isObject(raw) || !Array.isArray(raw.tools) || !Array.isArray(raw.wrap)) return null;
  const config = isObject(raw.config) ? raw.config : {};
  return {
    ...raw,
    at: typeof raw.at === 'number' ? raw.at : 0,
    language: str(raw.language),
    files: strings(raw.files),
    sdk: str(raw.sdk),
    framework: str(raw.framework),
    command: Array.isArray(raw.command) ? strings(raw.command) : null,
    commandFrom: str(raw.commandFrom),
    config: { ...config, file: str(config.file) ?? 'shadowlap.config.json', created: config.created === true, existed: config.existed === true },
    tools: raw.tools
      .filter(isObject)
      .filter((t) => typeof t.name === 'string' && t.name)
      .map((t) => ({ ...t, name: String(t.name), effect: EFFECTS.has(t.effect as string) ? (t.effect as SetupFindings['tools'][number]['effect']) : 'write', wrapped: t.wrapped === true, why: typeof t.why === 'string' ? t.why : '', file: typeof t.file === 'string' ? t.file : '', line: typeof t.line === 'number' ? t.line : 0 })),
    wrap: raw.wrap
      .filter(isObject)
      .filter((w) => typeof w.code === 'string')
      .map((w) => ({ ...w, language: w.language === 'python' || w.language === 'typescript' ? w.language : 'javascript', tools: strings(w.tools), code: String(w.code) })),
    modelServer: toModelServer(raw.modelServer),
    nodePin: isObject(raw.nodePin) && typeof raw.nodePin.version === 'string' ? { version: raw.nodePin.version, from: str(raw.nodePin.from) ?? '.nvmrc' } : null,
  };
}

/** A model server as read from the file: its address without credentials, and an upstream only when it is a plain http(s) URL. */
function toModelServer(raw: unknown): ModelServer | null {
  if (!isObject(raw)) return null;
  return modelServerFinding({ url: String(raw.url ?? ''), upstream: String(raw.upstream ?? ''), from: str(raw.from) ?? '' });
}

/** A setup as read from the file; keys this version doesn't know are kept. */
function toSetup(raw: unknown, fallbackAt: number): ProjectSetup {
  const r = isObject(raw) ? raw : {};
  const calibration = isObject(r.calibration) && Array.isArray(r.calibration.added) ? { ...r.calibration, added: r.calibration.added.filter(isObject).map((a) => ({ ...a, path: String(a.path ?? ''), why: str(a.why) })) } : null;
  return {
    ...r,
    stage: isSetupStage(r.stage) ? r.stage : 'added',
    runId: str(r.runId),
    command: Array.isArray(r.command) ? strings(r.command) : null,
    unwrappedAtRecord: strings(r.unwrappedAtRecord),
    findings: toFindings(r.findings),
    inspections: Array.isArray(r.inspections)
      ? r.inspections
          .filter(isObject)
          .filter((i) => typeof i.at === 'number')
          .map((i) => ({ ...i, at: i.at as number, unwrapped: strings(i.unwrapped) }))
          .slice(-MAX_INSPECTIONS)
      : [],
    calibration,
    golden: str(r.golden),
    skipped: r.skipped === true,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : fallbackAt,
  };
}

/** A project as read from the file, or null for an entry this version can't use (kept as it is on write). Unknown keys are kept. */
function toEntry(raw: unknown): ProjectEntry | null {
  if (!isObject(raw)) return null;
  const id = str(raw.id);
  const path = str(raw.path);
  if (!id || id.length > 100 || /[/\\?#%\s]/.test(id) || !path || !isAbsolute(path)) return null;
  const addedAt = typeof raw.addedAt === 'number' ? raw.addedAt : 0;
  return {
    ...raw,
    id,
    name: str(raw.name) ?? (basename(path) || path),
    path,
    addedAt,
    setup: toSetup(raw.setup, addedAt),
    confirmed: Array.isArray(raw.confirmed) ? raw.confirmed.filter(isObject).map((c) => ({ ...c, argv: strings(c.argv), upstream: str(c.upstream), at: typeof c.at === 'number' ? c.at : 0 })).filter((c) => c.argv.length > 0) : [],
  };
}

const newerList = (file: string) => `${file} was written by a newer shadowlap. Upgrade shadowlap to change the project list.`;

/**
 * The name typed in the Remove dialog confirms deleting a project's recordings once it is the
 * project's name exactly, compared composed: macOS keeps a folder named in Finder decomposed
 * (`Bu` and a combining diaeresis), while a keyboard types `ü`, and the two look the same.
 */
export function nameConfirms(typed: string, name: string): boolean {
  return typed.trim().normalize('NFC') === name.normalize('NFC');
}

/** Removed projects as the file keeps them, newest last; entries this version can't read are left out. */
function removedEntries(raw: Raw): RemovedEntry[] {
  if (!Array.isArray(raw.removed)) return [];
  return raw.removed.flatMap((r): RemovedEntry[] => {
    const entry = toEntry(r);
    if (!entry || !isObject(r)) return [];
    const place = typeof r.place === 'number' && Number.isInteger(r.place) && r.place >= 0 ? r.place : undefined;
    return [{ ...entry, removedAt: typeof r.removedAt === 'number' ? r.removedAt : 0, ...(place === undefined ? {} : { place }) }];
  });
}

/** The file's `removed` list without what it remembers of the folder at `path`. */
function forgetRemoved(raw: Raw, path: string): unknown[] {
  return (Array.isArray(raw.removed) ? raw.removed : []).filter((r) => !(isObject(r) && r.path === path));
}

/**
 * A project on the list: last, or at `place` among the projects listed, before the one there now
 * (where a removed one was, for its Undo). The file keeps its projects in the order of its list.
 */
function listAt(state: State, entry: ProjectEntry, place?: number): void {
  const next = place === undefined ? undefined : state.projects[place];
  const raw: unknown[] = Array.isArray(state.raw.projects) ? state.raw.projects : [];
  const at = next ? raw.findIndex((r) => toEntry(r)?.id === next.id) : -1;
  if (at < 0) {
    state.projects.push(entry);
    return;
  }
  state.projects.splice(place!, 0, entry);
  state.raw.projects = [...raw.slice(0, at), entry, ...raw.slice(at)];
}

/**
 * The recording the project list names as the setup's for the project in `folder` (the one the
 * dashboard recorded, calibrated or packed), for a command that takes the setup's run when none is
 * named, such as `shadowlap calibrate`. Null when the folder isn't a project, the list names none,
 * or the list can't be read. The store may hold newer recordings; `deriveSetup` says which one the
 * setup shows.
 */
export function setupRunOf(folder: string, options: RegistryOptions = {}): string | null {
  try {
    return new ProjectRegistry(options).find(folder)?.setup.runId ?? null;
  } catch {
    return null;
  }
}

/** A folder name as an id: lowercase letters, digits, dots, dashes and underscores. */
export function projectSlug(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
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

/** Findings as kept in the list: bounded, whatever a project holds, and never with a model server's credentials. */
function boundedFindings(f: SetupFindings): SetupFindings {
  return {
    ...f,
    tools: f.tools.slice(0, MAX_TOOLS),
    wrap: f.wrap.map((w) => ({ ...w, code: w.code.length > MAX_WRAP_CHARS ? `${w.code.slice(0, MAX_WRAP_CHARS)}\n…` : w.code })),
    modelServer: f.modelServer ? modelServerFinding({ url: f.modelServer.url, upstream: f.modelServer.upstream ?? '', from: f.modelServer.from }) : null,
    nodePin: f.nodePin ? { version: f.nodePin.version.slice(0, 32), from: f.nodePin.from.slice(0, 64) } : null,
  };
}

export type SetupPatch = Partial<Omit<ProjectSetup, 'updatedAt'>>;

export class ProjectRegistry {
  /** The folder the list lives in. */
  readonly dir: string;
  /** `projects.json`. */
  readonly file: string;
  readonly home: string;
  /** The home folder's real path, as project paths are kept: what the dashboard's read model shows paths against. */
  readonly realHome: string;
  /** Settings it ignored, and why: a relative `SHADOWLAP_HOME`. The dashboard shows them. */
  readonly warnings: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly actor: (folder: string) => string | null;
  private readonly lockTimeoutMs: number;
  /**
   * The list as last read, with the file's identity then: a dashboard asks for it several times a
   * request, and it is read again only once the file changed (each write replaces it).
   */
  private cached: { key: string; state: State } | null = null;

  constructor(options: RegistryOptions = {}) {
    this.env = options.env ?? process.env;
    this.home = options.home ?? homedir();
    this.realHome = realpathOrNull(this.home) ?? resolve(this.home);
    this.dir = options.dir ?? shadowlapHome(this.env, this.home);
    const problem = options.dir ? null : shadowlapHomeProblem(this.env, this.home);
    this.warnings = problem ? [problem] : [];
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

  /**
   * Why the list can't be read or changed right now, or null when it can: it isn't valid JSON, or a
   * newer shadowlap wrote it. The dashboard shows it, as every change would fail with it.
   */
  problem(): string | null {
    try {
      const { raw } = this.read();
      return typeof raw.version === 'number' && raw.version > REGISTRY_VERSION ? newerList(this.file) : null;
    } catch (err) {
      return messageOf(err);
    }
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

  /** Whether this command was confirmed in the project's folder, recording through this model server (null: the provider's API). */
  isConfirmed(id: string, argv: readonly string[], options: { upstream?: string | null } = {}): boolean {
    return isConfirmedCommand(this.need(this.list(), id).confirmed, argv, options.upstream ?? null);
  }

  // ---- changing ----

  /**
   * Adds a folder picked in the dashboard: it must be an existing folder with project files, under
   * the home folder or a configured root, not hidden or a system folder ({@link checkFolder}). A
   * folder that was a project before comes back with its runs, and with its setup finished if it
   * was. One whose store already holds runs (made in a terminal) counts as set up, as it does when
   * `shadowlap dashboard` starts there: shadowlap is in use there, so its Overview shows its runs.
   */
  add(folder: string): AddedProject {
    const check = checkFolder(folder, { home: this.home, roots: this.configuredRoots(), requireProjectFiles: true });
    if (!check.ok) throw new ProjectError('folder', check.why);
    return this.addFolder(check.path, { inUse: true });
  }

  /**
   * The project for a folder the user chose outside the dashboard (`shadowlap dashboard` started
   * there): added if it isn't in the list yet, without the dashboard's limits on where it may be.
   * Runs already in its store mean shadowlap is in use there, so it counts as set up. `dbPath` is
   * the store `--db` named, when the dashboard reads another one than the folder's.
   */
  ensure(folder: string, options: { dbPath?: string } = {}): ProjectEntry {
    const existing = this.find(folder);
    if (existing) return existing;
    const real = this.startFolder(folder);
    try {
      return this.addFolder(real, { inUse: true, ...(options.dbPath ? { dbPath: resolve(options.dbPath) } : {}) }).project;
    } catch (err) {
      // Another process added it in between.
      const now = err instanceof ProjectError && err.code === 'exists' ? this.find(real) : null;
      if (now) return now;
      throw err;
    }
  }

  /**
   * The entry {@link ensure} would add for a folder, built in memory and never written: what the
   * dashboard serves when the list can't be read or changed. Its id is unique among the projects
   * the list still shows.
   */
  unlisted(folder: string, options: { dbPath?: string } = {}): ProjectEntry {
    const real = this.startFolder(folder);
    let taken: ProjectEntry[] = [];
    try {
      taken = this.list();
    } catch {
      // unreadable: nothing to clash with
    }
    return this.newEntry(real, taken, this.startOf(real, options.dbPath ? resolve(options.dbPath) : projectDbPath(real), true).start);
  }

  /** The real path of a folder a dashboard starts in; it must be a folder. */
  private startFolder(folder: string): string {
    const abs = resolve(expandHome(folder, this.home));
    const real = realpathOrNull(abs);
    if (!real || !statSync(real).isDirectory()) throw new ProjectError('folder', `${this.display(abs)} isn’t a folder.`);
    return real;
  }

  /** Where a folder's setup starts, from what its store and repository say (read before any lock is taken: it may wait on SQLite). */
  private startOf(real: string, dbPath: string, inUse: boolean): { facts: StoreFacts; start: ReturnType<typeof initialSetup> } {
    const facts = this.factsOf(dbPath);
    return { facts, start: initialSetup(facts, countGoldens(real), { inUse }) };
  }

  /** A new entry for a folder, with an id unique among `taken`. Its name is the folder's, composed (see {@link nameConfirms}). */
  private newEntry(real: string, taken: readonly ProjectEntry[], start: ReturnType<typeof initialSetup>): ProjectEntry {
    const at = this.now();
    const name = (basename(real) || real).normalize('NFC');
    return {
      id: uniqueId(name, taken),
      name,
      path: real,
      addedAt: at,
      setup: { ...emptySetup(at), stage: start.stage, runId: start.runId, golden: start.golden },
      confirmed: [],
    };
  }

  /**
   * The entry the list remembered for a folder removed earlier, back on the list: its setup and
   * confirmed commands as they were, its id if no other project took it meanwhile. A setup finished
   * since (the store says so) comes back finished.
   */
  private restoredEntry(remembered: RemovedEntry, taken: readonly ProjectEntry[], facts: StoreFacts): ProjectEntry {
    const { removedAt: _removedAt, place: _place, ...entry } = remembered;
    const finished = facts.setupEvent && remembered.setup.stage !== 'done' ? initialSetup(facts, 0) : null;
    return {
      ...entry,
      id: taken.some((p) => p.id === remembered.id) ? uniqueId(remembered.name, taken) : remembered.id,
      addedAt: this.now(),
      setup: finished ? { ...remembered.setup, stage: 'done', runId: finished.runId ?? remembered.setup.runId, golden: finished.golden ?? remembered.setup.golden } : remembered.setup,
    };
  }

  private addFolder(real: string, options: { inUse?: boolean; dbPath?: string; place?: number } = {}): AddedProject {
    const dbPath = options.dbPath ?? projectDbPath(real);
    const { facts, start } = this.startOf(real, dbPath, !!options.inUse);
    const { project, restored, moved } = this.mutate((state) => {
      if (state.projects.some((p) => p.path === real)) throw new ProjectError('exists', `${this.display(real)} is already in the dashboard.`);
      // A project moved with a link left at its old path (`mv agent agent-v2 && ln -s agent-v2 agent`)
      // is the same folder and the same store, as find() resolves it: its entry moves to the real path
      // instead of the folder being listed twice, where deleting one entry's recordings would delete
      // the store the other still lists.
      const same = state.projects.find((p) => realpathOrNull(p.path) === real);
      if (same) {
        same.path = real;
        return { project: same, restored: false, moved: true };
      }
      const remembered = removedEntries(state.raw).filter((r) => r.path === real).at(-1) ?? null;
      const entry = remembered ? this.restoredEntry(remembered, state.projects, facts) : this.newEntry(real, state.projects, start);
      if (remembered) state.raw.removed = forgetRemoved(state.raw, real);
      listAt(state, entry, options.place);
      return { project: entry, restored: !!remembered, moved: false };
    });
    if (moved) throw new ProjectError('exists', `${this.display(real)} is already in the dashboard, as ${project.name}.`);
    const again = facts.addedBefore || restored;
    this.activity(project, { kind: 'project.added', ref: project.id, data: { path: this.display(real), name: project.name, ...(again ? { again: true } : {}) } }, true, dbPath);
    return { project, again, runs: facts.runs };
  }

  /**
   * Removes a project from the list. Its folder, store, config and goldens stay, and the list
   * remembers its setup and confirmed commands, so adding the folder again brings everything back.
   * With `deleteRecordings`, its store is deleted as well, once the name typed to confirm matches
   * the project's, and the list forgets it: adding it again starts its setup afresh. Goldens in the
   * repository are never touched. The only project can't be removed.
   */
  remove(id: string, options: { deleteRecordings?: boolean; typedName?: string } = {}): RemovedProject {
    const project = this.removeFromList(id, options);
    return { project, deleted: options.deleteRecordings ? this.deleteRecordingsOf(project) : [] };
  }

  /**
   * The Undo of {@link remove}: the project removed last under this id back on the list, at the
   * place it left, as adding its folder again brings it back (setup and confirmed commands as they
   * were, its id unless another project took it), without asking again where a folder may be: it
   * was on the list a moment ago. Refused when the list remembers no such project (it is back
   * already, was added again, or went with its recordings) and when its folder is gone. `store`:
   * the store `--db` named for a folder, read in place of the folder's own when it is this one's.
   */
  restore(id: string, options: { store?: { path: string; dbPath: string } } = {}): AddedProject {
    const remembered = removedEntries(this.read().raw).filter((r) => r.id === id).at(-1);
    if (!remembered) throw new ProjectError('not-found', `There is no removed project ${id} to put back.`);
    const real = realpathOrNull(remembered.path);
    if (real !== remembered.path || !statSync(real).isDirectory()) throw new ProjectError('folder', `${this.display(remembered.path)} isn’t on disk any more.`);
    const dbPath = options.store?.path === real ? options.store.dbPath : undefined;
    return this.addFolder(real, { inUse: true, ...(remembered.place === undefined ? {} : { place: remembered.place }), ...(dbPath ? { dbPath } : {}) });
  }

  /**
   * {@link remove} up to deleting the store, which {@link deleteRecordingsOf} does: for a caller that
   * has whatever else holds the store let go of it in between (`ProjectHost.remove`).
   */
  removeFromList(id: string, options: { deleteRecordings?: boolean; typedName?: string } = {}): ProjectEntry {
    const list = this.list();
    const project = this.need(list, id);
    if (list.length <= 1) throw new ProjectError('only-project', 'This is the only project. Add another one first.');
    if (options.deleteRecordings) {
      if (!nameConfirms(options.typedName ?? '', project.name)) throw new ProjectError('name-mismatch', `Type ${project.name} to confirm deleting its recordings.`);
      // Everything that could stop the deletion is checked before the project leaves the list.
      try {
        storeFilesToDelete(project.path, this.now());
      } catch (err) {
        if (err instanceof RecordingsError) throw new ProjectError(err.code, err.message);
        throw err;
      }
    }
    const at = this.now();
    this.mutate((state) => {
      const i = state.projects.findIndex((p) => p.id === id);
      if (i < 0) throw new ProjectError('not-found', `No project ${id}.`);
      if (state.projects.length <= 1) throw new ProjectError('only-project', 'This is the only project. Add another one first.');
      const [gone] = state.projects.splice(i, 1);
      const others = forgetRemoved(state.raw, gone!.path);
      state.raw.removed = options.deleteRecordings ? others : [...others, { ...gone, removedAt: at, place: i }].slice(-MAX_REMOVED);
    });
    if (!options.deleteRecordings) this.activity(project, { kind: 'project.removed', ref: project.id, data: { path: this.display(project.path), name: project.name } }, false);
    return project;
  }

  /** Deletes the store of a project {@link removeFromList} took off the list to delete its recordings: the files deleted, relative to its folder. */
  deleteRecordingsOf(project: ProjectEntry): string[] {
    try {
      return deleteRecordings(project.path, this.now());
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

  /**
   * Changes the setup of a project that isn't finished yet, moved to `runId` first: a finished
   * project stays as it is, whatever a late job says.
   */
  private changeSetup(id: string, runId: string, change: (setup: ProjectSetup) => ProjectSetup): ProjectEntry {
    const at = this.now();
    return this.mutate((state) => {
      const p = this.need(state.projects, id);
      if (p.setup.stage === 'done') return p;
      p.setup = { ...change(retarget(p.setup, runId)), updatedAt: at };
      return p;
    });
  }

  /** Step 1: `shadowlap init` ran in the folder (again, after Check again). */
  noteInspected(id: string, findings: SetupFindings): ProjectEntry {
    const kept = boundedFindings(findings);
    const at = this.now();
    return this.mutate((state) => {
      const p = this.need(state.projects, id);
      const inspection: Inspection = { at: kept.at, unwrapped: unwrappedTools(kept).map((t) => t.name) };
      const inspections = [...p.setup.inspections, inspection].sort((a, b) => a.at - b.at).slice(-MAX_INSPECTIONS);
      p.setup = { ...p.setup, findings: kept, inspections, stage: laterStage(p.setup.stage, 'inspected'), updatedAt: at };
      return p;
    });
  }

  /**
   * Step 2 started: the run recording now, the command it runs, and the tools whose calls it won't
   * hold. Recording again replaces the setup's recording, and what was made for the old one.
   */
  noteRecording(id: string, runId: string, argv: readonly string[]): ProjectEntry {
    return this.changeSetup(id, runId, (s) => ({ ...s, command: [...argv], unwrappedAtRecord: unwrappedTools(s.findings).map((t) => t.name) }));
  }

  /** Step 2 done: the recording finished. */
  noteRecorded(id: string, runId: string): ProjectEntry {
    return this.changeSetup(id, runId, (s) => ({ ...s, stage: laterStage(s.stage, 'recorded') }));
  }

  /** Step 3 done: calibrate made the replay clean, adding these normalizers (none when it was clean as recorded). */
  noteCalibrated(id: string, runId: string, added: Array<{ path: string; why?: string | null }>): ProjectEntry {
    return this.changeSetup(id, runId, (s) => ({ ...s, stage: laterStage(s.stage, 'clean'), calibration: { added: added.map((a) => ({ path: a.path, why: a.why ?? null })) } }));
  }

  /** Step 4 done: the golden was packed and its test passed. */
  noteTested(id: string, runId: string, golden: string): ProjectEntry {
    return this.changeSetup(id, runId, (s) => ({ ...s, stage: laterStage(s.stage, 'tested'), golden }));
  }

  /**
   * Go to Overview, or Skip setup: the project is set up. Logged as `project.setup` in its
   * store, which is also what brings the finished setup back if the folder is added again. The
   * dashboard offers it only after the first recording (`ProjectHost.finishSetup` checks), and
   * passes what the setup found: its recording, the golden kept from it, and whether the setup is
   * finished before that golden's test passed. Without them, the list's own say.
   */
  finishSetup(id: string, options: { runId?: string | null; golden?: string | null; skipped?: boolean } = {}): ProjectEntry {
    const at = this.now();
    const { project, changed } = this.mutate((state) => {
      const p = this.need(state.projects, id);
      // Finished already: whether it was skipped stays as it was, and it is logged once.
      if (p.setup.stage === 'done') return { project: p, changed: false };
      const s = options.runId ? retarget(p.setup, options.runId) : p.setup;
      const golden = options.golden !== undefined ? options.golden : s.golden;
      const skipped = options.skipped ?? !(stageAtLeast(s.stage, 'tested') && !!golden);
      p.setup = { ...s, stage: 'done', golden, skipped, updatedAt: at };
      return { project: p, changed: true };
    });
    if (changed) this.activity(project, { kind: 'project.setup', runId: project.setup.runId, ref: project.id, data: { stage: 'done', name: project.name, skipped: project.setup.skipped, golden: project.setup.golden } }, true);
    return project;
  }

  /**
   * The person confirmed recording this command in this project's folder, through this model server
   * (`plan.upstream`): it won't ask again while both stay the same.
   */
  confirmCommand(id: string, argv: readonly string[], options: { upstream?: string | null } = {}): ProjectEntry {
    if (!argv.length) throw new ProjectError('folder', 'No command to confirm.');
    const upstream = options.upstream ?? null;
    const at = this.now();
    return this.mutate((state) => {
      const p = this.need(state.projects, id);
      if (!isConfirmedCommand(p.confirmed, argv, upstream)) p.confirmed = [...p.confirmed, { argv: [...argv], upstream, at }].slice(-MAX_CONFIRMED);
      return p;
    });
  }

  // ---- plumbing ----

  private need(list: readonly ProjectEntry[], id: string): ProjectEntry {
    const p = list.find((x) => x.id === id);
    if (!p) throw new ProjectError('not-found', `No project ${id}.`);
    return p;
  }

  /** The list from the file, or as last read while the file is unchanged. A change reads it afresh (`parse`). */
  private read(): State {
    let key: string | null = null;
    try {
      const st = statSync(this.file);
      key = `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      // not there yet, or unreadable: read below says which
    }
    if (key !== null && this.cached?.key === key) return this.cached.state;
    const state = this.parse();
    this.cached = key === null ? null : { key, state };
    return state;
  }

  private parse(): State {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { raw: { version: REGISTRY_VERSION, projects: [] }, projects: [] };
      throw new ProjectError('registry', `Can’t read ${this.file}: ${messageOf(err)}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ProjectError('registry', `${this.file} isn’t valid JSON. Fix it, or move it away to start a new list; shadowlap won’t overwrite it.`);
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
        // Read afresh, and never the copy kept for readers: the change is made to what this reads.
        const state = this.parse();
        if (typeof state.raw.version === 'number' && state.raw.version > REGISTRY_VERSION) throw new ProjectError('registry', newerList(this.file));
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
      throw new ProjectError('registry', messageOf(err));
    }
  }

  /** What a store says, read without creating or migrating it. */
  private factsOf(db: string): StoreFacts {
    if (!existsSync(db)) return emptyStoreFacts();
    try {
      return readStoreFacts(db, this.now());
    } catch {
      return emptyStoreFacts();
    }
  }

  /** Records an activity event in the project's store. Never fails the change it describes. */
  private activity(project: ProjectEntry, event: RecordEventInput, createStore: boolean, db: string = projectDbPath(project.path)): void {
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
