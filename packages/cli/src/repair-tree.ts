import { execFileSync } from 'node:child_process';
import { closeSync, constants, cpSync, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { linkDependencies, mapArgv } from './bisect.js';
import { physicalPath, realPath } from './real-path.js';

/**
 * Where `shadowlap repair` verifies a candidate: a temporary git worktree of the project's
 * repository, outside the project, never the working tree. The working tree is what an editor
 * autosaves, a dev server reloads and a parallel `shadowlap test` replays; none of them ever sees a
 * candidate. Only the accepted one reaches it, at the end, and only with `--apply`.
 *
 * The worktree is the working tree as it is, not HEAD: it is checked out at HEAD, then every tracked
 * file with uncommitted changes and every untracked file git doesn't ignore is copied in (a file
 * deleted in the working tree is deleted there too), so verify replays the code repair was started
 * on, with one change. A link among them is copied as a link, except that one naming a path in the
 * repository by its absolute name names the worktree's copy instead. What git ignores is brought
 * along as the agent needs it: `node_modules` is linked entry by entry as bisect links it (a package
 * of the repository itself is the worktree's own copy), a Python virtual environment is linked whole,
 * caches a runtime makes again are left out, and everything else (a `.env`, build output, data) is
 * copied, cloned where the file system can. The working tree's own files and what git ignores are
 * copied up to COPY_LIMIT in all; past that they are linked, and `linked` names them: a `--build`
 * that writes there writes the working tree's copy.
 *
 * With `build` (repair's `--build`), which writes into what it builds with, nothing it builds with is
 * linked from the repository: `node_modules` is copied whole (cloned where the file system can), a
 * package of the repository itself still linked to the worktree's own copy, and a virtual environment
 * is left for the build to make, as it can't be copied (its scripts name the original's interpreter).
 * Packages installed above the repository are linked either way.
 */

/** What is copied of the working tree's files and of those git ignores, at most, before the rest is linked instead. */
export const COPY_LIMIT = 256 * 1024 * 1024;

/** Caches Python and its tools make again: neither copied nor linked. */
const REMADE = new Set(['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox']);

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
  remove: () => void;
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

/**
 * Copies the working tree's link `from` as a link at `to`, as it is, except that one naming a path in
 * the repository by its absolute name (`/home/me/agent/prompts/policy.md`) names the worktree's copy
 * of it: the working tree's would be what the agent reads, and what a build writes into.
 */
function relink(realRoot: string, from: string, to: string, tree: string): void {
  const target = readlinkSync(from);
  mkdirSync(dirname(to), { recursive: true });
  rmSync(to, { recursive: true, force: true });
  const real = isAbsolute(target) ? physicalPath(target) : null;
  if (real && within(realRoot, real)) symlinkSync(join(tree, relative(realRoot, real)), to);
  else copy(from, to);
}

/** Copies a file or a folder as it is, links included, cloned where the file system can. */
function copy(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, force: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
}

/** Whether `path` is `root` or inside it, both as the system names them. */
const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return !rel.startsWith('..') && !isAbsolute(rel);
};

/**
 * Whether a path relative to a repository's root is in a folder named .git, or is one, at any depth,
 * its name read as Windows and macOS read it: in any case, without the dots and spaces Windows drops
 * from its end. That is git's own, never the project's.
 */
const inGitFolder = (rel: string) => rel.split(/[\\/]/).some((part) => part.replace(/[. ]+$/, '').toLowerCase() === '.git');

/**
 * The folders git keeps the repository at `root` in, as the system names them: its git dir and, for
 * a linked worktree, the common one, wherever they are (`.git` at the root, or a folder a `.git` file
 * names, inside the repository or out of it). Neither holds a file of the project's, and the config
 * in them can hold a credential: a remote's URL with a token, the header actions/checkout writes.
 */
export function gitFolders(root: string): string[] {
  const named = git(root, ['rev-parse', '--absolute-git-dir', '--git-common-dir']).split('\n').filter(Boolean);
  return [...new Set(named.map((dir) => physicalPath(resolve(root, dir))))];
}

/**
 * The file a project path names, as repair may read and rewrite it: the path itself for a regular
 * file, or for a link (or a path through one) the path of the regular file it ends at, relative to
 * `root` with forward slashes, when that file is inside the repository and is not git's own: in no
 * folder named .git, and in none of `gitOwn` (gitFolders), git's own folders by whatever name a
 * `.git` file gives them. A link out of the repository, to a file of another project, a home folder
 * or the system, or into git's own folder, to its config, names nothing repair may touch: null, as
 * for anything that isn't a regular file or can't be read.
 */
export function fileInside(root: string, rel: string, gitOwn: readonly string[] = []): string | null {
  const realRoot = physicalPath(root);
  let real: string;
  try {
    real = realPath(join(realRoot, rel));
    if (!lstatSync(real).isFile()) return null;
  } catch {
    return null;
  }
  if (!within(realRoot, real) || real === realRoot) return null;
  const inside = relative(realRoot, real).split(sep).join('/');
  if (inGitFolder(inside) || gitOwn.some((dir) => within(dir, real))) return null;
  return inside;
}

/**
 * For a test that plays a process racing repair on the same files: `walked` is called once the path
 * has been walked, before the file is opened, and `opened` once it is open, before it is checked.
 */
export interface OpenRace {
  walked?: () => void;
  opened?: () => void;
}

/**
 * Each folder from `root` down to the file `parts` name, and the file itself, as they are, a link
 * never followed: a folder that is a link, or isn't a folder, or a file that is a link, or isn't a
 * regular one, throws, with why. Returns the file's own stat.
 */
function walkInside(root: string, parts: readonly string[]): BigIntStats {
  let at = root;
  let st: BigIntStats | null = null;
  for (const [i, part] of parts.entries()) {
    at = join(at, part);
    st = lstatSync(at, { bigint: true });
    if (st.isSymbolicLink()) throw new Error(`${parts.slice(0, i + 1).join('/')} is a link, which repair never writes through`);
    if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()) throw new Error(`${parts.slice(0, i + 1).join('/')} is not a ${i < parts.length - 1 ? 'folder' : 'file'}`);
  }
  return st!;
}

/**
 * Opens `rel` under `root` without following a link anywhere on the way: each folder from `root`
 * down, and the file itself, must be what they are, never a link, and the file a regular one that is
 * there already. Throws, with why, otherwise. `O_NOFOLLOW` covers only the file itself, so a folder
 * on the way swapped for a link between the walk and the open would have the open follow it, out
 * of the root: the open changes nothing (no `O_TRUNC`, no `O_CREAT`, and `O_NONBLOCK`, so a pipe
 * put there can't hold it), and the file it opened must be the one the path, walked again once it
 * is open, names now, else it is closed untouched and this throws. So does a file with another
 * name, a hard link, which is the same file outside the root as in it.
 */
function openInside(root: string, rel: string, flags: number, race: OpenRace = {}): number {
  const parts = rel.split('/');
  if (isAbsolute(rel) || parts.some((p) => p === '' || p === '.' || p === '..')) throw new Error(`${rel} is not a path inside the repository`);
  walkInside(root, parts);
  race.walked?.();
  const fd = openSync(join(root, rel), flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    race.opened?.();
    const opened = fstatSync(fd, { bigint: true });
    const named = walkInside(root, parts);
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) throw new Error(`${rel} changed while repair opened it, so repair left what it opened as it was`);
    // A file with another name (a hard link) is the same file wherever that name is, outside the root too.
    if (opened.nlink > 1n) throw new Error(`${rel} is a hard link, a file with another name, perhaps outside the repository, so repair leaves it as it is`);
    return fd;
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/** A file's text under `root`, read without following a link (openInside). */
export function readInside(root: string, rel: string, race: OpenRace = {}): string {
  const fd = openInside(root, rel, constants.O_RDONLY, race);
  try {
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes `text` over `rel` under `root`, a worktree's or the working tree's, without following a
 * link (openInside): a candidate written through one would land wherever it points, outside the
 * worktree. The file is emptied only once it is known to be the one the path names, through what
 * was opened, never the path. Throws, with why, when the path is a link, goes through one, isn't a
 * file there, or changed while it was opened.
 */
export function writeInside(root: string, rel: string, text: string, race: OpenRace = {}): void {
  const fd = openInside(root, rel, constants.O_WRONLY, race);
  try {
    ftruncateSync(fd, 0);
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/**
 * Gives a worktree a copy of the working tree's installed packages, for a build that writes into
 * them: each entry of `from/node_modules` is copied into `to/node_modules` as it is, links and all,
 * except a package linked from this repository itself (a workspace package), which is linked to the
 * worktree's own copy, as linkDependencies links it.
 */
function copyDependencies(root: string, from: string, to: string, worktree: string): void {
  const src = join(from, 'node_modules');
  const dst = join(to, 'node_modules');
  if (!existsSync(src) || existsSync(dst)) return;
  const one = (entry: string, path: string) => {
    try {
      if (lstatSync(entry).isSymbolicLink()) {
        const rel = relative(root, realPath(entry));
        if (rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(/[\\/]/).includes('node_modules')) {
          link(join(worktree, rel), path, true);
          return;
        }
      }
      copy(entry, path);
    } catch {
      // a dangling link, or one that can't be made: that package is missing in the worktree, as in bisect
    }
  };
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    if (name.startsWith('@') && statSync(join(src, name)).isDirectory() && !lstatSync(join(src, name)).isSymbolicLink()) {
      mkdirSync(join(dst, name), { recursive: true });
      for (const sub of readdirSync(join(src, name))) one(join(src, name, sub), join(dst, name, sub));
    } else one(join(src, name), join(dst, name));
  }
}

/**
 * A worktree for one candidate, as the working tree is now: see the module's comment. `root` is the
 * repository's root and `cwd` the folder repair runs in; `copyLimit` is what is copied of the working
 * tree's own files and of those git ignores, at most (COPY_LIMIT); `build`, that repair builds the
 * agent there. Throws when git can't make it.
 */
export function candidateTree(root: string, cwd: string, { copyLimit = COPY_LIMIT, build = false }: { copyLimit?: number; build?: boolean } = {}): CandidateTree {
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
      // Without the repository's hooks: a post-checkout hook (an install, say) is the project's, not a candidate's.
      const hooks = join(base, 'no-hooks');
      mkdirSync(hooks);
      git(realRoot, ['-c', `core.hooksPath=${hooks}`, 'worktree', 'add', '--detach', '--force', tree, 'HEAD']);
      made = true;
    } else mkdirSync(tree);
    const linked: string[] = [];
    let copied = 0;
    /** Copies a file or folder of the working tree's within the limit; past it, links it and names it. */
    const bring = (p: string, from: string, to: string, size: number, dir: boolean) => {
      if (copied + size <= copyLimit) {
        copy(from, to);
        copied += size;
        return;
      }
      mkdirSync(dirname(to), { recursive: true });
      try {
        link(from, to, dir);
        linked.push(p);
      } catch {
        // A file Windows won't link without privileges a runner may not have: copied after all.
        copy(from, to);
      }
    };
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
      if (st.isSymbolicLink()) {
        relink(realRoot, from, to, tree);
        continue;
      }
      if (st.isDirectory()) continue;
      bring(p, from, to, st.size, false);
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
      // Under a build, a node_modules that is itself a link is copied too: what the build writes there would reach what it links to.
      if (name === 'node_modules' && (st.isDirectory() || (build && st.isSymbolicLink() && statSync(from).isDirectory()))) {
        if (build) copyDependencies(realRoot, dirname(from), dirname(to), tree);
        else linkDependencies(realRoot, dirname(from), dirname(to), tree);
        continue;
      }
      if (st.isDirectory() && existsSync(join(from, 'pyvenv.cfg'))) {
        // A build makes the environment it needs: one linked here is the working tree's, which it would write into.
        if (build) continue;
        mkdirSync(dirname(to), { recursive: true });
        link(from, to, true);
        continue;
      }
      bring(p, from, to, st.isDirectory() ? sizeOf(from, copyLimit) : st.size, st.isDirectory());
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
  let listing: string;
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
