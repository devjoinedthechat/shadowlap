import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { truncate } from '../render.js';
import { useTheme } from '../theme.js';

/** A run of text in one style; color undefined is the terminal's own foreground. */
export interface Span {
  text: string;
  color?: string | undefined;
  bold?: boolean;
}

/** One column of a row: its spans cut to `width` less the gap after it, then padded to `width`. */
export interface Cell {
  spans: Span[];
  width: number;
  /** Columns left blank after the text, inside `width`. */
  gap?: number;
  align?: 'left' | 'right';
}

export function cell(text: string, width: number, style: Omit<Span, 'text'> = {}, gap = 1): Cell {
  return { spans: [{ text, ...style }], width, gap };
}

/** The selected row of the focused pane, the selected row of the other one, or neither. */
export type Selection = 'focus' | 'blur' | null;

/** The spans of a cell cut and padded to its width. */
function fit(c: Cell): Span[] {
  const room = Math.max(0, c.width - (c.gap ?? 1));
  const out: Span[] = [];
  let used = 0;
  for (const s of c.spans) {
    if (used >= room) break;
    const t = s.text.length > room - used ? truncate(s.text, room - used) : s.text;
    out.push({ ...s, text: t });
    used += t.length;
  }
  const pad = ' '.repeat(Math.max(0, c.width - used));
  if (c.align === 'right') return [{ text: pad }, ...out];
  return [...out, { text: pad }];
}

/**
 * One row of a list, exactly `width` wide, as one truncating Text: sibling Texts in a Box get
 * flex-shrunk by the layout engine when a row overflows, which silently drops the narrowest cells
 * first (the `>` that marks the selection, at 80 columns). The selected row is filled from edge to
 * edge, lime in the focused pane, as lazygit and k9s mark theirs; the `>` stays for a terminal
 * without colour.
 */
export function Row({ cells, width, selected = null }: { cells: Cell[]; width: number; selected?: Selection }) {
  const t = useTheme();
  const band = selected === 'focus';
  const bg = band ? t.band : selected === 'blur' ? t.selection : undefined;
  const spans = cells.filter((c) => c.width > 0).flatMap(fit);
  const used = spans.reduce((n, s) => n + s.text.length, 0);
  return (
    <Box height={1} width={width} flexShrink={0}>
      <Text wrap="truncate" {...(bg ? { backgroundColor: bg } : {})}>
        {spans.map((s, i) => {
          const color = band ? t.onBand : s.color;
          return (
            <Text key={i} {...(color ? { color } : {})} bold={band || s.bold === true}>
              {s.text}
            </Text>
          );
        })}
        {used < width ? ' '.repeat(width - used) : ''}
      </Text>
    </Box>
  );
}

/** A key and what it does, as the footer lists them. */
export type Hint = readonly [key: string, does: string];

/**
 * Key hints in at most `width` columns, as many whole hints as fit: the key in lime, what it does in
 * the secondary colour. The first hint is `? help`, so a narrow terminal still says where the rest are.
 */
export function KeyHints({ hints, width, lead }: { hints: readonly Hint[]; width: number; /** A state the keys act on, before them: `filter: live (28/30)`. */ lead?: string }) {
  const t = useTheme();
  const shown: Hint[] = [];
  let used = 1 + (lead ? lead.length + 2 : 0);
  for (const h of hints) {
    const w = h[0].length + 1 + h[1].length + (shown.length ? 2 : 0);
    if (used + w > width) break;
    shown.push(h);
    used += w;
  }
  return (
    <Box height={1} width={width} flexShrink={0}>
      <Text wrap="truncate">
        {' '}
        {lead ? <Text color={t.accent}>{`${lead}  `}</Text> : null}
        {shown.map(([k, d], i) => (
          <Text key={k}>
            {i ? '  ' : ''}
            <Text color={t.accent} bold>
              {k}
            </Text>
            <Text color={t.dim}> {d}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}

export type Tone = 'info' | 'ok' | 'warn' | 'err';

/** One line of text in a tone, cut to `width`: a message in the footer, a question, the detail line. */
export function Line({ children, width, tone, color }: { children: ReactNode; width: number; tone?: Tone; color?: string }) {
  const t = useTheme();
  const c = color ?? (tone === 'ok' ? t.ok : tone === 'warn' ? t.warn : tone === 'err' ? t.err : tone === 'info' ? undefined : t.dim);
  return (
    <Box height={1} width={width} flexShrink={0}>
      <Text wrap="truncate" {...(c ? { color: c } : {})}>
        {children}
      </Text>
    </Box>
  );
}
