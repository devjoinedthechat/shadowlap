/**
 * The strings of JavaScript, TypeScript and Python source, as their parsers read them: where each
 * string's text starts and ends, and the places in it that are code, a template literal's `${…}` and
 * an f-string's `{…}`. A repair rewrites the text an agent sends its model where the source holds it,
 * which in code is inside a string (repair-patch.ts): anything else is code, a comment or a regular
 * expression.
 *
 * Read in one pass, and nothing in it runs. Comments are skipped, and so is a regular expression in
 * JavaScript, told from a division by what comes before its slash. Source that doesn't parse is read
 * as far as it goes: a quote left open ends its string at the end of its line (a template literal or
 * a triple-quoted string at the end of the file), so a mistake in one line reaches no further.
 */

export type SourceLanguage = 'js' | 'python';

export interface SourceString {
  /** Where its text starts and ends: after its opening quote, before its closing one. */
  start: number;
  end: number;
  /** The places in its text that are code, each from its `${` or `{` to past its `}`. */
  code: Array<[number, number]>;
}

/** The strings of `source`, in the order they start: a string in a template literal's `${…}` after the template literal. */
export function sourceStrings(source: string, language: SourceLanguage): SourceString[] {
  const out: SourceString[] = [];
  if (language === 'js') jsCode(source, source.startsWith('#!') ? lineEnd(source, 0) : 0, out, false);
  else pyCode(source, 0, out, false);
  return out.sort((a, b) => a.start - b.start);
}

const lineEnd = (s: string, at: number) => {
  const end = s.indexOf('\n', at);
  return end < 0 ? s.length : end;
};

/** Past the identifier, keyword or number at `at`. */
function wordEnd(s: string, at: number): number {
  let i = at;
  while (i < s.length && /[\p{L}\p{N}_$\\]/u.test(s[i]!)) i++;
  return i;
}

/** Past a backslash at `at` and what it escapes: a character, or a line break, CRLF whole. */
const escaped = (s: string, at: number) => at + (s[at + 1] === '\r' && s[at + 2] === '\n' ? 3 : 2);

// ---- JavaScript and TypeScript ---------------------------------------------------------------

/** Words after which a slash starts a regular expression: what follows them is an expression. */
const BEFORE_EXPRESSION = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * Reads JavaScript from `at` to the end or, in a template literal's `${…}` (`inside`), to the `}` that
 * closes it, whose index it returns; its strings go to `out`. A slash after an operator, a bracket that
 * opens, or a keyword starts a regular expression; after a name, a number or a bracket that closes,
 * it divides.
 */
function jsCode(s: string, at: number, out: SourceString[], inside: boolean): number {
  let depth = 0;
  let regex = true;
  let i = at;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '/' && s[i + 1] === '/') {
      i = lineEnd(s, i);
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 2;
      continue;
    }
    const re = c === '/' && regex ? regexEnd(s, i) : -1;
    if (c === "'" || c === '"' || c === '`' || re > 0) {
      i = re > 0 ? re : c === '`' ? jsTemplate(s, i, out) : jsQuoted(s, i, out);
      regex = false;
      continue;
    }
    if (/[\p{L}\p{N}_$\\]/u.test(c)) {
      const end = wordEnd(s, i);
      regex = BEFORE_EXPRESSION.has(s.slice(i, end));
      i = end;
      continue;
    }
    if (c === '}' && inside && depth === 0) return i;
    depth += c === '{' ? 1 : c === '}' ? -1 : 0;
    // White space leaves what a slash would be as it was.
    if (!/\s/.test(c)) regex = !')]}'.includes(c);
    i++;
  }
  return i;
}

/** A `'…'` or `"…"` string opening at `at`, to `out`; returns past its closing quote. A line break ends one left open. */
function jsQuoted(s: string, at: number, out: SourceString[]): number {
  const q = s[at];
  let i = at + 1;
  while (i < s.length && s[i] !== q && s[i] !== '\n' && s[i] !== '\r') i = s[i] === '\\' ? escaped(s, i) : i + 1;
  out.push({ start: at + 1, end: Math.min(i, s.length), code: [] });
  return s[i] === q ? i + 1 : i;
}

/** A template literal opening at `at`, its `${…}` as code, to `out`; returns past its closing backtick. */
function jsTemplate(s: string, at: number, out: SourceString[]): number {
  const str: SourceString = { start: at + 1, end: s.length, code: [] };
  out.push(str);
  for (let i = at + 1; i < s.length; ) {
    if (s[i] === '\\') i = escaped(s, i);
    else if (s[i] === '`') {
      str.end = i;
      return i + 1;
    } else if (s[i] === '$' && s[i + 1] === '{') {
      const close = jsCode(s, i + 2, out, true);
      str.code.push([i, Math.min(close + 1, s.length)]);
      i = close + 1;
    } else i++;
  }
  return s.length;
}

/** Past a regular expression opening at `at`, its flags included, or -1 when no slash closes it on its line: then the slash divides. */
function regexEnd(s: string, at: number): number {
  let inClass = false;
  for (let i = at + 1; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\n' || c === '\r') return -1;
    if (c === '\\') i++;
    else if (c === '[' || c === ']') inClass = c === '[';
    else if (c === '/' && !inClass) return wordEnd(s, i + 1);
  }
  return -1;
}

// ---- Python ----------------------------------------------------------------------------------

/** What a string may start with, in any case: one of r, u, b, f and t, or r with b, f or t. */
const PY_PREFIX = /^(?:[rubft]|r[bft]|[bft]r)$/i;

/**
 * Reads Python from `at` to the end or, in an f-string's `{…}` (`inside`), to the `}` that closes it,
 * whose index it returns; its strings go to `out`. A comment runs from `#` to the end of its line.
 */
function pyCode(s: string, at: number, out: SourceString[], inside: boolean): number {
  let depth = 0;
  let i = at;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '#') i = lineEnd(s, i);
    else if (c === "'" || c === '"') i = pyString(s, i, '', out);
    else if (/[\p{L}\p{N}_]/u.test(c)) {
      const end = wordEnd(s, i);
      const prefix = s.slice(i, end);
      i = (s[end] === "'" || s[end] === '"') && PY_PREFIX.test(prefix) ? pyString(s, end, prefix, out) : end;
    } else {
      if (c === '}' && inside && depth === 0) return i;
      depth += '([{'.includes(c) ? 1 : ')]}'.includes(c) ? -1 : 0;
      i++;
    }
  }
  return i;
}

/**
 * A string opening at `at` with `prefix`, to `out`; returns past its closing quotes. In an f-string or
 * a t-string, each `{…}` is code and `{{` a brace. A backslash keeps the character after it from
 * ending the string, in a raw string too. A line break ends a string of one quote left open.
 */
function pyString(s: string, at: number, prefix: string, out: SourceString[]): number {
  const q = s[at]!;
  const triple = s.startsWith(q.repeat(3), at);
  const formatted = /[ft]/i.test(prefix);
  const str: SourceString = { start: at + (triple ? 3 : 1), end: s.length, code: [] };
  out.push(str);
  for (let i = str.start; i < s.length; ) {
    const c = s[i]!;
    if (c === '\\') i = escaped(s, i);
    else if (c === q && (!triple || s.startsWith(q.repeat(3), i))) {
      str.end = i;
      return i + (triple ? 3 : 1);
    } else if (!triple && (c === '\n' || c === '\r')) {
      str.end = i;
      return i;
    } else if (formatted && c === '{' && s[i + 1] !== '{') {
      const close = pyCode(s, i + 1, out, true);
      str.code.push([i, Math.min(close + 1, s.length)]);
      i = close + 1;
    } else i += formatted && c === '{' ? 2 : 1;
  }
  return s.length;
}
