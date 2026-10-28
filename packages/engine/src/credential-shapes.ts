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

/** A string value `mask` replaced: where its token starts and ends in the text, and the JSON string written in its place. */
type Replaced = [start: number, end: number, json: string];

/** `text` with each replaced string token written as its replacement, every other character as it was. */
function spliced(text: string, replaced: readonly Replaced[]): string {
  const out: string[] = [];
  let copied = 0;
  for (const [start, end, json] of replaced) {
    out.push(text.slice(copied, start), json);
    copied = end;
  }
  return out.join('') + text.slice(copied);
}

const isJsonSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

/**
 * Reads the one JSON value that starts at `start` in `text` (whitespace before it skipped), noting
 * in `replaced` each string value `mask` replaces. `whole` when the value is complete: `at` is then
 * just past it. Otherwise `at` is where the text stopped being JSON (its length, when it ended
 * first), and `replaced` holds what was masked before there. Iterative, so a document nested
 * thousands deep reads like any other; each character is read once.
 */
function walkValue(text: string, start: number, mask: StringMask, credentialMember: CredentialMember, replaced: Replaced[]): { at: number; whole: boolean } {
  const stack: Frame[] = [];
  const n = text.length;
  let i = start;
  /** The raw text of the string token at `i` (quotes and escapes), moving past it; null when it doesn't end. */
  const scanString = (): string | null => {
    const from = i;
    for (i++; i < n; i++) {
      const c = text.charCodeAt(i);
      if (c === 0x5c) i++;
      else if (c === 0x22) return text.slice(from, ++i);
    }
    i = n;
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
  /** After a value: the member or item it was now wants a comma or a close, or it was the whole value. */
  const ended = (): boolean => {
    const top = stack[stack.length - 1];
    if (!top) return true;
    top.expect = 'comma';
    return false;
  };
  for (;;) {
    while (i < n && isJsonSpace(text.charCodeAt(i))) i++;
    if (i >= n) return { at: n, whole: false };
    const top = stack[stack.length - 1];
    const c = text[i]!;
    if (top?.expect === 'colon') {
      if (c !== ':') return { at: i, whole: false };
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
      if (c !== (top.object ? '}' : ']')) return { at: i, whole: false };
      i++;
      stack.pop();
      if (ended()) return { at: i, whole: true };
      continue;
    }
    if (top?.expect === 'key') {
      if (c === '}' && top.first) {
        i++;
        stack.pop();
        if (ended()) return { at: i, whole: true };
        continue;
      }
      if (c !== '"') return { at: i, whole: false };
      const raw = scanString();
      const key = raw === null ? undefined : decode(raw);
      if (key === undefined) return { at: i, whole: false };
      top.key = key;
      top.expect = 'colon';
      continue;
    }
    // A value: at the top, an array's item, or an object member's.
    if (top && !top.object && c === ']' && top.first) {
      i++;
      stack.pop();
      if (ended()) return { at: i, whole: true };
      continue;
    }
    if (c === '"') {
      const from = i;
      const raw = scanString();
      const value = raw === null ? undefined : decode(raw);
      if (value === undefined) return { at: i, whole: false };
      const replacement = mask(top?.key ?? null, value, top?.under ?? false);
      if (replacement !== null && replacement !== value) replaced.push([from, i, JSON.stringify(replacement)]);
      if (ended()) return { at: i, whole: true };
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
    if (!m) return { at: i, whole: false };
    i += m[0].length;
    if (ended()) return { at: i, whole: true };
  }
}

/**
 * One JSON document (any value, whitespace around it) with each string value `mask` replaces
 * written as the JSON string of its replacement, every other character as it was: a number of any
 * length, the layout, escapes in the strings kept. Undefined when the text isn't JSON, null when it
 * is and nothing was replaced. Iterative, so a document nested thousands deep reads like any other.
 */
export function walkJson(text: string, mask: StringMask, credentialMember: CredentialMember): string | null | undefined {
  const replaced: Replaced[] = [];
  const { at, whole } = walkValue(text, 0, mask, credentialMember, replaced);
  if (!whole) return undefined;
  let i = at;
  while (i < text.length && isJsonSpace(text.charCodeAt(i))) i++;
  if (i < text.length) return undefined;
  return replaced.length ? spliced(text, replaced) : null;
}

/**
 * The JSON objects in a text that isn't JSON as a whole, each string value `mask` replaces written
 * as walkJson writes it, every other character as it was: a document after a comment or `<!--`, one
 * followed by `;` or by other text, documents run together or a line each (a JSON text sequence), a
 * jQuery JSONP call, the state a page's script holds (`__NEXT_DATA__`, `window.__STATE__ = …`).
 * Each `{` that no object read so far holds opens one, read as far as it is JSON: what it held
 * before it stopped being JSON is masked, and the search goes on from there, so each character is
 * read once. Null when nothing was replaced.
 */
export function maskEmbeddedJson(text: string, mask: StringMask, credentialMember: CredentialMember): string | null {
  const replaced: Replaced[] = [];
  for (let i = text.indexOf('{'); i >= 0; ) {
    const { at } = walkValue(text, i, mask, credentialMember, replaced);
    i = text.indexOf('{', Math.max(at, i + 1));
  }
  return replaced.length ? spliced(text, replaced) : null;
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
 * Lines of JSON (NDJSON, JSON Lines): two or more lines that are each a JSON object or array, each
 * masked by `maskLine`. A line that isn't one (a log line among them, a blank one) is left as it
 * is, and the others are read all the same. Null when it holds fewer than two, or nothing changed.
 */
export function maskJsonLines(text: string, maskLine: (line: string) => string | null | undefined): string | null {
  const lines = text.split('\n');
  let docs = 0;
  let changed = false;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]!;
    const body = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!/^\s*[{[]/.test(body)) continue;
    const masked = maskLine(body);
    if (masked === undefined) continue;
    docs++;
    if (masked !== null) {
      lines[k] = masked + (line.endsWith('\r') ? '\r' : '');
      changed = true;
    }
  }
  return docs >= 2 && changed ? lines.join('\n') : null;
}

/**
 * A line of an event stream: a comment, or a field and its value. A field other than `data`,
 * `event`, `id` and `retry` is one a client ignores, as the standard has it.
 */
const SSE_LINE = /^(?::.*|([A-Za-z][\w-]*)(?::( ?)(.*))?)$/;

/** One `data:` line of an event: where it is, how it was written, and its payload. */
interface DataLine {
  k: number;
  space: string;
  cr: boolean;
  payload: string;
}

/**
 * A text/event-stream body (SSE), each event's data masked by `maskData` (a JSON payload as JSON),
 * every other line as it was. An event's data is its `data:` lines' payloads joined with line
 * breaks, as a client reads it, so JSON written across several of them is read whole; a byte-order
 * mark may open the stream. Null when it isn't an event stream (no `data:` line, or a line that is
 * no field), or nothing changed.
 */
export function maskEventStream(text: string, maskData: (payload: string) => string | null): string | null {
  const bom = BOM.exec(text)?.[0] ?? '';
  const lines = text.slice(bom.length).split('\n');
  let data = false;
  let changed = false;
  let event: DataLine[] = [];
  const write = (d: DataLine, payload: string) => {
    lines[d.k] = `data:${d.space}${payload}${d.cr ? '\r' : ''}`;
    changed = true;
  };
  // An event's data, masked whole; when that masks it into other lines, each line on its own.
  const ended = () => {
    const joined = event.map((d) => d.payload).join('\n');
    const masked = event.length ? maskData(joined) : null;
    if (masked !== null && masked !== joined) {
      const parts = masked.split('\n');
      if (parts.length === event.length) event.forEach((d, j) => parts[j] !== d.payload && write(d, parts[j]!));
      else
        for (const d of event) {
          const one = maskData(d.payload);
          if (one !== null && one !== d.payload) write(d, one);
        }
    }
    event = [];
  };
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]!;
    const cr = line.endsWith('\r');
    const body = cr ? line.slice(0, -1) : line;
    if (!body) {
      ended();
      continue;
    }
    const m = SSE_LINE.exec(body);
    if (!m) return null;
    if (m[1] !== 'data' || m[3] === undefined) continue;
    data = true;
    event.push({ k, space: m[2] ?? '', cr, payload: m[3] });
  }
  ended();
  return data && changed ? bom + lines.join('\n') : null;
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

/** An XML (or XHTML) document: a tag, a comment or a doctype first, past a byte-order mark and a declaration. */
const XML_START = /^(?:\uFEFF|\u00EF\u00BB\u00BF)?\s*(?:<\?xml[^>]*\?>\s*)?<[A-Za-z_!]/;
/** A start or end tag, whole: whether it ends one, its name (and the name without a namespace prefix), and its attributes (a `/` last when it closes itself). */
const XML_TAG_PARTS = /^<(\/?)((?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*))((?:\s[^<>]*)?)>$/;
/** A start tag's attribute: `token="…"`, `ns:secret='…'`. */
const XML_ATTRIBUTE = /(\s)((?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*))(\s*=\s*)("[^"<]*"|'[^'<]*')/g;
/** Attributes that name what an element holds (`<entry key="db.password">`, `<input name="SAMLResponse">`), and those that hold its value. */
const NAMING_ATTRIBUTES = new Set(['name', 'key']);
const VALUE_ATTRIBUTES = new Set(['value', 'content']);
/** HTML's void elements, which have no end tag: what follows one is never inside it. */
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** An element the reader is inside: its tag, the name it goes by, and whether everything in it is a credential. */
interface XmlElement {
  tag: string;
  name: string;
  under: boolean;
}

/**
 * XML, or HTML, with each credential replaced by `replacement`, escaped as XML, every other
 * character as it was: an element's text (a CDATA section's too) whose name `credential` reads as
 * one with it, and each attribute whose name does; an element named by its `name` or `key`
 * attribute (`<entry key="db.password">`, `<property name="api_key" value="…"/>`, `<input
 * name="SAMLResponse" value="…">`, `<meta name="csrf-token" content="…">`) as by its tag, its
 * `value` or `content` attribute with it; and everything inside an element whose name or key
 * attribute `member` reads as a credential by itself (a SAML `<Attribute Name="password">`'s
 * `<AttributeValue>`). An element named so by its tag holds its own text alone, each element in it
 * judged by its own name: an AWS STS answer's `<Credentials>` keeps its key id and expiry, which a
 * client reads on replay, and masks its `<SecretAccessKey>` and `<SessionToken>`. Read tag by tag, each character once; a comment is skipped, and text after the
 * document is left as it is. Null when it isn't XML, or nothing changed.
 */
export function maskXml(text: string, credential: (name: string, value: string) => boolean, member: (name: string) => boolean, replacement: string): string | null {
  if (!XML_START.test(text)) return null;
  const placed = asXmlText(replacement);
  const out: string[] = [];
  let copied = 0;
  const replace = (from: number, to: number, written: string) => {
    out.push(text.slice(copied, from), written);
    copied = to;
  };
  const open: XmlElement[] = [];
  /** Whether a value inside the element read now is a credential: everything is under one, else by the element's name with it. */
  const secret = (value: string): boolean => {
    const top = open[open.length - 1];
    return top !== undefined && value !== replacement && value.trim() !== '' && (top.under || credential(top.name, value));
  };
  const n = text.length;
  let i = 0;
  while (i < n) {
    const lt = text.indexOf('<', i);
    const to = lt < 0 ? n : lt;
    if (to > i && secret(xmlText(text.slice(i, to)))) replace(i, to, placed);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) break;
      if (secret(text.slice(lt + 9, end))) replace(lt + 9, end, replacement);
      i = end + 3;
      continue;
    }
    const gt = text.indexOf('>', lt + 1);
    if (gt < 0) break;
    i = gt + 1;
    // A doctype, a declaration or a processing instruction, or `<` in text: none holds a value.
    const tag = XML_TAG_PARTS.exec(text.slice(lt, i));
    if (!tag) continue;
    const [, closing, qname = '', local = '', attrs = ''] = tag;
    if (closing) {
      let at = open.length - 1;
      while (at >= 0 && open[at]!.tag !== qname) at--;
      if (at >= 0) open.length = at;
      continue;
    }
    let named: string | null = null;
    for (const a of attrs.matchAll(XML_ATTRIBUTE)) if (named === null && NAMING_ATTRIBUTES.has(a[3]!.toLowerCase())) named = xmlText(a[5]!.slice(1, -1));
    const outer = open[open.length - 1]?.under ?? false;
    const name = named ?? local;
    const under = outer || (named !== null && member(named));
    const masked = attrs.replace(XML_ATTRIBUTE, (whole, lead: string, attr: string, own: string, eq: string, quoted: string) => {
      const value = xmlText(quoted.slice(1, -1));
      if (value === replacement || !value) return whole;
      const holds = VALUE_ATTRIBUTES.has(own.toLowerCase()) && (under || (named !== null && credential(named, value)));
      if (!holds && !credential(own, value)) return whole;
      return `${lead}${attr}${eq}${quoted[0]!}${placed}${quoted[0]!}`;
    });
    if (masked !== attrs) replace(lt + 1 + qname.length, lt + 1 + qname.length + attrs.length, masked);
    if (!attrs.trimEnd().endsWith('/') && !VOID_ELEMENTS.has(local.toLowerCase())) open.push({ tag: qname, name, under });
  }
  return out.length ? out.join('') + text.slice(copied) : null;
}

/** A GraphQL document: an operation or a fragment, or a query in its shorthand form (`{ … }`), after any comment lines. */
const GRAPHQL_START = /^\s*(?:#[^\n]*\n\s*)*(?:(?:query|mutation|subscription|fragment)\b|\{)/;
/**
 * A string argument or input field: `password: "…"`, `apiKey:"…"`, or a block string, `password:
 * """…"""` (in which `\"""` stands for three quotes, a backslash taking the character after it); a
 * name is read from its start only, so a long word costs its length once.
 */
const GRAPHQL_STRING_ARGUMENT = /(?<![_0-9A-Za-z])([_A-Za-z][_0-9A-Za-z]*)(\s*:\s*)(?:"""((?:[^"\\]|\\[^]|"(?!""))*)"""|"((?:[^"\\\n]|\\.)*)")/g;

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
  const out = text.replace(GRAPHQL_STRING_ARGUMENT, (whole, name: string, colon: string, block: string | undefined, raw: string | undefined) => {
    let value: string;
    if (block !== undefined) value = block.replaceAll('\\"""', '"""');
    else
      try {
        value = JSON.parse(`"${raw ?? ''}"`) as string;
      } catch {
        return whole;
      }
    if (value === replacement || !credential(name, value)) return whole;
    changed = true;
    return `${name}${colon}${block !== undefined ? `"""${replacement}"""` : JSON.stringify(replacement)}`;
  });
  return changed ? out : null;
}

/**
 * A line that sets a value: YAML's `key: value` (in a list too, `- key: value`), an INI file's
 * `key = value`, a .env file's `KEY=value` and `export KEY=value`. Its value is the rest of the line.
 */
const KEY_VALUE_LINE = /^(\s*(?:-[ \t]+)?(?:export[ \t]+)?)([A-Za-z_][\w.-]*)([ \t]*[:=][ \t]*)(\S(?:.*\S)?)[ \t]*$/;

/**
 * Text written as `key: value` or `key = value` lines (YAML, an INI file, a .env file), each value
 * whose key `credential` reads as one, with it, replaced by `replacement`, inside its quotes when it
 * is quoted; every other character as it was. A line of any other shape is left as it is, and so is
 * a sentence that starts `name=`: written with no space around its `=`, a value is one word unless
 * it is quoted, as a .env file writes one. Null when nothing changed.
 */
export function maskKeyValueLines(text: string, credential: (name: string, value: string) => boolean, replacement: string): string | null {
  const lines = text.split('\n');
  let changed = false;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]!;
    const cr = line.endsWith('\r');
    const m = KEY_VALUE_LINE.exec(cr ? line.slice(0, -1) : line);
    if (!m) continue;
    const [, lead = '', key = '', sep = '', raw = ''] = m;
    const quote = raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw.endsWith(raw[0]) ? raw[0] : '';
    const value = quote ? raw.slice(1, -1) : raw;
    if (sep === '=' && !quote && /\s/.test(value)) continue;
    if (!value || value === replacement || !credential(key, value)) continue;
    lines[k] = `${lead}${key}${sep}${quote}${replacement}${quote}${cr ? '\r' : ''}`;
    changed = true;
  }
  return changed ? lines.join('\n') : null;
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
