import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { fitColumns, truncate } from '../render.js';
import { useTheme } from '../theme.js';
import { cell, Row } from './Row.js';

export { actionContext, buildActions, forkMenuTitle, notRun, recordingNow, terminalActions, type Action } from '../actions.js';
import type { Action } from '../actions.js';

interface Props {
  actions: Action[];
  /** The header: `At #19 · search_web · read tool`. */
  title?: string;
  width: number;
  height: number;
  active: boolean;
  cliAvailable: boolean;
  onPick: (action: Action) => void;
  onClose: () => void;
}

/** The fork menu's order: the call's actions, then the whole run's, then the rest. */
export function menuOrder(actions: Action[]): Array<{ section: string | null; actions: Action[] }> {
  return [
    { section: null, actions: actions.filter((a) => a.group === 'call') },
    { section: 'The whole run', actions: actions.filter((a) => a.group === 'run') },
    { section: '', actions: actions.filter((a) => !a.group) },
  ].filter((s) => s.actions.length > 0);
}

export function ActionsView({ actions, title, width, height, active, cliAvailable, onPick, onClose }: Props) {
  const theme = useTheme();
  const sections = menuOrder(actions);
  const ordered = sections.flatMap((s) => s.actions);
  const [selected, setSelected] = useState(0);
  useInput(
    (input, key) => {
      if (key.escape || input === ':' || input === 'q') onClose();
      else if (key.downArrow || input === 'j') setSelected((s) => Math.min(ordered.length - 1, s + 1));
      else if (key.upArrow || input === 'k') setSelected((s) => Math.max(0, s - 1));
      else if (key.return && ordered[selected]) onPick(ordered[selected]);
      else {
        const hit = ordered.find((a) => a.key === input);
        if (hit) onPick(hit);
      }
    },
    { isActive: active },
  );
  const inner = Math.max(20, width - 4);
  // Each line carries its flag on the right, the way a menu shows a shortcut; the flags go first when the menu is narrow.
  const flagWidth = Math.min(Math.max(0, ...ordered.map((a) => (a.flag ?? '').length)), Math.floor(inner * 0.4));
  const w = fitColumns(
    [
      { key: 'mark', min: 2 },
      { key: 'key', min: 3 },
      { key: 'label', min: 10, max: Number.POSITIVE_INFINITY },
      { key: 'flag', min: flagWidth ? flagWidth + 2 : 0, drop: 1 },
    ],
    inner,
  );
  const current = ordered[selected];
  // The menu's lines, then as many of them as the pane holds, the selected action always among them.
  const lines: Array<{ section: string } | { action: Action; at: number }> = [];
  let index = 0;
  for (const s of sections) {
    if (s.section !== null) lines.push({ section: s.section || '─'.repeat(Math.min(inner, 24)) });
    for (const a of s.actions) lines.push({ action: a, at: index++ });
  }
  const room = Math.max(1, height - 2 - (title ? 1 : 0) - 2);
  const at = lines.findIndex((l) => 'action' in l && l.at === selected);
  const start = Math.max(0, Math.min(at - Math.floor(room / 2), lines.length - room));
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text bold wrap="truncate">
        Fork menu{cliAvailable ? '' : <Text color={theme.warn}> (unavailable: no CLI attached)</Text>}
      </Text>
      {title ? <Text color={theme.dim}>{truncate(title, inner)}</Text> : null}
      {lines.slice(start, start + room).map((l, i) =>
        'section' in l ? (
          <Text key={`s${start + i}`} color={theme.dim} wrap="truncate">
            {l.section}
          </Text>
        ) : (
          <Row
            key={l.action.key}
            width={inner}
            selected={l.at === selected ? 'focus' : null}
            cells={[
              cell(l.at === selected ? '>' : '', w.mark),
              cell(l.action.key, w.key, { color: l.action.disabled ? theme.faint : theme.accent, bold: true }),
              cell(l.action.label + (l.action.disabled ? `  (${l.action.disabled})` : ''), w.label, l.action.disabled ? { color: theme.faint } : {}, 2),
              { spans: [{ text: l.action.flag ?? '', color: theme.dim }], width: w.flag, gap: 0, align: 'right' },
            ]}
          />
        ),
      )}
      <Box flexGrow={1} />
      <Text color={theme.dim} wrap="truncate">
        {current?.hint ?? ' '}
      </Text>
    </Box>
  );
}
