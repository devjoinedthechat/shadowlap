import { safeText, type Block, type Turn, type TurnBlock } from '@shadowlap/engine';
/** Text rendering helpers: wrapping, truncation, JSON and message content blocks as lines. */

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** East Asian Wide and Fullwidth: Hangul Jamo, CJK, kana, Hangul syllables, compatibility and fullwidth forms, the supplementary ideographs. */
const WIDE = /^[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F200}-\u{1F2FF}\u{20000}-\u{3FFFD}]/u;
const ZERO = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}]+$/u;
const PICTURE = /\p{Extended_Pictographic}/u;
const SHOWN_AS_EMOJI = /\p{Emoji_Presentation}|\uFE0F/u;

/** Columns one character (a grapheme cluster) takes: two for CJK and emoji, none for a mark or a control. */
function graphemeWidth(g: string): number {
  if (ZERO.test(g)) return 0;
  if (PICTURE.test(g) && SHOWN_AS_EMOJI.test(g)) return 2;
  return WIDE.test(g) ? 2 : 1;
}

/**
 * Columns a string takes in a terminal, as the layout engine counts them: two for CJK and emoji,
 * none for a combining mark, one for the rest. Measured here, with Node's own Unicode tables, so the
 * terminal UI brings nothing more from npm than Ink and React.
 */
export function cells(s: string): number {
  if (/^[\x20-\x7e]*$/.test(s)) return s.length;
  let w = 0;
  for (const { segment } of graphemes.segment(s)) w += graphemeWidth(segment);
  return w;
}

/** The longest start of `s` that fits in `width` columns, cut between whole characters. */
function fitCells(s: string, width: number): string {
  let out = '';
  let used = 0;
  for (const { segment } of graphemes.segment(s)) {
    const w = graphemeWidth(segment);
    if (used + w > width) break;
    out += segment;
    used += w;
  }
  return out;
}

/** `s` in at most `width` terminal columns, with `…` where it was cut; hidden characters shown as escapes. */
export function truncate(s: string, width: number): string {
  s = safeText(s);
  if (cells(s) <= width) return s;
  if (width <= 1) return fitCells(s, Math.max(0, width));
  return fitCells(s, width - 1) + '…';
}

/**
 * Items joined with ` · ` in at most `width` columns: as many whole items as fit, then ` · …` where
 * the rest are left out, so a line never ends inside a word. A first item too long by itself is cut.
 */
export function fitItems(items: readonly string[], width: number, sep = ' · '): string {
  const all = items.join(sep);
  if (cells(all) <= width) return all;
  const more = `${sep}…`;
  let shown = '';
  for (const item of items) {
    const next = shown ? `${shown}${sep}${item}` : item;
    if (cells(next) + more.length > width) break;
    shown = next;
  }
  return shown ? `${shown}${more}` : truncate(all, width);
}

/**
 * A list column: `min` wide (gap included), widened up to `max` when there is room (Infinity takes
 * whatever is left), and dropped in order of `drop`, highest first, when the row can't hold every column.
 */
export interface Column<K extends string = string> {
  key: K;
  min: number;
  max?: number;
  drop?: number;
}

/**
 * Widths for a row `width` columns wide. Columns with a `drop` go, highest first, until the rest
 * fit at their minimum; then what is left widens the columns in order, each up to its `max`. A
 * dropped column is 0 wide. Columns without `drop` always stay, so a list keeps its cursor, ids and
 * verdicts and loses its least telling columns first.
 */
export function fitColumns<K extends string>(columns: ReadonlyArray<Column<K>>, width: number): Record<K, number> {
  const kept = new Set(columns.map((c) => c.key));
  const need = () => columns.reduce((n, c) => n + (kept.has(c.key) ? c.min : 0), 0);
  for (const c of [...columns].filter((c) => c.drop !== undefined).sort((a, b) => b.drop! - a.drop!)) {
    if (need() <= width) break;
    kept.delete(c.key);
  }
  const out = Object.fromEntries(columns.map((c) => [c.key, kept.has(c.key) ? c.min : 0])) as Record<K, number>;
  let left = width - need();
  for (const c of columns) {
    if (left <= 0) break;
    if (!kept.has(c.key)) continue;
    const grow = Math.min(left, Math.max(0, (c.max ?? c.min) - c.min));
    out[c.key] += grow;
    left -= grow;
  }
  return out;
}

/** The longest prefix every id shares, which says nothing about which run is which: the list draws it faint. */
export function sharedPrefix(ids: readonly string[]): number {
  if (ids.length < 2) return 0;
  let n = 0;
  while (n < ids[0]!.length - 1 && ids.every((id) => id[n] === ids[0]![n])) n++;
  return n;
}

export function wrap(text: string, width: number): string[] {
  text = safeText(text);
  const w = Math.max(8, width);
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (cells(para) <= w) {
      out.push(para);
      continue;
    }
    // Indented lines (lists, code) keep their indentation on every wrapped line, within reason.
    const indent = /^\s*/.exec(para)![0].slice(0, Math.floor(w / 3));
    const inner = w - indent.length;
    let line = '';
    for (const word of para.trimStart().split(' ')) {
      if (cells(word) > inner) {
        if (line) out.push(indent + line);
        line = '';
        // A word wider than the line (a URL, a run of CJK) is cut between whole characters.
        for (let rest = word; rest; ) {
          const piece = fitCells(rest, inner) || [...rest][0]!;
          out.push(indent + piece);
          rest = rest.slice(piece.length);
        }
        continue;
      }
      if (cells((line + ' ' + word).trim()) > inner) {
        out.push(indent + line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) out.push(indent + line);
  }
  return out;
}

export function jsonLines(value: unknown, width: number, maxLines = 4000): string[] {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  const lines = text.split('\n').flatMap((l) => (cells(l) > width ? wrap(l, width) : [l]));
  return lines.length > maxLines ? [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`] : lines;
}

/** Lines of a tool result shown in a conversation; the request tab has all of it. */
export const RESULT_LINES = 16;

/**
 * A tool result's content as lines: JSON on one line is laid out as JSON, so a wrap never lands
 * inside a string, and a long result stops after RESULT_LINES with how many lines are left.
 */
function resultLines(head: string, content: string, width: number): string[] {
  const trimmed = content.trim();
  let parsed: unknown = undefined;
  if (!content.includes('\n') && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = undefined;
    }
  }
  const lines = typeof parsed === 'object' && parsed !== null ? [head, ...jsonLines(parsed, width)] : wrap(`${head} ${content}`, width);
  if (lines.length <= RESULT_LINES + 1) return lines;
  return [...lines.slice(0, RESULT_LINES), `… ${lines.length - RESULT_LINES} more lines in the request tab`];
}

/** Renders one block of a normalized conversation or response as lines. */
export function blockLines(b: TurnBlock | Block, width: number): string[] {
  switch (b.type) {
    case 'text':
      return wrap(b.text, width);
    case 'thinking':
      return 'redacted' in b && b.redacted ? ['💭 (redacted thinking)'] : wrap(`💭 ${b.text || '(thinking)'}`, width);
    case 'tool_call':
      // While a streamed call plays back, its input is still partial JSON text.
      return wrap(`⚙ ${b.name} ${typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {})}`, width);
    case 'tool_result':
      return resultLines(`${b.isError ? '↳ error result' : '↳ result'}${b.name ? ` from ${b.name}` : ''}:`, b.content, width);
    case 'other':
      return [`[${b.label}]`];
  }
}

export interface RenderedLine {
  text: string;
  /** `label` is the inspector's own words (what a tab shows, a status); the rest name a turn's role. */
  role?: 'system' | 'user' | 'assistant' | 'tool' | 'label';
  /** The line that names a turn (`user  #1`), drawn bold. */
  head?: boolean;
  /** A turn this call's request added since the model call before it. */
  fresh?: boolean;
  /** A tool call or result: secondary to what was said. */
  aside?: boolean;
  /** A colour of its own (a diff's removed and added lines), from the theme. */
  color?: string;
}

/**
 * Renders a conversation, whatever the provider, as role-labelled lines. System turns are not
 * numbered. Turns from `freshFrom` on are the ones this request added since the previous model
 * call's: they are marked, and the inspector opens on the first of them.
 */
export function conversationLines(turns: Turn[], width: number, freshFrom = Number.POSITIVE_INFINITY): RenderedLine[] {
  const out: RenderedLine[] = [];
  let n = 0;
  turns.forEach((turn, i) => {
    const fresh = i >= freshFrom;
    out.push({ text: turn.role === 'system' ? 'system' : `${turn.role}  #${++n}`, role: turn.role, head: true, ...(fresh ? { fresh } : {}) });
    for (const b of turn.blocks) {
      const aside = b.type === 'tool_call' || b.type === 'tool_result';
      for (const text of blockLines(b, width)) out.push({ text, role: turn.role, ...(aside ? { aside } : {}) });
    }
    out.push({ text: '' });
  });
  return out;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
