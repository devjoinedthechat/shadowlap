/**
 * Python's repr() of a value, read back: None, True and False, ints and finite floats, strings,
 * lists, dicts with string keys, and an object pydantic prints as `Name(field=value, …)`, read as an
 * object of its fields. That is all a provider SDK's response objects hold once a JSON answer was read
 * into them, and how the Anthropic SDK prints one: str() of a TextBlock is
 * `TextBlock(citations=None, text='Hi', type='text')`.
 *
 * The reading is exact or nothing. Only the separators repr writes (`, `, `: `, `=`) and the escapes
 * it writes in a string (`\\`, `\'`, `\"`, `\n`, `\r`, `\t`, `\xhh`, `\uhhhh`, `\Uhhhhhhhh`) are taken,
 * the text must hold one value and nothing after it, and anything else (a tuple, a set, `nan`, a
 * string cut short) is no reading at all.
 */

/** Deeper than any answer a model writes, and shallow enough for the call stack. */
const MAX_DEPTH = 100;

class NotARepr extends Error {}

class Reader {
  at = 0;
  constructor(readonly text: string) {}

  fail(): never {
    throw new NotARepr();
  }

  take(token: string): boolean {
    if (!this.text.startsWith(token, this.at)) return false;
    this.at += token.length;
    return true;
  }

  expect(token: string): void {
    if (!this.take(token)) this.fail();
  }

  match(pattern: RegExp): string | null {
    pattern.lastIndex = this.at;
    const m = pattern.exec(this.text);
    if (!m) return null;
    this.at += m[0].length;
    return m[0];
  }

  value(depth: number): unknown {
    if (depth > MAX_DEPTH) this.fail();
    const c = this.text[this.at];
    if (c === "'" || c === '"') return this.string();
    if (c === '[') return this.list(depth);
    if (c === '{') return this.dict(depth);
    const number = this.match(/-?\d+(?:\.\d+)?(?:e[+-]\d+)?/y);
    if (number !== null) {
      const n = Number(number);
      return Number.isFinite(n) ? n : this.fail();
    }
    const name = this.match(/[A-Za-z_][A-Za-z0-9_]*/y);
    if (name === 'None') return null;
    if (name === 'True') return true;
    if (name === 'False') return false;
    // A class's name, as pydantic's are: Python's own types print in lower case (`set()`, `datetime.date(…)`).
    if (name !== null && /^[A-Z]/.test(name) && this.take('(')) return this.fields(depth);
    return this.fail();
  }

  /** `Name(field=value, …)`, after the parenthesis: the fields, as an object. */
  fields(depth: number): Record<string, unknown> {
    const entries: Array<[string, unknown]> = [];
    if (!this.take(')')) {
      do {
        const field = this.match(/[A-Za-z_][A-Za-z0-9_]*/y) ?? this.fail();
        this.expect('=');
        entries.push([field, this.value(depth + 1)]);
      } while (this.take(', '));
      this.expect(')');
    }
    // Built with fromEntries, so no field reaches a prototype.
    return Object.fromEntries(entries);
  }

  list(depth: number): unknown[] {
    this.expect('[');
    const items: unknown[] = [];
    if (this.take(']')) return items;
    do items.push(this.value(depth + 1));
    while (this.take(', '));
    this.expect(']');
    return items;
  }

  dict(depth: number): Record<string, unknown> {
    this.expect('{');
    const entries: Array<[string, unknown]> = [];
    if (!this.take('}')) {
      do {
        const quote = this.text[this.at];
        const key = quote === "'" || quote === '"' ? this.string() : this.fail();
        this.expect(': ');
        entries.push([key, this.value(depth + 1)]);
      } while (this.take(', '));
      this.expect('}');
    }
    return Object.fromEntries(entries);
  }

  string(): string {
    const quote = this.text[this.at++];
    let out = '';
    for (;;) {
      const c = this.text[this.at++];
      if (c === undefined) this.fail();
      if (c === quote) return out;
      // repr writes every control character as an escape.
      if (c < ' ' || c === '\u007f') this.fail();
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = this.text[this.at++];
      if (e === '\\' || e === "'" || e === '"') out += e;
      else if (e === 'n') out += '\n';
      else if (e === 'r') out += '\r';
      else if (e === 't') out += '\t';
      else if (e === 'x' || e === 'u' || e === 'U') {
        const digits = this.match(e === 'x' ? /[0-9a-f]{2}/y : e === 'u' ? /[0-9a-f]{4}/y : /[0-9a-f]{8}/y) ?? this.fail();
        const code = Number.parseInt(digits, 16);
        out += code > 0x10ffff ? this.fail() : String.fromCodePoint(code);
      } else this.fail();
    }
  }
}

/** The value a repr() wrote, or null when the text is not one value's repr, whole. */
export function readPythonRepr(text: string): { value: unknown } | null {
  const reader = new Reader(text);
  try {
    const value = reader.value(0);
    return reader.at === text.length ? { value } : null;
  } catch (err) {
    if (err instanceof NotARepr) return null;
    throw err;
  }
}
