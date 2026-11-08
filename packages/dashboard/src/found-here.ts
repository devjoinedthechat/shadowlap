import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { rootOf } from './patch-in-tree.js';
import { namesTeamStore } from './routes/verdicts.js';
import type { FoundChange, FoundCommit } from './tests-bisect.js';

/**
 * A first bad commit as every route that serves one serves it (Tests, a run's offers, a fix): its
 * author only where names are shown, a team store configured (`namesTeamStore`), as Verdicts names a
 * commit's author; and its change's file as a path in the project folder, through its real path as
 * the jobs' files are checked, with how many of the commit's files are outside the folder, which git
 * reverts too. Without a project folder, or where git can't say which repository it is in, the change
 * has no path.
 */
export async function foundHere(found: FoundCommit, project: string | null | undefined): Promise<FoundCommit> {
  const shown = namesTeamStore(project) ? found : { ...found, author: '' };
  if (!found.change || !project) return shown;
  return { ...shown, change: changeHere(found.change, project, await rootOf(project)) };
}

/** Each found commit of a list served as foundHere serves one; null stays null. */
export async function foundsHere<T extends { found: FoundCommit | null }>(rows: readonly T[], project: string | null | undefined): Promise<T[]> {
  return Promise.all(rows.map(async (r) => (r.found ? { ...r, found: await foundHere(r.found, project) } : r)));
}

const posix = (p: string) => p.split(sep).join('/');

/** `path` relative to `root`, or null where it is outside it. */
function under(root: string, path: string): string | null {
  const rel = relative(root, path);
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : posix(rel);
}

/** The change with its file's place in the project folder (`top`, the repository's top level, as git names it). */
export function changeHere(change: FoundChange, project: string, top: string | null): FoundChange {
  if (!top) return { ...change, path: null, outside: 0 };
  let folder: string;
  try {
    folder = realpathSync(project);
    top = realpathSync(top);
  } catch {
    return { ...change, path: null, outside: 0 };
  }
  let path: string | null = null;
  try {
    path = under(folder, realpathSync(join(top, change.file)));
  } catch {
    // Not in the working tree now: nothing to open.
  }
  const outside = change.files.filter((f) => under(folder, join(top, f)) === null).length;
  return { ...change, path, outside };
}
