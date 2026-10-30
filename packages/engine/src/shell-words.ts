import { quoteArgv } from './text.js';

/**
 * A command line or a script read as a shell reads its words (POSIX sh, bash), for masking what is
 * in them (http.ts): where each word stands in the text and its value with the quotes taken off, so
 * a word that changes is written again in its place and every other character stays as it was.
 */

/** A word of a command line: where it starts and ends in the text, and its value as the shell reads it. */
export interface ShellWord {
  start: number;
  end: number;
  value: string;
}

/** What ends a word outside quotes: white space, and a character that starts an operator (`;`, `&`, `|`, `(`, `)`, `<`, `>`). */
const WORD_END = new Set([' ', '\t', '\n', '\r', ';', '&', '|', '(', ')', '<', '>']);

/** The characters ANSI-C quoting (`$'…'`) writes by a letter after a backslash, as bash reads them. */
const ANSI_LETTERS: Readonly<Record<string, string>> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
/** How many hex digits each of ANSI-C quoting's escapes by number reads, at most. */
const ANSI_HEX: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };

/** An escape inside `$'…'`, read from just past its backslash: the text it stands for, and where reading goes on. */
function ansiEscape(text: string, at: number): { text: string; next: number } {
  const c = text[at]!;
  if (Object.hasOwn(ANSI_LETTERS, c)) return { text: ANSI_LETTERS[c]!, next: at + 1 };
  const digits = Object.hasOwn(ANSI_HEX, c) ? ANSI_HEX[c]! : 0;
  if (digits) {
    let end = at + 1;
    while (end < text.length && end <= at + digits && /[0-9A-Fa-f]/.test(text[end]!)) end++;
    const code = parseInt(text.slice(at + 1, end), 16);
    if (end > at + 1 && code <= 0x10ffff) return { text: String.fromCodePoint(code), next: end };
  }
  // `\\`, `\'`, `\"`, `\?`, and any other character: itself.
  return { text: c, next: at + 1 };
}

/** The end of a quoted part that opens at `at` (`'…'`, `"…"`, `$'…'`), with its value; null when it is left open. */
function quoted(text: string, at: number): { value: string; next: number } | null {
  const c = text[at]!;
  if (c === "'") {
    const end = text.indexOf("'", at + 1);
    return end < 0 ? null : { value: text.slice(at + 1, end), next: end + 1 };
  }
  const ansi = c === '$';
  let value = '';
  for (let i = at + (ansi ? 2 : 1); i < text.length; ) {
    const d = text[i]!;
    if (d === (ansi ? "'" : '"')) return { value, next: i + 1 };
    if (d === '\\' && i + 1 < text.length) {
      if (ansi) {
        const e = ansiEscape(text, i + 1);
        value += e.text;
        i = e.next;
        continue;
      }
      // Inside "…" a backslash escapes only what it would otherwise end or expand.
      if ('"\\$`\n'.includes(text[i + 1]!)) {
        value += text[i + 1]!;
        i += 2;
        continue;
      }
    }
    value += d;
    i++;
  }
  return null;
}

/**
 * The words of a command line or a script as a shell reads them, in time linear in its length: white
 * space and an operator's characters part them outside quotes; `'…'` keeps what it holds, `"…"` too
 * but for what its backslashes escape, `$'…'` reads its escapes (`\n`, `\x1b`, `\u202e`), and a
 * backslash outside them keeps the character after it. Null when a quote is left open.
 */
export function shellWords(text: string): ShellWord[] | null {
  const words: ShellWord[] = [];
  let i = 0;
  while (i < text.length) {
    if (WORD_END.has(text[i]!)) {
      i++;
      continue;
    }
    const start = i;
    let value = '';
    while (i < text.length && !WORD_END.has(text[i]!)) {
      const c = text[i]!;
      if (c === "'" || c === '"' || (c === '$' && text[i + 1] === "'")) {
        const part = quoted(text, i);
        if (!part) return null;
        value += part.value;
        i = part.next;
      } else if (c === '\\' && i + 1 < text.length) {
        value += text[i + 1]!;
        i += 2;
      } else {
        value += c;
        i++;
      }
    }
    words.push({ start, end: i, value });
  }
  return words;
}

/** A word a shell reads as it is: nothing in it a shell would read as anything else. */
const PLAIN = /^[\w@%+=:,./-]+$/;
/** A word that assigns a shell variable (`API_KEY=…`), whose name and `=` must stay unquoted to assign one. */
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
/** What double quotes would not keep as it is: a quote, a backslash, an expansion's `$` or `` ` ``, history's `!`, a hidden character. */
const NOT_IN_DOUBLE = /["\\$`!\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * A word as a script holds it, to write in place of one: plain as it is, else in double quotes when
 * they keep it as it is (`"<CREDENTIAL>"`), else as quoteArgv quotes it. An assignment keeps its
 * name and `=` outside the quotes, so the script still assigns it; a word with white space in it,
 * a script handed on (`bash -c '…'`), is quoted whole.
 */
export function scriptWord(value: string): string {
  if (PLAIN.test(value)) return value;
  const name = /\s/.test(value) ? '' : (ASSIGNMENT.exec(value)?.[0] ?? '');
  const rest = value.slice(name.length);
  if (!rest) return name || "''";
  return `${name}${NOT_IN_DOUBLE.test(rest) ? quoteArgv([rest]) : `"${rest}"`}`;
}

/**
 * `text` with each word whose value changed written again in its place (`write` makes it), every
 * other character as it was: `values[k]` is `words[k]`'s value now. The same string when none changed.
 */
export function rewriteWords(text: string, words: readonly ShellWord[], values: readonly string[], write: (value: string) => string): string {
  const parts: string[] = [];
  let at = 0;
  words.forEach((w, k) => {
    if (values[k] === w.value) return;
    parts.push(text.slice(at, w.start), write(values[k]!));
    at = w.end;
  });
  return parts.length ? parts.join('') + text.slice(at) : text;
}
