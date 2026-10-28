import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { safeLine } from '@shadowlap/engine';
import { ago } from '../data.js';
import { fitColumns } from '../render.js';
import { queryTerms, SEARCH_LIMIT, type SearchHit, type SearchResult } from '../search.js';
import { useTheme } from '../theme.js';
import { cell, KeyHints, Line, Row, type Span } from './Row.js';

interface Props {
  query: string;
  /** Null while the search runs. */
  result: SearchResult | null;
  width: number;
  height: number;
  active: boolean;
  /** Opens the run at the call, on the tab where the match is. */
  onOpen: (runId: string, callNo: number, field: SearchHit['field']) => void;
  onAgain: () => void;
  onClose: () => void;
}

/** A snippet with each searched word, or quoted phrase, marked where it appears. */
export function markTerms(snippet: string, terms: readonly string[], color: string): Span[] {
  const text = snippet.replace(/\s+/g, ' ');
  const lower = text.toLowerCase();
  const spans: Span[] = [];
  let i = 0;
  while (i < text.length) {
    let at = -1;
    let len = 0;
    for (const t of terms) {
      const j = t ? lower.indexOf(t, i) : -1;
      if (j >= 0 && (at < 0 || j < at)) [at, len] = [j, t.length];
    }
    if (at < 0) {
      spans.push({ text: text.slice(i) });
      break;
    }
    if (at > i) spans.push({ text: text.slice(i, at) });
    spans.push({ text: text.slice(at, at + len), color, bold: true });
    i = at + len;
  }
  return spans;
}

/**
 * What `s` found in what runs said, one match a row: the run, the call, where in it, and the text
 * around the match. Enter opens the run at that call, as `shadowlap ui <run> --call <n>` would.
 */
export function SearchResults({ query, result, width, height, active, onOpen, onAgain, onClose }: Props) {
  const theme = useTheme();
  const [at, setAt] = useState(0);
  const hits: SearchHit[] = result && 'hits' in result ? result.hits : [];
  const rows = Math.max(1, height - 3);
  useInput(
    (input, key) => {
      if (key.escape || input === 'q') return onClose();
      if (input === 's') return onAgain();
      const last = Math.max(0, hits.length - 1);
      if (key.downArrow || input === 'j') setAt((a) => Math.min(last, a + 1));
      else if (key.upArrow || input === 'k') setAt((a) => Math.max(0, a - 1));
      else if (key.pageDown) setAt((a) => Math.min(last, a + rows));
      else if (key.pageUp) setAt((a) => Math.max(0, a - rows));
      else if (input === 'g') setAt(0);
      else if (input === 'G') setAt(last);
      else if (key.return && hits[at]) onOpen(hits[at].runId, hits[at].callNo, hits[at].field);
    },
    { isActive: active },
  );
  const terms = queryTerms(query);
  const start = Math.max(0, Math.min(at - Math.floor(rows / 2), hits.length - rows));
  const w = fitColumns(
    [
      { key: 'mark', min: 2 },
      { key: 'run', min: 12 },
      { key: 'call', min: Math.max(...hits.map((h) => String(h.callNo).length), 1) + 3 },
      { key: 'name', min: 8, max: 18, drop: 2 },
      { key: 'field', min: 11, drop: 1 },
      { key: 'snippet', min: 10, max: Number.POSITIVE_INFINITY },
    ],
    width,
  );
  const asked = query.includes('"') ? query : `“${query}”`;
  const found = result === null ? `searching ${asked}…` : 'error' in result ? `search for ${asked} failed` : `${hits.length}${hits.length === SEARCH_LIMIT ? '+' : ''} match${hits.length === 1 ? '' : 'es'} for ${asked}`;
  const hit = hits[at];
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box height={1}>
        <Text wrap="truncate">
          <Text backgroundColor={theme.band} color={theme.onBand} bold>
            {' shadowlap '}
          </Text>
          <Text color={theme.dim}> {found}</Text>
        </Text>
      </Box>
      {result === null ? (
        <Line width={width}> The first search indexes every run in the store; later ones read only what changed.</Line>
      ) : 'error' in result ? (
        <Line width={width} tone="err">
          {' '}
          {safeLine(result.error)}
        </Line>
      ) : !hits.length ? (
        <Line width={width}> Nothing recorded says that. Every word must appear; “quoted words” together. s searches again.</Line>
      ) : (
        hits.slice(start, start + rows).map((h, i) => (
          <Row
            key={`${h.runId}:${h.callNo}:${h.field}:${start + i}`}
            width={width}
            selected={start + i === at ? 'focus' : null}
            cells={[
              cell(start + i === at ? '>' : '', w.mark),
              cell(h.runId.slice(0, 10), w.run, { bold: true }, 2),
              cell(`#${h.callNo}`, w.call, {}, 2),
              cell(h.name, w.name, { color: theme.dim }, 2),
              cell(h.field, w.field, { color: theme.dim }, 2),
              { spans: markTerms(h.snippet, terms, theme.accent), width: w.snippet, gap: 0 },
            ]}
          />
        ))
      )}
      <Box flexGrow={1} />
      <Line width={width}>{hit ? ` ${safeLine(`${hit.runId} · #${hit.callNo} ${hit.kind} ${hit.name} · ${hit.field}`)} · ${ago(hit.runStartedAt)}` : ' '}</Line>
      <KeyHints
        hints={[
          ['enter', 'open at the call'],
          ['j/k', 'move'],
          ['s', 'search again'],
          ['esc', 'back to the runs'],
        ]}
        width={width}
      />
    </Box>
  );
}
