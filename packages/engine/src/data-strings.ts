/**
 * The string values of YAML, JSON and TOML files, as their parsers read them: where each value's text
 * starts and ends, and the keys and list positions it sits under. A repair rewrites text inside one
 * string value of such a file (repair-patch.ts), where an agent's prompts can live (CrewAI's
 * agents.yaml and tasks.yaml) or its model's name (a JSON or TOML config), and the key path says
 * whether the value runs (package.json's `scripts`).
 *
 * Read in one pass, and nothing in it runs or is resolved. A key is never a value. A YAML value whose
 * syntax isn't read here (a flow collection, a quoted scalar over several lines, an alias) is left
 * out, and so is anything in a line that doesn't parse: no rewrite goes where the file isn't read.
 */

export type DataLanguage = 'yaml' | 'json' | 'toml';

export interface DataString {
  /** Where its text starts and ends: inside its quotes, or one line of a YAML block or plain scalar, its indentation left out. */
  start: number;
  end: number;
  /** The keys and list positions it sits under, as its parser reads them: `services`, `app`, `command`. */
  path: string[];
  /** A YAML plain scalar: a rewrite of it may not turn it into YAML's own syntax. */
  plain?: true;
  /** It carries a YAML anchor, or sits under a node that does: an alias anywhere can stand for it. */
  anchored?: true;
}

/** The string values of `source`, in the order they start. */
export function dataStrings(source: string, language: DataLanguage): DataString[] {
  const out = language === 'json' ? jsonStrings(source) : language === 'toml' ? tomlStrings(source) : yamlStrings(source);
  return out.sort((a, b) => a.start - b.start);
}

const lineEnd = (s: string, at: number) => {
  const end = s.indexOf('\n', at);
  return end < 0 ? s.length : end;
};

/**
 * Where a string quoted with `q` that opens at `at` ends: its closing quote, or the end of its line
 * when it is left open. With `escapes`, a backslash keeps the character after it from ending it.
 */
function quotedEnd(s: string, at: number, q: string, escapes: boolean): number {
  let i = at + 1;
  while (i < s.length && s[i] !== q && s[i] !== '\n' && s[i] !== '\r') i += escapes && s[i] === '\\' ? 2 : 1;
  return Math.min(i, s.length);
}

/** The characters a backslash names in JSON, TOML and YAML's double-quoted strings. */
const ESCAPES: Readonly<Record<string, string>> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '0': '\0', a: '\x07', v: '\v', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029' };
/** How many hex digits each escape by number reads. */
const HEX: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };

/** A quoted key as its parser reads it, escapes and all: `"scripts"` is `scripts`. */
function unescaped(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\\') {
      out += raw[i]!;
      continue;
    }
    const c = raw[++i] ?? '';
    const digits = Object.hasOwn(HEX, c) ? HEX[c]! : 0;
    if (digits) {
      const code = parseInt(raw.slice(i + 1, i + 1 + digits), 16);
      out += code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
      i += digits;
    } else out += Object.hasOwn(ESCAPES, c) ? ESCAPES[c]! : c;
  }
  return out;
}

// ---- JSON --------------------------------------------------------------------------------------

/** JSON's string values, each under its keys and array indexes; comments, as JSONC writes them, skipped. */
function jsonStrings(s: string): DataString[] {
  const out: DataString[] = [];
  // Each open object with the key of the value in it, each open array with its value's index.
  const open: Array<{ object: boolean; at: string }> = [];
  let key = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '/' && (s[i + 1] === '/' || s[i + 1] === '*')) {
      const end = s[i + 1] === '/' ? lineEnd(s, i) : s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : s[i + 1] === '/' ? end : end + 1;
    } else if (c === '"') {
      const end = quotedEnd(s, i, '"', true);
      if (key && open.length) open.at(-1)!.at = unescaped(s.slice(i + 1, end));
      else out.push({ start: i + 1, end, path: open.map((x) => x.at) });
      i = end;
    } else if (c === '{' || c === '[') {
      open.push({ object: c === '{', at: c === '{' ? '' : '0' });
      key = c === '{';
    } else if (c === '}' || c === ']') {
      open.pop();
      key = false;
    } else if (c === ',' && open.length) {
      const top = open.at(-1)!;
      if (top.object) key = true;
      else top.at = String(Number(top.at) + 1);
    } else if (c === ':') key = false;
  }
  return out;
}

// ---- TOML --------------------------------------------------------------------------------------

/** Past white space, and with `lines`, line breaks and comments too. */
function tomlSkip(s: string, at: number, lines: boolean): number {
  let i = at;
  for (;;) {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t' || (lines && (s[i] === '\n' || s[i] === '\r')))) i++;
    if (!lines || s[i] !== '#') return i;
    i = lineEnd(s, i);
  }
}

const BARE_KEY = /[A-Za-z0-9_-]+/y;

/** A dotted key at `at`, its parts read (bare, `"basic"` with escapes, `'literal'`), and where it ends; null for none. */
function tomlKey(s: string, at: number): { keys: string[]; end: number } | null {
  const keys: string[] = [];
  let i = at;
  for (;;) {
    i = tomlSkip(s, i, false);
    const q = s[i];
    if (q === '"' || q === "'") {
      const end = quotedEnd(s, i, q, q === '"');
      if (s[end] !== q) return null;
      keys.push(q === '"' ? unescaped(s.slice(i + 1, end)) : s.slice(i + 1, end));
      i = end + 1;
    } else {
      BARE_KEY.lastIndex = i;
      const bare = BARE_KEY.exec(s)?.[0];
      if (!bare) return null;
      keys.push(bare);
      i += bare.length;
    }
    const dot = tomlSkip(s, i, false);
    if (s[dot] !== '.') return { keys, end: i };
    i = dot + 1;
  }
}

/** Where a multi-line string's text ends: before the last three of the quotes that close it, which may be up to five. */
function tripleEnd(s: string, at: number, q: string): number {
  for (let i = at; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') i++;
    else if (s.startsWith(q.repeat(3), i)) {
      let run = 3;
      while (run < 5 && s[i + run] === q) run++;
      return i + run - 3;
    }
  }
  return s.length;
}

/** A value at `at`, its strings to `out` under `path`; returns where it ends. */
function tomlValue(s: string, at: number, path: string[], out: DataString[]): number {
  const c = s[at];
  if (c === '"' || c === "'") {
    const triple = s.startsWith(c.repeat(3), at);
    const start = at + (triple ? 3 : 1);
    const end = triple ? tripleEnd(s, start, c) : quotedEnd(s, at, c, c === '"');
    out.push({ start, end, path });
    return Math.min(end + (triple ? 3 : 1), s.length);
  }
  if (c === '[' || c === '{') return tomlCollection(s, at, path, out);
  // A number, a boolean or a date: to what ends it.
  let i = at;
  while (i < s.length && !',]}#\r\n'.includes(s[i]!)) i++;
  return i;
}

/** An array or an inline table at `at`, each value under its index or key; returns where it ends, or the end of its line when it isn't one. */
function tomlCollection(s: string, at: number, path: string[], out: DataString[]): number {
  const table = s[at] === '{';
  let i = at + 1;
  for (let index = 0; ; index++) {
    i = tomlSkip(s, i, true);
    if (s[i] === (table ? '}' : ']')) return i + 1;
    let under = [...path, String(index)];
    if (table) {
      const key = tomlKey(s, i);
      const eq = key ? tomlSkip(s, key.end, false) : -1;
      if (!key || s[eq] !== '=') return lineEnd(s, i);
      under = [...path, ...key.keys];
      i = tomlSkip(s, eq + 1, false);
    }
    i = tomlSkip(s, tomlValue(s, i, under, out), true);
    if (s[i] === ',') i++;
    else if (s[i] === (table ? '}' : ']')) return i + 1;
    else return lineEnd(s, i);
  }
}

/** TOML's string values, basic and literal, on one line or several, each under its table, keys and array indexes. */
function tomlStrings(s: string): DataString[] {
  const out: DataString[] = [];
  let table: string[] = [];
  for (let i = tomlSkip(s, 0, true); i < s.length; i = tomlSkip(s, i, true)) {
    if (s[i] === '[') {
      const double = s[i + 1] === '[';
      const header = tomlKey(s, i + (double ? 2 : 1));
      const close = header ? tomlSkip(s, header.end, false) : -1;
      if (header && s.startsWith(double ? ']]' : ']', close)) table = header.keys;
      i = lineEnd(s, i);
      continue;
    }
    const key = tomlKey(s, i);
    const eq = key ? tomlSkip(s, key.end, false) : -1;
    i = key && s[eq] === '=' ? tomlValue(s, tomlSkip(s, eq + 1, false), [...table, ...key.keys], out) : lineEnd(s, i);
  }
  return out;
}

// ---- YAML --------------------------------------------------------------------------------------

/** A line of YAML: where it starts and ends (a CR before its break left out), its indentation in spaces, and its text after that. */
interface Line {
  start: number;
  end: number;
  indent: number;
  text: string;
}

function yamlLines(s: string): Line[] {
  const lines: Line[] = [];
  for (let start = 0; start <= s.length; ) {
    const next = lineEnd(s, start);
    const end = s[next - 1] === '\r' ? next - 1 : next;
    let indent = 0;
    while (s[start + indent] === ' ') indent++;
    lines.push({ start, end, indent, text: s.slice(start + indent, Math.max(end, start + indent)) });
    start = next + 1;
  }
  return lines;
}

/** An open node of a YAML block: a mapping's key or a sequence's item, at its column, and how many items the sequence under it has had. */
interface Open {
  col: number;
  at: string;
  anchored: boolean;
  items: number;
  item: boolean;
}

/** Characters a plain scalar can't start with, which YAML reads as its own syntax there. */
const INDICATOR = /^[-?:,[\]{}#&*!|>'"%@`]/;

/**
 * A plain scalar that YAML reads as no text: a null, a boolean (YAML 1.1's `yes`, `no`, `on` and `off`
 * too), a number or a date. It is no string value, and no rewrite makes one of a string.
 */
const NOT_TEXT = /^(?:~|null|true|false|yes|no|on|off|y|n|[-+]?\.(?:inf|nan)|[-+]?(?:0x[\da-f_]+|0o[0-7_]+|0b[01_]+|[\d_]+(?::[0-5]?\d)*(?:\.[\d_]*)?(?:e[-+]?\d+)?|\.\d[\d_]*(?:e[-+]?\d+)?)|\d{4}-\d\d?-\d\d?(?:[t ].*)?)$/i;

/**
 * Why a line of a YAML plain scalar, rewritten to `text`, would read as YAML's own syntax or as no
 * text at all, or null: what follows "its rewrite".
 */
export function yamlPlainProblem(text: string): string | null {
  if (/^\s/.test(text) || INDICATOR.test(text)) return `would start it with ${JSON.stringify(text[0])}, which YAML reads as its own syntax there`;
  if (/:(?:\s|$)/.test(text)) return "would put a ': ' in it, which YAML reads as a key";
  if (/\s#/.test(text)) return "would put a ' #' in it, which YAML reads as a comment";
  if (NOT_TEXT.test(text)) return `would make it ${JSON.stringify(text)}, which YAML reads as no text`;
  return null;
}

/** YAML's string values in block style, each under its keys and sequence indexes. */
function yamlStrings(s: string): DataString[] {
  const out: DataString[] = [];
  const lines = yamlLines(s);
  // The open nodes, under a root that is never closed.
  const open: Open[] = [{ col: -1, at: '', anchored: false, items: 0, item: false }];
  let li = 0;
  while (li < lines.length) {
    const line = lines[li]!;
    if (!line.text || line.text.startsWith('#') || line.text.startsWith('\t')) li++;
    else if (line.indent === 0 && /^(?:---|\.\.\.)(?:\s|$)|^%/.test(line.text)) {
      // A document starts or ends, or a directive: what was open is closed.
      open.length = 1;
      open[0]!.items = 0;
      li++;
    } else li = yamlNode(s, lines, li, line.start + line.indent, open, out);
  }
  return out;
}

/** The key a line's text at `text` starts with, and where its value starts in it; null for none, `complex` for a `?` key, which isn't read. */
function yamlKey(text: string): { key: string; value: number } | null | 'complex' {
  if (text.startsWith('? ') || text === '?') return 'complex';
  let key: string;
  let after: number;
  if (text[0] === '"' || text[0] === "'") {
    const end = quotedEnd(text, 0, text[0], text[0] === '"');
    const raw = text.slice(1, end);
    key = text[0] === '"' ? unescaped(raw) : raw.replace(/''/g, "'");
    after = end + 1;
    while (text[after] === ' ') after++;
    if (text[after] !== ':' || !/^:(?:\s|$)/.test(text.slice(after))) return null;
  } else {
    if (INDICATOR.test(text) && !/^[-?:][^\s]/.test(text)) return null;
    const colon = /:(?:\s|$)/.exec(text);
    if (!colon || /\s#/.test(text.slice(0, colon.index))) return null;
    key = text.slice(0, colon.index).trimEnd();
    after = colon.index;
  }
  let value = after + 1;
  while (text[value] === ' ' || text[value] === '\t') value++;
  return { key, value };
}

/** The line `pos` is on, from line `from` on. */
function lineOf(lines: Line[], from: number, pos: number): number {
  let li = from;
  while (li < lines.length - 1 && lines[li]!.end < pos) li++;
  return li;
}

/** The column `pos` is at on its line. */
const colOf = (lines: Line[], li: number, pos: number) => pos - lines[li]!.start;

/** A node of a block at `pos`, on line `li`: a sequence's item, a mapping's entry, or a value. Returns the next line to read. */
function yamlNode(s: string, lines: Line[], li: number, pos: number, open: Open[], out: DataString[]): number {
  const col = colOf(lines, li, pos);
  const text = s.slice(pos, lines[li]!.end);
  if (text === '-' || text.startsWith('- ')) {
    while (open.length > 1 && (open.at(-1)!.col > col || (open.at(-1)!.col === col && open.at(-1)!.item))) open.pop();
    const parent = open.at(-1)!;
    open.push({ col, at: String(parent.items++), anchored: false, items: 0, item: true });
    let at = pos + 1;
    while (s[at] === ' ') at++;
    return at >= lines[li]!.end ? li + 1 : yamlNode(s, lines, li, at, open, out);
  }
  const entry = yamlKey(text);
  if (entry === 'complex') return li + 1;
  if (entry) {
    while (open.length > 1 && open.at(-1)!.col >= col) open.pop();
    open.push({ col, at: entry.key, anchored: false, items: 0, item: false });
    return yamlValue(s, lines, li, pos + entry.value, col, open, out);
  }
  // A value on a line of its own, under the node open above it.
  while (open.length > 1 && open.at(-1)!.col >= col) open.pop();
  return yamlValue(s, lines, li, pos, open.at(-1)!.col, open, out);
}

/**
 * A value at `pos` on line `li`, of a node at column `parent`: a block scalar, a quoted or plain
 * scalar, an alias or a flow collection, or nothing, its node's content on the lines below. Returns
 * the next line to read.
 */
function yamlValue(s: string, lines: Line[], li: number, pos: number, parent: number, open: Open[], out: DataString[]): number {
  let at = pos;
  let anchored = false;
  const end = lines[li]!.end;
  // An anchor or a tag before the value: an anchored node's values can be another's through an alias.
  while (s[at] === '&' || s[at] === '!') {
    if (s[at] === '&') anchored = true;
    while (at < end && s[at] !== ' ') at++;
    while (s[at] === ' ') at++;
  }
  const top = open.at(-1)!;
  top.anchored ||= anchored;
  const path = open.slice(1).map((o) => o.at);
  const mark = open.some((o) => o.anchored) ? { anchored: true as const } : {};
  const c = s[at];
  if (at >= end || c === '#') return li + 1;
  if (c === '|' || c === '>') return /^[|>](?:[1-9][-+]?|[-+][1-9]?)?\s*(?:#.*)?$/.test(s.slice(at, end)) ? yamlBlock(s, lines, li, parent, s.slice(at + 1, end), path, mark, out) : li + 1;
  if (c === '"' || c === "'") {
    const close = quotedEnd(s, at, c, c === '"');
    if (s[close] === c && /^\s*(?:#.*)?$/.test(s.slice(close + 1, end))) out.push({ start: at + 1, end: close, path, ...mark });
    // One left open on its line goes on below: those lines are its, and no rewrite goes there.
    return s[close] === c ? li + 1 : yamlSkipQuoted(s, lines, li, at, c);
  }
  if (c === '[' || c === '{') return yamlSkipFlow(s, lines, li, at);
  if (c === '*' || INDICATOR.test(s.slice(at, at + 1))) return li + 1;
  return yamlPlain(s, lines, li, at, parent, path, mark, out);
}

/** A plain scalar's lines from `at` on line `li`: this one, and those more indented than `parent` that go on with it. */
function yamlPlain(s: string, lines: Line[], li: number, at: number, parent: number, path: string[], mark: { anchored?: true }, out: DataString[]): number {
  const piece = (from: number, to: number) => {
    const text = s.slice(from, to);
    const comment = /\s#/.exec(text);
    const kept = (comment ? text.slice(0, comment.index) : text).trimEnd();
    // A null, a boolean, a number or a date standing alone is no string value.
    if (kept && !(from === at && NOT_TEXT.test(kept))) out.push({ start: from, end: from + kept.length, path, plain: true, ...mark });
    return !comment;
  };
  if (!piece(at, lines[li]!.end)) return li + 1;
  let next = li + 1;
  for (; next < lines.length; next++) {
    const line = lines[next]!;
    if (!line.text) continue;
    if (line.indent <= parent || line.text.startsWith('#') || /:(?:\s|$)/.test(line.text)) break;
    if (!piece(line.start + line.indent, line.end)) return next + 1;
  }
  return next;
}

/** A block scalar's lines below line `li`, of a node at column `parent`: each, its indentation left out, to `out`. */
function yamlBlock(s: string, lines: Line[], li: number, parent: number, header: string, path: string[], mark: { anchored?: true }, out: DataString[]): number {
  const explicit = /[1-9]/.exec(header);
  let indent = explicit ? Math.max(parent, 0) + Number(explicit[0]) : 0;
  let next = li + 1;
  for (; next < lines.length; next++) {
    const line = lines[next]!;
    if (!line.text) continue;
    if (!indent) {
      if (line.indent <= parent) break;
      indent = line.indent;
    }
    if (line.indent < indent) break;
    out.push({ start: line.start + indent, end: line.end, path, ...mark });
  }
  return next;
}

/** Past a quoted scalar that opened at `at` on line `li` and goes on below: the line after the one it closes on. */
function yamlSkipQuoted(s: string, lines: Line[], li: number, at: number, q: string): number {
  for (let i = at + 1; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') i++;
    else if (s[i] === q) {
      if (q === "'" && s[i + 1] === "'") i++;
      else return lineOf(lines, li, i) + 1;
    }
  }
  return lines.length;
}

/** Past a flow collection that opened at `at` on line `li`: the line after the one it closes on. */
function yamlSkipFlow(s: string, lines: Line[], li: number, at: number): number {
  let depth = 0;
  for (let i = at; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"' || c === "'") i = quotedEnd(s, i, c, c === '"');
    else if (c === '#' && /\s/.test(s[i - 1] ?? '')) i = lineEnd(s, i) - 1;
    else if (c === '[' || c === '{') depth++;
    else if ((c === ']' || c === '}') && --depth === 0) return lineOf(lines, li, i) + 1;
  }
  return lines.length;
}
