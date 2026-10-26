import { unrescuedWords } from './blame.js';
import { markdownCode, markdownFence, markdownText } from './markdown.js';
import { formatUsd } from './prices.js';
import type { Palette } from './report.js';
import { plain } from './report.js';
import { formatTally } from './stats.js';
import { quoteArgv, safeLine } from './text.js';
import { eachRun, footprintDelta, keptTally, outcomeOf, type VerifiedRun, type VerifyReport } from './verify.js';

/**
 * The deterministic half of `shadowlap repair`. A model proposes fixes; everything that decides whether
 * one is applied, and whether it is kept, is here or in the verify gate, so the model never grades
 * its own work.
 *
 * A fix is a rewrite of one **anchor**: a span of the text the agent sends the model (its system
 * prompt, a tool description) that appears exactly once, verbatim, in the project's source. The
 * repairer may only rewrite anchors, so every candidate can be applied where the text lives, and a
 * patch is one contiguous change a reviewer can read.
 *
 * Fixes written while reading failed runs tend to fit those runs: "if the order is A-1042, escalate".
 * **Case details** are the ids, amounts and addresses that appear in the failing runs but not in the
 * good ones or in the prompt itself; a candidate that brings one in is rejected before anything runs.
 */

/** A text the agent sends the model that a fix may rewrite. */
export interface Surface {
  /** `system prompt`, or `tool <name>` for a tool description. */
  label: string;
  text: string;
}

export interface SourceFile {
  /** Relative to the project root, with forward slashes. */
  path: string;
  content: string;
}

export interface Anchor {
  id: number;
  surface: string;
  /** The span as the file holds it, placeholders and all: `Refunds above {limit} need a manager.` */
  text: string;
  file: string;
  /** Where the text starts in the file. */
  offset: number;
  /**
   * The span as the agent sent it, when that differs from `text`: its placeholders filled in
   * (`Refunds above 100 need a manager.`). Absent for a span the file holds verbatim.
   */
  rendered?: string;
  /** The characters just before and after the span in the file ('' at either end), which a rewrite must not join into a placeholder. */
  prev?: string;
  next?: string;
}

/** Spans worth anchoring, largest first: the whole text, its lines, the sentences of each line. */
function spansOf(text: string): string[] {
  const out: string[] = [text.trim()];
  for (const line of text.split('\n')) {
    const l = line.trim();
    out.push(l);
    for (const sentence of l.split(/(?<=[.!?])\s+/)) out.push(sentence.trim());
  }
  return [...new Set(out)].filter((s) => s.length >= 12);
}

function occurrences(haystack: string, needle: string, limit = 2): number[] {
  const at: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1 && at.length < limit; i = haystack.indexOf(needle, i + 1)) at.push(i);
  return at;
}

// ---- Placeholders ------------------------------------------------------------------------------

/**
 * What reads a file's text, for the placeholders it can hold: JavaScript and TypeScript, Python,
 * prose (Markdown, plain text, a prompt file, which a template engine may render), or other code.
 */
export type TemplateSyntax = 'js' | 'python' | 'prose' | 'code';

export function templateSyntax(path: string): TemplateSyntax {
  if (/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(path)) return 'js';
  if (/\.py[iw]?$/i.test(path)) return 'python';
  if (isProse(path)) return 'prose';
  return 'code';
}

/**
 * A place in a text that is filled in, or read as syntax, when the agent builds its prompt: a
 * template literal's `${…}`, an f-string's or `.format`'s `{…}` (and the `{{` and `}}` that escape a
 * brace), a printf-style `%s` or `%(name)s`, Jinja's and Mustache's `{{ … }}`, `{% … %}` and
 * `{# … #}`, an EJS or ERB `<% … %>`; outside JavaScript, a `string.Template` or shell `$name`; in
 * other code, Ruby's `#{…}` and the shell's `$(…)`.
 */
export interface Placeholder {
  /** As written: `${limit}`, `{limit}`, `{{ limit }}`, `%(limit)s`, `{{`. */
  text: string;
  start: number;
  end: number;
  /** For an escape, the text it renders as (`{{` → `{` in Python, `{{` in JavaScript, `%%` → `%`); absent for a placeholder that is filled in. */
  literal?: string;
  /**
   * It only names a value (`{limit}`, `${policy.limit}`, `{{ limit | upper }}`, `%(limit)s`), with
   * no quotes, statements or code around it: a templated span may stand on it.
   */
  simple: boolean;
}

/** The longest text read as one placeholder: a brace further on is code, not a placeholder's end. */
const LONGEST_PLACEHOLDER = 400;

/** Python's printf conversions: `%%`, `%(name)…s`, `%5.2f`. A space flag alone is left out, so prose such as "a 5% fee" holds none. */
const PRINTF = /%(?:%|\([^()\n]{1,64}\)[-+#0 ]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[diouxXeEfFgGcrsa]|[-+#0]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[diouxXeEfFgGcrsa])/y;
/** Node's util.format conversions. */
const UTIL_FORMAT = /%[sdifjoOc%]/y;
const NAME = /[A-Za-z_]\w*/y;

/** The index of the `close` that matches the `open` at `at`, counting those between, or -1. */
function closing(s: string, at: number, open = '{', close = '}'): number {
  let depth = 0;
  const stop = Math.min(s.length, at + LONGEST_PLACEHOLDER);
  for (let i = at; i < stop; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close && --depth === 0) return i;
  }
  return -1;
}

/** Whether what a placeholder holds only names a value: no quotes, statements or nested braces. */
const namesAValue = (inner: string) => inner.length <= 80 && !/[\n'"`;{}<>\\]/.test(inner);

/** The placeholders in a text, as the file it lives in would read them (see `Placeholder`), in order. */
export function placeholders(text: string, syntax: TemplateSyntax): Placeholder[] {
  const out: Placeholder[] = [];
  let i = 0;
  const take = (end: number, inner: string, literal?: string) => {
    out.push({ text: text.slice(i, end), start: i, end, ...(literal !== undefined ? { literal } : {}), simple: literal !== undefined || namesAValue(inner) });
    i = end;
  };
  const regex = (re: RegExp) => {
    re.lastIndex = i;
    return re.exec(text)?.[0] ?? null;
  };
  while (i < text.length) {
    const c = text[i]!;
    const d = text[i + 1];
    if (c === '{') {
      // Jinja and Mustache: {{{ x }}}, {{ x }}, {% x %}, {# x #}.
      if (d === '{' || d === '%' || d === '#') {
        const triple = d === '{' && text[i + 2] === '{';
        const close = triple ? '}}}' : d === '{' ? '}}' : d === '%' ? '%}' : '#}';
        const from = i + (triple ? 3 : 2);
        const end = text.indexOf(close, from);
        if (end >= 0 && end - i <= LONGEST_PLACEHOLDER && !text.slice(from, end).includes('\n')) {
          take(end + close.length, text.slice(from, end));
          continue;
        }
        // `{{` with no `}}` after it: an f-string's or format's escape for a brace (in JavaScript, two braces).
        if (d === '{') {
          take(i + 2, '', syntax === 'js' ? '{{' : '{');
          continue;
        }
      }
      const end = closing(text, i);
      if (end > i) {
        take(end + 1, text.slice(i + 1, end));
        continue;
      }
    } else if (c === '}' && d === '}') {
      take(i + 2, '', syntax === 'js' ? '}}' : '}');
      continue;
    } else if (c === '$') {
      if (d === '{') {
        const end = closing(text, i + 1);
        if (end > i) {
          take(end + 1, text.slice(i + 2, end));
          continue;
        }
      } else if (d === '(' && syntax === 'code') {
        const end = closing(text, i + 1, '(', ')');
        if (end > i) {
          take(end + 1, text.slice(i + 2, end));
          continue;
        }
      } else if (d === '$' && syntax === 'python') {
        take(i + 2, '', '$');
        continue;
      } else if (syntax !== 'js' && d !== undefined && /[A-Za-z_]/.test(d)) {
        NAME.lastIndex = i + 1;
        const name = NAME.exec(text)![0];
        take(i + 1 + name.length, name);
        continue;
      }
    } else if (c === '#' && d === '{' && syntax === 'code') {
      const end = closing(text, i + 1);
      if (end > i) {
        take(end + 1, text.slice(i + 2, end));
        continue;
      }
    } else if (c === '<' && d === '%') {
      const end = text.indexOf('%>', i + 2);
      if (end >= 0 && end - i <= LONGEST_PLACEHOLDER) {
        take(end + 2, text.slice(i + 2, end));
        continue;
      }
    } else if (c === '%') {
      const spec = regex(syntax === 'js' ? UTIL_FORMAT : PRINTF);
      if (spec) {
        take(i + spec.length, /\(([^()]*)\)/.exec(spec)?.[1] ?? '', spec === '%%' ? '%' : undefined);
        continue;
      }
    }
    i++;
  }
  return out;
}

/** The text with its placeholders taken out: what a rewrite writes in its own words. */
function outsidePlaceholders(text: string, found: readonly Placeholder[]): string {
  let out = '';
  let at = 0;
  for (const p of found) {
    out += text.slice(at, p.start);
    at = p.end;
  }
  return out + text.slice(at);
}

/**
 * The characters, outside a placeholder, that a rewrite may add no more of than the text it replaces
 * already had, counted one at a time as `lacking` counts placeholders: a brace, `<%`, `%>`, and in
 * other code `#{` and `$(`, each of which starts or ends a placeholder on its own; and, in anything
 * but prose, each quote (`"`, `'`, `` ` ``) and the backslash, any of which could end or escape the
 * string literal the span sits in. A prose file (a Markdown policy) is text, not a string, so its
 * quotes and backslashes are left alone.
 */
function strays(text: string, syntax: TemplateSyntax): string[] {
  const re =
    syntax === 'prose' ? /[{}]|<%|%>/g : syntax === 'code' ? /["'`\\{}]|<%|%>|#\{|\$\(/g : /["'`\\{}]|<%|%>/g;
  return [...text.matchAll(re)].map((m) => m[0]);
}

/**
 * Why a stray character the replacement adds is refused, with how many of it each has: `has` in the
 * replacement against `had` in the text it replaces. A quote or backslash breaks the string, anything
 * else starts a placeholder.
 */
function strayReason(ch: string, had: number, has: number, file: string): string {
  const counts = `${has} where the text it replaces has ${had === 0 ? 'none' : had}`;
  if (ch === '\\') return `it adds a backslash, ${counts}, which could escape the string it goes into in ${file}`;
  if (ch === '"' || ch === "'" || ch === '`') return `it adds a ${ch} quote, ${counts}, which could end the string it goes into in ${file}`;
  return `it has ${ch} outside a placeholder, ${counts}, which could start one in ${file}: a rewrite keeps the placeholders of the text it replaces and adds none`;
}

/** What `from` has that `to` lacks, counting repeats: the placeholders a rewrite dropped, or added. */
function lacking(from: readonly string[], to: readonly string[]): string[] {
  const left = [...to];
  return from.filter((x) => {
    const at = left.indexOf(x);
    if (at < 0) return true;
    left.splice(at, 1);
    return false;
  });
}

/** Characters that open a placeholder together with what follows them: `$` `{`, `#` `{`, `%` `(`, `<` `%`, `{` `{`. */
const OPENS = /[$#%<{@]/;

// ---- Templated anchors -------------------------------------------------------------------------

/** A line of a file broken into what a span is matched against: characters, and placeholders that stand for any text. */
type Unit = { char: string } | { value: true } | { barrier: true };

interface TemplateLine {
  file: SourceFile;
  /** Where the line starts in the file. */
  start: number;
  text: string;
  units: Unit[];
  /** Each unit's offset in the line, and the line's length after the last. */
  at: number[];
  /** Which unit each is part of: the characters an escape stands for share its number, so a span never splits one. */
  part: number[];
  /** The words of its text outside placeholders, lower-cased, to pass over lines a span can't be. */
  words: Set<string>;
}

const wordsOf = (s: string) => new Set((s.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w, i, all) => all.indexOf(w) === i));

/** The lines of the project's files that hold a placeholder that only names a value: where a span sent with values filled in can come from. */
function templateLines(files: readonly SourceFile[]): TemplateLine[] {
  const out: TemplateLine[] = [];
  for (const file of files) {
    const syntax = templateSyntax(file.path);
    let start = 0;
    for (const text of file.content.split('\n')) {
      const lineStart = start;
      start += text.length + 1;
      if (text.length > 4000) continue;
      const found = placeholders(text, syntax);
      if (!found.some((p) => p.simple && p.literal === undefined)) continue;
      const units: Unit[] = [];
      const at: number[] = [];
      const part: number[] = [];
      let i = 0;
      const one = (unit: Unit, offset: number, of = part.length) => {
        units.push(unit);
        at.push(offset);
        part.push(of);
      };
      for (const p of found) {
        for (; i < p.start; i++) one({ char: text[i]! }, i);
        // An escape stands for its own text, a character at a time, all at the escape's place.
        if (p.literal !== undefined) {
          const of = part.length;
          for (const char of p.literal) one({ char }, p.start, of);
        } else one(p.simple ? { value: true } : { barrier: true }, p.start);
        i = p.end;
      }
      for (; i < text.length; i++) one({ char: text[i]! }, i);
      at.push(text.length);
      part.push(-1);
      out.push({ file, start: lineStart, text, units, at, part, words: wordsOf(outsidePlaceholders(text, found)) });
    }
  }
  return out;
}

/**
 * Where `span` is `line` with its placeholders filled in: each run of units (from `from` to `to`)
 * whose characters equal the span's where they are characters, each placeholder standing for one or
 * more characters of it. Found in one pass per start, the set of the span's positions reached kept
 * as it goes, so a line is read in time that grows with its length times the span's.
 */
function templateRuns(line: TemplateLine, span: string): Array<{ from: number; to: number; literal: number }> {
  const n = span.length;
  const found: Array<{ from: number; to: number; literal: number }> = [];
  let reach = new Uint8Array(n + 1);
  let next = new Uint8Array(n + 1);
  for (let from = 0; from < line.units.length; from++) {
    const first = line.units[from]!;
    if ('barrier' in first || ('char' in first && first.char !== span[0])) continue;
    reach.fill(0);
    reach[0] = 1;
    let values = 0;
    let literal = 0;
    for (let j = from; j < line.units.length && j - from <= 3 * n; j++) {
      const u = line.units[j]!;
      next.fill(0);
      let any = false;
      if ('barrier' in u) break;
      if ('value' in u) {
        values++;
        let low = -1;
        for (let k = 0; k < n; k++)
          if (reach[k]) {
            low = k;
            break;
          }
        if (low < 0) break;
        for (let k = low + 1; k <= n; k++) next[k] = 1;
        any = true;
      } else {
        literal++;
        for (let k = 0; k < n; k++)
          if (reach[k] && span[k] === u.char) {
            next[k + 1] = 1;
            any = true;
          }
      }
      if (next[n] && values > 0) found.push({ from, to: j + 1, literal });
      next[n] = 0;
      [reach, next] = [next, reach];
      if (!any || !reach.some((x) => x === 1)) break;
    }
  }
  return found;
}

/**
 * The places a span sent with its values filled in comes from: a line's run whose placeholders,
 * filled in, give the span. Most of the span has to be the line's own text (a placeholder that would
 * stand for most of it says nothing of where it is), and of two runs of one line that overlap, the
 * one with more of its own text is the span's.
 */
function templatedMatches(span: string, lines: readonly TemplateLine[]): Array<{ file: SourceFile; offset: number; text: string }> {
  if (span.includes('\n') || span.length > 2000) return [];
  const words = [...wordsOf(span)];
  const out: Array<{ file: SourceFile; offset: number; text: string; literal: number }> = [];
  for (const line of lines) {
    if (words.length && words.filter((w) => line.words.has(w)).length * 2 < words.length) continue;
    // A run that starts or ends inside an escape stands for part of it, which no span of the file is.
    const whole = (r: { from: number; to: number }) => (r.from === 0 || line.part[r.from] !== line.part[r.from - 1]) && line.part[r.to] !== line.part[r.to - 1];
    const runs = templateRuns(line, span).filter((r) => r.literal >= Math.max(8, span.length / 2) && whole(r));
    const kept = runs.filter((r) => !runs.some((o) => o !== r && o.from < r.to && r.from < o.to && o.literal > r.literal));
    for (const r of kept) out.push({ file: line.file, offset: line.start + line.at[r.from]!, text: line.text.slice(line.at[r.from], line.at[r.to]), literal: r.literal });
  }
  return out.filter((m, i) => out.findIndex((o) => o.file === m.file && o.offset === m.offset && o.text === m.text) === i).map(({ literal: _literal, ...m }) => m);
}

/**
 * The spans of each surface that appear exactly once across the project's files. A span inside a
 * larger anchored span of the same surface is left out: rewriting the larger one covers it.
 *
 * A span the files don't hold verbatim may be one the agent filled values into: `Refunds above 100
 * need a manager.` from `f"Refunds above {limit} need a manager."`. Each line of a file with a
 * placeholder is matched against it, every placeholder standing for any text, and a span found that
 * way exactly once (and nowhere verbatim) anchors where the file holds it, placeholders and all.
 */
export function findAnchors(surfaces: readonly Surface[], files: readonly SourceFile[]): Anchor[] {
  const anchors: Anchor[] = [];
  let lines: TemplateLine[] | null = null;
  for (const surface of surfaces) {
    const taken: string[] = [];
    for (const span of spansOf(surface.text)) {
      if (taken.some((t) => t.includes(span))) continue;
      let found: { file: SourceFile; offset: number; text: string } | null = null;
      let count = 0;
      for (const f of files) {
        const at = occurrences(f.content, span);
        count += at.length;
        if (count > 1) break;
        if (at.length === 1) found = { file: f, offset: at[0]!, text: span };
      }
      if (count === 0) {
        const matches = templatedMatches(span, (lines ??= templateLines(files)));
        count = matches.length;
        if (count === 1) found = matches[0]!;
      }
      if (count !== 1 || !found) continue;
      taken.push(span);
      const { file, offset, text } = found;
      if (anchors.some((a) => a.file === file.path && a.offset === offset && a.text === text)) continue;
      anchors.push({ id: anchors.length + 1, surface: surface.label, text, file: file.path, offset, ...(text !== span ? { rendered: span } : {}), prev: file.content[offset - 1] ?? '', next: file.content[offset + text.length] ?? '' });
    }
  }
  return anchors;
}

/** Ids, amounts and email addresses in a text, lower-cased: what a case is made of. */
export function caseDetails(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) out.add(m[0].toLowerCase());
  // An id: letters and digits run together, such as A-1042, INC_7731 or ord9f2.
  for (const m of text.matchAll(/\b[A-Za-z]+[-_]?\d[\w-]*|\b\d+[A-Za-z][\w-]*/g)) out.add(m[0].toLowerCase());
  // An amount or number of two digits or more: 240, $1,250.00. Single digits are too common to mean a case.
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = m[0].replace(/,/g, '').replace(/\.0+$/, '');
    if (n.replace(/\D/g, '').length >= 2) out.add(n);
  }
  return out;
}

/** Case details of the failing runs that neither the good runs nor the agent's own prompt contain. */
export function forbiddenDetails(failing: readonly string[], allowed: readonly string[]): Set<string> {
  const ok = new Set<string>();
  for (const t of allowed) for (const d of caseDetails(t)) ok.add(d);
  const out = new Set<string>();
  for (const t of failing) for (const d of caseDetails(t)) if (!ok.has(d)) out.add(d);
  return out;
}

/** A file whose text is prose, not code: Markdown and plain text, where a prompt often lives. */
export function isProse(path: string): boolean {
  return /\.(md|markdown|mdx|txt|rst|prompt)$/i.test(path);
}

/** A rewrite the repairer proposed, as it proposed it. */
export interface ProposedEdit {
  anchor: number;
  replace: string;
  strategy: string;
  why: string;
}

export type EditCheck = { ok: true } | { ok: false; reason: string };

/** The largest file repair reads (`projectFiles` skips bigger ones), so the most text one candidate can rewrite. */
export const REPAIR_FILE_LIMIT = 1024 * 1024;

/** The longest replacement `checkEdit` lets a candidate make of a text so long. */
const longestRewrite = (length: number) => Math.max(600, length * 4);

/**
 * Whether a proposed rewrite may be tried at all. The repairer reads the failing runs, tool output
 * included, which can be anyone's text, so a rewrite is held to text and nothing more before it
 * runs: verify builds the agent's prompt from it, and a placeholder brought in (a template literal's
 * `${process.env.GH_TOKEN}`, an f-string's `{os.environ}`, a Jinja expression) would be evaluated
 * there, its value sent to the provider and recorded. So a rewrite keeps exactly the placeholders of
 * the text it replaces, each as written, and adds none: no other placeholder, no brace or other
 * syntax that starts one, and nothing that would make one with the characters on either side of it.
 */
export function checkEdit(edit: ProposedEdit, anchors: readonly Anchor[], forbidden: ReadonlySet<string>): EditCheck {
  const anchor = anchors.find((a) => a.id === edit.anchor);
  if (!anchor) return { ok: false, reason: `anchor ${edit.anchor} does not exist` };
  const replace = edit.replace.trim();
  if (!replace) return { ok: false, reason: 'the replacement is empty' };
  if (replace === anchor.text) return { ok: false, reason: 'the replacement is the text it replaces' };
  const syntax = templateSyntax(anchor.file);
  const had = placeholders(anchor.text, syntax);
  const has = placeholders(replace, syntax);
  const own = outsidePlaceholders(replace, has);
  const was = outsidePlaceholders(anchor.text, had);
  // A one-line span stays one line: CR and LF, and the Unicode line and paragraph separators, which
  // break a line as much and show nothing. In code the span sits in a string literal, whose quotes
  // and backslashes the stray check below counts; in a prose file they are just punctuation.
  const newline = /[\n\r\u2028\u2029]/;
  if (newline.test(replace) && !newline.test(anchor.text)) return { ok: false, reason: 'the replacement spans several lines, and the text it replaces is one' };
  if (replace.length > longestRewrite(anchor.text.length)) return { ok: false, reason: `the replacement is ${replace.length} characters, far longer than the ${anchor.text.length} it replaces` };
  const added = lacking(has.map((p) => p.text), had.map((p) => p.text));
  if (added.length) return { ok: false, reason: `it brings in ${safeLine(added.join(', ')).slice(0, 120)}, which ${anchor.file} could fill in when the agent builds its prompt, as code or as a value of the agent's: a rewrite keeps the placeholders of the text it replaces and adds none` };
  const dropped = lacking(had.map((p) => p.text), has.map((p) => p.text));
  if (dropped.length) return { ok: false, reason: `it leaves out ${safeLine(dropped.join(', ')).slice(0, 120)}, which the text it replaces has: a rewrite keeps each placeholder as it is written` };
  // A quote, backslash or stray brace the replacement adds beyond what the span had: counted one at a
  // time, so a span that already holds an apostrophe can't add its literal's delimiter or a backslash.
  const ownStrays = strays(own, syntax);
  const wasStrays = strays(was, syntax);
  const stray = lacking(ownStrays, wasStrays);
  if (stray.length) {
    const ch = stray[0]!;
    const count = (list: readonly string[]) => list.filter((x) => x === ch).length;
    return { ok: false, reason: strayReason(safeLine(ch), count(wasStrays), count(ownStrays), anchor.file) };
  }
  // The characters on either side of the span stay: a rewrite that starts after a `$` with a `{`,
  // or ends in a `%` before a `(`, makes a placeholder with them.
  if (anchor.prev !== undefined && OPENS.test(anchor.prev) && replace[0] !== anchor.text[0]) return { ok: false, reason: `it starts differently from the text it replaces, right after the ${anchor.prev} in ${anchor.file}, and the two could make a placeholder` };
  const last = replace.at(-1)!;
  if (anchor.next !== undefined && /[\w{(%]/.test(anchor.next) && OPENS.test(last) && last !== anchor.text.at(-1)) return { ok: false, reason: `it ends in ${last}, right before the ${anchor.next} in ${anchor.file}, and the two could make a placeholder` };
  const before = caseDetails(anchor.text);
  const brought = [...caseDetails(replace)].filter((d) => forbidden.has(d) && !before.has(d));
  if (brought.length) {
    // As written in the replacement, and without the parts of a detail already named (1042 of A-1042).
    const shown = brought.filter((d) => !brought.some((o) => o !== d && o.includes(d))).map((d) => replace.slice(replace.toLowerCase().indexOf(d)).slice(0, d.length) || d);
    return { ok: false, reason: `it mentions ${shown.join(', ')}, which only the failing runs contain: a fix has to hold for cases it has not seen` };
  }
  return { ok: true };
}

/** Characters a rewrite changes: what differs between the text and its replacement, past their common start and end. */
export function editSize(before: string, after: string): number {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  return before.length - p - s + (after.length - p - s);
}

/**
 * The characters one token is taken to hold when a rewrite's growth is worked out before anything
 * runs: more than tokenizers fit into a token of English prose (about 3.5 to 4.5), so the tokens a
 * rewrite adds are counted low, and the estimate stays under the growth verify measures.
 */
export const CHARS_PER_TOKEN = 5;

/**
 * How much a rewrite alone grows the input tokens of runs, before any of them is replayed: each
 * recorded model request that carries the span as it was sent grows by the characters the rewrite
 * adds (`extra`, negative for a shorter one), at CHARS_PER_TOKEN, against what those runs' model
 * calls recorded in all. `requests` holds each call's request body as JSON and the input tokens it
 * recorded (cache reads and writes included, as verify's footprint counts them). Null when they
 * recorded none, as an import without usage does: nothing to measure the growth against.
 */
export function rewriteGrowth(requests: ReadonlyArray<{ body: string; inputTokens: number }>, sent: string, extra: number): number | null {
  const total = requests.reduce((n, r) => n + r.inputTokens, 0);
  if (!(total > 0) || !sent) return null;
  // As the body holds it: JSON-escaped.
  const needle = JSON.stringify(sent).slice(1, -1);
  let carried = 0;
  for (const r of requests) for (let i = r.body.indexOf(needle); i !== -1; i = r.body.indexOf(needle, i + needle.length)) carried++;
  return (carried * extra) / CHARS_PER_TOKEN / total;
}

/** A file with one span replaced. Throws when the span is not where the anchor says, rather than guess. */
export function applyEdit(content: string, at: { offset: number; text: string }, replace: string): string {
  if (content.slice(at.offset, at.offset + at.text.length) !== at.text) throw new Error('the file changed since its text was anchored');
  return content.slice(0, at.offset) + replace + content.slice(at.offset + at.text.length);
}

/**
 * A unified diff of one file, as `git apply` reads it: one hunk around the lines that differ, with
 * three lines of context. Enough for a rewrite of one span, which is all a repair makes.
 */
export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  if (before === after) return '';
  const split = (s: string) => {
    const lines = s.split('\n');
    const eol = lines.at(-1) === '';
    if (eol) lines.pop();
    return { lines, eol };
  };
  const a = split(before);
  const b = split(after);
  let p = 0;
  while (p < a.lines.length && p < b.lines.length && a.lines[p] === b.lines[p]) p++;
  let s = 0;
  while (s < a.lines.length - p && s < b.lines.length - p && a.lines[a.lines.length - 1 - s] === b.lines[b.lines.length - 1 - s]) s++;
  // A change in the final newline alone moves no line; take the last line into the change.
  if (p === a.lines.length && p === b.lines.length) {
    p = Math.max(0, a.lines.length - 1);
    s = 0;
  } else if (p > 0 && ((p === a.lines.length && !a.eol) || (p === b.lines.length && !b.eol))) {
    // A line of context reads the same in both files, its line break included. The shared line in
    // front of the change is the last of one file, with no newline there, and has one in the other,
    // where more lines follow it: it goes into the change, or git would give it a newline.
    p--;
    s = 0;
  }
  // The shared lines after the change end both files, and only one ends with a newline: the last of
  // them reads differently in each, so they all go into the change.
  if (s > 0 && a.eol !== b.eol) s = 0;
  const start = Math.max(0, p - context);
  const aEnd = Math.min(a.lines.length, a.lines.length - s + context);
  const bEnd = Math.min(b.lines.length, b.lines.length - s + context);
  const out: string[] = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -${start + 1},${aEnd - start} +${start + 1},${bEnd - start} @@`];
  const noEol = '\\ No newline at end of file';
  const push = (prefix: string, line: string, last: boolean, eol: boolean) => {
    out.push(prefix + line);
    if (last && !eol) out.push(noEol);
  };
  for (let i = start; i < p; i++) push(' ', a.lines[i]!, false, true);
  for (let i = p; i < a.lines.length - s; i++) push('-', a.lines[i]!, i === a.lines.length - 1, a.eol);
  for (let i = p; i < b.lines.length - s; i++) push('+', b.lines[i]!, i === b.lines.length - 1, b.eol);
  for (let i = a.lines.length - s; i < aEnd; i++) push(' ', a.lines[i]!, i === a.lines.length - 1, a.eol && b.eol);
  return out.join('\n') + '\n';
}

/**
 * The command that applies a repair's patch by hand: git apply with core.autocrlf off, so the file
 * comes out as the repair verified it. Git for Windows sets core.autocrlf, under which plain git
 * apply writes a file whose lines end with LF back with CRLF, every line of it. A patch whose lines
 * end otherwise than the file's (a teammate's, made in a checkout with LF, for a Windows checkout's
 * file with CRLF) applies only through that conversion, with plain git apply; a text or eol
 * attribute in .gitattributes converts either way. `shadowlap fix apply` writes the file's bytes
 * itself, whatever git would convert.
 */
export function gitApplyCommand(patch: string): string {
  return quoteArgv(['git', '-c', 'core.autocrlf=false', 'apply', patch]);
}

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
  const was = text('-');
  const is = text('+');
  // The hunk holds three lines of context around the lines that differ, so a long text whose last
  // line alone was rewritten is not all in it: what has to be in it is the part of the rewrite that
  // differs, with what the text and its rewrite share at either end left out.
  let p = 0;
  while (p < c.before.length && p < c.after.length && c.before[p] === c.after[p]) p++;
  let s = 0;
  while (s < c.before.length - p && s < c.after.length - p && c.before[c.before.length - 1 - s] === c.after[c.after.length - 1 - s]) s++;
  const from = c.before.slice(p, c.before.length - s);
  const to = c.after.slice(p, c.after.length - s);
  return rewrites(was, is, from, to) ? null : `the lines it changes in ${file} are not its accepted candidate's rewrite`;
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

// ---- The report ------------------------------------------------------------------------------

export type CandidateState = 'invalid' | 'untried' | 'build-failed' | 'rejected' | 'incomplete' | 'accepted';

export interface RepairCandidate {
  id: number;
  /** `repairer`: proposed by the model; `model`: a switch to the model that rescued the runs, which needs no model to propose. */
  source: 'repairer' | 'model';
  strategy: string;
  why: string;
  surface: string;
  file: string;
  /** Where `before` starts in the file: the edit is made there, not wherever the text happens to appear. */
  offset: number;
  before: string;
  after: string;
  size: number;
  state: CandidateState;
  /** Why it was not kept, for every state but `accepted`. */
  reason: string | null;
  verify: VerifyReport | null;
}

export interface RepairTarget {
  runId: string;
  /**
   * What its blame found: where the run was lost (`blamed`), that no model call rescued it, that the
   * search stopped, that the run passed the check when replayed so there was no failure to blame
   * (`passes`: it is not a failing run, whatever `--fixes` said), or that blame couldn't run (`note`
   * says why).
   */
  outcome: 'blamed' | 'unrescuable' | 'stopped' | 'passes' | 'error';
  /**
   * An `unrescuable` blame that placed the failure on no call only because its first probe couldn't
   * tell (blame.ts `unsettledFirst`): not settled, never a finding that no call rescues the run.
   * Absent otherwise, and from reports made before it was.
   */
  unsettled?: boolean;
  callNo: number | null;
  step: number | null;
  steps: number;
  rescuedRunId: string | null;
  /** The model that rescued the run, when resampling the recorded one did not. */
  rescuedBy: string | null;
  /** The blame stored on the run was used rather than run again. */
  reused: boolean;
  /** What the agent answered at the blamed call, in the recording and in the rescued fork. */
  recorded: string | null;
  rescued: string | null;
  note: string | null;
}

export type RepairOutcome = 'fixed' | 'not-fixed' | 'no-diagnosis' | 'stopped';

export interface RepairReport {
  outcome: RepairOutcome;
  /** Why it is not fixed, for every outcome but `fixed`. */
  why: string | null;
  targets: RepairTarget[];
  holdout: string[];
  good: string[];
  /** Held-out runs were taken from the failing runs given, because none were named. */
  heldOutAutomatically: boolean;
  oracle: string[];
  /** Who proposed the candidates: null when no repairer answered. */
  repairer: { provider: string; model: string; served: string | null; cost: number | null } | null;
  /**
   * Why no repairer proposed candidates when nothing cheaper was accepted, in a few words
   * ({@link NO_REPAIRER}): none is configured, it had nothing it could rewrite, or it could not be
   * asked (`the repairer could not be asked: claude was not found`). One of `warnings` says it at
   * length, with what to do. Null when the repairer answered, or when nothing called for it: a fix
   * that needs no model was accepted, no failing run was rescued, or the repair stopped first.
   * Reports written before it was added lack it: read it with {@link noRepairerOf}.
   */
  noRepairer?: string | null;
  diagnosis: string | null;
  anchors: number;
  candidates: RepairCandidate[];
  /** The accepted candidate's id. */
  accepted: number | null;
  patch: string | null;
  /**
   * USD each stage cost: blame's and verify's replays (the agent's calls), the repairer, and `judge`,
   * what judge checks' calls cost across blame and verify, apart from the agent's. `judge` is absent
   * when no judge was asked live, and from reports kept before it was added.
   */
  cost: { blame: number; repairer: number | null; verify: number; judge?: number };
  /**
   * What write tools did after a fork, in every replay blame and verify made: stubbed (the agent
   * carried on as if the write succeeded) or blocked. Reports written before it was kept lack it.
   */
  writes?: 'stub' | 'block';
  /**
   * With `--branch`: tracked files that had uncommitted changes when the fix was handed over. Verify
   * replayed the working tree with them; the branch is HEAD with the fix, without them. Absent when
   * there were none, or no branch was asked for.
   */
  uncommitted?: string[];
  output: { dir: string | null; patch: string | null; report: string | null; goldens: string[]; applied: boolean; branch: string | null; pr: string | null };
  warnings: string[];
}

/** What `noRepairer` says. The warning that says it at length, with what to do, starts with it. */
export const NO_REPAIRER = {
  unconfigured: 'no repairer is configured',
  nothingToRewrite: 'the repairer had nothing it could rewrite',
  /** Followed by what went wrong, in a few words: `the repairer could not be asked: claude was not found`. */
  notAsked: 'the repairer could not be asked',
} as const;

/**
 * Why no repairer proposed candidates for a repair, or null: in a few words (its `noRepairer`, or,
 * in a report kept before there was one, what its warnings say), and the warning that says it at
 * length, with what to do. A repair whose repairer answered, and one that needed none (a fix that
 * needs no model was accepted), give null.
 */
export function noRepairerOf(r: Pick<RepairReport, 'noRepairer' | 'repairer' | 'warnings'>): { text: string; warning: string | null } | null {
  const warnings = Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === 'string') : [];
  // The warning starts with it; in an older report, one about nothing to rewrite ends with it.
  const said = (text: string) => ({ text, warning: warnings.find((w) => w.startsWith(text) || w.endsWith(text)) ?? null });
  if (typeof r.noRepairer === 'string' && r.noRepairer.trim()) return said(r.noRepairer);
  if (r.noRepairer !== undefined || r.repairer) return null;
  for (const w of warnings) {
    // `the repairer could not be asked: <what went wrong>: <what to do>`, kept to what went wrong.
    if (w.startsWith(`${NO_REPAIRER.notAsked}: `)) return { text: `${NO_REPAIRER.notAsked}: ${w.slice(NO_REPAIRER.notAsked.length + 2).split(': ')[0]!}`, warning: w };
    if (w.startsWith(NO_REPAIRER.unconfigured)) return { text: NO_REPAIRER.unconfigured, warning: w };
    if (w.endsWith(NO_REPAIRER.nothingToRewrite)) return { text: NO_REPAIRER.nothingToRewrite, warning: w };
  }
  return null;
}

const short = (id: string) => id.slice(0, 10);

const one = (s: string, n = 90) => {
  const line = safeLine(s).replace(/\s+/g, ' ').trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

/** What a fix's report says when verify replayed uncommitted changes that its branch doesn't hold. */
function uncommittedNote(files: readonly string[]): string {
  const named = files.slice(0, 5).map((f) => markdownCode(one(f, 120))).join(', ') + (files.length > 5 ? ` and ${files.length - 5} more` : '');
  return `The runs were replayed on a working tree with uncommitted changes to ${named}. The branch holds HEAD with the fix, without them, so check that it passes as committed.`;
}

/** The commit title for a candidate: its strategy, as a sentence without a full stop. */
export function commitTitle(c: Pick<RepairCandidate, 'strategy'>): string {
  const t = one(c.strategy, 72).replace(/[.\s]+$/, '');
  return t ? t[0]!.toUpperCase() + t.slice(1) : 'Repair the agent instructions';
}

/** What verify found, by role: `fixes 2 of 2 target runs, 1 of 1 held-out, keeps 1 of 1 good`. */
function verifiedCounts(v: VerifyReport): string {
  const count = (role: VerifiedRun['role']) => {
    const of = v.runs.filter((x) => x.role === role);
    return { of: of.length, ok: of.filter((x) => x.verdict === 'pass').length };
  };
  const t = count('target');
  const h = count('holdout');
  const g = count('good');
  return [t.of ? `fixes ${t.ok} of ${t.of} target run${t.of === 1 ? '' : 's'}` : '', h.of ? `${h.ok} of ${h.of} held-out` : '', g.of ? `keeps ${g.ok} of ${g.of} good` : ''].filter(Boolean).join(', ');
}

function verifiedLine(v: VerifyReport): string {
  return `${verifiedCounts(v)}, ${eachRun(v)}`;
}

/** Words wrapped to lines of at most `width` columns (a longer word has a line of its own). */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

export function formatRepair(r: RepairReport, p: Palette = plain): string {
  const lines: string[] = [];
  const accepted = r.candidates.find((c) => c.id === r.accepted) ?? null;
  if (r.outcome === 'fixed' && accepted) {
    lines.push(`${p.green('✓')} ${p.bold(`Fixed: ${commitTitle(accepted)}`)}`);
    lines.push(`  ${p.dim(`${safeLine(accepted.file)} · ${safeLine(accepted.surface)}`)}`);
    lines.push(`  ${p.red(`- ${one(accepted.before, 200)}`)}`, `  ${p.green(`+ ${one(accepted.after, 200)}`)}`);
    // The counts, then how each run was decided, under them, wrapped to fit an 80-column terminal.
    if (accepted.verify) lines.push('', `  Verified: ${verifiedCounts(accepted.verify)},`, ...wrap(eachRun(accepted.verify), 66).map((l) => `            ${l}`));
  } else {
    const head = r.outcome === 'stopped' ? `${p.yellow('!')} ${p.bold('Stopped')}` : r.outcome === 'no-diagnosis' ? `${p.yellow('!')} ${p.bold('No fix to try')}` : `${p.red('✗')} ${p.bold('Not fixed')}`;
    lines.push(`${head}${r.why ? `: ${safeLine(r.why)}` : ''}`);
  }

  if (r.targets.length) {
    lines.push('', `  ${p.bold('Where the failing runs were lost')}`);
    for (const t of r.targets) {
      const where =
        t.outcome === 'blamed' && t.callNo !== null
          ? `model call #${t.callNo} (${t.step!} of ${t.steps})${t.rescuedBy ? `, rescued by ${safeLine(t.rescuedBy)}` : ''}${t.reused ? p.dim(' · from an earlier blame') : ''}`
          : t.outcome === 'unrescuable'
            ? unrescuedWords(t.unsettled === true)
            : safeLine(t.note ?? t.outcome);
      lines.push(`    ${short(t.runId)}  ${where}`);
    }
  }
  if (r.diagnosis) lines.push('', `  ${p.bold('Diagnosis')} ${p.dim(`(${r.repairer ? safeLine(r.repairer.served ?? r.repairer.model) : 'repairer'})`)}`, `    ${one(r.diagnosis, 300)}`);

  if (r.candidates.length) {
    lines.push('', `  ${p.bold('Candidates')} ${p.dim('(tried smallest first; the first the gate accepts twice is kept)')}`);
    const w = Math.max(...r.candidates.map((c) => c.state.length));
    for (const c of r.candidates) {
      const state = c.state === 'accepted' ? p.green(c.state.padEnd(w)) : c.state === 'untried' ? p.dim(c.state.padEnd(w)) : p.yellow(c.state.padEnd(w));
      lines.push(`    ${String(c.id).padStart(2)}  ${state}  ${one(`${c.surface}: ${c.after}`, 80)}`);
      if (c.reason) lines.push(`        ${p.dim(one(c.reason, 150))}`);
    }
  }

  if (r.warnings.length) lines.push('', ...r.warnings.map((w) => `  ${p.yellow('!')} ${safeLine(w)}`));

  const repairer = r.repairer ? ` · repairer ${r.repairer.cost === null ? `(no price for ${safeLine(r.repairer.served ?? r.repairer.model)})` : `≈${formatUsd(r.repairer.cost)}`}` : '';
  const judged = r.cost.judge ? ` · judge checks ≈${formatUsd(r.cost.judge)}` : '';
  lines.push('', p.dim(`  cost: blame ≈${formatUsd(r.cost.blame)}${repairer} · verify ≈${formatUsd(r.cost.verify)}${judged}`));
  if (r.output.patch) lines.push(p.dim(`  patch: ${safeLine(r.output.patch)}${r.output.applied ? ' (applied to the working tree)' : `   apply it: ${gitApplyCommand(safeLine(r.output.patch))}`}`));
  if (r.output.report) lines.push(p.dim(`  report: ${safeLine(r.output.report)}`));
  if (r.output.goldens.length) lines.push(p.dim(`  recordings of the fixed runs, for shadowlap test: ${r.output.goldens.map(safeLine).join(' ')}`));
  if (r.output.branch) lines.push(p.dim(`  branch: ${safeLine(r.output.branch)}`));
  if (r.output.pr) lines.push(p.dim(`  pull request: ${safeLine(r.output.pr)}`));
  return lines.join('\n');
}

/**
 * Text of a run's, a model's or the repairer's, on one line and cut to `n`, as the Markdown GitHub
 * renders shows it and makes nothing of (markdownText): a pull request's body is posted by the bot,
 * and what failing runs read can be anyone's words.
 */
const md = (s: string, n = 90) => markdownText(one(s, n));
const cell = (s: string) => md(s, 160);

/**
 * The report as Markdown, for a pull request: the change, why it was needed, and the evidence that it
 * holds. Whatever came from a run, the repairer or the agent's source is written as text GitHub links,
 * mentions and renders nothing in (`md`, `cell`), as a code span (markdownCode) or in a fenced block.
 */
export function repairMarkdown(r: RepairReport): string {
  const accepted = r.candidates.find((c) => c.id === r.accepted) ?? null;
  const out: string[] = [];
  if (accepted) {
    out.push(`## ${markdownText(commitTitle(accepted))}`, '');
    if (accepted.why.trim()) out.push(md(accepted.why, 600), '');
    out.push(`A change to the ${md(accepted.surface, 200)} in ${markdownCode(one(accepted.file, 400))}:`, '', markdownFence(`- ${one(accepted.before, 400)}\n+ ${one(accepted.after, 400)}`, 'diff'), '');
  } else {
    out.push(`## Not fixed${r.why ? `: ${md(r.why, 200)}` : ''}`, '');
  }

  out.push('### What failed', '', `A run passes when ${r.oracle.map((o) => md(o, 120)).join('; ')}.`, '');
  if (r.targets.length) {
    out.push('Each failing run was lost at the model call below: the last one whose answer, asked again, lets the run pass (`shadowlap blame`).', '');
    out.push('| Run | Lost at | What the agent did there | What a passing run did |', '|---|---|---|---|');
    for (const t of r.targets) {
      const at = t.outcome === 'blamed' && t.callNo !== null ? `model call #${t.callNo} (${t.step!} of ${t.steps})` : t.outcome === 'unrescuable' ? unrescuedWords(t.unsettled === true) : t.outcome === 'passes' ? 'passes when replayed' : t.outcome;
      out.push(`| \`${short(t.runId)}\` | ${cell(at)} | ${cell(t.recorded ?? '')} | ${cell(t.rescued ? `${t.rescued}${t.rescuedBy ? ` (${t.rescuedBy})` : ''}` : '')} |`);
    }
  } else {
    // Found out before blame ran, as a repairer that can't sign in is.
    out.push(`No failing run was blamed${r.noRepairer ? `: ${md(r.noRepairer, 200)}` : ''}.`);
  }
  if (r.diagnosis) out.push('', `The repairer's diagnosis: ${md(r.diagnosis, 600)}`);
  out.push('');

  if (accepted?.verify) {
    const v = accepted.verify;
    out.push('### Evidence', '', `\`shadowlap verify\` replayed every run under the change: it ${verifiedLine(v)}.${r.holdout.length ? ' The held-out runs were never shown to the repairer.' : ''}`, '');
    out.push('| Role | Run | Outcome | Attempts |', '|---|---|---|---|');
    // A run its gate decided shows the evidence: the tally, the pass rate's interval and pass^k; a good
    // run kept against its baseline, both tallies and the bound on the drop.
    for (const x of v.runs) out.push(`| ${x.role === 'holdout' ? 'held-out' : x.role} | \`${short(x.runId)}\` | ${outcomeOf(x)} | ${x.deterministic ? 'clean replay' : x.baseline && !x.undecided ? keptTally(x, x.baseline) : x.gate ? formatTally(x.gate) : `${x.passes} of ${x.attempts.length} passed`} |`);
    const d = footprintDelta(v.runs);
    if (d) out.push('', `Per run, as it would run live: ${Math.round(d.recorded.inputTokens).toLocaleString('en-US')} → ${Math.round(d.now.inputTokens).toLocaleString('en-US')} input tokens${d.recorded.cost !== null && d.now.cost !== null ? `, ≈${formatUsd(d.recorded.cost)} → ≈${formatUsd(d.now.cost)}` : ''}.`);
    if (r.uncommitted?.length) out.push('', `**${uncommittedNote(r.uncommitted)}**`);
    out.push('');
  }

  if (r.candidates.length > 1 || !accepted) {
    out.push('### Candidates', '', '| # | Change | Result |', '|---|---|---|');
    for (const c of r.candidates) out.push(`| ${c.id} | ${cell(`${c.surface}: ${c.after}`)} | ${c.state}${c.reason ? `: ${cell(c.reason)}` : ''} |`);
    out.push('');
  }

  const repairer = r.repairer ? `, the repairer (${md(r.repairer.served ?? r.repairer.model, 120)}) ${r.repairer.cost === null ? 'at no known price' : `≈${formatUsd(r.repairer.cost)}`}` : '';
  // The write policy the replays ran under, when the report kept it: an older report says nothing it can't know.
  const writes = r.writes === 'block' ? ' Writes were blocked in every replay.' : r.writes === 'stub' ? ' Writes were stubbed in every replay.' : '';
  const judged = r.cost.judge ? `, judge checks ≈${formatUsd(r.cost.judge)}` : '';
  out.push(`Cost: blame ≈${formatUsd(r.cost.blame)}${repairer}, verification ≈${formatUsd(r.cost.verify)}${judged}.${writes}`);
  return out.join('\n') + '\n';
}
