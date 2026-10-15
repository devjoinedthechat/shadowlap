import { lstatSync, opendirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { displayPath, expandHome, isWithin, realpathOrNull } from './paths.js';

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
 *   by name and project kind. It never returns a file's name or contents.
 * - Only under the user's home folder, or roots they configured (`roots` in the project list, or
 *   `SHADOWLAP_PROJECT_ROOTS`). A path that resolves elsewhere, through `..` or a symbolic link,
 *   lists nothing. A configured root can't be a filesystem root, a system folder, or a folder
 *   that holds the home folder.
 * - Never hidden folders (a name starting with a dot, such as `~/.ssh`) or system folders
 *   (`~/Library`, `~/AppData` and `~/snap` at the top of the home folder or a root;
 *   `node_modules`, `__pycache__` and `site-packages` anywhere), and nothing inside them. Only a
 *   root the user configured there, such as iCloud Drive's folder under `~/Library`, reaches in.
 * - Capped: at most {@link SUGGEST_LIMITS.scanned} entries read from a directory, at most
 *   {@link SUGGEST_LIMITS.described} of them looked into for project files, and at most
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
  /** The kind with its project files, as a folder list shows it (`Python · uv · pyproject.toml`), or `No project files`. */
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

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
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
export function describeFolder(folder: string, options: { home?: string } = {}): FolderKind {
  const home = options.home ?? homedir();
  const shown = displayPath(folder, home);
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
  const manifestNames = manifests.map(([name]) => name);
  return {
    kind,
    label: `${kind} · ${manifestNames.join(' · ')}`,
    languages,
    managers,
    files: [...manifestNames, ...locks.map(([name]) => name)],
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
   * The same roots as they were given as well, when a link makes that differ (`/work` for
   * `/Volumes/work`): a typed path is checked against these before anything is looked up, so the
   * answer never says whether a path elsewhere exists.
   */
  reach: string[];
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
  const reach: string[] = roots.length ? [...new Set([home, resolve(givenHome)])] : [];
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
    if (!reach.includes(resolve(expanded))) reach.push(resolve(expanded));
    if (!reach.includes(real)) reach.push(real);
    // Inside a root already, it adds nothing, unless it is somewhere that root keeps out (a hidden
    // or system folder): then it is a root of its own.
    if (roots.some((r) => isWithin(real, r) && !blockedBetween(r, real))) continue;
    roots.push(real);
  }
  return { roots, reach, refused };
}

/** Whether a typed path, as typed (`..` resolved, links not followed), is under one of the roots. */
function reachable(path: string, reach: readonly string[]): boolean {
  return reach.some((r) => isWithin(path, r));
}

export type FolderCheck =
  | { ok: true; path: string; folder: FolderKind }
  | { ok: false; code: 'invalid' | 'missing' | 'not-a-folder' | 'outside' | 'hidden' | 'system' | 'no-project-files'; why: string };

/**
 * Whether a folder typed or picked in the dashboard may become a project there: an existing folder
 * under the home folder or a configured root (checked on its real path, so `..` and symbolic links
 * can't step out), not hidden, not a system folder, and with project files. Returns its real path.
 */
export function checkFolder(input: string, options: { home?: string; roots?: readonly string[]; requireProjectFiles?: boolean } = {}): FolderCheck {
  const home = options.home ?? homedir();
  const typed = input.trim();
  if (!typed || typed.length > 4096 || typed.includes('\0')) return { ok: false, code: 'invalid', why: 'Give the folder’s path, such as ~/my-agent.' };
  const expanded = expandHome(typed, home);
  const abs = resolve(isAbsolute(expanded) ? expanded : join(home, expanded));
  const shown = displayPath(abs, home);
  const { roots, reach } = projectRoots({ home, configured: options.roots ?? [] });
  const outside: FolderCheck = { ok: false, code: 'outside', why: `Only folders in your home folder${roots.length > 1 ? ' or a configured root' : ''} can be added from the dashboard. Run shadowlap dashboard in the folder to open it.` };
  // Where it may go is settled before anything is looked up: the answer for a path elsewhere is
  // the same whether or not it exists.
  if (!reachable(abs, reach)) return outside;
  const real = realpathOrNull(abs);
  if (!real) return { ok: false, code: 'missing', why: `${shown} doesn’t exist.` };
  const root = rootOf(real, roots);
  if (!root) return outside;
  if (!isDirectory(real)) return { ok: false, code: 'not-a-folder', why: `${shown} isn’t a folder.` };
  const blocked = blockedBetween(root, real);
  if (blocked === 'hidden') return { ok: false, code: 'hidden', why: `${shown} is in a hidden folder.` };
  if (blocked === 'system') return { ok: false, code: 'system', why: `${shown} holds system files, not a project.` };
  const folder = describeFolder(real, { home });
  if (options.requireProjectFiles !== false && !folder.kind) return { ok: false, code: 'no-project-files', why: folder.why ?? `${shown} has no project files.` };
  return { ok: true, path: real, folder };
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

/**
 * Completes a typed path with the folders it could mean, one directory level at a time: `~/co`
 * lists the home folder's subfolders matching "co" (those that start with it first), `~/code/`
 * lists everything in `~/code`, and an empty query lists the home folder (and the configured roots
 * themselves). Folders with project files come before those without; each says what it holds.
 * See the limits at the top of this file.
 */
export function suggestFolders(query: string, options: SuggestOptions = {}): FolderSuggestions {
  const home = options.home ?? homedir();
  const limit = Math.max(1, Math.min(SUGGEST_LIMITS.maxResults, Math.floor(options.limit ?? SUGGEST_LIMITS.results)));
  const result = (listed: string | null, folders: FolderSuggestion[], truncated: boolean, note: string | null): FolderSuggestions => ({ query, listed, folders, truncated, note });
  if (query.length > SUGGEST_LIMITS.queryChars || query.includes('\0')) return result(null, [], false, 'That path is too long to look up.');

  const { roots, reach } = projectRoots({ home, configured: options.roots ?? [] });
  if (!roots.length) return result(null, [], false, 'No folders to suggest: set SHADOWLAP_PROJECT_ROOTS to the folders your projects are in.');
  const outside = () => result(null, [], false, `Only folders in your home folder${roots.length > 1 ? ' and the configured roots' : ''} are listed.`);
  let typed = query.trim();
  if (typed === '' || typed === '~') typed = '~/';
  if (typed.startsWith('~') && !/^~(?:[/\\]|$)/.test(typed)) return result(null, [], false, 'Only your own home folder is listed.');
  const expanded = expandHome(typed, home);
  const abs = isAbsolute(expanded) ? expanded : join(home, expanded);
  const endsWithSeparator = /[/\\]$/.test(typed);
  const dir = endsWithSeparator ? resolve(abs) : dirname(resolve(abs));
  const prefix = endsWithSeparator ? '' : basename(resolve(abs)).toLowerCase();
  const shownDir = displayPath(dir, home);
  const separator = shownDir.startsWith('~') ? '/' : sep;
  const listed = shownDir.endsWith(separator) ? shownDir : `${shownDir}${separator}`;

  // Where it may go is settled before anything is looked up: the answer for a path elsewhere is
  // the same whether or not it exists.
  if (!reachable(dir, reach)) return outside();
  const realDir = realpathOrNull(dir);
  if (!realDir) return result(listed, [], false, `${shownDir} doesn’t exist.`);
  const root = rootOf(realDir, roots);
  if (!root) return outside();
  if (!isDirectory(realDir)) return result(listed, [], false, `${shownDir} isn’t a folder.`);
  const blocked = blockedBetween(root, realDir);
  if (blocked) return result(null, [], false, blocked === 'hidden' ? 'Hidden folders aren’t listed.' : `${shownDir} holds system files, not projects.`);

  const opened = new Map<string, string>();
  for (const p of options.opened ?? []) opened.set(realpathOrNull(p.path) ?? resolve(p.path), p.id);

  // Read one level, directories only, skipping hidden and system names.
  const matches: Array<{ name: string; path: string; rank: number }> = [];
  const links: Array<{ name: string; path: string; rank: number }> = [];
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
      const lower = name.toLowerCase();
      const rank = !prefix || lower.startsWith(prefix) ? 0 : lower.includes(prefix) ? 1 : -1;
      if (rank < 0) continue;
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

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  matches.sort((a, b) => a.rank - b.rank || byName(a, b));
  if (matches.length > SUGGEST_LIMITS.described) truncated = true;
  const described = matches.slice(0, SUGGEST_LIMITS.described).map((m) => {
    const id = opened.get(m.path) ?? null;
    return { ...m, suggestion: { path: m.path, display: displayPath(m.path, home), name: m.name, folder: describeFolder(m.path, { home }), added: id !== null, projectId: id } satisfies FolderSuggestion };
  });
  // The best match first, then folders with project files before those without.
  described.sort((a, b) => a.rank - b.rank || Number(!a.suggestion.folder.kind) - Number(!b.suggestion.folder.kind) || byName(a, b));
  let folders = described.map((d) => d.suggestion);

  // With nothing typed, the configured roots themselves are offered too, so they can be opened.
  if (query.trim() === '' || query.trim() === '~') {
    const realHome = realpathOrNull(home) ?? resolve(home);
    for (const r of roots.filter((x) => x !== realHome)) {
      const id = opened.get(r) ?? null;
      folders.push({ path: r, display: displayPath(r, home), name: basename(r), folder: describeFolder(r, { home }), added: id !== null, projectId: id });
    }
  }
  if (folders.length > limit) {
    truncated = true;
    folders = folders.slice(0, limit);
  }
  return result(listed, folders, truncated, null);
}
