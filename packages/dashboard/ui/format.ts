/**
 * Formatting for the dashboard: money, tokens, durations, ids, times and paths. No DOM here: the
 * tests import it.
 */
export { formatDuration, formatUsd, shortModel } from '../../engine/src/prices.js';
export { shortCallName as callName } from '../../engine/src/labels.js';
import { formatTokens } from '../../engine/src/tokens.js';
import { twoDigits as pad } from '../../engine/src/words.js';

/** Dollars as the mock writes them: up to four decimals below a cent, trailing zeros dropped. */
export function money(v: number): string {
  if (!v) return '$0';
  const s = v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2);
  return `$${s.replace(/0+$/, '').replace(/\.$/, '')}`;
}

export function cents(v: number): string {
  return `$${v.toFixed(2)}`;
}

/**
 * An estimate, as the CLI prints one: four decimals below a cent, as `money` writes a captured cost
 * beside it, three below a dollar, then two. Spend too small for four decimals reads "<$0.0001",
 * never "≈$0.000".
 */
export function approx(v: number): string {
  if (!v) return '$0';
  if (v < 0.00005) return '<$0.0001';
  return `≈$${v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2)}`;
}

/** A token count as the CLI writes it too (`1.8k`, `1.23M`): one formatter, so the page and `show` agree. */
export const ktok = (v: number): string => formatTokens(v);

/** A call's duration: 840 ms, 2.9 s, 1m 4s. */
export function dur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** A longer span, rounded: 24s, 28m, 1h 5m. */
export function durLong(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  if (m >= 1) return `${m}m`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * A receipt's time, such as the time a replay did not wait: a short one as a call's duration (340
 * ms, 2.9 s), so a replay of quick calls does not read "0s"; a long one rounded (28m, 1h 5m).
 */
export function receiptDuration(ms: number): string {
  return ms < 60_000 ? dur(ms) : durLong(ms);
}

export function num(n: number): string {
  return n >= 1000 ? n.toLocaleString('en-US') : String(n);
}

/** "1 call", "3 calls". */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${num(n)} ${n === 1 ? word : many}`;
}

/** The id the CLI prints and accepts: the first ten characters of a run's ULID. */
export const shortId = (id: string): string => id.slice(0, 10);

/** Whether a run id as typed or linked (the full id, or its first characters in either case) names this run. */
export function sameRun(asked: string, runId: string): boolean {
  return asked.length > 0 && runId.toUpperCase().startsWith(asked.toUpperCase());
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 09:41, local time. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** When a run started, in a list: now, 09:58 today, Sep 30 before that. */
export function whenShort(ms: number, now = Date.now()): string {
  if (now - ms < 60_000 && now >= ms) return 'now';
  const d = new Date(ms);
  const t = new Date(now);
  if (d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate()) return clock(ms);
  return `${MONTHS[d.getMonth()]!} ${d.getDate()}`;
}

/** Oct 1, 09:41:07, local time. */
export function stamp(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]!} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 2026-10-01 09:41:07 UTC: for a record, where the reader's time zone must not matter. */
export function utcStamp(ms: number): string {
  return `${new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')} UTC`;
}

/** The day, for a copy that may be read long after it was made. */
export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A home folder shortened to ~, as a terminal shows it. */
export function tildePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~');
}

/** A path short enough for a label: ~ for the home folder, then only its last folders past `max` characters. */
export function compactPath(path: string, max = 36): string {
  const p = tildePath(path);
  if (p.length <= max) return p;
  const parts = p.split(/[\\/]/).filter(Boolean);
  let out = parts[parts.length - 1] ?? p;
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = `${parts[i]!}/${out}`;
    if (next.length + 2 > max) break;
    out = next;
  }
  return `…/${out}`;
}

/** The folder a store sits in: `<project>/.shadowlap/shadowlap.db` gives `<project>`. */
export function projectOfStore(dbPath: string): { name: string; path: string } | null {
  const parts = dbPath.split(/[\\/]/);
  const at = parts.lastIndexOf('.shadowlap');
  if (at <= 0) return null;
  const path = parts.slice(0, at).join(dbPath.includes('\\') && !dbPath.includes('/') ? '\\' : '/');
  const name = parts[at - 1] ?? '';
  return name ? { name, path } : null;
}

/** A call's fingerprint as the inspector shows it, `sha256:30350c36c41e6a18`; the whole hash is on hover. */
export function shortFingerprint(fp: string): string {
  const m = /^(?:sha256:)?([0-9a-f]{64})$/i.exec(fp);
  return m ? `sha256:${m[1]!.slice(0, 16)}` : fp;
}

/** A stored blob's hash, short enough for a table cell: its first 24 characters. */
export function shortHash(hash: string): string {
  return hash.length > 24 ? hash.slice(0, 24) : hash;
}

/** api, tool, clk, rnd: a call's kind in four characters or fewer. */
export function kindShort(kind: string): string {
  return kind === 'clock' ? 'clk' : kind === 'random' ? 'rnd' : kind;
}

export function jsonText(value: unknown, pretty = true): string {
  if (typeof value === 'string') return value;
  return (pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)) ?? String(value);
}

/** One line, cut with an ellipsis. */
export function oneLine(s: string, max = 120): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A separator held to the item before it by a no-break space, so a wrapped line never starts with one. */
export const GLUED_SEPARATOR = '\u00a0· ';

/** Items joined by ` · ` as a line that wraps only after a separator's space, never before its dot. */
export const glued = (text: string): string => text.replaceAll(' · ', GLUED_SEPARATOR);

/** A count kept with its unit where a line wraps, as a tally is: "1 time", "2 times (2 blocked)", "3 calls" never part. */
export const wholeCounts = (text: string): string => text.replace(/(\d) (?=(?:times?|calls?|attempts?|blocked|stubbed)\b)/g, '$1\u00a0');

/**
 * A command line's words, split at the spaces a shell splits at (outside '…' and "…"), each kept
 * with its quotes: what a command line on the page wraps between, so a flag and its value or a
 * quoted header never break inside.
 */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: string | null = null;
  let escaped = false;
  for (const c of line) {
    if (escaped) {
      word += c;
      escaped = false;
    } else if (quote) {
      word += c;
      if (c === quote) quote = null;
    } else if (c === '\\') {
      word += c;
      escaped = true;
    } else if (c === ' ') {
      if (word) words.push(word);
      word = '';
    } else {
      word += c;
      if (c === "'" || c === '"') quote = c;
    }
  }
  if (word) words.push(word);
  return words;
}

export function clip(s: string, max = 1500): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** A string that is a JSON object or array, parsed; anything else is left alone. */
export function asJson(text: string): unknown {
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
  try {
    const v: unknown = JSON.parse(t);
    return v !== null && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}
