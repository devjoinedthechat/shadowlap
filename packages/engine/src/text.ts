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
