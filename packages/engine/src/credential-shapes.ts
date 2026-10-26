/**
 * The shapes a recorded body, or a string inside one, can have, read just far enough to mask the
 * values in them: JSON (also behind a byte-order mark, an anti-XSSI prefix or inside a JSONP call),
 * lines of JSON (NDJSON), an event stream (SSE), XML, a multipart body and GraphQL arguments. Each
 * reader is told by its caller what to do with a value it finds (http.ts decides what a credential
 * is), keeps every character it doesn't replace, and returns null when it replaced nothing or the
 * text isn't of its shape. Every reader runs in time linear in its text.
 */

/**
 * What to put in place of a string value: `key` is the member it belongs to (an array's items take
 * the member the array is), `under` whether a member above it is a credential, so everything in it
 * is. The replacement text, or null to keep the value as it is.
 */
export type StringMask = (key: string | null, value: string, under: boolean) => string | null;

/** Whether a member's value, when it is an object or an array, is a credential through and through (`client_secret: {…}`, `api_keys: […]`). */
export type CredentialMember = (key: string) => boolean;

/** One open object or array, as the JSON reader walks it. */
interface Frame {
  object: boolean;
  /** Everything in it is a credential. */
  under: boolean;
  /** An object's current member, or the member an array is the value of. */
  key: string | null;
  expect: 'key' | 'colon' | 'value' | 'comma';
  first: boolean;
}

const NUMBER_OR_LITERAL = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

/**
 * One JSON document (any value, whitespace around it) with each string value `mask` replaces
 * written as the JSON string of its replacement, every other character as it was: a number of any
 * length, the layout, escapes in the strings kept. Undefined when the text isn't JSON, null when it
 * is and nothing was replaced. Iterative, so a document nested thousands deep reads like any other.
 */
export function walkJson(text: string, mask: StringMask, credentialMember: CredentialMember): string | null | undefined {
  const out: string[] = [];
  const stack: Frame[] = [];
  let copied = 0;
  let i = 0;
  let done = false;
  const n = text.length;
  const skipWs = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
      i++;
    }
  };
  /** The raw text of the string token at `i` (quotes and escapes), moving past it; null when it doesn't end. */
  const scanString = (): string | null => {
    const start = i;
    for (i++; i < n; i++) {
      const c = text.charCodeAt(i);
      if (c === 0x5c) i++;
      else if (c === 0x22) return text.slice(start, ++i);
    }
    return null;
  };
  const decode = (raw: string): string | undefined => {
    try {
      const v: unknown = JSON.parse(raw);
      return typeof v === 'string' ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const afterValue = () => {
    const top = stack[stack.length - 1];
    if (top) top.expect = 'comma';
    else done = true;
  };
  for (;;) {
    skipWs();
    if (i >= n) break;
    if (done) return undefined;
    const top = stack[stack.length - 1];
    const c = text[i]!;
    if (top?.expect === 'colon') {
      if (c !== ':') return undefined;
      i++;
      top.expect = 'value';
      continue;
    }
    if (top?.expect === 'comma') {
      if (c === ',') {
        i++;
        top.expect = top.object ? 'key' : 'value';
        top.first = false;
        continue;
      }
      if (c !== (top.object ? '}' : ']')) return undefined;
      i++;
      stack.pop();
      afterValue();
      continue;
    }
    if (top?.expect === 'key') {
      if (c === '}' && top.first) {
        i++;
        stack.pop();
        afterValue();
        continue;
      }
      if (c !== '"') return undefined;
      const raw = scanString();
      const key = raw === null ? undefined : decode(raw);
      if (key === undefined) return undefined;
      top.key = key;
      top.expect = 'colon';
      continue;
    }
    // A value: at the top, an array's item, or an object member's.
    if (top && !top.object && c === ']' && top.first) {
      i++;
      stack.pop();
      afterValue();
      continue;
    }
    if (c === '"') {
      const start = i;
      const raw = scanString();
      const value = raw === null ? undefined : decode(raw);
      if (value === undefined) return undefined;
      const replaced = mask(top?.key ?? null, value, top?.under ?? false);
      if (replaced !== null && replaced !== value) {
        out.push(text.slice(copied, start), JSON.stringify(replaced));
        copied = i;
      }
      afterValue();
      continue;
    }
    if (c === '{' || c === '[') {
      i++;
      const key = top?.key ?? null;
      const under = (top?.under ?? false) || (top?.object === true && key !== null && credentialMember(key));
      stack.push({ object: c === '{', under, key: c === '[' ? key : null, expect: c === '{' ? 'key' : 'value', first: true });
      continue;
    }
    NUMBER_OR_LITERAL.lastIndex = i;
    const m = NUMBER_OR_LITERAL.exec(text);
    if (!m) return undefined;
    i += m[0].length;
    afterValue();
  }
  if (!done || stack.length) return undefined;
  return out.length ? out.join('') + text.slice(copied) : null;
}

/** The index just past the JSON string token that opens at `start`, or -1 when it doesn't end. */
function endOfString(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x5c) i++;
    else if (c === 0x22) return i + 1;
  }
  return -1;
}

/**
 * The index just past the JSON value that starts at `start` (after any whitespace), or -1 when no
 * value starts there: brackets matched and the grammar between them followed, iteratively, so a value
 * nested thousands deep is skipped like any other. Its strings' escapes aren't checked.
 */
export function skipJsonValue(text: string, start: number): number {
  const closers: string[] = [];
  let expect: 'value' | 'key' | 'colon' | 'comma' = 'value';
  let first = false;
  let i = start;
  const n = text.length;
  for (;;) {
    while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
    if (i >= n) return -1;
    const c = text[i]!;
    const top = closers[closers.length - 1];
    if (expect === 'colon') {
      if (c !== ':') return -1;
      i++;
      expect = 'value';
      continue;
    }
    if (expect === 'comma' || (first && c === top)) {
      if (c === ',' && expect === 'comma') {
        i++;
        expect = top === '}' ? 'key' : 'value';
        first = false;
        continue;
      }
      if (c !== top) return -1;
      i++;
      closers.pop();
      if (!closers.length) return i;
      expect = 'comma';
      first = false;
      continue;
    }
    if (expect === 'key') {
      if (c !== '"') return -1;
      i = endOfString(text, i);
      if (i < 0) return -1;
      expect = 'colon';
      continue;
    }
    if (c === '"') {
      i = endOfString(text, i);
      if (i < 0) return -1;
    } else if (c === '{' || c === '[') {
      closers.push(c === '{' ? '}' : ']');
      i++;
      expect = c === '{' ? 'key' : 'value';
      first = true;
      continue;
    } else {
      NUMBER_OR_LITERAL.lastIndex = i;
      const m = NUMBER_OR_LITERAL.exec(text);
      if (!m) return -1;
      i += m[0].length;
    }
    if (!closers.length) return i;
    expect = 'comma';
    first = false;
  }
}

/**
 * Whether JSON text nests deeper than `limit` (its objects and arrays, outside its strings), read
 * once and stopping as soon as it does: a reader that holds a document as values walks it by
 * recursion, which a document thousands deep would overflow.
 */
export function nestsDeeper(text: string, limit: number): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x22) {
      const end = endOfString(text, i);
      if (end < 0) return false;
      i = end - 1;
    } else if (c === 0x7b || c === 0x5b) {
      if (++depth > limit) return true;
    } else if (c === 0x7d || c === 0x5d) depth--;
  }
  return false;
}

/** A JSON document's text (`json`) and what wraps it, kept as it was around the masked document. */
export interface WrappedJson {
  prefix: string;
  json: string;
  suffix: string;
}

/** UTF-8's byte-order mark, read as text and as the three bytes a body read as Latin-1 shows. */
const BOM = /^(?:\uFEFF|\u00EF\u00BB\u00BF)/;
/** What a server puts before JSON so a page can't run it as a script (anti-XSSI): `)]}'`, `while(1);`, `for(;;);`. */
const XSSI = /^(?:\)\]\}'(?:,)?|while\s*\(\s*1\s*\)\s*;|for\s*\(\s*;\s*;\s*\)\s*;)/;
/** A JSONP call's start: an optional `/**\/`, a callback name (`cb`, `jQuery123_456`, `window.app.cb`), `(`. */
const JSONP_START = /^(\/\*\*\/\s*)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/;
const JSONP_END = /\)\s*;?\s*$/;

/**
 * The JSON document in a text and what wraps it: a byte-order mark, an anti-XSSI prefix, a JSONP
 * call around it. The text itself, unwrapped, when nothing does.
 */
export function unwrapJson(text: string): WrappedJson {
  let at = BOM.exec(text)?.[0].length ?? 0;
  const xssi = XSSI.exec(text.slice(at + leadingSpace(text, at)));
  if (xssi) at += leadingSpace(text, at) + xssi[0].length;
  const open = at + leadingSpace(text, at);
  const call = JSONP_START.exec(text.slice(open));
  const end = call ? JSONP_END.exec(text) : null;
  if (call && end && end.index >= open + call[0].length) return { prefix: text.slice(0, open + call[0].length), json: text.slice(open + call[0].length, end.index), suffix: text.slice(end.index) };
  return { prefix: text.slice(0, at), json: text.slice(at), suffix: '' };
}

/** How many whitespace characters start `text` at `at`. */
function leadingSpace(text: string, at: number): number {
  let i = at;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i - at;
}

/**
 * Lines of JSON (NDJSON, JSON Lines): two or more lines, each a JSON object or array (or blank),
 * each masked by `maskLine`. Null when it isn't lines of JSON, or nothing changed.
 */
export function maskJsonLines(text: string, maskLine: (line: string) => string | null | undefined): string | null {
  const lines = text.split('\n');
  let docs = 0;
  let changed = false;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]!;
    const body = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!body.trim()) continue;
    if (!/^\s*[{[]/.test(body)) return null;
    const masked = maskLine(body);
    if (masked === undefined) return null;
    docs++;
    if (masked !== null) {
      lines[k] = masked + (line.endsWith('\r') ? '\r' : '');
      changed = true;
    }
  }
  return docs >= 2 && changed ? lines.join('\n') : null;
}

/** A line of an event stream: a comment, or a field (`data`, `event`, `id`, `retry`) and its value. */
const SSE_LINE = /^(?::.*|(data|event|id|retry)(?::( ?)(.*))?)$/;

/**
 * A text/event-stream body (SSE), each `data:` line's payload masked by `maskData` (a JSON payload
 * as JSON), every other line as it was. Null when it isn't an event stream (no `data:` line, or a
 * line that is no field), or nothing changed.
 */
export function maskEventStream(text: string, maskData: (payload: string) => string | null): string | null {
  const lines = text.split('\n');
  let data = false;
  let changed = false;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]!;
    const cr = line.endsWith('\r');
    const body = cr ? line.slice(0, -1) : line;
    if (!body) continue;
    const m = SSE_LINE.exec(body);
    if (!m) return null;
    if (m[1] !== 'data' || m[3] === undefined) continue;
    data = true;
    const masked = maskData(m[3]);
    if (masked !== null && masked !== m[3]) {
      lines[k] = `data:${m[2] ?? ''}${masked}${cr ? '\r' : ''}`;
      changed = true;
    }
  }
  return data && changed ? lines.join('\n') : null;
}

const XML_ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** XML text with its entity and character references read. */
export function xmlText(raw: string): string {
  return raw.replace(/&(?:#x([0-9A-Fa-f]{1,6})|#(\d{1,7})|(lt|gt|amp|quot|apos));/g, (whole, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (name) return XML_ENTITIES[name]!;
    const code = parseInt(hex ?? dec!, hex ? 16 : 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** `text` as XML text content: its `&`, `<` and `>` escaped. */
export function asXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** An XML (or XHTML) document: a tag, a comment or a doctype first, past a byte-order mark and a declaration; `>` last. */
const XML_START = /^(?:\uFEFF|\u00EF\u00BB\u00BF)?\s*(?:<\?xml[^>]*\?>\s*)?<[A-Za-z_!]/;
/** A leaf element, its text plain or a CDATA section: `<ns:SessionToken a="1">…</ns:SessionToken>`. */
const XML_LEAF = /<((?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*))((?:\s[^<>]*)?)>(?:([^<]*)|<!\[CDATA\[([^]*?)\]\]>)<\/\1\s*>/g;
/** A start tag's attribute: `token="…"`, `ns:secret='…'`. */
const XML_ATTRIBUTE = /(\s)((?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*))(\s*=\s*)("[^"<]*"|'[^'<]*')/g;
const XML_TAG = /<[A-Za-z_][^<>]*>/g;

/**
 * XML with the text of each leaf element, and the value of each attribute, whose name (without its
 * namespace prefix) `credential` reads as one, with its text, replaced by `replacement`, escaped as
 * XML; every other character as it was. An AWS STS answer's `<SecretAccessKey>` and
 * `<SessionToken>`, a SAML attribute. Null when it isn't XML, or nothing changed.
 */
export function maskXml(text: string, credential: (name: string, value: string) => boolean, replacement: string): string | null {
  if (!XML_START.test(text) || !text.trimEnd().endsWith('>')) return null;
  const placed = asXmlText(replacement);
  let changed = false;
  const leaves = text.replace(XML_LEAF, (whole, tag: string, local: string, attrs: string, plain: string | undefined, cdata: string | undefined) => {
    const value = cdata ?? xmlText(plain ?? '');
    if (value === replacement || !value.trim() || !credential(local, value)) return whole;
    changed = true;
    return cdata !== undefined ? `<${tag}${attrs}><![CDATA[${replacement}]]></${tag}>` : `<${tag}${attrs}>${placed}</${tag}>`;
  });
  const out = leaves.replace(XML_TAG, (tag) =>
    tag.replace(XML_ATTRIBUTE, (whole, lead: string, name: string, local: string, eq: string, quoted: string) => {
      const value = xmlText(quoted.slice(1, -1));
      if (value === replacement || !value || !credential(local, value)) return whole;
      changed = true;
      return `${lead}${name}${eq}${quoted[0]!}${placed}${quoted[0]!}`;
    }),
  );
  return changed ? out : null;
}

/** A GraphQL document: an operation or a fragment, or a query in its shorthand form (`{ … }`). */
const GRAPHQL_START = /^\s*(?:(?:query|mutation|subscription|fragment)\b|\{)/;
/** A string argument or input field: `password: "…"`, `apiKey:"…"`; a name is read from its start only, so a long word costs its length once. */
const GRAPHQL_STRING_ARGUMENT = /(?<![_0-9A-Za-z])([_A-Za-z][_0-9A-Za-z]*)(\s*:\s*)"((?:[^"\\\n]|\\.)*)"/g;

/** Whether a text reads as a GraphQL document. */
export function graphqlShaped(text: string): boolean {
  return GRAPHQL_START.test(text) && text.includes('(');
}

/**
 * A GraphQL document with each string argument or input field whose name `credential` reads as one,
 * with its value, replaced by `replacement` (`login(password: "…")`): every other character as it
 * was. Null when it isn't GraphQL, or nothing changed.
 */
export function maskGraphqlArguments(text: string, credential: (name: string, value: string) => boolean, replacement: string): string | null {
  if (!graphqlShaped(text)) return null;
  let changed = false;
  const out = text.replace(GRAPHQL_STRING_ARGUMENT, (whole, name: string, colon: string, raw: string) => {
    let value: string;
    try {
      value = JSON.parse(`"${raw}"`) as string;
    } catch {
      return whole;
    }
    if (value === replacement || !credential(name, value)) return whole;
    changed = true;
    return `${name}${colon}${JSON.stringify(replacement)}`;
  });
  return changed ? out : null;
}

/** One part of a multipart body: its header lines as written, and its content. */
export interface MultipartPartText {
  headers: string;
  content: string;
}

/**
 * A multipart body (`multipart/form-data`, `multipart/related`, …) with each part passed through
 * `maskPart`, which returns the part's headers and content to write, or null to keep it. The
 * boundary is read from the body itself, as a copy that has no content type must: the first line
 * that starts with `--` (past a preamble), whose closing `--boundary--` the body has. CRLF or LF
 * line breaks; delimiters, the preamble and the epilogue as they were. Null when it isn't
 * multipart, or nothing changed.
 */
export function maskMultipart(text: string, maskPart: (part: MultipartPartText) => MultipartPartText | null): string | null {
  const first = /(?:^|\n)--([^\r\n]{1,200}?)[ \t]*(\r?\n)/.exec(text);
  if (!first) return null;
  const boundary = first[1]!;
  const nl = first[2]!;
  const delimiter = `${nl}--${boundary}`;
  const firstAt = first.index + (text[first.index] === '\n' ? 1 : 0);
  const closing = `--${boundary}--`;
  if (!text.includes(closing, firstAt)) return null;
  const chunks: string[] = [text.slice(0, firstAt + 2 + boundary.length)];
  let at = firstAt + 2 + boundary.length;
  let changed = false;
  for (;;) {
    // At a delimiter's end: `--` closes the body; otherwise transport padding, then its line break.
    if (text.startsWith('--', at)) {
      chunks.push(text.slice(at));
      break;
    }
    let lineEnd = at;
    while (text[lineEnd] === ' ' || text[lineEnd] === '\t') lineEnd++;
    if (!text.startsWith(nl, lineEnd)) return null;
    chunks.push(text.slice(at, lineEnd + nl.length));
    const start = lineEnd + nl.length;
    const next = text.indexOf(delimiter, start);
    if (next < 0) return null;
    const raw = text.slice(start, next);
    // A part with no headers starts with the blank line that ends them.
    const blank = raw.startsWith(nl) ? 0 : raw.indexOf(nl + nl);
    if (blank < 0) return null;
    const headers = blank === 0 ? '' : raw.slice(0, blank);
    const content = raw.slice(blank === 0 ? nl.length : blank + 2 * nl.length);
    const masked = maskPart({ headers, content });
    if (masked && (masked.headers !== headers || masked.content !== content)) {
      chunks.push(masked.headers ? `${masked.headers}${nl}${nl}${masked.content}` : `${nl}${masked.content}`);
      changed = true;
    } else chunks.push(raw);
    chunks.push(delimiter);
    at = next + delimiter.length;
  }
  return changed ? chunks.join('') : null;
}
