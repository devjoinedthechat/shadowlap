import type { Palette } from '@shadowlap/engine';
import { plain, safeLine } from '@shadowlap/engine';

const enabled = process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const wrap = (open: number, close: number) => (s: string) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const palette: Palette = enabled
  ? { green: wrap(32, 39), red: wrap(31, 39), yellow: wrap(33, 39), dim: wrap(2, 22), bold: wrap(1, 22), cyan: wrap(36, 39) }
  : plain;

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

/** A recorded string for one terminal line. */
export function safe(s: string): string {
  return safeLine(s);
}

/** A command line as a shell would need it typed: the engine's, so the CLI and the dashboard quote alike. */
export { quoteArgv } from '@shadowlap/engine';
