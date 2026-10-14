import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import type { CallRecord, Store } from '@shadowlap/engine';
import { estimateCost, formatDuration, formatTokens, formatUsd, normalizeResponse, type SummaryOptions } from '@shadowlap/engine';
import { conversationAt, loadRequest, loadResponseBytes } from '../data.js';
import { conversationLines, formatBytes, jsonLines, truncate, wrap, type RenderedLine } from '../render.js';
import { streamView } from '../sse.js';
import { roleColor } from '../theme.js';

export type Tab = 'conversation' | 'request' | 'response' | 'meta';
export const TABS: Tab[] = ['conversation', 'request', 'response', 'meta'];

export interface PlayState {
  playing: boolean;
  speed: number; // 0 = instant
  /** Stream deltas shown so far. */
  upto: number;
}

interface Props {
  store: Store;
  calls: CallRecord[];
  index: number;
  tab: Tab;
  scroll: number;
  play: PlayState;
  onPlayTick: (next: PlayState) => void;
  width: number;
  height: number;
  focused?: boolean;
  /** Price table and model resolver for the cost row of the meta tab. */
  summaryOptions?: SummaryOptions;
}

function metaLines(call: CallRecord, width: number, options?: SummaryOptions): string[] {
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
      `${formatTokens(u.inputTokens)} in → ${formatTokens(u.outputTokens)} out` +
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
  if (end?.meta.headers) for (const [k, v] of Object.entries(end.meta.headers)) rows.push([`h: ${k}`, v]);
  const keyWidth = 12;
  return rows.flatMap(([k, v]) => wrap(v, width - keyWidth - 1).map((line, i) => (i === 0 ? k.padEnd(keyWidth) : ' '.repeat(keyWidth)) + ' ' + line));
}

export function Inspector({ store, calls, index, tab, scroll, play, onPlayTick, width, height, focused = false, summaryOptions }: Props) {
  const call = calls[index];
  const innerWidth = Math.max(20, width - 2);
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
  useEffect(() => {
    if (!call) {
      setLines([]);
      return;
    }
    let next: RenderedLine[] = [];
    if (tab === 'conversation') {
      const conv = conversationAt(store, calls, index);
      next = conv ? [{ text: `conversation as sent in call #${conv.fromCallNo}`, role: 'label' }, { text: '' }, ...conversationLines(conv.turns, innerWidth)] : [{ text: '(no model request before this call)', role: 'label' }];
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
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(responseBytes.toString('utf8'));
        } catch {
          parsed = responseBytes.toString('utf8');
        }
        next = jsonLines(parsed, innerWidth).map((text) => ({ text }));
      } else next = [{ text: '(empty response)', role: 'label' }];
    } else {
      next = metaLines(call, innerWidth, summaryOptions).map((text) => ({ text }));
    }
    setLines(next);
  }, [store, calls, index, call, tab, innerWidth, isSse, events, deltas, response, play, responseBytes, summaryOptions]);

  const maxScroll = Math.max(0, lines.length - bodyHeight);
  const offset = Math.min(scroll, maxScroll);
  const visible = lines.slice(offset, offset + bodyHeight);

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="single" borderColor={focused ? 'cyan' : 'gray'}>
      <Box height={1} flexShrink={0}>
        {TABS.map((t) => (
          <Text key={t} inverse={t === tab} {...(t === tab ? {} : { color: 'gray' })}>
            {` ${t} `}
          </Text>
        ))}
        <Text color="gray">{lines.length > bodyHeight ? `  ${offset + 1}–${Math.min(lines.length, offset + bodyHeight)}/${lines.length}` : ''}</Text>
      </Box>
      {visible.map((l, i) => (
        <Text key={i} wrap="truncate" {...(l.role && roleColor[l.role] ? { color: roleColor[l.role]! } : {})} bold={l.role === 'label'}>
          {truncate(l.text, innerWidth) || ' '}
        </Text>
      ))}
    </Box>
  );
}
