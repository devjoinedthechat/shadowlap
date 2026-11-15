import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { safeLine, type DecisionRemedy } from '@shadowlap/engine';
import { physicalPath } from './real-path.js';
import { listedFiles, readInside } from './repair-tree.js';

/**
 * Where a project's files name the model a migration switches from, and the config change that names
 * the new one there (`shadowlap migrate`'s The config change): the files git lists, a string value in
 * code or config naming the model whole switched in place, a field the new model refuses taken out
 * with it where it stands as a literal on a line of its own in the same call, and every other mention
 * listed for review.
 */

/**
 * The change to the project's files: where a string value names a model it switches from (in code
 * and config), the places in each and the patch; the fields the patch takes out with the model, each
 * with the line it stood on; and the mentions left for review (prose, history, tests, an object key,
 * shadowlap's own config).
 */
export interface ConfigChange {
  files: Array<{ path: string; places: number }>;
  patch: string;
  review: ModelMention[];
  leftOut: Array<{ field: string; path: string; line: number }>;
}

/** A place a project file names a model the switch changes. */
export interface ModelMention {
  path: string;
  line: number;
  text: string;
}


/** Paths whose text is no place the agent names its model: the store, packages, recordings' blobs and lockfiles. */
const NOT_SOURCE = /(^|\/)(\.shadowlap|node_modules|blobs)\/|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|uv\.lock|poetry\.lock|Cargo\.lock)$/;

/**
 * Files the project tracks or would (not ignored), with text, outside recordings and the store. A link
 * is read as the file it ends at, under that file's own path, and only when git lists that file too
 * and it is not git's own (listedFiles, as repair reads them): the patch's context lines and the
 * review never quote a file git ignores, such as a `.env`, a key file kept elsewhere, nor git's
 * config, which can hold a credential.
 */
function projectTextFiles(cwd: string): Array<{ path: string; content: string }> | null {
  let paths: string[];
  try {
    paths = listedFiles(cwd, (path) => NOT_SOURCE.test(path));
  } catch {
    return null;
  }
  const real = physicalPath(cwd);
  const out: Array<{ path: string; content: string }> = [];
  for (const path of paths) {
    // A pack's recording holds the requests the model was sent, not where the agent names it.
    if (/(^|\/)(run\.json|calls\.jsonl)$/.test(path) && existsSync(join(real, dirname(path), 'run.json'))) continue;
    try {
      if (statSync(join(real, path)).size > 1024 * 1024) continue;
      const content = readInside(real, path);
      if (!content.includes('\u0000')) out.push({ path, content });
    } catch {
      // gone, unreadable, or a file with another name
    }
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A unified diff of a file whose lines changed in place, `removed` taken out (by their index in
 * `before`), one hunk per group of changed lines with three lines of context, each hunk's sides
 * counted again where a line went out, as `git apply` reads it. `after` holds the file's lines by
 * the same index, a removed one as it was.
 */
export function lineDiff(path: string, before: string, after: readonly string[], removed: ReadonlySet<number> = new Set()): string {
  const a = before.split('\n');
  const changed = a.map((line, i) => removed.has(i) || line !== after[i]).flatMap((c, i) => (c ? [i] : []));
  if (!changed.length) return '';
  const hunks: Array<[number, number]> = [];
  for (const i of changed) {
    const last = hunks.at(-1);
    if (last && i - last[1] <= 6) last[1] = i;
    else hunks.push([i, i]);
  }
  const lines = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  // A file that ends without a newline has one line fewer to show than `split` gives.
  const count = before.endsWith('\n') ? a.length - 1 : a.length;
  // Lines taken out above a hunk move where it starts in the new file.
  let gone = 0;
  for (const [first, end] of hunks) {
    const start = Math.max(0, first - 3);
    const stop = Math.min(count - 1, end + 3);
    let out = 0;
    for (let i = start; i <= stop; i++) if (removed.has(i)) out++;
    lines.push(`@@ -${start + 1},${stop - start + 1} +${start + 1 - gone},${stop - start + 1 - out} @@`);
    for (let i = start; i <= stop; i++) {
      const noEol = i === count - 1 && !before.endsWith('\n');
      if (removed.has(i)) lines.push(`-${a[i]!}`);
      else if (a[i] === after[i]) lines.push(` ${a[i]!}`);
      else lines.push(`-${a[i]!}`, ...(noEol ? ['\\ No newline at end of file'] : []), `+${after[i]!}`);
      if (noEol && !removed.has(i) && a[i] === after[i]) lines.push('\\ No newline at end of file');
    }
    gone += out;
  }
  return `${lines.join('\n')}\n`;
}

/** Prose and history: what a model was, never what the agent sends now. */
const PROSE = /(^|\/)(CHANGELOG|CHANGES|HISTORY|NEWS|RELEASES?)[^/]*$|\.(md|mdx|markdown|rst|adoc|txt)$/i;
/** Tests and fixtures: what a run once sent, or what a check expects. */
const TESTS = /(^|\/)(tests?|__tests__|specs?|fixtures?|__fixtures__|__recordings__|goldens|testdata)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/i;
/** shadowlap's own config: its prices are keyed by model and its judges name theirs; none is the agent's. */
const SHADOWLAP_CONFIG = /(^|\/)shadowlap\.config\.json$/;
/** A line that is a comment. */
const COMMENT = /^\s*(\/\/|#|\*|\/\*|--|;)/;

type FileKind = 'json' | 'yaml' | 'env' | 'toml' | 'code';

function kindOf(path: string): FileKind {
  if (/\.jsonc?$/i.test(path)) return 'json';
  if (/\.ya?ml$/i.test(path)) return 'yaml';
  if (/(^|\/)\.env(\.[\w.-]+)?$|\.env$/i.test(path)) return 'env';
  if (/\.toml$/i.test(path)) return 'toml';
  return 'code';
}

/**
 * Whether the mention at `at` (of `name`) on `line` is a string value naming the model whole: a JSON
 * string that is no key, a YAML, TOML or .env value, a string literal in code that is no object key.
 */
function isValue(kind: FileKind, line: string, at: number, name: string): boolean {
  if (COMMENT.test(line)) return false;
  const before = line.slice(0, at);
  const after = line.slice(at + name.length);
  const quote = before.at(-1);
  const quoted = (quote === '"' || quote === "'" || quote === '`') && after[0] === quote;
  const rest = quoted ? after.slice(1) : after;
  switch (kind) {
    case 'json':
      return quote === '"' && quoted && !/^\s*:/.test(rest);
    case 'yaml':
      return /^(\s*-\s+|\s*[\w.-]+\s*:\s*|\s*-\s+[\w.-]+\s*:\s*)$/.test(quoted ? before.slice(0, -1) : before) && /^\s*(#.*)?$/.test(rest);
    case 'env':
      return /^\s*(export\s+)?[A-Za-z_]\w*\s*=\s*$/.test(quoted ? before.slice(0, -1) : before) && /^\s*$/.test(rest);
    case 'toml':
      return quoted && /^\s*[\w.-]+\s*=\s*$/.test(before.slice(0, -1)) && /^\s*(#.*)?$/.test(rest);
    default:
      return quoted && !/^\s*:(?!:)/.test(rest);
  }
}

/** A literal a field is set to: a number, a quoted string, a boolean or a null, in the spellings code writes them. */
const LITERAL = String.raw`(?:-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|"[^"\\\n]*"|'[^'\\\n]*'|true|false|True|False|None|null)`;

/** A line that holds only `field` set to a literal, as an argument or a key with a comma after it: `temperature=0,`, `temperature: 0,`, `"temperature": 0,`. */
const fieldLine = (field: string) => new RegExp(String.raw`^[ \t]*(["']?)${escape(field)}\1\s*[=:]\s*${LITERAL}\s*,[ \t]*$`);

const indentOf = (line: string) => /^[ \t]*/.exec(line)![0];

/**
 * The lines of the argument list a switched line stands in: those around it at its indentation, up
 * to the lines that open and close the call (less indented) or a blank line. A line more indented (a
 * nested value) is passed over. A line at the file's top level is in no argument list.
 */
function sameList(lines: readonly string[], at: number): number[] {
  const indent = indentOf(lines[at]!);
  if (!indent) return [];
  const out: number[] = [];
  for (const step of [-1, 1]) {
    for (let j = at + step; j >= 0 && j < lines.length; j += step) {
      const line = lines[j]!;
      const own = indentOf(line);
      if (!line.trim() || own.length < indent.length) break;
      if (own === indent) out.push(j);
    }
  }
  return out;
}

/** The fields the new model refuses that the patch can take out with their line: left out, under no other name. */
type LeaveOut = Pick<DecisionRemedy, 'field' | 'leftOut' | 'renamedTo'>;

/**
 * The lines of a code file the patch takes out with the model: each a field What to set leaves out,
 * set to a literal on a line of its own, in the argument list of a line it switched. A field in JSON,
 * YAML, TOML or .env config stays for the hand, as does a value that is no literal and a field set
 * elsewhere: taken out there, a line could leave the file one its reader refuses.
 */
function linesLeftOut(lines: readonly string[], switched: readonly number[], remedies: readonly LeaveOut[]): Map<number, string> {
  const out = new Map<number, string>();
  const fields = remedies.filter((r) => r.leftOut && !r.renamedTo).map((r) => ({ field: r.field, re: fieldLine(r.field) }));
  if (!fields.length) return out;
  for (const at of switched) {
    for (const j of sameList(lines, at)) {
      const hit = fields.find((f) => f.re.test(lines[j]!));
      if (hit && !switched.includes(j)) out.set(j, hit.field);
    }
  }
  return out;
}

/**
 * Where the project's files name a model it switches from, and the patch that names the new one
 * there: only where a string value in code or config names the model whole. A mention in prose or
 * history, in a test, as an object key (a price table's), or in shadowlap's own config is listed for
 * review and left as it is. In a code file, the patch takes out with the model each field What to set
 * leaves out that stands as a literal on a line of its own in the same call (`leftOut`).
 */
export function modelMentions(cwd: string, from: readonly string[], to: string, remedies: readonly LeaveOut[] = []): ConfigChange | null | 'no-git' {
  const files = projectTextFiles(cwd);
  if (!files) return 'no-git';
  const names = [...new Set(from.filter((m) => m && m !== to))].sort((x, y) => y.length - x.length);
  if (!names.length) return null;
  // A name whole: no id character on either side, though a sentence may end on it (`… to claude-sonnet-4-6.`).
  const re = new RegExp(`(?<![\\w.-])(${names.map(escape).join('|')})(?![\\w-]|\\.\\w)`, 'g');
  const touched: ConfigChange['files'] = [];
  const review: ModelMention[] = [];
  const leftOut: ConfigChange['leftOut'] = [];
  let patch = '';
  for (const f of files) {
    if (!re.test(f.content)) continue;
    re.lastIndex = 0;
    const reviewOnly = PROSE.test(f.path) || TESTS.test(f.path) || SHADOWLAP_CONFIG.test(f.path);
    const kind = kindOf(f.path);
    let places = 0;
    const switched: number[] = [];
    const lines = f.content.split('\n').map((line, i) => {
      let changed = '';
      let last = 0;
      for (const m of line.matchAll(re)) {
        const at = m.index;
        if (!reviewOnly && isValue(kind, line, at, m[0])) {
          changed += `${line.slice(last, at)}${to}`;
          last = at + m[0].length;
          places++;
        } else review.push({ path: f.path, line: i + 1, text: safeLine(line.trim().slice(0, 160)) });
      }
      if (last) switched.push(i);
      return last ? `${changed}${line.slice(last)}` : line;
    });
    if (!places) continue;
    const out = kind === 'code' ? linesLeftOut(lines, switched, remedies) : new Map<number, string>();
    touched.push({ path: f.path, places });
    for (const [j, field] of [...out].sort((x, y) => x[0] - y[0])) leftOut.push({ field, path: f.path, line: j + 1 });
    patch += lineDiff(f.path, f.content, lines, new Set(out.keys()));
  }
  // One entry per line, however many mentions it holds.
  const seen = new Set<string>();
  const listed = review.filter((r) => !seen.has(`${r.path}:${r.line}`) && seen.add(`${r.path}:${r.line}`));
  return touched.length || listed.length ? { files: touched, patch, review: listed, leftOut } : null;
}
