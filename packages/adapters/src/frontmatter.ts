/**
 * The YAML frontmatter of Claude Code's skills (`SKILL.md`) and subagents (`agents/*.md`), read for
 * the keys the fence needs: `name`, `hooks` and `mcpServers`. Claude Code takes hooks from it in the
 * same format as a settings file's, and MCP servers as `.mcp.json` names them.
 *
 * Only the YAML that frontmatter uses is read: block mappings and sequences, plain and quoted
 * scalars, block scalars (`|`, `>`) and flow collections (`[a, b]`, `{ a: b }`). Each top-level key
 * is read on its own, so a description written in YAML this doesn't read costs nothing; a key whose
 * value can't be read is `unreadable`, and its reader decides what that means (the fence assumes the
 * worst of it).
 */

/** One top-level key's value: what it holds, or `unreadable`. */
export type FrontmatterValue = { value: unknown } | { unreadable: true };

/**
 * The top-level keys of a file's frontmatter, each with its value, or null when the file has no
 * frontmatter (it doesn't start with a `---` line, or nothing closes it).
 */
export function frontmatter(text: string): Map<string, FrontmatterValue> | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trimEnd() !== '---') return null;
  const close = lines.findIndex((l, i) => i > 0 && (l.trimEnd() === '---' || l.trimEnd() === '...'));
  if (close < 0) return null;
  const entries: Array<{ key: string; rest: string; block: string[] }> = [];
  for (const line of lines.slice(1, close)) {
    const top = !/^\s/.test(line) && line.trim() !== '' && !line.startsWith('#') && !line.startsWith('-') ? splitKey(stripComment(line)) : null;
    if (top) entries.push({ key: top.key, rest: top.rest, block: [] });
    else entries.at(-1)?.block.push(line);
  }
  const out = new Map<string, FrontmatterValue>();
  for (const e of entries) {
    try {
      const r = new Reader(e.block);
      const value = r.value(e.rest, 0);
      r.end();
      out.set(e.key, { value });
    } catch {
      out.set(e.key, { unreadable: true });
    }
  }
  return out;
}

interface Line {
  indent: number;
  /** The line without its indentation, or its comment. */
  text: string;
  /** The line as it is, for a block scalar. */
  raw: string;
}

class YamlError extends Error {}

/** `key: rest` or `key:`, the key plain or quoted; null for a line that holds no key. */
function splitKey(text: string): { key: string; rest: string } | null {
  const t = text.trim();
  if (!t || /^[-?[\]{}#&*!|>%@`,]/.test(t) && !/^-[^\s]/.test(t)) return null;
  if (t[0] === '"' || t[0] === "'") {
    const { value, end } = quoted(t, 0);
    const after = t.slice(end).trimStart();
    if (!after.startsWith(':') || (after.length > 1 && !/\s/.test(after[1]!))) return null;
    return { key: value, rest: after.slice(1).trim() };
  }
  const m = /:(\s|$)/.exec(t);
  if (!m) return null;
  return { key: t.slice(0, m.index).trim(), rest: t.slice(m.index + 1).trim() };
}

/** The line without a comment: a `#` at its start or after a space, outside quotes. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote === '"') {
      if (c === '\\') i++;
      else if (c === '"') quote = null;
    } else if (quote === "'") {
      if (c === "'" && line[i + 1] === "'") i++;
      else if (c === "'") quote = null;
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:-]/.test(line[i - 1]!))) quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

/** A quoted scalar starting at `at`: its value and where it ends. Throws when nothing closes it. */
function quoted(text: string, at: number): { value: string; end: number } {
  const q = text[at]!;
  let out = '';
  for (let i = at + 1; i < text.length; i++) {
    const c = text[i]!;
    if (q === "'") {
      if (c === "'" && text[i + 1] === "'") {
        out += "'";
        i++;
      } else if (c === "'") return { value: out, end: i + 1 };
      else out += c;
      continue;
    }
    if (c === '"') return { value: out, end: i + 1 };
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = text[++i];
    const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', '\\': '\\', '/': '/', ' ': ' ', e: '\x1b', b: '\b', f: '\f' };
    if (e !== undefined && e in simple) out += simple[e];
    else if (e === 'x' || e === 'u' || e === 'U') {
      const n = e === 'x' ? 2 : e === 'u' ? 4 : 8;
      const hex = text.slice(i + 1, i + 1 + n);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== n) throw new YamlError('bad escape');
      out += String.fromCodePoint(parseInt(hex, 16));
      i += n;
    } else throw new YamlError('bad escape');
  }
  throw new YamlError('unclosed quote');
}

/** A plain scalar: true, false and null as YAML reads them, anything else the text itself. */
function plain(text: string): unknown {
  const t = text.trim();
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^(null|Null|NULL|~)?$/.test(t)) return null;
  if (/^[&*!]/.test(t)) throw new YamlError('anchors, aliases and tags are not read');
  return t;
}

/** A flow collection or scalar, `[a, "b", { c: d }]`, read from `text` at `at`. */
function flow(text: string, at: number): { value: unknown; end: number } {
  const skip = (i: number) => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    return i;
  };
  let i = skip(at);
  const c = text[i];
  if (c === '[' || c === '{') {
    const list = c === '[';
    const out: unknown[] = [];
    const map: Record<string, unknown> = {};
    i = skip(i + 1);
    while (text[i] !== (list ? ']' : '}')) {
      if (i >= text.length) throw new YamlError('unclosed flow collection');
      const key = flow(text, i);
      i = skip(key.end);
      if (!list || text[i] === ':') {
        if (text[i] !== ':') throw new YamlError('a flow mapping entry needs a value');
        const value = flow(text, i + 1);
        map[String(key.value)] = value.value;
        if (list) out.push({ [String(key.value)]: value.value });
        i = skip(value.end);
      } else out.push(key.value);
      if (text[i] === ',') i = skip(i + 1);
      else if (text[i] !== (list ? ']' : '}')) throw new YamlError('expected , in a flow collection');
    }
    return { value: list ? out : map, end: i + 1 };
  }
  if (c === '"' || c === "'") return quoted(text, i);
  let j = i;
  while (j < text.length && !/[,\]}]/.test(text[j]!) && !(text[j] === ':' && (j + 1 >= text.length || /[\s,\]}]/.test(text[j + 1]!)))) j++;
  return { value: plain(text.slice(i, j)), end: j };
}

/** Reads one value from a block of lines, as YAML's block context does. */
class Reader {
  private lines: Line[];
  private i = 0;
  constructor(raw: readonly string[]) {
    this.lines = raw.map((r) => {
      const indent = /^ */.exec(r)![0].length;
      if (r[indent] === '\t') throw new YamlError('a tab indents the line');
      return { indent, text: stripComment(r.slice(indent)), raw: r };
    });
  }

  /** The next line that holds anything, without taking it. */
  private peek(): Line | undefined {
    while (this.i < this.lines.length && this.lines[this.i]!.text === '') this.i++;
    return this.lines[this.i];
  }

  /** Every line was read. */
  end(): void {
    if (this.peek()) throw new YamlError('a line left over');
  }

  /** The value after a key or a dash (`rest`), its block below it, more indented than `indent`. */
  value(rest: string, indent: number): unknown {
    if (rest === '') {
      const next = this.peek();
      if (!next) return null;
      if (next.indent > indent) return this.node(next.indent);
      // A mapping's value may be a sequence at the key's own indentation.
      if (next.indent === indent && isDash(next.text)) return this.sequence(indent);
      return null;
    }
    if (/^[|>][-+0-9]*$/.test(rest)) return this.blockScalar(indent, rest[0] === '|');
    if (rest[0] === '[' || rest[0] === '{') {
      let text = rest;
      // A flow collection may go on over the lines below it.
      for (;;) {
        try {
          const r = flow(text, 0);
          if (text.slice(r.end).trim() !== '') throw new YamlError('text after a flow collection');
          return r.value;
        } catch (err) {
          const next = this.peek();
          if (!next || next.indent <= indent) throw err;
          text += ' ' + next.text;
          this.i++;
        }
      }
    }
    if (rest[0] === '"' || rest[0] === "'") {
      const r = quoted(rest, 0);
      if (rest.slice(r.end).trim() !== '') throw new YamlError('text after a quoted scalar');
      return r.value;
    }
    // A plain scalar may go on over the lines below it.
    let text = rest;
    for (let next = this.peek(); next && next.indent > indent && !splitKey(next.text) && !isDash(next.text); next = this.peek()) {
      text += ' ' + next.text;
      this.i++;
    }
    return plain(text);
  }

  private node(indent: number): unknown {
    const line = this.peek()!;
    if (isDash(line.text)) return this.sequence(indent);
    if (splitKey(line.text)) return this.mapping(indent);
    this.i++;
    return this.value(line.text, indent - 1);
  }

  private mapping(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (let line = this.peek(); line && line.indent === indent; line = this.peek()) {
      const kv = splitKey(line.text);
      if (!kv) throw new YamlError('expected a key');
      this.i++;
      out[kv.key] = this.value(kv.rest, indent);
    }
    const next = this.peek();
    if (next && next.indent > indent) throw new YamlError('a line indented past its mapping');
    return out;
  }

  private sequence(indent: number): unknown[] {
    const out: unknown[] = [];
    for (let line = this.peek(); line && line.indent === indent && isDash(line.text); line = this.peek()) {
      const rest = line.text.slice(1).trimStart();
      if (rest !== '' && splitKey(rest)) {
        // `- key: value` starts a mapping whose keys line up after the dash.
        const col = indent + line.text.length - rest.length;
        this.lines[this.i] = { indent: col, text: rest, raw: ' '.repeat(col) + rest };
        out.push(this.mapping(col));
        continue;
      }
      this.i++;
      out.push(this.value(rest, indent));
    }
    return out;
  }

  private blockScalar(indent: number, literal: boolean): string {
    const taken: string[] = [];
    let width: number | null = null;
    while (this.i < this.lines.length) {
      const line = this.lines[this.i]!;
      if (line.raw.trim() === '') {
        taken.push('');
        this.i++;
        continue;
      }
      if (line.indent <= indent) break;
      width ??= line.indent;
      taken.push(line.raw.slice(Math.min(width, line.indent)));
      this.i++;
    }
    while (taken.length && taken.at(-1) === '') taken.pop();
    return literal ? taken.join('\n') : taken.join(' ');
  }
}

const isDash = (text: string) => text === '-' || text.startsWith('- ');

