import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import type { CallRecord, DivergenceReport, Store } from '@shadowlap/engine';
import { estimateCost, formatDuration, formatTokens, formatUsd, normalizeResponse, type SummaryOptions } from '@shadowlap/engine';
import { conversationAt, loadRequest, loadResponseBytes } from '../data.js';
import { diffLines } from '../diff.js';
import { conversationLines, formatBytes, jsonLines, truncate, wrap, type RenderedLine } from '../render.js';
import { streamView } from '../sse.js';
import { useTheme, type Theme } from '../theme.js';

export type Tab = 'conversation' | 'request' | 'response' | 'meta' | 'diff';
export const TABS: Tab[] = ['conversation', 'request', 'response', 'meta'];

/** The tabs a run's inspector has: a fork's has its diff as well, fifth so the others keep their keys. */
export function tabsFor(divergence: DivergenceReport | null): Tab[] {
  return divergence ? [...TABS, 'diff'] : TABS;
}

/** Shorter names for a pane too narrow for the full ones. */
const SHORT: Record<Tab, string> = { conversation: 'chat', request: 'req', response: 'resp', meta: 'meta', diff: 'diff' };

export interface PlayState {
  playing: boolean;
  speed: number; // 0 = instant
  /** Stream deltas shown so far. */
  upto: number;
}

/** Where the inspector is scrolled, and how far it can go, for keys that move it by a line or a page. */
export interface InspectorView {
  offset: number;
  max: number;
  page: number;
}

interface Props {
  store: Store;
  calls: CallRecord[];
  index: number;
  tab: Tab;
  /** Lines scrolled from the top; null opens where the tab starts reading (a conversation's newest turns). */
  scroll: number | null;
  play: PlayState;
  onPlayTick: (next: PlayState) => void;
  width: number;
  height: number;
  focused?: boolean;
  /** The run's divergence, for the diff tab. */
  divergence?: DivergenceReport | null;
  /** Told where the view is after each render. */
  onView?: (view: InspectorView) => void;
  /** Price table and model resolver for the cost row of the meta tab. */
  summaryOptions?: SummaryOptions;
}

function metaLines(call: CallRecord, width: number, theme: Theme, options?: SummaryOptions): RenderedLine[] {
  const end = call.end;
  const model = end?.meta.model ?? call.meta.model ?? options?.modelOf?.(call) ?? null;
  const rows: Array<[string, string]> = [
    ['call', `#${call.callNo}  ${call.kind} ${call.name}`],
    ['origin', call.origin + (end?.meta.replayedFrom !== undefined ? `  (from parent call #${end.meta.replayedFrom})` : '')],
    ['outcome', end ? end.outcome + (end.meta.status ? `  HTTP ${end.meta.status}` : '') : 'pending'],
  ];
  if (typeof call.meta.scope === 'string') rows.push(['scope', call.meta.scope]);
  if (model) rows.push(['model', model]);
  if (end?.meta.stopReason) rows.push(['stop reason', end.meta.stopReason]);
  if (call.effect) rows.push(['effect', call.effect]);
  if (end?.meta.latencyMs !== undefined) rows.push(['latency', `${end.meta.latencyMs} ms`]);
  if (end?.meta.usage) {
    const u = end.meta.usage;
    rows.push([
      'usage',
      `${formatTokens(u.inputTokens)} in, ${formatTokens(u.outputTokens)} out` +
        (u.cacheReadInputTokens ? `, ${formatTokens(u.cacheReadInputTokens)} cache read` : '') +
        (u.cacheCreationInputTokens ? `, ${formatTokens(u.cacheCreationInputTokens)} cache write` : ''),
    ]);
    const usd = estimateCost(model, u, options?.prices);
    rows.push([
      'cost',
      usd === null
        ? `unknown: no price for ${model ?? 'this model'}; add one under "prices" in shadowlap.config.json`
        : `≈${formatUsd(usd)}` + (call.origin === 'replayed' ? '  not re-spent (served from the recording)' : call.origin === 'live' ? '  at list price' : ''),
    ]);
  }
  if (end?.meta.bytes !== undefined) rows.push(['size', formatBytes(end.meta.bytes)]);
  if (end?.meta.chunks?.length) rows.push(['stream', `${end.meta.chunks.length} events over ${end.meta.chunks[end.meta.chunks.length - 1]![1]} ms`]);
  if (call.attempts.length) rows.push(['attempts', `${call.attempts.length} retried (${call.attempts.map((a) => a.meta.status ?? a.outcome).join(', ')}) before the final outcome`]);
  rows.push(['occurrence', String(call.occurrence)], ['fingerprint', call.fingerprint.slice(0, 16) + '…']);
  if (call.meta.implHash) rows.push(['impl hash', String(call.meta.implHash).slice(0, 16) + '…']);
  if (end?.meta.error) rows.push(['error', `${end.meta.error.name}: ${end.meta.error.message}`]);
  const keyWidth = 12;
  const out: RenderedLine[] = rows.flatMap(([k, v]) => wrap(v, width - keyWidth - 1).map((line, i) => ({ text: (i === 0 ? k.padEnd(keyWidth) : ' '.repeat(keyWidth)) + ' ' + line })));
  // Response headers under a heading of their own: their names are longer than the column above.
  const headers = Object.entries(end?.meta.headers ?? {});
  if (headers.length) {
    out.push({ text: '' }, { text: 'response headers', role: 'label', head: true });
    for (const [k, v] of headers) for (const line of wrap(`${k}: ${v}`, width)) out.push({ text: line, color: theme.dim });
  }
  return out;
}

export function Inspector({ store, calls, index, tab, scroll, play, onPlayTick, width, height, focused = false, divergence = null, onView, summaryOptions }: Props) {
  const theme = useTheme();
  const call = calls[index];
  // Border (2) and a column of padding each side (2).
  const innerWidth = Math.max(16, width - 4);
  // Border (2) plus the tab row (1).
  const bodyHeight = Math.max(1, height - 3);

  const responseBytes = useMemo(() => (call ? loadResponseBytes(store, call) : null), [store, call]);
  // Any provider's stream becomes timed deltas, so play mode works the same for all of them.
  const response = useMemo(() => {
    const end = call?.end;
    if (!call || call.kind !== 'api' || !end) return null;
    const provider = end.meta.provider ?? call.meta.provider;
    return normalizeResponse(responseBytes, end.meta.headers?.['content-type'], end.meta.chunks ?? [], typeof provider === 'string' ? provider : undefined);
  }, [call, responseBytes]);
  const isSse = response?.kind === 'sse';
  const deltas = useMemo(() => response?.deltas ?? [], [response]);
  const events = deltas;

  // Play mode: advance through the stream at its recorded pacing.
  useEffect(() => {
    if (!play.playing || !isSse) return;
    if (play.upto >= events.length) {
      onPlayTick({ ...play, playing: false });
      return;
    }
    if (play.speed === 0) {
      // Instant: one jump to the end, not one re-render per event.
      onPlayTick({ ...play, playing: false, upto: events.length });
      return;
    }
    const at = (i: number) => deltas[Math.min(i, deltas.length - 1)]?.t ?? 0;
    const delay = play.speed === 0 ? 0 : Math.max(0, (at(play.upto) - (play.upto > 0 ? at(play.upto - 1) : 0)) / play.speed);
    const t = setTimeout(() => onPlayTick({ ...play, upto: play.upto + 1 }), Math.min(delay, 5000));
    return () => clearTimeout(t);
  }, [play, isSse, events.length, deltas, onPlayTick]);

  const [lines, setLines] = useState<RenderedLine[]>([]);
  // Where a tab starts reading when nothing has scrolled it: a conversation's first new turn.
  const [anchor, setAnchor] = useState(0);
  useEffect(() => {
    let next: RenderedLine[];
    let start = 0;
    if (tab === 'diff') {
      next = diffLines(divergence, innerWidth, theme);
    } else if (!call) {
      next = [];
    } else if (tab === 'conversation') {
      const conv = conversationAt(store, calls, index);
      if (conv) {
        const fresh = conv.freshFrom;
        const turns = conversationLines(conv.turns, innerWidth, fresh ?? Number.POSITIVE_INFINITY);
        const intro = `conversation as sent in call #${conv.fromCallNo}${fresh !== undefined && fresh < conv.turns.length ? ` · ${conv.turns.length - fresh} new since the last model call` : ''}`;
        next = [{ text: intro, role: 'label' }, { text: '' }, ...turns];
        // Opens with the first turn this call added at the top, the turns before it a scroll up.
        const first = next.findIndex((l) => l.fresh);
        start = first > 2 ? first : 0;
      } else next = [{ text: '(no model request before this call)', role: 'label' }];
    } else if (tab === 'request') {
      next = jsonLines(loadRequest(store, call), innerWidth).map((text) => ({ text }));
    } else if (tab === 'response') {
      if (!call.end) next = [{ text: '(pending)', role: 'label' }];
      else if (isSse) {
        // At rest the whole response shows; play mode starts it over from the first delta.
        const upto = play.playing || (play.upto > 0 && play.upto < events.length) ? play.upto : events.length;
        const v = streamView(deltas, upto);
        next = v.lines.flatMap((l) => wrap(l, innerWidth)).map((text) => ({ text }));
        const total = deltas.at(-1)?.t ?? 0;
        const now = upto > 0 ? (deltas[upto - 1]?.t ?? 0) : 0;
        const status = play.playing
          ? `▶ playing ${play.speed === 0 ? 'instantly' : `×${play.speed}`}  ${formatDuration(now)} of ${formatDuration(total)}`
          : upto < events.length
            ? `⏸ paused at ${formatDuration(now)} of ${formatDuration(total)}  (space to play)`
            : `■ ${response?.events ?? 0} events over ${formatDuration(total)}${v.stopReason ? ` · ended: ${v.stopReason}` : ''} · space plays`;
        next.unshift({ text: status, role: 'label' }, { text: '' });
      } else if (responseBytes) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(responseBytes.toString('utf8'));
        } catch {
          parsed = responseBytes.toString('utf8');
        }
        next = jsonLines(parsed, innerWidth).map((text) => ({ text }));
      } else next = [{ text: '(empty response)', role: 'label' }];
    } else {
      next = metaLines(call, innerWidth, theme, summaryOptions);
    }
    setLines(next);
    setAnchor(start);
  }, [store, calls, index, call, tab, innerWidth, isSse, events, deltas, response, play, responseBytes, summaryOptions, divergence, theme]);

  // A view opened at its anchor may end short of the pane's foot, so the newest turn heads it.
  const maxScroll = Math.max(0, lines.length - bodyHeight, Math.min(anchor, lines.length - 1));
  const offset = Math.max(0, Math.min(scroll ?? anchor, maxScroll));
  const visible = lines.slice(offset, offset + bodyHeight);
  useEffect(() => {
    onView?.({ offset, max: maxScroll, page: bodyHeight });
  }, [onView, offset, maxScroll, bodyHeight]);

  // The tab row: full names when they fit, short ones when they don't, and the line count after.
  const tabs = tabsFor(divergence);
  const position = lines.length > bodyHeight ? `${offset + 1}–${Math.min(lines.length, offset + bodyHeight)}/${lines.length}` : '';
  const full = tabs.reduce((n, t) => n + t.length + 2, 0);
  const short = tabs.reduce((n, t) => n + SHORT[t].length + 2, 0);
  // Full names, short ones, or in the narrowest pane only the open tab and which of them it is.
  const names: string[] = full + position.length + 2 <= innerWidth ? tabs : short + position.length + 2 <= innerWidth ? tabs.map((t) => SHORT[t]) : [];

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor={focused ? theme.accent : theme.faint} paddingX={1}>
      <Box height={1} flexShrink={0}>
        <Text wrap="truncate">
          {names.length ? (
            tabs.map((t, i) => (
              <Text key={t} {...(t === tab ? { backgroundColor: theme.band, color: theme.onBand, bold: true } : { color: theme.dim })}>
                {` ${names[i] ?? t} `}
              </Text>
            ))
          ) : (
            <Text>
              <Text backgroundColor={theme.band} color={theme.onBand} bold>{` ${SHORT[tab]} `}</Text>
              <Text color={theme.faint}>{` ${tabs.indexOf(tab) + 1}/${tabs.length}`}</Text>
            </Text>
          )}
          {position ? <Text color={theme.faint}>{`  ${position}`}</Text> : null}
        </Text>
      </Box>
      {visible.map((l, i) => {
        const text = truncate(l.text, innerWidth) || ' ';
        if (l.head && l.role !== 'label' && !l.color) {
          // A turn's name: bold, the system prompt's quieter, and a new turn says so in lime.
          return (
            <Text key={i} wrap="truncate">
              <Text bold {...(l.role === 'system' ? { color: theme.dim } : {})}>
                {text}
              </Text>
              {l.fresh ? <Text color={theme.accent}> · new</Text> : null}
            </Text>
          );
        }
        const color = l.color ?? (l.role === 'label' || l.aside ? theme.dim : undefined);
        return (
          <Text key={i} wrap="truncate" {...(color ? { color } : {})} bold={l.head === true}>
            {text}
          </Text>
        );
      })}
    </Box>
  );
}
