import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Each folder's repository index, once found: a request then stats one file. */
const found = new Map<string, string>();

/** Where `at/.git` keeps the repository's metadata: that folder, or the one a worktree's `.git` file names; undefined where there is no `.git`. */
function gitDirAt(at: string): string | null | undefined {
  const dotGit = join(at, '.git');
  const st = statSync(dotGit, { throwIfNoEntry: false });
  if (!st) return undefined;
  if (st.isDirectory()) return dotGit;
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
  return m ? resolve(at, m[1]!.trim()) : null;
}

/** The index of the repository `dir` is in, found by walking up from it; null outside one, or where it can't be read. */
function indexOf(dir: string): string | null {
  const known = found.get(dir);
  if (known) return known;
  try {
    for (let at = resolve(dir); ; at = dirname(at)) {
      const gitDir = gitDirAt(at);
      if (gitDir !== undefined) {
        if (gitDir === null) return null;
        const index = join(gitDir, 'index');
        found.set(dir, index);
        return index;
      }
      if (dirname(at) === at) return null;
    }
  } catch {
    return null;
  }
}

/**
 * A stamp of what git tracks in the repository `dir` is in: its index's size and when it was last
 * written, which `git add`, `git rm --cached`, a commit and a checkout each rewrite. A read that asks
 * git what it tracks is revalidated by it without running git. Empty outside a repository.
 */
export function gitIndexStamp(dir: string): string {
  const index = indexOf(dir);
  try {
    const st = index ? statSync(index, { throwIfNoEntry: false }) : undefined;
    return st ? `${st.size}:${st.mtimeMs}` : '';
  } catch {
    return '';
  }
}
