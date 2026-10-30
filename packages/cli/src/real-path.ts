import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * A path as the system names it, the way git reports a repository's: links resolved and, on
 * Windows, short names (`C:\Users\RUNNER~1`) written out in full. Node's JavaScript realpath keeps
 * short names, so a folder reached by one never compares equal to what git says; the system's
 * realpath is asked first, and the JavaScript one answers where it can't (some network and RAM
 * drives on Windows).
 */
export function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return realpathSync(path);
  }
}

/**
 * A path with its symbolic links resolved, as git reports the repository's own: the longest part of
 * it that exists is resolved, and the rest kept as it is. A project reached through a link (`/tmp`
 * on macOS, a linked home folder) or by a short name on Windows then compares equal to the
 * repository git names.
 */
export function physicalPath(path: string): string {
  const rest: string[] = [];
  let head = resolve(path);
  for (;;) {
    try {
      return join(realPath(head), ...rest.reverse());
    } catch {
      const up = dirname(head);
      if (up === head) return resolve(path);
      rest.push(basename(head));
      head = up;
    }
  }
}

/**
 * The first of the folders `rel` names under `root`, from the top, that is a link, as `rel` names it
 * (`.shadowlap/repairs`); null when none is. Each is looked at itself, never followed: a repository
 * can track a folder as a link, and what is written through one lands wherever it points.
 */
export function linkInPath(root: string, rel: string): string | null {
  const parts = rel.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const path = parts.slice(0, i).join('/');
    if (isLink(join(root, path))) return path;
  }
  return null;
}

/** Whether `path` itself is a link; false for nothing there, or a path under a file. */
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
