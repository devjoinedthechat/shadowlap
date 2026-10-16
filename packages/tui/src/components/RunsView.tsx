import { Box, Text, useInput } from 'ink';
import { formatDuration, formatUsd, safeLine } from '@shadowlap/engine';
import { useEffect, useMemo, useState } from 'react';
import type { RunNode } from '../data.js';
import { ago } from '../data.js';
import { truncate } from '../render.js';
import type { OpenDashboard } from './TimelineView.js';
import { copyToClipboard } from '../clipboard.js';
import { TextInput } from './TextInput.js';

interface Props {
  nodes: RunNode[];
  width: number;
  height: number;
  onOpen: (runId: string) => void;
  /** Deletes a run; what it says back (why it didn't) is shown. */
  onDelete: (runId: string) => string | null | void;
  onQuit: () => void;
  onHelp: () => void;
  openDashboard?: OpenDashboard;
}

type Mode = { kind: 'list' } | { kind: 'search' } | { kind: 'confirm-delete'; runId: string };

/** `shadowlap test` checks as `✓ 3/3` or `✗ 2/3`, empty for a run that has none. */
function checksOf(run: RunNode['run']): { text: string; ok: boolean } | null {
  const checks = run.meta?.checks;
  if (!checks?.length) return null;
  const passed = checks.filter((c) => c.ok).length;
  return { text: `${passed === checks.length ? '✓' : '✗'} ${passed}/${checks.length}`, ok: passed === checks.length };
}

export function RunsView({ nodes, width, height, onOpen, onDelete, onQuit, onHelp, openDashboard }: Props) {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return nodes;
    return nodes.filter(
      (n) =>
        n.run.runId.toLowerCase().startsWith(q) ||
        n.run.command.argv.join(' ').toLowerCase().includes(q) ||
        (n.run.codeVersion ?? '').toLowerCase().includes(q) ||
        (n.run.meta?.labels ?? []).some((l) => l.toLowerCase().includes(q)),
    );
  }, [nodes, query]);
  const [toast, setToast] = useState<{ text: string; ms: number } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.ms);
    return () => clearTimeout(t);
  }, [toast]);
  const [selected, setSelected] = useState(Math.max(0, nodes.length - 1));
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  useEffect(() => {
    if (selected > visible.length - 1) setSelected(Math.max(0, visible.length - 1));
  }, [visible.length, selected]);

  // Header, optional search line, the detail line at the bottom.
  const rows = Math.max(1, height - (mode.kind === 'search' ? 4 : 3));
  const start = Math.max(0, Math.min(selected - Math.floor(rows / 2), visible.length - rows));
  const shown = visible.slice(start, start + rows);
  const current = visible[selected];

  const toDashboard = (runId: string) => {
    if (!openDashboard) return setToast({ text: 'the dashboard is not available here; run shadowlap dashboard', ms: 2500 });
    setToast({ text: 'starting the dashboard…', ms: 10_000 });
    openDashboard(runId).then(
      ({ url, opened }) => {
        if (opened) return setToast({ text: `opened ${runId.slice(0, 10)} in the dashboard`, ms: 2500 });
        void copyToClipboard(url).then((copied) => setToast({ text: `dashboard${copied ? ' (link copied)' : ''}: ${url}`, ms: 30_000 }));
      },
      (err: unknown) => setToast({ text: `could not start the dashboard: ${err instanceof Error ? err.message : String(err)}`, ms: 8000 }),
    );
  };

  useInput(
    (input, key) => {
      if (mode.kind === 'confirm-delete') {
        if (input === 'y' || input === 'Y') {
          const refused = onDelete(mode.runId);
          if (refused) setToast({ text: refused, ms: 4000 });
          setMode({ kind: 'list' });
        } else if (key.escape || input === 'n' || input === 'N' || input === 'q') setMode({ kind: 'list' });
        return;
      }
      if (key.escape) {
        if (query) setQuery('');
        else onQuit();
      } else if (input === 'q') onQuit();
      else if (input === '?') onHelp();
      else if (input === '/') setMode({ kind: 'search' });
      else if (key.downArrow || input === 'j') setSelected((s) => Math.min(visible.length - 1, s + 1));
      else if (key.upArrow || input === 'k') setSelected((s) => Math.max(0, s - 1));
      else if (key.pageDown) setSelected((s) => Math.min(visible.length - 1, s + rows));
      else if (key.pageUp) setSelected((s) => Math.max(0, s - rows));
      else if (input === 'g') setSelected(0);
      else if (input === 'G') setSelected(Math.max(0, visible.length - 1));
      else if (key.return && current) onOpen(current.run.runId);
      else if (input === 'o' && current) toDashboard(current.run.runId);
      else if (input === 'x' && current) setMode({ kind: 'confirm-delete', runId: current.run.runId });
    },
    { isActive: mode.kind !== 'search' },
  );

  const idWidth = 26;
  const costWidth = 9;
  const fixed = 1 + idWidth + 14 + 11 + 11 + costWidth + 9;
  const cmdWidth = Math.max(0, width - fixed);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box>
        <Text bold> Shadowlap </Text>
        <Text color="gray">
          {visible.length}
          {query ? `/${nodes.length}` : ''} run{nodes.length === 1 ? '' : 's'} · Enter open · o dashboard · / search · x delete · ? help · q quit
        </Text>
      </Box>
      {mode.kind === 'search' ? (
        <Box paddingX={1}>
          <TextInput
            label="run id, command, revision or label contains:"
            initial={query}
            placeholder="agent.js"
            active
            onSubmit={(v) => {
              setQuery(v.trim());
              setSelected(0);
              setMode({ kind: 'list' });
            }}
            onCancel={() => setMode({ kind: 'list' })}
          />
        </Box>
      ) : null}
      {nodes.length === 0 ? (
        <Text color="gray"> no runs yet: shadowlap run -- {'<command>'}</Text>
      ) : visible.length === 0 ? (
        <Text color="gray"> no runs match "{query}" · Esc clears</Text>
      ) : (
        shown.map((n, i) => {
          const idx = start + i;
          const sel = idx === selected;
          const label = n.label;
          const labelColor = n.run.divergence ? 'yellow' : label === 'clean replay' ? 'cyan' : 'white';
          const status = n.run.status;
          const statusColor = status === 'completed' ? 'green' : status === 'running' ? 'yellow' : 'red';
          const indent = n.depth === 0 ? '' : '  '.repeat(n.depth - 1) + '\\_ ';
          // Check results and labels lead the command column: they are what the run is known by.
          const checks = checksOf(n.run);
          const labels = (n.run.meta?.labels ?? []).join(' ');
          const checksText = checks ? `${checks.text} ` : '';
          const labelsText = labels ? truncate(labels, Math.min(labels.length, Math.max(Math.floor(cmdWidth / 2), cmdWidth - checksText.length - 12))) + ' ' : '';
          const cmd = truncate(n.run.command.argv.join(' '), Math.max(0, cmdWidth - checksText.length - labelsText.length));
          return (
            <Box key={n.run.runId} height={1} flexShrink={0}>
              <Text inverse={sel}>{sel ? '>' : ' '}</Text>
              <Text bold={sel}>{truncate(` ${indent}${n.run.runId.slice(0, 10)}`, idWidth - 1).padEnd(idWidth)}</Text>
              <Text color={labelColor}>{label.padEnd(14).slice(0, 14)}</Text>
              <Text color={statusColor}>{(status === 'running' ? 'recording' : status).padEnd(11).slice(0, 11)}</Text>
              <Text>{`${n.calls} calls`.padEnd(11).slice(0, 11)}</Text>
              <Text color="gray">{(n.spent ? `≈${formatUsd(n.spent)}` : n.captured ? `≈${formatUsd(n.captured)} capt` : '').padEnd(costWidth).slice(0, costWidth)}</Text>
              <Text color="gray">{ago(n.run.startedAt).padEnd(9).slice(0, 9)}</Text>
              {checks && cmdWidth >= 6 ? <Text color={checks.ok ? 'green' : 'red'}>{checksText}</Text> : null}
              {labelsText && cmdWidth >= 12 ? <Text color="magenta">{labelsText}</Text> : null}
              {cmdWidth >= 6 ? <Text color="gray">{cmd}</Text> : null}
            </Box>
          );
        })
      )}
      <Box flexGrow={1} />
      {mode.kind === 'confirm-delete' ? (
        <Text color="red"> delete run {mode.runId.slice(0, 10)} and its calls? forks keep their data but lose the link. y / n</Text>
      ) : toast ? (
        <Text color="yellow" wrap="truncate">
          {' '}
          {toast.text}
        </Text>
      ) : current ? (
        <Text color="gray" wrap="truncate">
          {' '}
          {current.run.runId}
          {current.run.meta?.checks?.length ? ` · checks ${current.run.meta.checks.filter((c) => c.ok).length}/${current.run.meta.checks.length} passed` : ''}
          {current.run.meta?.covers?.length ? ` · partial: ${current.run.meta.covers.join('/')} only` : ''}
          {current.run.meta?.labels?.length ? ` · ${current.run.meta.labels.join(', ')}` : ''}
          {current.run.meta?.notes?.length ? ` · ${current.run.meta.notes.length} note${current.run.meta.notes.length === 1 ? '' : 's'}` : ''}
          {' · '}
          {safeLine(current.run.command.argv.join(' '))}
          {current.run.codeVersion ? ` · @${current.run.codeVersion}` : ''}
          {current.run.endedAt !== null ? ` · ${formatDuration(current.run.endedAt - current.run.startedAt)}` : ''}
          {current.spent ? ` · ≈${formatUsd(current.spent)} spent` : ''}
          {current.captured ? ` · ≈${formatUsd(current.captured)} of traffic captured` : ''}
          {current.saved ? ` · ${formatUsd(current.saved)} saved by replay` : ''}
          {current.run.divergence ? ` · diverged at #${current.run.divergence.callNo} (${current.run.divergence.type})` : ''}
        </Text>
      ) : (
        <Text> </Text>
      )}
    </Box>
  );
}
