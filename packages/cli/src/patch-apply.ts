import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, sep } from 'node:path';
import { messageOf, patchFiles } from '@shadowlap/engine';
import { EXIT } from './exit-codes.js';

/**
 * Putting a patch from the store into the working tree, as `shadowlap fix apply` and `shadowlap
 * migrate apply` do: the checks on each file it names (a plain file of the working tree, reached
 * through no link, that git doesn't ignore), the patch applied to the files' bytes as they are, a
 * patch already in the tree told apart, and a tree whose changes conflict with it left alone, with
 * what to do about it. Each command passes its own words for what to run again.
 */

export class ApplyError extends Error {
  /** The status apply ends with: 1 for a patch refused or failed, 2 where it was run (not the repository or folder the patch was made in) or what it was given can't be applied. */
  constructor(
    message: string,
    readonly exitCode: number = EXIT.failed,
  ) {
    super(message);
    this.name = 'ApplyError';
  }
}

export const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/**
 * `git apply` as apply runs it: the change as it was verified, whatever git's config says, with no
 * whitespace fixed (apply.whitespace) and none ignored to find where it goes (apply.ignoreWhitespace,
 * which would also take a line that ends with CRLF for one with LF).
 */
export const APPLY = ['-c', 'apply.ignoreWhitespace=no', 'apply', '--whitespace=nowarn'];

/**
 * What the patch makes of its files' bytes as they are: whether it is in them already, else each
 * file's bytes with it applied, or null when it applies to neither. git apply in the working tree
 * converts what it reads and writes as core.autocrlf and the file's text, eol, ident and filter
 * attributes ask: where Git for Windows sets core.autocrlf, or where .gitattributes says `* text=auto`
 * and the line ending git writes is CRLF (Git for Windows' own), it writes a file whose lines end with
 * LF back with CRLF, every line of it, and the file is no longer the one that was verified. Here git
 * applies the patch to the bytes as blobs, in an index of its own, where nothing is converted.
 */
export function applyToBytes(root: string, files: readonly string[], patch: string, args: readonly string[] = []): { already: boolean; bytes: Map<string, Buffer> | null } {
  const now = new Map<string, Buffer>();
  for (const file of files) {
    try {
      now.set(file, readFileSync(join(root, file)));
    } catch {
      // Not there, or not readable: git apply in the working tree says why.
      return { already: false, bytes: null };
    }
  }
  const scratch = mkdtempSync(join(tmpdir(), 'shadowlap-apply-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
    const run = (args: string[], input?: Buffer) => spawnSync('git', args, { cwd: root, env, input, maxBuffer: 64 * 1024 * 1024 });
    const staged = [...now].every(([file, bytes]) => {
      const blob = run(['hash-object', '-w', '--stdin'], bytes);
      return blob.status === 0 && run(['update-index', '--add', '--cacheinfo', `100644,${blob.stdout.toString().trim()},${file}`]).status === 0;
    });
    if (staged && run([...APPLY, ...args, '--cached', '--reverse', '--check', patch]).status === 0) return { already: true, bytes: null };
    if (!staged || run([...APPLY, ...args, '--cached', patch]).status !== 0) return { already: false, bytes: null };
    const bytes = new Map<string, Buffer>();
    for (const file of files) {
      const out = run(['cat-file', 'blob', `:0:${file}`]);
      if (out.status !== 0) return { already: false, bytes: null };
      bytes.set(file, out.stdout);
    }
    return { already: false, bytes };
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Held a moment longer on Windows (a virus scanner reading the new index, say): an index left
      // in the temporary folder harms nothing, and the patch still goes in.
    }
  }
}

export const lstatOrNull = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

/** The first folder on the way to a file of the repository that is a link (a symbolic link, a junction), or null. */
export function linkOnTheWay(root: string, file: string): string | null {
  const dirs = file.split('/').slice(0, -1);
  for (let i = 1; i <= dirs.length; i++) {
    const dir = dirs.slice(0, i).join('/');
    if (lstatOrNull(join(root, dir))?.isSymbolicLink()) return dir;
  }
  return null;
}

/** A path as apply reports it: relative to the folder it runs in, with forward slashes on every system. */
export const shown = (cwd: string, path: string) => relative(cwd, path).split(sep).join('/');

/**
 * Refuses a file the patch would write unless it is a plain file of the working tree, reached through
 * no link to a folder (which could lead the write out of the tree: git apply writes nothing beyond one
 * either), that git doesn't ignore: a change to one git ignores would show in neither git status nor
 * git diff, so nobody would ever read it. `only` says what the patch's maker ever changes, and `read`
 * the patch to read before applying any of it by hand.
 */
export function checkTreeFile(root: string, file: string, words: { only: string; read: string }): void {
  const target = lstatOrNull(join(root, file));
  if (target && !target.isFile()) throw new ApplyError(`${file} is not a plain file in this working tree (a symbolic link or a folder), so the patch was not applied: apply it by hand if you mean to`);
  const link = linkOnTheWay(root, file);
  if (link) throw new ApplyError(`${file} is reached through ${link}, which is a link in this working tree, so the patch was not applied: apply it by hand if you mean to`);
  if (git(root, ['check-ignore', '-q', '--', file]).status === 0) throw new ApplyError(`${file} is a path git ignores here, so a change to it would show in neither git status nor git diff: the patch was not applied. ${words.only}; read ${words.read}, and apply it by hand if you mean to`);
}

/** What a refusal to put the patch in tells to do: the command to run again, what it was made by (`the repair`), and how to make it again (`repair again`). */
export interface PutInWords {
  rerun: string;
  since: string;
  redo: string;
}

/**
 * Puts the patch in: the files' bytes as git applied it to them (`applyToBytes`), else as `git apply`
 * puts it in the working tree, converting line endings. `before` runs once git has found where the
 * patch goes, before anything is written. A tree whose changes conflict with the patch is left alone,
 * with what to do about it. `args` go to each `git apply` (a `--directory` for a patch made in a
 * folder inside the repository, whose paths start there: `prefix`).
 */
export function putIn(at: { root: string; patch: string; text: string; bytes: Map<string, Buffer> | null; cwd: string; args?: readonly string[]; prefix?: string }, words: PutInWords, before: (() => void) | null): void {
  const { root, patch } = at;
  const args = at.args ?? [];
  if (at.bytes) {
    before?.();
    for (const [file, bytes] of at.bytes) {
      try {
        writeFileSync(join(root, file), bytes);
      } catch (err) {
        throw new ApplyError(`writing ${file} failed: ${messageOf(err)}`);
      }
    }
    return;
  }
  const check = git(root, [...APPLY, ...args, '--check', patch]);
  if (check.status !== 0) {
    const files = patchFiles(at.text).map((f) => (at.prefix ? posix.join(at.prefix, f) : f));
    const dirty = files.length ? git(root, ['status', '--porcelain', '--', ...files]).stdout.trim() : '';
    const why = (check.stderr || check.stdout).trim().split('\n')[0] ?? '';
    throw new ApplyError(
      dirty
        ? `${files.join(', ')} ${files.length === 1 ? 'has' : 'have'} uncommitted changes the patch conflicts with (${why}). Nothing was changed: commit or stash them, then run ${words.rerun} again`
        : `the patch no longer applies: ${files.join(', ') || 'the file it changes'} changed since ${words.since} (${why}). Nothing was changed: apply it by hand with git apply --3way ${shown(at.cwd, patch)}, or ${words.redo}`,
    );
  }
  before?.();
  const applied = git(root, [...APPLY, ...args, patch]);
  if (applied.status !== 0) throw new ApplyError(`git apply failed: ${(applied.stderr || applied.stdout).trim()}`);
}
