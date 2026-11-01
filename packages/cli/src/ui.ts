import type { Palette } from '@shadowlap/engine';
import { plain, safeLine } from '@shadowlap/engine';

const enabled = process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const wrap = (open: number, close: number) => (s: string) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const palette: Palette = enabled
  ? { green: wrap(32, 39), red: wrap(31, 39), yellow: wrap(33, 39), dim: wrap(2, 22), bold: wrap(1, 22), cyan: wrap(36, 39) }
  : plain;

/** The columns of the terminal `stream` writes to, which a dim line of prose is fit to (`dimLines`); null for a pipe or a file, which wrap nothing. */
export function columnsOf(stream: NodeJS.WriteStream): number | null {
  return stream.isTTY === true && stream.columns > 0 ? stream.columns : null;
}

export function shortId(id: string, n = 10): string {
  return id.length > n ? id.slice(0, n) : id;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

export function table(rows: string[][], indent = ''): string {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)));
  return rows.map((r) => indent + r.map((c, i) => (i === r.length - 1 ? c : pad(c, widths[i] ?? 0))).join('  ').trimEnd()).join('\n');
}

/** A folder's path with a separator after it, so it reads as a folder in a sentence: `goldens/`. */
export function folder(path: string): string {
  return /[\\/]$/.test(path) ? path : `${path}/`;
}

/**
 * A head and the clauses after it, joined with commas and broken before a line passes `width`
 * columns, the lines after the first indented by two: `✓ fx-01K5CQ2E8M applied: the patch is in the
 * working tree,` then `  2 of 2 goldens copied to goldens/, shadowlap test passed`.
 */
export function clauses(head: string, parts: readonly string[], width = 80): string {
  const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
  const lines = [`${head}${parts[0] ?? ''}`];
  for (const part of parts.slice(1)) {
    const last = lines.length - 1;
    const line = lines[last]!;
    if (visible(`${line}, ${part}`) <= width) lines[last] = `${line}, ${part}`;
    else {
      lines[last] = `${line},`;
      lines.push(`  ${part}`);
    }
  }
  return lines.join('\n');
}

/** A recorded string's characters escaped for a terminal line: its controls (safeLine), and each `##[`, which a CI runner reads as a workflow command anywhere in a line it logs, written `#\x23[`. */
function escapedInLine(s: string): string {
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

/** A command line as a shell would need it typed: the engine's, so the CLI and the dashboard quote alike. */
export { quoteArgv } from '@shadowlap/engine';
