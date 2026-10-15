/**
 * Recorded strings (tool names, commands, model output, values from a pack someone sent) are
 * untrusted when they reach a terminal: an escape sequence in one can recolor, rewrite or clear the
 * screen, retitle the window, or write to the clipboard. Everything printed from a recording goes
 * through this, which shows control characters as visible escapes instead of sending them.
 */
const CONTROL_EXCEPT_LAYOUT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function safeText(s: string): string {
  return s.replace(CONTROL_EXCEPT_LAYOUT, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** For one-line fields: newlines, carriage returns and tabs are shown as escapes too. */
export function safeLine(s: string): string {
  return safeText(s).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

/**
 * A command line as a shell would need it typed: plain words bare, anything else in single quotes.
 * The CLI prints commands with it, and the dashboard shows them the same way.
 */
export function quoteArgv(argv: readonly string[]): string {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' ');
}
