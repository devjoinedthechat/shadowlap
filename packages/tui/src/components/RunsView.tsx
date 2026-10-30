import { Box, Text, useInput } from 'ink';
import { checksOf as engineChecksOf, failedChecks, formatDuration, formatUsd, lostAt, lostWords, markKey, messageOf, safeLine, type RunMark } from '@shadowlap/engine';
import { allPassed, attemptsText } from '../attempts.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RunNode } from '../data.js';
import { ago } from '../data.js';
import { fitColumns, fitItems, sharedPrefix } from '../render.js';
import { useTheme, type Theme } from '../theme.js';
import type { OpenDashboard } from './TimelineView.js';
import { copyToClipboard } from '../clipboard.js';
import type { RunAbout } from '@shadowlap/engine';
import { fitAbout } from '../about.js';
import { runSearch, type RunningSearch, type SearchResult } from '../search.js';
import { cell, KeyHints, Line, Row, type Hint, type Tone } from './Row.js';
import { SearchResults } from './SearchResults.js';
import { TextInput } from './TextInput.js';
import type { SpawnCli } from './TimelineView.js';
import type { Tab } from './Inspector.js';
import type { SearchHit } from '../search.js';

/** The inspector tab a search's match is on: what the call was asked, or what it answered. */
const FIELD_TAB: Record<SearchHit['field'], Tab> = { prompt: 'conversation', response: 'response', arguments: 'request', result: 'response' };

interface Props {
  nodes: RunNode[];
  width: number;
  height: number;
  /** Opens a run, at a call when given (a search's match). */
  onOpen: (runId: string, callNo?: number, tab?: Tab) => void;
  /** What a run was about, as the dashboard names it; without it, the command it ran. */
  aboutOf?: (n: RunNode) => Pick<RunAbout, 'text' | 'from'>;
  /** Runs `shadowlap search` for `s`; without it, `s` says to run it from the shell. */
  spawnCli?: SpawnCli;
  /** Deletes a run, with the attempts bundled under it; what it says back (why it didn't) is shown. */
  onDelete: (runId: string) => string | null | undefined;
  /** How many attempts are bundled under a run, which a delete takes with it: the confirm names them. */
  attemptsOf?: (runId: string) => number;
  onQuit: () => void;
  onHelp: () => void;
  openDashboard?: OpenDashboard;
  /** Help is open over it: it keeps its state and takes no keys. */
  paused?: boolean;
  /** Labels a run good or bad (`+`, `-`); says what it did. */
  onMark?: (runId: string, mark: RunMark) => string;
  /** Whether attempts are listed one by one, and the key that switches it (`a`). */
  attemptsShown?: boolean;
  onToggleAttempts?: () => void;
}

type Mode =
  | { kind: 'list' }
  | { kind: 'search'; before: string }
  | { kind: 'confirm-delete'; runId: string; attempts: number }
  /** Asking what to search for in what runs said; then the matches, null while the search runs. */
  | { kind: 'find' }
  | { kind: 'found'; query: string; result: SearchResult | null; token: number };

/**
 * `shadowlap test` checks as `✓ 3/3`, `✗ 2/3` or `? 1/2`: passed of those that applied, lime when
 * all passed, red when one failed, amber when one could not be decided; `–` when none applied.
 * Empty for a run that has none.
 */
function checksOf(run: RunNode['run'], theme: Theme): { text: string; color: string } | null {
  const n = engineChecksOf(run);
  if (!n) return null;
  const applied = n.total - (n.notApplicable ?? 0);
  if (!applied) return { text: '– 0/0', color: theme.dim };
  const failed = failedChecks(n) > 0;
  return { text: `${failed ? '✗' : n.inconclusive ? '?' : '✓'} ${n.passed}/${applied}`, color: failed ? theme.err : n.inconclusive ? theme.warn : theme.ok };
}

/** The confirm before `x` deletes a run, naming the attempts that go with it, as `rm` deletes them. */
export function deletePrompt(runId: string, attempts: number): string {
  const bundled = attempts ? `, the ${attempts === 1 ? 'attempt' : `${attempts} attempts`} bundled under it` : '';
  return `delete run ${runId.slice(0, 10)}${bundled} and ${attempts ? 'their' : 'its'} calls? forks keep their data but lose the link. y / n`;
}

/** The same question in fewer words, for a narrower terminal: the shortest that fits `width` is asked. */
export function fittedDeletePrompt(runId: string, attempts: number, width: number): string {
  const id = runId.slice(0, 10);
  const more = attempts ? ` and ${attempts} attempt${attempts === 1 ? '' : 's'}` : '';
  const asks = [deletePrompt(runId, attempts), `delete run ${id}${more}? its forks keep their data. y / n`, `delete ${id}${more}? y / n`];
  return asks.find((a) => a.length <= width) ?? asks.at(-1)!;
}

/** The footer's words for a run's checks: `checks 1/3 passed, 2 not applicable`, a check that did not apply never counted as passed. */
function checksLine(run: RunNode['run']): string {
  const n = engineChecksOf(run);
  if (!n) return '';
  return `checks ${n.passed}/${n.total} passed${n.inconclusive ? `, ${n.inconclusive} inconclusive` : ''}${n.notApplicable ? `, ${n.notApplicable} not applicable` : ''}`;
}

/** A run's status where it says something: a finished run needs no word, a failed one where blame found it lost (at a call, or gradually around two). */
function statusOf(n: RunNode): string {
  if (n.run.status === 'running') return n.interrupted ? 'interrupted' : 'recording';
  const lost = lostAt(n.run);
  if (lost !== null) return lostWords(lost, n.run.meta?.blame?.range);
  return n.run.status === 'completed' ? '' : n.run.status;
}

/** Everything about the selected run that the row has no room for, cut by whole items. */
function detailItems(n: RunNode): string[] {
  const r = n.run;
  return [
    r.runId,
    r.meta?.checks?.length ? checksLine(r) : '',
    r.meta?.covers?.length ? `partial: ${r.meta.covers.join('/')} only` : '',
    r.meta?.labels?.length ? r.meta.labels.join(', ') : '',
    n.attempts ? attemptsText(n.attempts) : '',
    r.meta?.notes?.length ? `${r.meta.notes.length} note${r.meta.notes.length === 1 ? '' : 's'}` : '',
    safeLine(r.command.argv.join(' ')),
    r.codeVersion ? `@${r.codeVersion}` : '',
    r.endedAt !== null ? formatDuration(r.endedAt - r.startedAt) : '',
    n.spent ? `≈${formatUsd(n.spent)} spent` : '',
    n.captured ? `≈${formatUsd(n.captured)} of traffic captured` : '',
    n.saved ? `${formatUsd(n.saved)} not re-spent` : '',
    r.divergence ? (r.divergence.type === 'ended_early' ? `ended early at #${r.divergence.callNo}` : `diverged at #${r.divergence.callNo} (${r.divergence.type})`) : '',
  ]
    .filter(Boolean)
    // From the recording, a pack or a teammate: shown with any escape sequence made visible.
    .map(safeLine);
}

const ID = 10;

export function RunsView({ nodes, width, height, onOpen, onDelete, attemptsOf, onQuit, onHelp, openDashboard, paused = false, onMark, attemptsShown = false, onToggleAttempts, aboutOf, spawnCli }: Props) {
  const theme = useTheme();
  const [query, setQuery] = useState('');
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return nodes;
    return nodes.filter(
      (n) =>
        n.run.runId.toLowerCase().startsWith(q) ||
        n.run.command.argv.join(' ').toLowerCase().includes(q) ||
        // What the row shows the run by: worked out once a run, and kept.
        (aboutOf?.(n).text.toLowerCase().includes(q) ?? false) ||
        (n.run.codeVersion ?? '').toLowerCase().includes(q) ||
        (n.run.meta?.labels ?? []).some((l) => l.toLowerCase().includes(q)),
    );
  }, [nodes, query, aboutOf]);
  const [toast, setToast] = useState<{ text: string; ms: number; tone: Tone } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.ms);
    return () => clearTimeout(t);
  }, [toast]);
  // The selected run, by its id: folding attempts in or out, a filter, or a run that finished moving
  // the rows never puts the cursor (and the next + or Enter) on another run.
  const [selectedId, setSelectedId] = useState<string | null>(() => nodes.at(-1)?.run.runId ?? null);
  const found = visible.findIndex((n) => n.run.runId === selectedId);
  const selected = found >= 0 ? found : Math.min(Math.max(0, visible.length - 1), 0);
  const move = (by: number | 'first' | 'last') =>
    setSelectedId((id) => {
      if (!visible.length) return id;
      const at = Math.max(0, visible.findIndex((n) => n.run.runId === id));
      const to = by === 'first' ? 0 : by === 'last' ? visible.length - 1 : Math.max(0, Math.min(visible.length - 1, at + by));
      return visible[to]!.run.runId;
    });
  const [mode, setMode] = useState<Mode>({ kind: 'list' });

  // The header, the list, the selected run's details, the footer.
  const rows = Math.max(1, height - 3);
  const start = Math.max(0, Math.min(selected - Math.floor(rows / 2), visible.length - rows));
  const shown = visible.slice(start, start + rows);
  const current = visible[selected];

  const toDashboard = (runId: string) => {
    if (!openDashboard) return setToast({ text: 'the dashboard is not available here; run shadowlap dashboard', ms: 2500, tone: 'warn' });
    setToast({ text: 'starting the dashboard…', ms: 10_000, tone: 'info' });
    openDashboard(runId).then(
      ({ url, opened }) => {
        if (opened) return setToast({ text: `opened ${runId.slice(0, 10)} in the dashboard`, ms: 2500, tone: 'ok' });
        void copyToClipboard(url).then((copied) => setToast({ text: `dashboard${copied ? ' (link copied)' : ''}: ${url}`, ms: 30_000, tone: 'info' }));
      },
      (err: unknown) => setToast({ text: `could not start the dashboard: ${messageOf(err)}`, ms: 8000, tone: 'err' }),
    );
  };

  useInput(
    (input, key) => {
      if (mode.kind === 'confirm-delete') {
        if (input === 'y' || input === 'Y') {
          const refused = onDelete(mode.runId);
          setToast(refused ? { text: refused, ms: 4000, tone: 'warn' } : { text: `deleted ${mode.runId.slice(0, 10)}`, ms: 2500, tone: 'ok' });
          setMode({ kind: 'list' });
        } else if (key.escape || input === 'n' || input === 'N' || input === 'q') setMode({ kind: 'list' });
        return;
      }
      if (key.escape) {
        if (query) setQuery('');
        else onQuit();
        return;
      }
      // Ctrl and Alt chords are none of these keys (Ctrl-G is not g).
      if (key.ctrl || key.meta) return;
      if (input === 'q') onQuit();
      else if (input === '?') onHelp();
      else if (input === '/') setMode({ kind: 'search', before: query });
      else if (input === 's') {
        if (spawnCli) setMode({ kind: 'find' });
        else setToast({ text: 'search what runs said with shadowlap search <words>', ms: 4000, tone: 'info' });
      }
      else if (key.downArrow || input === 'j') move(1);
      else if (key.upArrow || input === 'k') move(-1);
      else if (key.pageDown) move(rows);
      else if (key.pageUp) move(-rows);
      else if (input === 'g') move('first');
      else if (input === 'G') move('last');
      else if (key.return && current) onOpen(current.run.runId);
      else if (input === 'o' && current) toDashboard(current.run.runId);
      else if (input === 'x' && current) setMode({ kind: 'confirm-delete', runId: current.run.runId, attempts: attemptsOf?.(current.run.runId) ?? 0 });
      else if (input === 'a' && onToggleAttempts) {
        onToggleAttempts();
        setToast({ text: attemptsShown ? 'attempts folded under their runs' : 'attempts listed one by one; a folds them again', ms: 2500, tone: 'info' });
      } else if (markKey(input) && current && onMark) setToast({ text: onMark(current.run.runId, markKey(input)!), ms: 4000, tone: 'ok' });
    },
    { isActive: (mode.kind === 'list' || mode.kind === 'confirm-delete') && !paused },
  );

  // Columns sized to what the shown runs hold, then fitted to the width: the least telling go
  // first (cost, call count, labels, age), never the cursor, the id, what the run is or its checks.
  const indentOf = (n: RunNode) => (n.depth === 0 ? '' : '  '.repeat(n.depth - 1) + '\\_ ');
  const longest = (f: (n: RunNode) => string) => shown.reduce((m, n) => Math.max(m, f(n).length), 0);
  const costText = (n: RunNode) => (n.spent ? `≈${formatUsd(n.spent)}` : n.captured ? `≈${formatUsd(n.captured)}` : '');
  const labelsText = (n: RunNode) => (n.run.meta?.labels ?? []).join(' ');
  const checkW = longest((n) => checksOf(n.run, theme)?.text ?? '');
  const labelsW = longest(labelsText);
  const statusW = longest(statusOf);
  const attemptsW = longest((n) => (n.attempts ? attemptsText(n.attempts) : ''));
  const w = fitColumns(
    [
      { key: 'mark', min: 2 },
      { key: 'id', min: Math.min(24, longest((n) => indentOf(n) + 'x'.repeat(ID))) + 2 },
      { key: 'label', min: Math.min(16, longest((n) => n.label)) + 2 },
      // What the run was about, as the dashboard names it: after what it is, widened before the counts.
      { key: 'about', min: 14, max: 46 },
      { key: 'checks', min: checkW ? checkW + 2 : 0 },
      { key: 'status', min: statusW ? statusW + 2 : 0, drop: 1 },
      { key: 'labels', min: labelsW ? Math.min(labelsW, 10) + 2 : 0, max: labelsW ? Math.min(labelsW, 28) + 2 : 0, drop: 3 },
      { key: 'attempts', min: attemptsW ? attemptsW + 2 : 0, drop: 3.5 },
      { key: 'calls', min: longest((n) => `${n.calls} calls`) + 2, drop: 4 },
      { key: 'cost', min: longest(costText) ? longest(costText) + 2 : 0, drop: 5 },
      { key: 'age', min: longest((n) => ago(n.run.startedAt)) + 2, drop: 2 },

    ],
    width,
  );
  // The part of the ids every shown run shares (the day they were made, in a ULID) is drawn faint.
  const common = sharedPrefix(shown.map((n) => n.run.runId.slice(0, ID)));
  const count = `${visible.length}${query ? `/${nodes.length}` : ''} run${nodes.length === 1 ? '' : 's'}`;

  const anyAttempts = attemptsShown || nodes.some((n) => n.attempts);
  const all: Hint[] = [
        ['?', 'help'],
        ['enter', 'open'],
        ['/', 'filter'],
        ['s', 'search'],
        ['o', 'dashboard'],
        ['x', 'delete'],
        ['+ -', 'good/bad'],
        ['a', attemptsShown ? 'fold attempts' : 'attempts'],
        ['q', 'quit'],
      ];
  const hints: Hint[] = nodes.length
    ? all.filter(([k]) => k !== 'a' || anyAttempts)
    : [
        ['?', 'help'],
        ['q', 'quit'],
      ];

  // Searching what runs said: the CLI runs it in a process of its own, the keys still answered meanwhile.
  // One search at a time: a new one, leaving the results, or quitting stops the last if it still runs.
  const searching = useRef<RunningSearch | null>(null);
  const stopSearch = () => {
    searching.current?.stop();
    searching.current = null;
  };
  useEffect(() => stopSearch, []);
  const find = (q: string) => {
    stopSearch();
    if (!q.trim() || !spawnCli) return setMode({ kind: 'list' });
    const token = Date.now();
    setMode({ kind: 'found', query: q.trim(), result: null, token });
    const running = runSearch(spawnCli, q.trim());
    searching.current = running;
    void running.done.then((result) => setMode((m) => (m.kind === 'found' && m.token === token ? { ...m, result } : m)));
  };

  const footer =
    mode.kind === 'find' ? (
      <TextInput label="search what runs said:" placeholder='words, or "a phrase"' enterDoes="search" width={width} active onSubmit={find} onCancel={() => setMode({ kind: 'list' })} />
    ) : mode.kind === 'search' ? (
      <TextInput
        label="filter runs:"
        initial={query}
        placeholder="id, command, revision or label"
        enterDoes="keep"
        width={width}
        active
        onChange={(v) => setQuery(v.trim())}
        onSubmit={(v) => {
          setQuery(v.trim());
          setMode({ kind: 'list' });
        }}
        onCancel={() => {
          setQuery(mode.before);
          setMode({ kind: 'list' });
        }}
      />
    ) : mode.kind === 'confirm-delete' ? (
      <Line width={width} tone="err">
        {' '}
        {fittedDeletePrompt(mode.runId, mode.attempts, width - 1)}
      </Line>
    ) : toast ? (
      <Line width={width} tone={toast.tone}>
        {' '}
        {toast.text}
      </Line>
    ) : (
      <KeyHints hints={hints} width={width} />
    );

  if (mode.kind === 'found') {
    return (
      <SearchResults
        key={mode.token}
        query={mode.query}
        result={mode.result}
        width={width}
        height={height}
        active={!paused}
        onOpen={(runId, callNo, field) => {
          stopSearch();
          onOpen(runId, callNo, FIELD_TAB[field]);
        }}
        onAgain={() => setMode({ kind: 'find' })}
        onClose={() => {
          stopSearch();
          setMode({ kind: 'list' });
        }}
      />
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* One truncating Text with nested spans: sibling Texts get flex-shrunk on overflow and lose characters. */}
      <Box height={1}>
        <Text wrap="truncate">
          <Text backgroundColor={theme.band} color={theme.onBand} bold>
            {' shadowlap '}
          </Text>
          <Text color={theme.dim}> {count}</Text>
          {query ? <Text color={theme.dim}>{` · filter: ${query}`}</Text> : null}
        </Text>
      </Box>
      {nodes.length === 0 ? (
        <Box flexDirection="column" paddingX={2} paddingTop={1}>
          <Text wrap="truncate">Record a run of your agent, then replay it and fork it at any call.</Text>
          <Text> </Text>
          <Text wrap="truncate">
            <Text color={theme.accent}>{'shadowlap run -- node agent.js'.padEnd(32)}</Text>
            <Text color={theme.dim}>record your agent, whatever starts it</Text>
          </Text>
          <Text wrap="truncate">
            <Text color={theme.accent}>{'shadowlap demo'.padEnd(32)}</Text>
            <Text color={theme.dim}>or watch the whole loop on a sample agent</Text>
          </Text>
          <Text> </Text>
          <Text color={theme.dim} wrap="truncate">
            Runs show up here as they record.
          </Text>
        </Box>
      ) : visible.length === 0 ? (
        <Line width={width}> no runs match "{query}" · Esc clears</Line>
      ) : (
        shown.map((n, i) => {
          const sel = start + i === selected;
          const checks = checksOf(n.run, theme);
          const status = statusOf(n);
          const id = n.run.runId.slice(0, ID);
          const labelColor = n.run.divergence ? theme.accent : n.label === 'clean replay' ? theme.ok : undefined;
          return (
            <Row
              key={n.run.runId}
              width={width}
              selected={sel ? 'focus' : null}
              cells={[
                cell(sel ? '>' : '', w.mark),
                {
                  width: w.id,
                  gap: 2,
                  spans: [
                    { text: indentOf(n), color: theme.faint },
                    { text: id.slice(0, common), color: theme.faint },
                    { text: id.slice(common), bold: true },
                  ],
                },
                cell(n.label, w.label, labelColor ? { color: labelColor } : {}, 2),
                aboutOf ? cell(fitAbout(aboutOf(n), Math.max(1, w.about - 2)), w.about, {}, 2) : cell(n.run.command.argv.join(' '), w.about, { color: theme.faint }, 2),
                cell(checks?.text ?? '', w.checks, checks ? { color: checks.color } : {}, 2),
                cell(status, w.status, { color: status === 'recording' ? theme.warn : theme.err }, 2),
                cell(labelsText(n), w.labels, { color: theme.dim }, 2),
                cell(n.attempts ? attemptsText(n.attempts) : '', w.attempts, { color: n.attempts && !allPassed(n.attempts) ? theme.warn : theme.dim }, 2),
                cell(`${n.calls} calls`, w.calls, {}, 2),
                cell(costText(n), w.cost, { color: theme.dim }, 2),
                cell(ago(n.run.startedAt), w.age, { color: theme.dim }, 2),
              ]}
            />
          );
        })
      )}
      <Box flexGrow={1} />
      <Line width={width}>{current ? ` ${fitItems(detailItems(current), Math.max(0, width - 1))}` : ' '}</Line>
      {footer}
    </Box>
  );
}
