import { execFileSync } from 'node:child_process';
import { constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { linkDependencies, mapArgv } from './bisect.js';
import { physicalPath } from './real-path.js';

/**
 * Where `shadowlap repair` verifies a candidate: a temporary git worktree of the project's
 * repository, outside the project, never the working tree. The working tree is what an editor
 * autosaves, a dev server reloads and a parallel `shadowlap test` replays; none of them ever sees a
 * candidate. Only the accepted one reaches it, at the end, and only with `--apply`.
 *
 * The worktree is the working tree as it is, not HEAD: it is checked out at HEAD, then every tracked
 * file with uncommitted changes and every untracked file git doesn't ignore is copied in (a file
 * deleted in the working tree is deleted there too), so verify replays the code repair was started
 * on, with one change. What git ignores is brought along as the agent needs it: `node_modules` is
 * linked entry by entry as bisect links it (a package of the repository itself is the worktree's own
 * copy), a Python virtual environment is linked whole, caches a runtime makes again are left out,
 * and everything else (a `.env`, build output, data) is copied, cloned where the file system can,
 * up to COPY_LIMIT in all. Past that it is linked, and `linked` names it: a `--build` that writes
 * there writes the working tree's copy.
 */

/** What is copied of the files git ignores, at most, before the rest is linked instead. */
export const COPY_LIMIT = 256 * 1024 * 1024;

/** Caches a runtime or a tool makes again: neither copied nor linked. */
const REMADE = new Set(['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox', '.cache', '.turbo', '.parcel-cache', '.eslintcache']);

/** The folder the worktrees of one repair go under, in the system's temporary folder: `shadowlap-repair-…`. */
const PREFIX = 'shadowlap-repair-';

export interface CandidateTree {
  /** The worktree's root, and the folder in it that matches the one repair runs in. */
  root: string;
  cwd: string;
  /** A run's recorded command, pointed into the worktree as bisect points it at a commit. */
  argv(argv: readonly string[]): string[];
  /** What git ignores that was linked from the working tree rather than copied, past COPY_LIMIT. */
  linked: string[];
  /** Removes the worktree, and what git keeps about it. Never throws. */
  remove(): void;
}

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).toString();

function gitOk(cwd: string, args: string[]): boolean {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

/** Paths git prints with -z, relative to the repository's root, without what is Shadowlap's own or git's. */
function listed(root: string, args: string[]): string[] {
  return git(root, args)
    .split('\0')
    .filter((p) => p && !p.split('/').some((s) => s === '.shadowlap' || s === '.git'));
}

/** Bytes under a path, without following links, stopping once past `limit`. */
function sizeOf(path: string, limit: number): number {
  let total = 0;
  const walk = (p: string) => {
    if (total > limit) return;
    const st = lstatSync(p);
    if (st.isDirectory()) for (const name of readdirSync(p)) walk(join(p, name));
    else total += st.size;
  };
  walk(path);
  return total;
}

const link = (target: string, path: string, dir: boolean) => symlinkSync(target, path, dir && process.platform === 'win32' ? 'junction' : undefined);

/** Copies a file or a folder as it is, links included, cloned where the file system can. */
function copy(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, force: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
}

/**
 * A worktree for one candidate, as the working tree is now: see the module's comment. `root` is the
 * repository's root and `cwd` the folder repair runs in. Throws when git can't make it.
 */
export function candidateTree(root: string, cwd: string): CandidateTree {
  const realRoot = physicalPath(root);
  const realCwd = physicalPath(cwd);
  const inRepo = relative(realRoot, realCwd);
  const base = mkdtempSync(join(tmpdir(), PREFIX));
  const tree = join(base, 'tree');
  let made = false;
  const remove = () => {
    if (made && !gitOk(realRoot, ['worktree', 'remove', '--force', tree])) gitOk(realRoot, ['worktree', 'prune']);
    rmSync(base, { recursive: true, force: true, maxRetries: 3 });
    if (made) gitOk(realRoot, ['worktree', 'prune']);
  };
  try {
    const head = gitOk(realRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (head) {
      git(realRoot, ['worktree', 'add', '--detach', '--force', tree, 'HEAD']);
      made = true;
    } else mkdirSync(tree);
    // The working tree's own files: the ones changed since HEAD (or, with no commit yet, every one)
    // and the untracked ones git doesn't ignore. A file deleted here is deleted there.
    const changed = head ? listed(realRoot, ['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--']) : listed(realRoot, ['ls-files', '-z', '--cached']);
    const untracked = listed(realRoot, ['ls-files', '-z', '--others', '--exclude-standard']);
    for (const p of [...changed, ...untracked]) {
      const from = join(realRoot, p);
      const to = join(tree, p);
      let st;
      try {
        st = lstatSync(from);
      } catch {
        rmSync(to, { recursive: true, force: true });
        continue;
      }
      if (st.isDirectory() && !st.isSymbolicLink()) continue;
      copy(from, to);
    }
    // A submodule is linked as it is checked out here: a worktree has its folder, empty.
    for (const line of git(realRoot, ['ls-files', '-z', '--stage']).split('\0')) {
      const m = /^160000 [0-9a-f]+ \d\t(.+)$/.exec(line);
      if (!m || !existsSync(join(realRoot, m[1]!))) continue;
      rmSync(join(tree, m[1]!), { recursive: true, force: true });
      mkdirSync(dirname(join(tree, m[1]!)), { recursive: true });
      link(join(realRoot, m[1]!), join(tree, m[1]!), true);
    }
    // What git ignores, as the agent needs it.
    const linked: string[] = [];
    let copied = 0;
    for (const entry of listed(realRoot, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])) {
      const p = entry.replace(/\/$/, '');
      const from = join(realRoot, p);
      const to = join(tree, p);
      const name = basename(p);
      if (REMADE.has(name) || existsSync(to)) continue;
      let st;
      try {
        st = lstatSync(from);
      } catch {
        continue;
      }
      if (name === 'node_modules' && st.isDirectory()) {
        linkDependencies(realRoot, dirname(from), dirname(to), tree);
        continue;
      }
      if (st.isDirectory() && existsSync(join(from, 'pyvenv.cfg'))) {
        mkdirSync(dirname(to), { recursive: true });
        link(from, to, true);
        continue;
      }
      const size = st.isDirectory() ? sizeOf(from, COPY_LIMIT) : st.size;
      if (copied + size <= COPY_LIMIT) {
        copy(from, to);
        copied += size;
      } else {
        mkdirSync(dirname(to), { recursive: true });
        link(from, to, st.isDirectory());
        linked.push(p);
      }
    }
    linkModulesAbove(realRoot, tree);
    const treeCwd = join(tree, inRepo);
    mkdirSync(treeCwd, { recursive: true });
    return {
      root: tree,
      cwd: treeCwd,
      argv: (argv) => mapArgv(argv, { root: realRoot, worktree: tree, cwd: realCwd, worktreeCwd: treeCwd }),
      linked,
      remove,
    };
  } catch (err) {
    remove();
    throw err;
  }
}

/**
 * Packages installed in folders above the repository, as a project inside another one finds them:
 * Node looks for a package in the node_modules of every folder above a module, nearest first, and the
 * worktree is in the temporary folder. Each package the worktree's own node_modules lacks is linked
 * into it from the nearest folder above the repository that has it. A node_modules that is itself a
 * link is left as it is: what goes into it would go into the folder it links to.
 */
function linkModulesAbove(root: string, tree: string): void {
  const into = join(tree, 'node_modules');
  if (existsSync(into) && lstatSync(into).isSymbolicLink()) return;
  for (let dir = dirname(root); dir !== dirname(dir); dir = dirname(dir)) {
    const above = join(dir, 'node_modules');
    let names: string[];
    try {
      if (!statSync(above).isDirectory()) continue;
      names = readdirSync(above);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const scoped = name.startsWith('@') && statSync(join(above, name)).isDirectory();
      for (const pkg of scoped ? readdirSync(join(above, name)).map((sub) => join(name, sub)) : [name]) {
        const to = join(into, pkg);
        if (existsSync(to)) continue;
        try {
          mkdirSync(dirname(to), { recursive: true });
          link(join(above, pkg), to, true);
        } catch {
          // one that can't be linked is missing in the worktree, as a dangling one would be
        }
      }
    }
  }
}

/**
 * Removes the worktrees a repair that died left, and what git keeps about them: each registered
 * worktree in a `shadowlap-repair-…` folder of the temporary folder. Called holding the folder's
 * repair lock, so none is a running repair's. Returns the folders it removed.
 */
export function removeCandidateTrees(root: string): string[] {
  const realRoot = physicalPath(root);
  // The temporary folder as it was named and as the system resolves it (/var and /private/var on macOS).
  const temps = [...new Set([tmpdir(), physicalPath(tmpdir())])];
  const removed: string[] = [];
  let listing = '';
  try {
    listing = git(realRoot, ['worktree', 'list', '--porcelain', '-z']);
  } catch {
    return removed;
  }
  for (const field of listing.split('\0')) {
    if (!field.startsWith('worktree ')) continue;
    const path = field.slice('worktree '.length);
    const ours = temps.some((temp) => {
      const rel = relative(temp, path);
      return !!rel && !rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep).length === 2 && rel.split(sep)[0]!.startsWith(PREFIX);
    });
    if (!ours || basename(path) !== 'tree') continue;
    if (!gitOk(realRoot, ['worktree', 'remove', '--force', path])) rmSync(path, { recursive: true, force: true });
    rmSync(dirname(path), { recursive: true, force: true });
    removed.push(dirname(path));
  }
  gitOk(realRoot, ['worktree', 'prune']);
  return removed;
}
