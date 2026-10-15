/**
 * The command palette's matching: which items a query shows, in which order. No DOM here: the
 * tests import it. The palette itself is `shell/Palette.tsx`.
 */

export type PaletteGroup = 'This run' | 'Go to' | 'Actions' | 'Runs' | 'Fixes' | 'Tests' | 'Projects' | 'In recorded data';

export const GROUP_ORDER: readonly PaletteGroup[] = ['This run', 'Go to', 'Actions', 'Runs', 'Fixes', 'Tests', 'Projects', 'In recorded data'];

export interface PaletteEntry {
  group: PaletteGroup;
  label: string;
  hint: string;
}

/** With nothing typed: This run, Go to, Actions, this many of the newest runs, and Projects. */
export const EMPTY_RUNS = 5;
/** Typed items shown at most, before what runs recorded. */
export const MAX_ITEMS = 34;

export function words(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * The items a query shows. Every typed word must appear in the label or the hint. Groups keep their
 * order; within a group, a label that starts with the first word comes first, then one that
 * contains it, then the rest. Runs come in the order given (newest first).
 */
export function matchPalette<T extends PaletteEntry>(items: readonly T[], query: string, limit = MAX_ITEMS): T[] {
  const w = words(query);
  const order = (g: PaletteGroup) => GROUP_ORDER.indexOf(g);
  if (!w.length) {
    let runs = 0;
    return items
      .filter((x) => x.group !== 'Fixes' && x.group !== 'Tests' && x.group !== 'In recorded data' && (x.group !== 'Runs' || runs++ < EMPTY_RUNS))
      .map((x, i) => ({ x, i }))
      .sort((a, b) => order(a.x.group) - order(b.x.group) || a.i - b.i)
      .map((m) => m.x);
  }
  const first = w[0]!;
  return items
    .map((x, i) => {
      const label = x.label.toLowerCase();
      const hay = `${label} ${x.hint.toLowerCase()}`;
      if (!w.every((word) => hay.includes(word))) return null;
      return { x, i, score: label.startsWith(first) ? 0 : label.includes(first) ? 1 : 2 };
    })
    .filter((m): m is { x: T; i: number; score: number } => m !== null)
    .sort((a, b) => order(a.x.group) - order(b.x.group) || a.score - b.score || a.i - b.i)
    .slice(0, limit)
    .map((m) => m.x);
}

/** Recorded data is searched from this many characters. */
export const RECORDED_MIN_CHARS = 3;

/** Hits from what runs recorded: at most `max`, and at most `perRun` from any one run. */
export function limitRecorded<H extends { runId: string }>(hits: readonly H[], max = 6, perRun = 2): H[] {
  const seen = new Map<string, number>();
  const out: H[] = [];
  for (const h of hits) {
    if (out.length >= max) break;
    const n = seen.get(h.runId) ?? 0;
    if (n >= perRun) continue;
    seen.set(h.runId, n + 1);
    out.push(h);
  }
  return out;
}

/** The label split around the first typed word, for marking it; null when it does not contain it. */
export function highlight(label: string, query: string): [string, string, string] | null {
  const first = words(query)[0];
  if (!first) return null;
  const at = label.toLowerCase().indexOf(first);
  if (at < 0) return null;
  return [label.slice(0, at), label.slice(at, at + first.length), label.slice(at + first.length)];
}

/** A search snippet's text, with the server's match markers (\u0001 … \u0002) taken out and the matches returned. */
export function snippetParts(snippet: string): Array<{ text: string; match: boolean }> {
  const out: Array<{ text: string; match: boolean }> = [];
  const flat = snippet.replace(/\s+/g, ' ');
  const re = /\u0001([^\u0002]*)\u0002/g;
  let last = 0;
  for (let m = re.exec(flat); m; m = re.exec(flat)) {
    if (m.index > last) out.push({ text: flat.slice(last, m.index), match: false });
    out.push({ text: m[1] ?? '', match: true });
    last = m.index + m[0].length;
  }
  if (last < flat.length) out.push({ text: flat.slice(last), match: false });
  return out;
}
