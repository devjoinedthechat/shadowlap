import { execFileSync } from 'node:child_process';
import { basename, dirname, join, sep } from 'node:path';
import { specFor, type TestEntry } from '@shadowlap/engine';

/**
 * The first bad commit's change, kept with bisect's answer so the dashboard shows it without a
 * checkout: the file it opens, the commit's files, that file's hunk and the line to open. Every diff
 * is against the commit's first parent, as the search follows first parents: a merge's change is
 * what it brought into the line, and reverting it takes `-m 1`.
 */
export interface BisectChange {
  /** Relative to the repository, as git names it: the changed file the answer opens. */
  file: string;
  /** Every file the commit changed against its first parent, as git names them, up to {@link MAX_FILES}. */
  files: string[];
  /** `file`'s diff from its first `@@`, cut to about {@link MAX_HUNK_LINES} lines and {@link MAX_HUNK_BYTES} bytes; null for a binary or deleted file. */
  hunk: string | null;
  /** The new file's line of the first added line, the hunk's start where it only deletes; null without a hunk. */
  line: number | null;
  /** The hunk was cut to its bounds. */
  cut: boolean;
  /** The commit is a merge: its change is against its first parent. */
  merge: boolean;
}

export const MAX_FILES = 50;
export const MAX_HUNK_LINES = 60;
export const MAX_HUNK_BYTES = 4096;

/** Pathspecs taken as names, so a file called `*.md` or `:(top)x` is only itself. */
const git = (root: string, args: string[]) => execFileSync('git', ['--literal-pathspecs', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString();

/** Where to look for the file that broke the agent, and what can't be it. */
export interface ChangeScope {
  /** The recorded command's folder, relative to the repository ('' for its top). */
  inRepo: string;
  /** The project folder (where shadowlap.config.json is), as a physical path. */
  projectDir: string;
  /** The config's tests: their pack folders hold recordings, not the agent. */
  tests: TestEntry[];
  /** The golden searched, a pack folder relative to the project, or null for a run. */
  golden: string | null;
}

/**
 * The change `rev` made, against its first parent, or null when git can't say (it never fails the
 * search) or the commit changed no file.
 */
export function commitChange(root: string, rev: string, scope: ChangeScope): BisectChange | null {
  try {
    const parents = git(root, ['rev-list', '--parents', '-n', '1', rev]).trim().split(/\s+/);
    const names = (filter: string[]) => git(root, ['diff', '--name-only', '-z', ...filter, `${rev}^1`, rev]).split('\0').filter(Boolean);
    const files = names([]);
    if (!files.length) return null;
    const file = pickFile(files, root, scope, new Set(names(['--diff-filter=D'])));
    const diff = git(root, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', `${rev}^1`, rev, '--', file]);
    return { file, files: files.slice(0, MAX_FILES), ...hunkOf(diff), merge: parents.length > 2 };
  } catch {
    return null;
  }
}

/**
 * The file the answer opens: the first under the recorded command's folder that isn't in a pack
 * folder and isn't the config, since bisect takes the recordings, checks and normalizers from the
 * working tree at every commit, so none of those broke it. One the commit deleted (`gone`) has no
 * hunk to show, nor a line to open, so one still there comes first, in the same order. The first
 * file when none fits.
 */
export function pickFile(files: readonly string[], root: string, scope: ChangeScope, gone: ReadonlySet<string> = new Set()): string {
  const under = scope.inRepo.split(sep).join('/');
  const packs = scope.golden ? new Set([join(scope.projectDir, scope.golden)]) : new Set<string>();
  const inPack = (file: string): boolean => {
    for (let dir = dirname(join(root, file)); dir !== root && dir !== dirname(dir); dir = dirname(dir)) {
      if (packs.has(dir) || specFor(scope.tests, dir, scope.projectDir)) return true;
    }
    return false;
  };
  const fits = (file: string) => (!under || file.startsWith(`${under}/`)) && basename(file) !== 'shadowlap.config.json' && !inPack(file);
  return files.find((f) => fits(f) && !gone.has(f)) ?? files.find(fits) ?? files.find((f) => !gone.has(f)) ?? files[0]!;
}

/**
 * One file's diff as the answer keeps it: from its first `@@`, cut at a line to the bounds, with the
 * new file's line of the first added line. Lines are counted from a hunk's `+c`, advancing on context
 * and added lines only, so lines deleted before the first addition don't move it. A diff with no hunk
 * (a binary file) or of a deleted file keeps none.
 */
export function hunkOf(diff: string): Pick<BisectChange, 'hunk' | 'line' | 'cut'> {
  const lines = diff.split('\n');
  const start = lines.findIndex((l) => l.startsWith('@@'));
  if (start < 0 || lines.slice(0, start).some((l) => l.startsWith('deleted file mode'))) return { hunk: null, line: null, cut: false };
  const body = lines.slice(start);
  while (body.length && body.at(-1) === '') body.pop();
  return { ...bounded(body), line: firstAdded(body) };
}

function bounded(body: readonly string[]): { hunk: string; cut: boolean } {
  const kept: string[] = [];
  let bytes = 0;
  for (const l of body) {
    const size = Buffer.byteLength(l, 'utf8') + 1;
    if (kept.length >= MAX_HUNK_LINES || (kept.length && bytes + size > MAX_HUNK_BYTES)) return { hunk: kept.join('\n'), cut: true };
    kept.push(l);
    bytes += size;
  }
  return { hunk: kept.join('\n'), cut: false };
}

function firstAdded(body: readonly string[]): number {
  let first: number | null = null;
  let n = 0;
  for (const l of body) {
    const at = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (at) {
      n = Number(at[1]);
      first ??= Math.max(1, n);
    } else if (l.startsWith('+')) return Math.max(1, n);
    else if (l.startsWith(' ')) n++;
  }
  return first ?? 1;
}
