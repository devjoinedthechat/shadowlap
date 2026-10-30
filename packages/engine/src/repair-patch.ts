import { longestRewrite, placeholders, REPAIR_FILE_LIMIT, templateSyntax, type Placeholder, type RepairReport, type SourceFile } from './repair.js';
import { sourceStrings, type SourceString } from './source-strings.js';
import { safeLine } from './text.js';

/**
 * What a repair's patch may change, and where a repair rewrites text. `shadowlap fix apply` hands a
 * patch to `git apply`, and the store it comes from can be someone else's (a teammate's bucket, a
 * copied file), so a patch is held to the one rewrite its accepted candidate makes
 * (`repairPatchProblem`). A repair rewrites text only inside a string of JavaScript, TypeScript or
 * Python source, or in a prose file, where it places its anchors (`repairNeverRewritesAt`).
 */

/**
 * Every file a patch names, as `git apply` reads its headers: both sides of `diff --git`, the `---`
 * and `+++` lines, renames and copies; `/dev/null` (a file made or deleted) is left out. A hunk's
 * lines are skipped by its counts, so a removed line that starts with `--` is not taken for a header.
 */
export function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  const add = (name: string, prefix: boolean) => {
    const n = name.replace(/\t.*$/, '').trim();
    if (n && n !== '/dev/null') files.add(prefix ? n.replace(/^[ab]\//, '') : n);
  };
  const lines = patch.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(l);
    if (hunk) {
      let old = hunk[1] === undefined ? 1 : Number(hunk[1]);
      let now = hunk[2] === undefined ? 1 : Number(hunk[2]);
      while ((old > 0 || now > 0) && i + 1 < lines.length) {
        const h = lines[++i]!;
        if (h.startsWith('\\')) continue;
        if (!h.startsWith('+')) old--;
        if (!h.startsWith('-')) now--;
      }
      continue;
    }
    const git = /^diff --git (.+)$/.exec(l);
    if (git) {
      // `a/<name> b/<name>`: the same name on both sides, spaces and all, unless it was renamed.
      const both = git[1]!;
      const n = (both.length - 5) / 2;
      if (Number.isInteger(n) && both.startsWith('a/') && both.slice(2 + n, 5 + n) === ' b/' && both.slice(2, 2 + n) === both.slice(5 + n)) add(both.slice(2, 2 + n), false);
      else for (const side of both.split(/ (?=b\/)/)) add(side, true);
      continue;
    }
    const named = /^(?:---|\+\+\+) (.+)$/.exec(l);
    if (named) add(named[1]!, true);
    const moved = /^(?:rename|copy) (?:from|to) (.+)$/.exec(l);
    if (moved) add(moved[1]!, false);
  }
  return [...files];
}

/** A path `git apply` reads as written: relative, inside the repository, outside `.git`, with nothing it would unquote or trim. */
function plainRepoPath(file: string): boolean {
  return (
    file.length > 0 &&
    file === file.trim() &&
    !/[\u0000-\u001f\u007f-\u009f"\\]/.test(file) &&
    !file.startsWith('/') &&
    !/^[a-z]:/i.test(file) &&
    file.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && s.toLowerCase() !== '.git')
  );
}

const fileList = (files: string[]) => (files.length > 1 ? `${files.slice(0, -1).join(', ')} and ${files.at(-1)!}` : (files[0] ?? 'nothing'));

/**
 * What `file` (a path relative to the repository, with forward slashes) is when a repair never
 * rewrites it, whatever a report says, or null. A repair rewrites the text the agent sends the model where the
 * agent's source holds it. A recording holds a copy of that text, and a pack's run.json holds the
 * command its replay runs, which `shadowlap test` runs without asking for a pack the repository
 * tracks: so no file of a recording (a pack's run.json, calls.jsonl and blobs, or anything in
 * `__recordings__`) is ever rewritten, nor Shadowlap's config, which says what runs and where runs
 * go, nor anything in its own folder or in git's, whose config can hold a credential. Each name is
 * read as Windows reads it too: in any case, without the dots and spaces it drops from the end, and
 * never as a stream of a file (`run.json::$DATA`) or a short name (`RUN~1.JSO`), either of which
 * names another file there.
 */
export function repairNeverRewrites(file: string): string | null {
  const parts = file.split('/');
  if (parts.some((p) => p.includes(':'))) return 'a stream of a file, which Windows writes as the file itself';
  if (parts.some((p) => /~\d/.test(p))) return 'a name with a ~ and a digit, which Windows can read as the short name of another file';
  const names = parts.map((p) => p.replace(/[. ]+$/, '').toLowerCase());
  const name = names.at(-1) ?? '';
  if (names.includes('.git')) return "a file in git's own folder, where the repository and its config are, which can hold a credential";
  if (names.includes('.shadowlap')) return "a file in Shadowlap's own folder, where its store and repairs are";
  if (names.includes('__recordings__')) return 'a file in a folder of recordings';
  if (name === 'shadowlap.config.json') return "Shadowlap's config, which says what runs and where runs go";
  if (name === 'run.json') return "a pack's run.json, which holds the command a replay of the recording runs";
  if (name === 'calls.jsonl' || (names.at(-2) === 'blobs' && /^[0-9a-f]{64}$/.test(name))) return "a recording's file";
  return null;
}

/**
 * Why a repair's patch is not the change its accepted candidate makes, or null when it is (or when
 * there is no patch). `shadowlap fix apply` hands the patch to `git apply`, and a store can come from
 * elsewhere (a teammate's bucket, a copied file), so it is held to what `unifiedDiff` writes for that
 * one rewrite and nothing more: the candidate's file alone, changed in place (no file made, deleted,
 * renamed or copied, no mode or binary change), in one hunk whose removed side turns into its added
 * side by the candidate's rewrite of its text, once, and by nothing else.
 */
export function repairPatchProblem(report: Pick<RepairReport, 'patch' | 'candidates' | 'accepted'>): string | null {
  const patch = report.patch;
  if (patch === null) return null;
  const c = report.candidates.find((x) => x.id === report.accepted);
  if (!c) return 'no accepted candidate comes with it';
  const file = c.file;
  if (!plainRepoPath(file)) return `its accepted candidate names "${safeLine(file)}", which is not a plain path inside the repository`;
  const never = repairNeverRewrites(file);
  if (never) return `its accepted candidate rewrites ${safeLine(file)}, ${never}: a repair rewrites only the text the agent sends the model, where the agent's source holds it`;
  // Nothing larger than a repair makes is read any further: the text a candidate rewrites is in a
  // file repair read, and its rewrite is held to longestRewrite. The patch holds the lines around
  // the rewrite before and after it, a mark in front of each, which at most doubles them (empty lines).
  if (c.before.length > REPAIR_FILE_LIMIT) return `its accepted candidate's text is ${c.before.length} characters, longer than any file a repair reads`;
  if (c.after.length > longestRewrite(c.before.length)) return `its accepted candidate's rewrite is ${c.after.length} characters, longer than a repair keeps for the ${c.before.length} it replaces`;
  if (patch.length > 2 * (2 * REPAIR_FILE_LIMIT + c.after.length) + 4 * file.length + 256) return `it is ${patch.length} characters, more than a repair writes for its accepted candidate`;
  const files = patchFiles(patch);
  if (files.some((f) => f !== file)) return `it changes ${fileList(files.map(safeLine))}, where its accepted candidate changes ${file} alone`;
  if (!c.before) return 'its accepted candidate rewrites no text';
  if (c.before === c.after) return 'its accepted candidate changes nothing';
  const hunk = hunkOf(patch, file);
  if (typeof hunk === 'string') return hunk;
  // The hunk holds three lines of context around the lines that differ, so a long text whose last
  // line alone was rewritten is not all in it: what has to be in it is the part of the rewrite that
  // differs, with what the text and its rewrite share at either end left out.
  let p = 0;
  while (p < c.before.length && p < c.after.length && c.before[p] === c.after[p]) p++;
  let s = 0;
  while (s < c.before.length - p && s < c.after.length - p && c.before[c.before.length - 1 - s] === c.after[c.after.length - 1 - s]) s++;
  const from = c.before.slice(p, c.before.length - s);
  const to = c.after.slice(p, c.after.length - s);
  return rewrites(hunk.was, hunk.is, from, to) ? null : `the lines it changes in ${file} are not its accepted candidate's rewrite`;
}

/**
 * The lines the one hunk of a patch to `file` takes away (`was`) and puts in their place (`is`),
 * context and all, as `unifiedDiff` writes it; or why the patch is not that. A line's break is in its
 * text but where the hunk says there is no newline at the end of the file.
 */
function hunkOf(patch: string, file: string): { was: string; is: string } | string {
  const lines = patch.split('\n');
  if (lines.pop() !== '') return 'it does not end with a line break';
  const head = [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`];
  if (head.some((h, i) => lines[i] !== h)) return `its header is not the one a repair writes for ${file}: a repair never makes, deletes, renames or copies a file, nor changes its mode`;
  const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@$/.exec(lines[3] ?? '');
  if (!hunk) return 'it holds no hunk a repair writes';
  let old = hunk[1] === undefined ? 1 : Number(hunk[1]);
  let now = hunk[2] === undefined ? 1 : Number(hunk[2]);
  const sides: Record<'-' | '+', Array<{ text: string; eol: boolean }>> = { '-': [], '+': [] };
  let last: ' ' | '-' | '+' | null = null;
  let i = 4;
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    if (l === '\\ No newline at end of file' && last) {
      for (const side of last === ' ' ? (['-', '+'] as const) : [last]) sides[side].at(-1)!.eol = false;
      last = null;
      continue;
    }
    if (old <= 0 && now <= 0) break;
    const kind = l[0];
    if (kind !== ' ' && kind !== '-' && kind !== '+') return 'a line in its hunk is neither context, removed nor added';
    if (kind !== '+') {
      sides['-'].push({ text: l.slice(1), eol: true });
      old--;
    }
    if (kind !== '-') {
      sides['+'].push({ text: l.slice(1), eol: true });
      now--;
    }
    last = kind;
  }
  if (old !== 0 || now !== 0) return 'its hunk holds a different number of lines than its header says';
  if (i < lines.length) return 'it holds more than the one hunk a repair writes';
  const text = (side: '-' | '+') => sides[side].map((x) => x.text + (x.eol ? '\n' : '')).join('');
  return { was: text('-'), is: text('+') };
}

/**
 * Whether `is` is `was` with `from` replaced by `to` at one place, found in time that grows with the
 * texts' length alone: they come from a store someone else may write, and trying every place `from`
 * appears in turn, comparing the whole text each time, grew with the square of the patch (43 seconds
 * for a crafted megabyte). Before that place the texts agree, so it is at most where they first
 * differ; after it they agree too, which bounds it from below.
 */
function rewrites(was: string, is: string, from: string, to: string): boolean {
  if (is.length - to.length !== was.length - from.length) return false;
  let start = 0;
  while (start < was.length && start < is.length && was.charCodeAt(start) === is.charCodeAt(start)) start++;
  let end = 0;
  while (end < was.length && end < is.length && was.charCodeAt(was.length - 1 - end) === is.charCodeAt(is.length - 1 - end)) end++;
  const lo = Math.max(0, was.length - from.length - end);
  const hi = Math.min(start, was.length - from.length);
  if (lo > hi) return false;
  // What `from` and `to` share at either end was left out, so when neither is empty they differ in
  // their first character, and the place can only be where the texts first differ.
  if (from && to) return lo <= start && start <= hi && was.startsWith(from, start) && is.startsWith(to, start);
  // Text only added, or only taken away: any place between lo and hi where that text is will do.
  return occursBetween(from ? was : is, from || to, lo, hi);
}

/** Whether `piece` (not empty) appears in `text` starting anywhere from `lo` to `hi`, by Knuth-Morris-Pratt: one pass, however the text repeats. */
function occursBetween(text: string, piece: string, lo: number, hi: number): boolean {
  const back = new Int32Array(piece.length);
  for (let i = 1, k = 0; i < piece.length; i++) {
    while (k > 0 && piece.charCodeAt(i) !== piece.charCodeAt(k)) k = back[k - 1]!;
    if (piece.charCodeAt(i) === piece.charCodeAt(k)) k++;
    back[i] = k;
  }
  const stop = Math.min(text.length, hi + piece.length);
  for (let i = lo, k = 0; i < stop; i++) {
    while (k > 0 && text.charCodeAt(i) !== piece.charCodeAt(k)) k = back[k - 1]!;
    if (text.charCodeAt(i) === piece.charCodeAt(k)) k++;
    if (k === piece.length) return true;
  }
  return false;
}

// ---- Where a repair rewrites text ----------------------------------------------------------------

/** Where a repair rewrites text, as a reason that refuses a rewrite elsewhere says it. */
const REWRITTEN_TEXT = 'a string of JavaScript, TypeScript or Python source, or in a Markdown, plain text, prompt or Jinja file';

/** What a repair rewrites in a file: the text inside its strings (`js`, `python`), or any of its text (`prose`). */
export type RewriteKind = 'js' | 'python' | 'prose';

/**
 * What a repair rewrites in `file`, by its name, or null for a file it rewrites nothing in. The text
 * an agent sends its model is in a string of its code, or in a prose or template file it reads. In
 * any other file, a workflow, a manifest, a script or another language's source, Shadowlap can't
 * tell such text from what runs, so a repair rewrites none of it. MDX is left out too: it is JSX,
 * whose code runs when it is built.
 */
export function rewriteKind(file: string): RewriteKind | null {
  const syntax = templateSyntax(file);
  if (syntax === 'js' || syntax === 'python') return syntax;
  return /\.(?:md|markdown|txt|rst|prompt|j2|jinja2?)$/i.test(file) ? 'prose' : null;
}

/** A file's kind as a reason names it: `a .yml file`, or `a file with no extension` (`.gitignore` is a name). */
function kindWords(file: string): string {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const ext = /\.([^.]+)$/.exec(name.slice(1))?.[1];
  return ext ? `a .${safeLine(ext).slice(0, 20)} file` : 'a file with no extension';
}

/** Each file's strings in code, and its placeholders in prose, read once however many spans of it are checked. */
const stringsOf = new WeakMap<SourceFile, SourceString[]>();
const placeholdersOf = new WeakMap<SourceFile, Placeholder[]>();

/**
 * Why a repair never rewrites the `length` characters at `offset` of `file`, or null when it may:
 * the kind of file (`rewriteKind`), and in code, where the text is. It has to be inside one string,
 * from start to end, and in any file it may hold a placeholder only whole: a rewrite never starts or
 * ends inside a template literal's `${…}`, an f-string's `{…}` or a Jinja expression, whose code
 * `checkEdit` would otherwise let it change. Read as what follows "the text": `is outside any string`.
 */
export function repairNeverRewritesAt(file: SourceFile, offset: number, length: number): string | null {
  const kind = rewriteKind(file.path);
  if (!kind) return `is in ${kindWords(file.path)}: a repair rewrites text only in ${REWRITTEN_TEXT}`;
  const end = offset + length;
  let code: ReadonlyArray<{ start: number; end: number }>;
  if (kind === 'prose') {
    let found = placeholdersOf.get(file);
    if (!found) placeholdersOf.set(file, (found = placeholders(file.content, templateSyntax(file.path))));
    code = found;
  } else {
    let strings = stringsOf.get(file);
    if (!strings) stringsOf.set(file, (strings = sourceStrings(file.content, kind)));
    // The innermost string it starts in: one in a template literal's ${…} starts after the template literal.
    const str = strings.filter((s) => s.start <= offset && offset < s.end).at(-1);
    if (!str) return 'is outside any string: in code, a repair rewrites only text inside a string';
    if (end > str.end) return 'runs past the end of the string it starts in: a repair rewrites text inside one string';
    const inside = placeholders(file.content.slice(str.start, str.end), kind).map((p) => ({ start: str.start + p.start, end: str.start + p.end }));
    code = [...str.code.map(([start, stop]) => ({ start, end: stop })), ...inside];
  }
  const cut = code.find((p) => p.start < end && offset < p.end && (p.start < offset || p.end > end));
  return cut ? `starts or ends inside ${safeLine(file.content.slice(cut.start, cut.end)).slice(0, 80)}: a rewrite keeps each placeholder whole` : null;
}
