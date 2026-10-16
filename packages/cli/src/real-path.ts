import { realpathSync } from 'node:fs';
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
