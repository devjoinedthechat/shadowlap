import { lstatSync, opendirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { displayPath, expandHome, isWithin, realpathOrNull, tildePath } from './paths.js';

/**
 * Folders for the dashboard's Add a project page: what kind of project a folder holds, and the
 * folders to suggest while a path is typed.
 *
 * Suggesting folders means the dashboard's server lists directories, so it does that within limits
 * a web page could not stretch:
 *
 * - The endpoint that serves suggestions needs the dashboard's session token, like every other
 *   one. The token travels in a header a page on another site can't send (the server answers no
 *   CORS preflight), so such a page can neither call it nor read its answer; adding a project is a
 *   change, and changes are also refused from another origin.
 * - It lists one directory level per request (the folder the typed path is in), directories only,
 *   by name and project kind, plus the projects one level inside the folders there that have no
 *   project files of their own (real folders only, never through a link). It never returns a
 *   file's name or contents, and says nothing about whether a file is there: a file and a path
 *   where nothing is get the same answer.
 * - Only under the user's home folder, or roots they configured (`roots` in the project list, or
 *   `SHADOWLAP_PROJECT_ROOTS`). A path that resolves elsewhere, through `..` or a symbolic link,
 *   lists nothing. A configured root can't be a filesystem root, a system folder, or a folder
 *   that holds the home folder.
 * - Never hidden folders (a name starting with a dot, such as `~/.ssh`) or system folders
 *   (`~/Library`, `~/AppData` and `~/snap` at the top of the home folder or a root;
 *   `node_modules`, `__pycache__` and `site-packages` anywhere), and nothing inside them. Only a
 *   root the user configured there, such as iCloud Drive's folder under `~/Library`, reaches in.
 * - A typed path is checked as typed before anything is looked up on disk, then where it really
 *   is (links followed, or the deepest folder above it that exists), and only then whether it is a
 *   folder. So a path elsewhere, or in a hidden or system folder, gets the same answer whether or
 *   not something is there: `~/.ssh/id_rsa/` can't be told from `~/.ssh/nothing/`.
 * - Capped: at most {@link SUGGEST_LIMITS.scanned} entries read from a directory, at most
 *   {@link SUGGEST_LIMITS.described} of them looked into for project files, at most
 *   {@link SUGGEST_LIMITS.insideFolders} folders looked into one level down (and
 *   {@link SUGGEST_LIMITS.insideDescribed} of their subfolders), and at most
 *   {@link SUGGEST_LIMITS.maxResults} returned.
 *
 * Adding a folder from the dashboard checks the same limits again ({@link checkFolder}), and also
 * requires project files: the button stays disabled until such a folder is picked.
 */

export type ProjectLanguage = 'python' | 'node' | 'deno' | 'go' | 'rust' | 'ruby' | 'java';

/** What a folder holds, as the Add a project page shows it. */
export interface FolderKind {
  /** `Python · uv`, `Node · npm`, `Python · Node`; null when the folder has no project files. */
  kind: string | null;
  /** The kind with its project files, as a folder list shows it (`Python · uv · pyproject.toml · uv.lock`), or `No project files`. */
  label: string;
  languages: ProjectLanguage[];
  /** Package managers, one per language where one can be told: uv, poetry, pip, npm, pnpm, cargo… */
  managers: string[];
  /** Project files at the top of the folder: manifests first, then lockfiles. */
  files: string[];
  /** Why the folder can't be added, when it can't. */
  why: string | null;
}

const LANGUAGE_NAMES: Record<ProjectLanguage, string> = { python: 'Python', node: 'Node', deno: 'Deno', go: 'Go', rust: 'Rust', ruby: 'Ruby', java: 'Java' };

/** Files that make a folder a project, in the order a kind lists its languages (Python first, as `Python · Node`). */
const MANIFESTS: ReadonlyArray<readonly [string, ProjectLanguage]> = [
  ['pyproject.toml', 'python'],
  ['requirements.txt', 'python'],
  ['requirements.in', 'python'],
  ['Pipfile', 'python'],
  ['setup.py', 'python'],
  ['setup.cfg', 'python'],
  ['package.json', 'node'],
  ['deno.json', 'deno'],
  ['deno.jsonc', 'deno'],
  ['go.mod', 'go'],
  ['Cargo.toml', 'rust'],
  ['Gemfile', 'ruby'],
  ['pom.xml', 'java'],
  ['build.gradle', 'java'],
  ['build.gradle.kts', 'java'],
];

/** Lockfiles, which tell the package manager. */
const LOCKFILES: ReadonlyArray<readonly [string, ProjectLanguage, string]> = [
  ['uv.lock', 'python', 'uv'],
  ['poetry.lock', 'python', 'poetry'],
  ['Pipfile.lock', 'python', 'pipenv'],
  ['pdm.lock', 'python', 'pdm'],
  ['pnpm-lock.yaml', 'node', 'pnpm'],
  ['yarn.lock', 'node', 'yarn'],
  ['bun.lock', 'node', 'bun'],
  ['bun.lockb', 'node', 'bun'],
  ['package-lock.json', 'node', 'npm'],
  ['npm-shrinkwrap.json', 'node', 'npm'],
  ['Cargo.lock', 'rust', 'cargo'],
  ['Gemfile.lock', 'ruby', 'bundler'],
];

const NO_PROJECT_FILES = 'No project files';

// A path that isn't there is the common answer here (most folders have few of the files looked
// for), so it is asked without an exception for it: suggestions look at thousands.
function isFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

/** Folder names in a list's order, as people read them: case and accents aside. One collator for every comparison, which is what keeps a sort of thousands fast. */
const BY_NAME = new Intl.Collator('en', { sensitivity: 'base' });

/** Paths as people read them under `home` (`~/code/agent`), with the home folder's real path found once rather than for every path. */
function displayer(home: string): (path: string) => string {
  const bases = [...new Set([resolve(home), realpathOrNull(home) ?? resolve(home)])];
  return (path) => {
    for (const base of bases) if (isWithin(path, base)) return tildePath(path, base);
    return path;
  };
}

/** A small text file's contents, or '' (a manifest is never this large; a huge one isn't read). */
function readSmall(path: string, limit = 256 * 1024): string {
  try {
    if (statSync(path).size > limit) return '';
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function defaultManager(folder: string, language: ProjectLanguage, has: (name: string) => boolean): string | null {
  switch (language) {
    case 'python':
      if (has('Pipfile')) return 'pipenv';
      if (has('pyproject.toml') && /^\s*\[tool\.poetry\]/m.test(readSmall(join(folder, 'pyproject.toml')))) return 'poetry';
      return 'pip';
    case 'node': {
      // Corepack's field names the manager when no lockfile does: "packageManager": "pnpm@9.12.0".
      const m = /"packageManager"\s*:\s*"(npm|pnpm|yarn|bun)@/.exec(readSmall(join(folder, 'package.json')));
      return m ? m[1]! : 'npm';
    }
    case 'rust':
      return 'cargo';
    case 'ruby':
      return 'bundler';
    case 'java':
      return has('pom.xml') ? 'maven' : 'gradle';
    default:
      return null;
  }
}

/**
 * What kind of project a folder holds, from the files at its top level: `Python · uv` with
 * `pyproject.toml` and `uv.lock`, `Node · pnpm` with `package.json`. It reads no source and lists
 * nothing below the folder; it only checks for a fixed set of names, so a folder of any size costs
 * the same.
 */
export function describeFolder(folder: string, options: { home?: string; display?: (path: string) => string } = {}): FolderKind {
  const home = options.home ?? homedir();
  const shown = options.display ? options.display(folder) : displayPath(folder, home);
  const none = (why: string): FolderKind => ({ kind: null, label: NO_PROJECT_FILES, languages: [], managers: [], files: [], why });
  if (!isDirectory(folder)) {
    try {
      statSync(folder);
      return none(`${shown} isn’t a folder.`);
    } catch {
      return none(`${shown} doesn’t exist.`);
    }
  }
  try {
    opendirSync(folder).closeSync();
  } catch {
    return none(`Can’t read ${shown}.`);
  }
  const present = new Set<string>();
  const has = (name: string) => {
    if (present.has(name)) return true;
    if (!isFile(join(folder, name))) return false;
    present.add(name);
    return true;
  };
  const manifests = MANIFESTS.filter(([name]) => has(name));
  const languages = [...new Set(manifests.map(([, language]) => language))];
  if (!languages.length) return none(`No pyproject.toml, package.json or requirements file in ${shown}. Pick the folder your agent’s code is in.`);
  const locks = LOCKFILES.filter(([name, language]) => languages.includes(language) && has(name));
  const managers: string[] = [];
  for (const language of languages) {
    const manager = locks.find(([, l]) => l === language)?.[2] ?? defaultManager(folder, language, has);
    if (manager && !managers.includes(manager)) managers.push(manager);
  }
  const names = languages.map((l) => LANGUAGE_NAMES[l]);
  // One language shows its manager (`Python · uv`); two show the languages (`Python · Node`), as a
  // manager no longer says which side it belongs to.
  const kind = languages.length === 1 && managers.length ? `${names[0]} · ${managers[0]}` : names.join(' · ');
  // The files that tell it, manifests then lockfiles, as the folder list shows them: `Python · uv · pyproject.toml · uv.lock`.
  const files = [...manifests.map(([name]) => name), ...locks.map(([name]) => name)];
  return {
    kind,
    label: `${kind} · ${files.join(' · ')}`,
    languages,
    managers,
    files,
    why: null,
  };
}

/** The largest `run.json` read to see which runs a pack holds; a pack's is a few kilobytes. */
const MAX_PACK_MANIFEST = 1024 * 1024;

/**
 * The runs a pack folder holds, from its `run.json`: null when the folder isn't a pack. A `run.json`
 * that is a link, too large or not what `pack` writes still makes the folder a pack, holding runs
 * that can't be told (an empty list).
 */
export function readPack(dir: string): string[] | null {
  const file = join(dir, 'run.json');
  let st;
  try {
    st = lstatSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_PACK_MANIFEST) return [];
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as { runs?: unknown };
    if (!Array.isArray(manifest.runs)) return [];
    return manifest.runs.flatMap((r) => (typeof r === 'object' && r !== null && typeof (r as { runId?: unknown }).runId === 'string' ? [(r as { runId: string }).runId] : []));
  } catch {
    return [];
  }
}

/**
 * Packs in a project's repository, as Tests finds them: folders with a `run.json` under `goldens/`,
 * one or two levels down, never through a link or into a hidden folder. Capped.
 */
function visitPacks(folder: string, limit: number, found: (path: string, dir: string) => void): void {
  let count = 0;
  const visit = (dir: string, rel: string, depth: number) => {
    let handle;
    try {
      handle = opendirSync(dir);
    } catch {
      return;
    }
    try {
      for (let entry = handle.readSync(); entry && count < limit; entry = handle.readSync()) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const path = join(dir, entry.name);
        const relPath = `${rel}/${entry.name}`;
        if (isFile(join(path, 'run.json'))) {
          count++;
          found(relPath, path);
        } else if (depth < 2) visit(path, relPath, depth + 1);
      }
    } finally {
      handle.closeSync();
    }
  };
  // `goldens` may be a link, as long as it stays in the project.
  const goldens = realpathOrNull(join(folder, 'goldens'));
  const root = realpathOrNull(folder);
  if (!goldens || !root || !isWithin(goldens, root) || !isDirectory(goldens)) return;
  visit(goldens, 'goldens', 1);
}

/** How many goldens a project keeps in its repository (see {@link listPacks}); it only looks for the file names. */
export function countGoldens(folder: string, limit = 500): number {
  let count = 0;
  visitPacks(folder, limit, () => count++);
  return count;
}

/** The goldens in a project's repository with the runs each holds, so the setup knows its recording was packed. */
export function listPacks(folder: string, limit = 500): Array<{ path: string; runIds: string[] }> {
  const packs: Array<{ path: string; runIds: string[] }> = [];
  visitPacks(folder, limit, (path, dir) => packs.push({ path, runIds: readPack(dir) ?? [] }));
  return packs;
}

// ---------------------------------------------------------------------------------------------
// Where suggestions may go

/**
 * Folders at the top of the home folder (or of a root) that hold the system's and apps' files, not
 * projects: `~/Library`, `~/AppData`, `~/snap`. Deeper down the same names are ordinary folders
 * (`~/code/library`). Compared lowercased.
 */
const SYSTEM_TOP = new Set(['library', 'applications', 'appdata', 'application data', 'snap', 'system volume information', '$recycle.bin']);
/** Folders of installed packages and caches, at any depth. Compared lowercased. */
const SYSTEM_ANYWHERE = new Set(['node_modules', '__pycache__', 'site-packages']);

/** A system folder's name, `depth` folders below a root (0: right in it). */
function systemName(name: string, depth: number): boolean {
  const lower = name.toLowerCase();
  return SYSTEM_ANYWHERE.has(lower) || (depth === 0 && SYSTEM_TOP.has(lower));
}

/** Folders that can never be a root, whatever the configuration says. */
const SYSTEM_PATHS = new Set(
  process.platform === 'win32'
    ? ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata', 'c:\\users']
    : ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/proc', '/run', '/sbin', '/sys', '/usr', '/var', '/tmp', '/private', '/private/var', '/private/tmp', '/private/etc', '/System', '/Library', '/Applications', '/Users', '/home', '/cores', '/opt/homebrew'],
);

function isSystemPath(path: string): boolean {
  if (parse(path).root === path) return true;
  return SYSTEM_PATHS.has(process.platform === 'win32' ? path.toLowerCase() : path);
}

/** The segments between `root` and `path`: hidden or system names there keep a folder out. */
function blockedBetween(root: string, path: string): 'hidden' | 'system' | null {
  const rel = relative(root, path);
  if (!rel) return null;
  const segments = rel.split(sep);
  for (let depth = 0; depth < segments.length; depth++) {
    const segment = segments[depth]!;
    if (segment.startsWith('.')) return 'hidden';
    if (systemName(segment, depth)) return 'system';
  }
  return null;
}

/**
 * The root a path is in: the deepest that holds it, so a root configured inside another (even in a
 * hidden or system folder there, such as iCloud Drive's folder under `~/Library`) is its own root.
 */
function rootOf(path: string, roots: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const r of roots) if (isWithin(path, r) && (best === undefined || r.length > best.length)) best = r;
  return best;
}

export interface ProjectRoots {
  /** Real paths that suggestions and adds may reach: the home folder first, then configured roots. */
  roots: string[];
  /**
   * Each root by every path it is reached by, as given and as its real path when a link makes
   * them differ (`/work` for `/Volumes/work`), with the root it stands for. A typed path is checked
   * against these as typed, before anything is looked up on disk, so the answer for a path
   * elsewhere, or inside a hidden or system folder, never says whether something is there.
   */
  aliases: Array<{ path: string; root: string }>;
  /** Configured roots that were left out, and why. */
  refused: Array<{ path: string; why: string }>;
}

/**
 * The folders a dashboard may suggest and add projects from: the home folder, plus configured roots
 * (the project list's `roots` and `SHADOWLAP_PROJECT_ROOTS`, which `ProjectRegistry.configuredRoots`
 * gathers). A configured root must be an existing folder given as an absolute path (or `~/…`), and
 * can't be a filesystem root, a system folder, or a folder that holds the home folder (`/Users`
 * would reach everyone's).
 */
export function projectRoots(options: { home?: string; configured?: readonly string[] } = {}): ProjectRoots {
  const givenHome = options.home ?? homedir();
  const home = realpathOrNull(givenHome) ?? resolve(givenHome);
  const roots: string[] = isSystemPath(home) ? [] : [home];
  const aliases: ProjectRoots['aliases'] = [];
  const alias = (path: string, root: string) => {
    if (!aliases.some((a) => a.path === path)) aliases.push({ path, root });
  };
  if (roots.length) {
    alias(home, home);
    alias(resolve(givenHome), home);
  }
  const refused: ProjectRoots['refused'] = [];
  for (const raw of options.configured ?? []) {
    const expanded = expandHome(raw, givenHome);
    if (!isAbsolute(expanded)) {
      refused.push({ path: raw, why: 'a root is an absolute path, or one starting with ~/' });
      continue;
    }
    const real = realpathOrNull(resolve(expanded));
    if (!real || !isDirectory(real)) {
      refused.push({ path: raw, why: 'no such folder' });
      continue;
    }
    if (isSystemPath(real)) {
      refused.push({ path: raw, why: 'a system folder' });
      continue;
    }
    if (isWithin(home, real) && real !== home) {
      refused.push({ path: raw, why: 'it holds your home folder' });
      continue;
    }
    // Inside a root already, it adds nothing (its folders are checked from that root), unless it is
    // somewhere that root keeps out (a hidden or system folder): then it is a root of its own.
    if (roots.some((r) => isWithin(real, r) && !blockedBetween(r, real))) continue;
    roots.push(real);
    alias(real, real);
    alias(resolve(expanded), real);
  }
  return { roots, aliases, refused };
}

/**
 * Where a path is, as typed (`..` resolved, links not followed), without touching the disk: outside
 * every root, inside a hidden or system folder of the root it is under, or neither (null).
 */
function placeAsTyped(path: string, aliases: ProjectRoots['aliases']): 'outside' | 'hidden' | 'system' | null {
  let under: string | undefined;
  for (const a of aliases) if (isWithin(path, a.path) && (under === undefined || a.path.length > under.length)) under = a.path;
  return under === undefined ? 'outside' : blockedBetween(under, path);
}

/**
 * Where a path really is: its real path when it exists, else the real path of the deepest folder
 * above it that does, with the rest of the path after it. So a path through a link into a hidden
 * folder is placed there whether or not its last part exists.
 */
function placeOnDisk(path: string): { real: string; exists: boolean } {
  for (let p = path; ; ) {
    const real = realpathOrNull(p);
    if (real) return { real: p === path ? real : join(real, relative(p, path)), exists: p === path };
    const up = dirname(p);
    if (up === p) return { real: path, exists: false };
    p = up;
  }
}

type Place = { ok: true; real: string; root: string } | { ok: false; why: 'outside' | 'hidden' | 'system' | 'missing' };

/**
 * Where a typed path may be looked at, checked in an order that gives nothing away: first as typed,
 * then where it really is (links followed), and only then whether it is a folder. A path outside
 * the roots, or in a hidden or system folder, gets that answer whether or not anything is there,
 * and a file gets the same answer as nothing at all.
 */
function place(path: string, roots: ProjectRoots): Place {
  const typed = placeAsTyped(path, roots.aliases);
  if (typed) return { ok: false, why: typed };
  const { real, exists } = placeOnDisk(path);
  const root = rootOf(real, roots.roots);
  if (!root) return { ok: false, why: 'outside' };
  const blocked = blockedBetween(root, real);
  if (blocked) return { ok: false, why: blocked };
  if (!exists || !isDirectory(real)) return { ok: false, why: 'missing' };
  return { ok: true, real, root };
}

/** What the dashboard says about a path with nothing to show there: one answer for a file and for nothing at all. */
const noFolder = (shown: string) => `There’s no folder at ${shown}.`;

export type FolderCheck =
  | { ok: true; path: string; folder: FolderKind }
  | { ok: false; code: 'invalid' | 'missing' | 'outside' | 'hidden' | 'system' | 'no-project-files'; why: string };

/**
 * Whether a folder typed or picked in the dashboard may become a project there: an existing folder
 * under the home folder or a configured root (checked as typed and on its real path, so `..` and
 * symbolic links can't step out), not hidden, not a system folder, and with project files. Returns
 * its real path. A file, and a path where nothing is, get the same answer (`missing`).
 */
export function checkFolder(input: string, options: { home?: string; roots?: readonly string[]; requireProjectFiles?: boolean } = {}): FolderCheck {
  const home = options.home ?? homedir();
  const typed = input.trim();
  if (!typed || typed.length > 4096 || typed.includes('\0')) return { ok: false, code: 'invalid', why: 'Give the folder’s path, such as ~/my-agent.' };
  const expanded = expandHome(typed, home);
  const abs = resolve(isAbsolute(expanded) ? expanded : join(home, expanded));
  const shown = displayPath(abs, home);
  const roots = projectRoots({ home, configured: options.roots ?? [] });
  const at = place(abs, roots);
  if (!at.ok) {
    if (at.why === 'outside') return { ok: false, code: 'outside', why: `Only folders in your home folder${roots.roots.length > 1 ? ' or a configured root' : ''} can be added from the dashboard. Run shadowlap dashboard in the folder to open it.` };
    if (at.why === 'hidden') return { ok: false, code: 'hidden', why: `${shown} is in a hidden folder.` };
    if (at.why === 'system') return { ok: false, code: 'system', why: `${shown} holds system files, not a project.` };
    return { ok: false, code: 'missing', why: noFolder(shown) };
  }
  const folder = describeFolder(at.real, { home });
  if (options.requireProjectFiles !== false && !folder.kind) return { ok: false, code: 'no-project-files', why: folder.why ?? `${shown} has no project files.` };
  return { ok: true, path: at.real, folder };
}

// ---------------------------------------------------------------------------------------------
// Suggestions

export const SUGGEST_LIMITS = Object.freeze({
  /** Folders returned when the caller doesn't say. */
  results: 30,
  /** Folders returned at most. */
  maxResults: 100,
  /** Entries read from the listed directory at most. */
  scanned: 2000,
  /** Matching folders looked into for project files at most. */
  described: 200,
  /** Longest query read. */
  queryChars: 1024,
  /** Folders without project files looked into for projects one level down (`~/code/invoice-bot`), at most. */
  insideFolders: 40,
  /** Entries read from each of them at most. */
  insideScanned: 500,
  /** Their subfolders looked into for project files at most, all of them together, and in each of them. */
  insideDescribed: 200,
  insideEach: 25,
});

export interface FolderSuggestion {
  /** The real path, as the registry keeps it. */
  path: string;
  /** As people read it: `~/research-agent`. */
  display: string;
  name: string;
  folder: FolderKind;
  /** Already a project in this dashboard: listed, but it can't be added again. */
  added: boolean;
  projectId: string | null;
}

export interface FolderSuggestions {
  query: string;
  /** The folder whose subfolders are listed, as shown (`~/code/`); null when nothing was listed. */
  listed: string | null;
  folders: FolderSuggestion[];
  /** More folders matched than were returned. */
  truncated: boolean;
  /** Why nothing is listed, when the typed path reaches somewhere suggestions don't go. */
  note: string | null;
}

export interface SuggestOptions {
  home?: string;
  /** Configured roots besides the home folder (`ProjectRegistry.configuredRoots()`); vetted by {@link projectRoots}. */
  roots?: readonly string[];
  /** The dashboard's projects, marked as added. */
  opened?: ReadonlyArray<{ id: string; path: string }>;
  limit?: number;
}

/** Folder names code is usually kept in: looked into first for projects one level down. Compared lowercased. */
const CODE_FOLDERS = new Set(['code', 'src', 'source', 'dev', 'developer', 'development', 'projects', 'project', 'repos', 'repositories', 'git', 'github', 'gitlab', 'work', 'workspace', 'workspaces', 'agents', 'apps', 'sites', 'desktop']);

/** How well a folder's name matches what was typed after the last `/`: 0 starts with it (or nothing typed), 1 holds it, -1 neither. */
function nameRank(name: string, prefix: string): number {
  const lower = name.normalize('NFC').toLowerCase();
  return !prefix || lower.startsWith(prefix) ? 0 : lower.includes(prefix) ? 1 : -1;
}

/**
 * The projects one level inside each of `parents` (folders without project files), within the
 * `inside…` limits: subfolders with project files whose name matches `prefix`, or all of them when
 * the parent's own name matched. Real folders only, never a link, a hidden folder or a system one
 * (`depth` is theirs below the root). Keyed by the parent's path, each list by name.
 */
interface Ranked {
  name: string;
  path: string;
  rank: number;
}

function projectsInside(parents: readonly Ranked[], prefix: string, depth: number, suggest: (m: Ranked) => FolderSuggestion): Map<string, Array<Ranked & { suggestion: FolderSuggestion }>> {
  const out = new Map<string, Array<Ranked & { suggestion: FolderSuggestion }>>();
  let described = 0;
  for (const parent of parents.slice(0, SUGGEST_LIMITS.insideFolders)) {
    if (described >= SUGGEST_LIMITS.insideDescribed) break;
    let handle;
    try {
      handle = opendirSync(parent.path);
    } catch {
      continue;
    }
    const children: Ranked[] = [];
    try {
      let scanned = 0;
      for (let entry = handle.readSync(); entry && ++scanned <= SUGGEST_LIMITS.insideScanned; entry = handle.readSync()) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || systemName(entry.name, depth)) continue;
        const rank = parent.rank >= 0 ? parent.rank : nameRank(entry.name, prefix);
        if (rank >= 0) children.push({ name: entry.name, path: join(parent.path, entry.name), rank });
      }
    } finally {
      handle.closeSync();
    }
    children.sort((a, b) => BY_NAME.compare(a.name, b.name));
    const found: Array<Ranked & { suggestion: FolderSuggestion }> = [];
    for (const c of children.slice(0, SUGGEST_LIMITS.insideEach)) {
      if (described >= SUGGEST_LIMITS.insideDescribed) break;
      described++;
      const suggestion = suggest(c);
      if (suggestion.folder.kind) found.push({ ...c, suggestion });
    }
    if (found.length) out.set(parent.path, found);
  }
  return out;
}

/**
 * Completes a typed path with the folders it could mean, one directory level at a time: `~/co`
 * lists the home folder's subfolders matching "co" (those that start with it first), `~/code/`
 * lists everything in `~/code`, and an empty query lists the home folder (and the configured roots
 * themselves). A folder without project files that holds projects one level down stands aside for
 * them: `~/code/invoice-bot` is listed rather than `~/code` (which still opens when typed), and
 * `~/inv` finds it too. Folders with project files come before those without; each says what it
 * holds. See the limits at the top of this file.
 */
export function suggestFolders(query: string, options: SuggestOptions = {}): FolderSuggestions {
  const home = options.home ?? homedir();
  const limit = Math.max(1, Math.min(SUGGEST_LIMITS.maxResults, Math.floor(options.limit ?? SUGGEST_LIMITS.results)));
  const result = (listed: string | null, folders: FolderSuggestion[], truncated: boolean, note: string | null): FolderSuggestions => ({ query, listed, folders, truncated, note });
  if (query.length > SUGGEST_LIMITS.queryChars || query.includes('\0')) return result(null, [], false, 'That path is too long to look up.');

  const vetted = projectRoots({ home, configured: options.roots ?? [] });
  const roots = vetted.roots;
  if (!roots.length) return result(null, [], false, 'No folders to suggest: set SHADOWLAP_PROJECT_ROOTS to the folders your projects are in.');
  let typed = query.trim();
  if (typed === '' || typed === '~') typed = '~/';
  if (typed.startsWith('~') && !/^~(?:[/\\]|$)/.test(typed)) return result(null, [], false, 'Only your own home folder is listed.');
  const expanded = expandHome(typed, home);
  const abs = isAbsolute(expanded) ? expanded : join(home, expanded);
  const endsWithSeparator = /[/\\]$/.test(typed);
  const dir = endsWithSeparator ? resolve(abs) : dirname(resolve(abs));
  // Compared composed: a name typed on a keyboard and one macOS keeps decomposed (Finder's `Bücher`) match.
  const prefix = endsWithSeparator ? '' : basename(resolve(abs)).normalize('NFC').toLowerCase();
  const shownDir = displayPath(dir, home);
  const separator = shownDir.startsWith('~') ? '/' : sep;
  const listed = shownDir.endsWith(separator) ? shownDir : `${shownDir}${separator}`;

  // Settled as typed first, then where it really is, then whether it is a folder (see `place`): a
  // path elsewhere, or in a hidden or system folder, gets the same answer whether or not it exists.
  const at = place(dir, vetted);
  if (!at.ok) {
    if (at.why === 'outside') return result(null, [], false, `Only folders in your home folder${roots.length > 1 ? ' and the configured roots' : ''} are listed.`);
    if (at.why === 'hidden') return result(null, [], false, 'Hidden folders aren’t listed.');
    if (at.why === 'system') return result(null, [], false, `${shownDir} holds system files, not projects.`);
    return result(listed, [], false, noFolder(shownDir));
  }
  const realDir = at.real;
  const root = at.root;

  const opened = new Map<string, string>();
  for (const p of options.opened ?? []) opened.set(realpathOrNull(p.path) ?? resolve(p.path), p.id);

  // Read one level, directories only, skipping hidden and system names.
  const matches: Ranked[] = [];
  const links: Ranked[] = [];
  // Folders whose own name doesn't match: a project one level inside one may (`~/inv` finds `~/code/invoice-bot`).
  const others: Ranked[] = [];
  const depth = realDir === root ? 0 : 1;
  let truncated = false;
  let handle;
  try {
    handle = opendirSync(realDir);
  } catch {
    return result(listed, [], false, `Can’t read ${shownDir}.`);
  }
  try {
    let scanned = 0;
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
      if (++scanned > SUGGEST_LIMITS.scanned) {
        truncated = true;
        break;
      }
      const name = entry.name;
      if (name.startsWith('.') || systemName(name, depth)) continue;
      const rank = nameRank(name, prefix);
      if (rank < 0) {
        if (entry.isDirectory()) others.push({ name, path: join(realDir, name), rank });
        continue;
      }
      if (entry.isDirectory()) matches.push({ name, path: join(realDir, name), rank });
      else if (entry.isSymbolicLink()) links.push({ name, path: join(realDir, name), rank });
    }
  } finally {
    handle.closeSync();
  }
  // A link is followed only to a folder that is itself inside a root, and not hidden there; one to a
  // folder listed anyway shows once, under the folder's own name.
  const seen = new Set(matches.map((m) => m.path));
  for (const link of links) {
    const target = realpathOrNull(link.path);
    const targetRoot = target ? rootOf(target, roots) : undefined;
    if (!target || !targetRoot || seen.has(target) || !isDirectory(target) || blockedBetween(targetRoot, target)) continue;
    seen.add(target);
    matches.push({ ...link, path: target });
  }

  const byName = (a: { name: string }, b: { name: string }) => BY_NAME.compare(a.name, b.name);
  matches.sort((a, b) => a.rank - b.rank || byName(a, b));
  if (matches.length > SUGGEST_LIMITS.described) truncated = true;
  const display = displayer(home);
  const suggest = (m: { name: string; path: string }): FolderSuggestion => {
    const id = opened.get(m.path) ?? null;
    return { path: m.path, display: display(m.path), name: m.name, folder: describeFolder(m.path, { home, display }), added: id !== null, projectId: id };
  };
  const described = matches.slice(0, SUGGEST_LIMITS.described).map((m) => ({ ...m, suggestion: suggest(m) }));

  // Projects one level inside the folders that have no project files: those that match first, then
  // the rest; in each, the folders code is usually kept in (`~/code`, `~/projects`) before the others.
  const codeFirst = (a: Ranked, b: Ranked) => Number(!CODE_FOLDERS.has(a.name.toLowerCase())) - Number(!CODE_FOLDERS.has(b.name.toLowerCase())) || byName(a, b);
  const parents = [...described.filter((d) => !d.suggestion.folder.kind).sort(codeFirst), ...others.sort(codeFirst)];
  const inside = projectsInside(parents, prefix, depth + 1, suggest);
  const listedHere = described.flatMap((d) => {
    const found = inside.get(d.path);
    // A folder that holds projects stands aside for them; one that holds none is listed as it is.
    return found?.length ? found : [d];
  });
  for (const o of others) listedHere.push(...(inside.get(o.path) ?? []));
  // The best match first, then folders with project files before those without, by what they show as.
  listedHere.sort((a, b) => a.rank - b.rank || Number(!a.suggestion.folder.kind) - Number(!b.suggestion.folder.kind) || BY_NAME.compare(a.suggestion.display, b.suggestion.display));
  let folders = listedHere.map((d) => d.suggestion);

  // With nothing typed, the configured roots themselves are offered too, so they can be opened.
  if (query.trim() === '' || query.trim() === '~') {
    const realHome = realpathOrNull(home) ?? resolve(home);
    for (const r of roots.filter((x) => x !== realHome)) {
      const id = opened.get(r) ?? null;
      folders.push({ path: r, display: display(r), name: basename(r), folder: describeFolder(r, { home, display }), added: id !== null, projectId: id });
    }
  }
  if (folders.length > limit) {
    truncated = true;
    folders = folders.slice(0, limit);
  }
  return result(listed, folders, truncated, null);
}
