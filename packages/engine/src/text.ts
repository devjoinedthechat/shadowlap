/**
 * Recorded strings (tool names, commands, model output, values from a pack someone sent) are
 * untrusted when they reach a terminal: an escape sequence in one can recolor, rewrite or clear the
 * screen, retitle the window, or write to the clipboard, and a format character can disguise what it
 * shows (a right-to-left override that reverses the text after it, a zero-width space, a line or
 * paragraph separator). Everything printed from a recording goes through this, which shows each of
 * them as a visible escape instead of sending it: C0 and C1 controls but tabs and line breaks,
 * Unicode's format characters (Cf) and its line and paragraph separators (Zl, Zp).
 */
const HIDDEN_EXCEPT_LAYOUT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu;

/** One hidden character as the escape that shows it: `\x1b`, `\u202e`, `\u{e0041}`. */
function escapeHidden(ch: string): string {
  const code = ch.codePointAt(0)!;
  if (code <= 0xff) return `\\x${code.toString(16).padStart(2, '0')}`;
  return code <= 0xffff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\u{${code.toString(16)}}`;
}

export function safeText(s: string): string {
  return s.replace(HIDDEN_EXCEPT_LAYOUT, escapeHidden);
}

/** For one-line fields: newlines, carriage returns and tabs are shown as escapes too. */
export function safeLine(s: string): string {
  return safeText(s).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

/** A recorded string's characters escaped for a terminal line: its controls (safeLine), and each `##[`, which a CI runner reads as a workflow command anywhere in a line it logs, written `#\x23[`. */
export function escapedInLine(s: string): string {
  return safeLine(s).replace(/##\[/g, '#\\x23[');
}

/**
 * A `::` that starts a line, white space before it or not, ahead of a command's name: a GitHub runner
 * reads that line as a workflow command (`::add-mask::`, `::stop-commands::`). IPv6's `::1` is none.
 */
const LEADING_COMMAND = /^(\s*)::(?=[A-Za-z])/;

/**
 * A recorded string for one terminal line: its control characters and each `##[` escaped
 * (escapedInLine), and a leading `::` before a command's name written `:\x3a`, as it may start the
 * line it is printed in.
 */
export function safe(s: string): string {
  return escapedInLine(s).replace(LEADING_COMMAND, '$1:\\x3a');
}

/**
 * Recorded text of several lines for a terminal and a CI log alike: each of its lines (a bare CR ends
 * one too) after `prefix`, escaped as a recorded string is, and the `::` of a line that would start
 * a workflow command written `:\x3a`. Behind a prefix that already keeps a line from starting one
 * (the bar what an agent printed is shown behind), its text is left as it was printed.
 */
export function safeLines(text: string, prefix: string): string {
  return `${text
    .split(/\r\n|\r|\n/)
    .map((l) => (prefix + escapedInLine(l)).replace(LEADING_COMMAND, '$1:\\x3a'))
    .join('\n')}\n`;
}

/** The last `lines` lines of what an agent printed, as `shadowlap test` prints them under a golden that failed; null for none. */
export function outputTail(output: string, lines = 20): string | null {
  const t = output.trim();
  return t ? t.split('\n').slice(-lines).join('\n') : null;
}

/** A hidden character as ANSI-C quotes write it: `\x1b` for ASCII, `\u202e` beyond it, `\U` and up to eight digits past U+FFFF. */
function ansiEscape(ch: string): string {
  const code = ch.codePointAt(0)!;
  if (code <= 0x7f) return `\\x${code.toString(16).padStart(2, '0')}`;
  return code <= 0xffff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\U${code.toString(16)}`;
}

/** A character a command line can't show as itself: a control but a tab or a line break, a format character, a line or paragraph separator. */
const HIDDEN_IN_WORD = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * A command line as a shell would need it typed: plain words bare, anything else in single quotes,
 * and a word holding a character that would hide or disguise what the line shows (a control, a
 * right-to-left override, a zero-width space) in ANSI-C quotes (`$'…'`), that character written as
 * its escape, so the line shows what runs and still runs it when typed. The CLI prints commands
 * with it, and the dashboard shows them the same way.
 */
export function quoteArgv(argv: readonly string[]): string {
  return argv
    .map((a) => {
      if (/^[\w@%+=:,./-]+$/.test(a)) return a;
      if (!HIDDEN_IN_WORD.test(a)) return `'${a.replace(/'/g, "'\\''")}'`;
      return `$'${a.replace(/[\\']/g, (c) => `\\${c}`).replace(new RegExp(HIDDEN_IN_WORD.source, 'gu'), ansiEscape)}'`;
    })
    .join(' ');
}

/** A colour's or a weight's escape (SGR): it takes no column. */
const SGR = /\x1b\[[0-9;]*m/g;
/**
 * What glues a command's words into one (`whole`), read as spaces once a line is laid out. No
 * recorded text holds it raw: safeLine shows it as an escape.
 */
const GLUE = '\u001f';
/** A flag and its quoted value, `--gate '{"good":0.3}'`: kept on one line, as it is typed. */
const QUOTED_FLAG = /--[a-z][a-z-]* '[^']*'/g;
/** A mark that leads a line, `! `, `✗ `, `· `: the lines it wraps to line up past it. */
const MARK = /^[^\p{L}\p{N}\s] /u;

/** A command, or a flag with its value, glued into one word that wrapping never breaks. */
export const whole = (words: string): string => words.replace(/ /g, GLUE);

const unglued = (text: string): string => text.replaceAll(GLUE, ' ');

/** Columns a text takes on a terminal: its colours' and weights' escapes take none. */
const columnsTaken = (text: string): number => text.replace(SGR, '').length;

/** Words wrapped to lines of at most `width` columns (a longer word has a line of its own), colours taking none and glued words kept together. */
export function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  let taken = 0;
  for (const word of text.split(' ')) {
    const w = columnsTaken(word);
    if (!line) {
      line = word;
      taken = w;
    } else if (taken + 1 + w > width) {
      lines.push(line);
      line = word;
      taken = w;
    } else {
      line = `${line} ${word}`;
      taken += 1 + w;
    }
  }
  if (line) lines.push(line);
  return lines.map(unglued);
}

/**
 * A line of prose after `indent`, fit to a terminal `columns` wide: its words wrapped to lines within
 * the width, each indented as the first, so the terminal never breaks a word in two. With no
 * `columns` (a pipe or a file, which wrap nothing), the one line as it is.
 */
export function fitLines(indent: string, text: string, columns: number | null | undefined): string[] {
  return (columns ? wrapWords(text.replace(QUOTED_FLAG, whole), Math.max(1, columns - indent.length)) : [unglued(text)]).map((line) => indent + line);
}

/** A row of a report: its head, then its text, which wraps at whole words to fit, the lines after the first under where it starts. */
export function fitRow(head: string, text: string, columns: number | null | undefined): string[] {
  const under = ' '.repeat(columnsTaken(head));
  return fitLines(under, text, columns).map((line, i) => (i ? line : head + line.slice(under.length)));
}

/**
 * A line as a terminal `columns` wide shows it whole: its words wrapped to lines within the width,
 * each indented as the line is, and past the mark that leads it (`! `, `✗ `), a colour carried on
 * as the terminal carries it. The one line as it is when it fits, and in a pipe or a file (no
 * `columns`), which wrap nothing.
 */
export function fitLine(line: string, columns: number | null | undefined): string[] {
  if (!columns || columnsTaken(unglued(line)) <= columns) return [unglued(line)];
  const [lead, sgr = '', indent = ''] = /^((?:\x1b\[[0-9;]*m)*)( *)/.exec(line)!;
  const rest = sgr + line.slice(lead.length);
  const under = MARK.test(rest.replace(SGR, '')) ? `${indent}  ` : indent;
  return wrapWords(rest.replace(QUOTED_FLAG, whole), Math.max(1, columns - under.length)).map((text, i) => (i ? under : indent) + text);
}

/**
 * A URL path segment decoded, as a provider reads it, or as it was sent when it doesn't decode
 * (`anthropic.claude%ZZ`): a malformed path names what it names as it stands.
 */
export function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Text percent-encoded as RFC 3986 has it, as an AWS signature encodes a request's path and query:
 * encodeURIComponent's encoding, with `!`, `'`, `(`, `)` and `*` encoded too.
 */
export const encodeRfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** A tool's name as a JavaScript string literal, in the single quotes the SDK's examples use. */
export const jsString = (name: string) => `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
