import { execFileSync } from 'node:child_process';
import { lstatSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isObject, messageOf } from '@shadowlap/engine';
import { fileInside, gitFolders, readInside, repositoryRoot, writeInside } from './repair-tree.js';
import { physicalPath, realPath } from './real-path.js';

/**
 * The journal an older shadowlap kept while it tried a candidate in the working tree, and what puts
 * back a working tree such a repair left edited when it died. shadowlap writes none: every candidate
 * is verified in a worktree of its own, outside the project (repair-tree.ts), and only `--apply`
 * writes the working tree, once, holding the folder's repair lock. So there is no journal to keep out
 * of the checkout or to sign, and one an older shadowlap left carries no signature to check: what is
 * left is to tell a journal such a repair left from one that came with the checkout.
 *
 * The journal is a file in the checkout, `.shadowlap/repair-journal.json` in the folder repair ran
 * in, and what it names is written to, so it is taken for a repair's only when git says it is the
 * checkout's own: a file git doesn't track, in any case of its name (a clone, a pull, a checkout of a
 * pull request writes only what git tracks), of this repository and not a submodule's, reached
 * through no link and with no other name. A journal that names a file outside the repository, which
 * no repair of it edited, is no repair's of this checkout either. Even then, it puts back only a
 * regular file of the repository's own, never one of git's (fileInside), never through a link or
 * onto a file with another name (writeInside), and only one that holds exactly the candidate's text:
 * a file someone changed since is theirs. A journal it doesn't take is left as it is, and repair and
 * `shadowlap doctor` say why.
 */

/** Where the journal is: `.shadowlap/repair-journal.json` in the folder repair runs in. */
export const journalPath = (cwd: string) => join(cwd, '.shadowlap', 'repair-journal.json');

/** A file the journal says a candidate was written into: its path in the repository, with forward slashes, and its text before and after. */
export interface JournaledFile {
  file: string;
  original: string;
  patched: string;
}

/**
 * What is where the journal goes: nothing; one a repair left, with the repository's root as git
 * names it, the process that wrote it and the files it names; or one that is no repair's of this
 * checkout, and why.
 */
export type Journal = { kind: 'none' } | { kind: 'left'; root: string; pid: number | null; files: JournaledFile[] } | { kind: 'ignored'; why: string };

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).toString();

/**
 * Why git doesn't list `rel` as a file of the repository's that it doesn't track, or null when it
 * does. Asked by the name the file system gives it, and of every tracked name in any case: on macOS
 * and Windows, a tracked `.SHADOWLAP/repair-journal.json` is the same file, which a question in
 * the other case would take for an untracked one.
 */
function notUntracked(realRoot: string, rel: string): string | null {
  try {
    const named = relative(realRoot, realPath(join(realRoot, rel))).split(sep).join('/');
    if (git(realRoot, ['ls-files', '-z', '--cached', '--', `:(icase,literal)${named}`])) return 'git tracks it, so it came with the repository';
    // Not a submodule's, nor a nested repository's: git lists only its own files.
    if (git(realRoot, ['ls-files', '-z', '--others', '--', `:(literal)${named}`]) !== `${named}\0`) return 'git does not list it as a file of this repository';
    return null;
  } catch (err) {
    return `git could not say whether it tracks it: ${messageOf(err).split('\n')[0]!}`;
  }
}

/**
 * A path the journal names, relative to the repository's root with forward slashes, when it is a
 * path an older shadowlap wrote: the root git named joined to a file's path, so absolute, and inside
 * the repository once its links are resolved. Otherwise why it is no such path.
 */
function journaledPath(realRoot: string, path: string): { file: string } | string {
  if (!isAbsolute(path)) return 'it names a file by a relative path, which no shadowlap writes';
  const rel = relative(realRoot, physicalPath(path));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return 'it names a file outside the repository, which no repair of it edited';
  return { file: rel.split(sep).join('/') };
}

/** The files a journal's text names, or why it is no journal of a repair of this checkout's. */
function journaledFiles(realRoot: string, text: string): { pid: number | null; files: JournaledFile[] } | string {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // no JSON: no journal
  }
  const notOne = 'it is not a journal shadowlap writes';
  if (!isObject(parsed) || !Array.isArray(parsed.files)) return notOne;
  const listed: unknown[] = parsed.files;
  if (!listed.every((f) => isObject(f) && typeof f.path === 'string' && typeof f.original === 'string' && typeof f.patched === 'string')) return notOne;
  const decode = (s: string) => Buffer.from(s, 'base64').toString('utf8');
  const files: JournaledFile[] = [];
  for (const f of listed as Array<{ path: string; original: string; patched: string }>) {
    const at = journaledPath(realRoot, f.path);
    if (typeof at === 'string') return at;
    files.push({ file: at.file, original: decode(f.original), patched: decode(f.patched) });
  }
  return { pid: typeof parsed.pid === 'number' ? parsed.pid : null, files };
}

/**
 * The journal in `cwd`, and whether it is one a repair of this checkout left (see the module's
 * comment). `root` is the git repository's root, found from `cwd` when not given.
 */
export function readJournal(cwd: string, root?: string): Journal {
  const path = journalPath(cwd);
  try {
    // Not followed: a journal that is a link, even a dangling one, is found too, and refused.
    if (!lstatSync(path, { throwIfNoEntry: false })) return { kind: 'none' };
  } catch {
    return { kind: 'none' };
  }
  const top = root ?? repositoryRoot(cwd);
  if (!top) return { kind: 'ignored', why: 'the folder is in no git repository' };
  const realRoot = physicalPath(top);
  // Where it is by the folder's own name, every folder on the way and the file itself checked as they are.
  const rel = relative(realRoot, join(physicalPath(cwd), '.shadowlap', 'repair-journal.json')).split(sep).join('/');
  let text: string;
  try {
    text = readInside(realRoot, rel);
  } catch (err) {
    return { kind: 'ignored', why: `it can't be read as a file of the repository's own (${messageOf(err)})` };
  }
  const untracked = notUntracked(realRoot, rel);
  if (untracked) return { kind: 'ignored', why: untracked };
  const found = journaledFiles(realRoot, text);
  return typeof found === 'string' ? { kind: 'ignored', why: found } : { kind: 'left', root: top, ...found };
}

/**
 * Puts back whatever an interrupted repair left in the working tree, from its journal, which is then
 * removed. Returns the files it restored, by `root` joined to their paths, and why it left a journal
 * that is no repair's of this checkout as it is (null when there was none, or it was one).
 */
export function recoverWorkingTree(cwd: string, root?: string): { restored: string[]; ignored: string | null } {
  const journal = readJournal(cwd, root);
  if (journal.kind === 'none') return { restored: [], ignored: null };
  if (journal.kind === 'ignored') return { restored: [], ignored: journal.why };
  const realRoot = physicalPath(journal.root);
  const gitOwn = gitFolders(realRoot);
  const restored: string[] = [];
  for (const f of journal.files) {
    // The repository's own regular file, a link resolved to the one it names; gone, git's own, or anything else, is left.
    const file = fileInside(realRoot, f.file, gitOwn);
    if (!file) continue;
    let now: string;
    try {
      now = readInside(realRoot, file);
    } catch {
      // a file with another name, or one that changed as it was opened: not the repository's alone
      continue;
    }
    // Only undo the candidate's edit: a file someone changed since is theirs.
    if (now !== f.patched) continue;
    writeInside(realRoot, file, f.original);
    restored.push(join(journal.root, file));
  }
  rmSync(journalPath(cwd), { force: true });
  return { restored, ignored: null };
}
