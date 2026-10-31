import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Paths for projects: where Shadowlap keeps its own files on this machine, `~` in what people type,
 * and how a folder is shown. Shared by the registry, folder suggestions and the dashboard's read model.
 */

/**
 * Shadowlap's folder for this machine's files: `SHADOWLAP_HOME`, else `~/.shadowlap`. It holds the
 * project list (`projects.json`), and the registrations of the agents commands start (`agents/`) and
 * of the `mcp --listen` proxies (`mcp/`) while they run, so processes that share an environment find
 * each other's. Only an absolute path (or one starting with `~/`) counts: a relative one would name
 * a different folder in every directory a command runs in, so `init` in a project and the dashboard
 * would keep different lists. It is ignored ({@link shadowlapHomeProblem} says so).
 */
export function shadowlapHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const explicit = env.SHADOWLAP_HOME?.trim();
  const expanded = explicit ? expandHome(explicit, home) : '';
  return expanded && isAbsolute(expanded) ? resolve(expanded) : join(home, '.shadowlap');
}

/** Why `SHADOWLAP_HOME` is ignored, when it is set to a relative path; null otherwise. */
export function shadowlapHomeProblem(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | null {
  const explicit = env.SHADOWLAP_HOME?.trim();
  if (!explicit || isAbsolute(expandHome(explicit, home))) return null;
  return `SHADOWLAP_HOME is ${explicit}, which isn’t an absolute path, so it is ignored: the project list is in ${join(home, '.shadowlap')}.`;
}

/** `~` and `~/x` (or `~\x`) become the home folder; anything else is returned as given. */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2));
  return path;
}

/** True when `child` is `parent` or inside it. Both should be absolute and resolved. */
export function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The path with symbolic links resolved, or null when it doesn't exist or can't be read. */
export function realpathOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/**
 * A folder as people read it, without touching the disk: `~/research-agent` inside `home`, the
 * path as it is elsewhere. Forward slashes after `~` on every platform, as the dashboard shows
 * paths. Give the home folder's real path, as the project list keeps real paths
 * (`ProjectRegistry.realHome`).
 */
export function tildePath(path: string, home: string): string {
  const base = resolve(home);
  if (!isWithin(path, base)) return path;
  const rel = relative(base, path);
  return rel ? `~/${rel.split(sep).join('/')}` : '~';
}

/**
 * A folder as people read it: `~/research-agent` inside the home folder, reached by its own path
 * or its real one, the absolute path elsewhere.
 */
export function displayPath(path: string, home: string): string {
  const realHome = realpathOrNull(home) ?? resolve(home);
  for (const base of new Set([resolve(home), realHome])) {
    if (isWithin(path, base)) return tildePath(path, base);
  }
  return path;
}

/** The store of the project in `folder`: `.shadowlap/shadowlap.db`, as every command finds it. */
export function projectDbPath(folder: string): string {
  return join(folder, '.shadowlap', 'shadowlap.db');
}
