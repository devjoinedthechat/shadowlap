import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { truncate } from '../render.js';

export { actionContext, buildActions, forkMenuTitle, notRun, terminalActions, type Action } from '../actions.js';
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
  const sections = menuOrder(actions);
  const ordered = sections.flatMap((s) => s.actions);
  const [selected, setSelected] = useState(0);
  useInput(
    (input, key) => {
      if (key.escape || input === ':' || input === 'q') onClose();
      else if (key.downArrow || input === 'j') setSelected((s) => Math.min(ordered.length - 1, s + 1));
      else if (key.upArrow || input === 'k') setSelected((s) => Math.max(0, s - 1));
      else if (key.return && ordered[selected]) onPick(ordered[selected]!);
      else {
        const hit = ordered.find((a) => a.key === input);
        if (hit) onPick(hit);
      }
    },
    { isActive: active },
  );
  const inner = Math.max(20, width - 4);
  // Each line carries its flag on the right, the way a menu shows a shortcut.
  const flagWidth = Math.min(Math.max(0, ...ordered.map((a) => (a.flag ?? '').length)), Math.floor(inner * 0.4));
  const room = Math.max(10, inner - 5 - (flagWidth ? flagWidth + 2 : 0));
  const current = ordered[selected];
  let index = 0;
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>Actions {cliAvailable ? '' : '(unavailable: no CLI attached)'}</Text>
      {title ? <Text color="gray">{truncate(title, inner)}</Text> : null}
      {sections.map((s) => (
        <Box key={s.section ?? 'call'} flexDirection="column">
          {s.section === null ? null : <Text color="gray">{s.section || '─'.repeat(Math.min(inner, 24))}</Text>}
          {s.actions.map((a) => {
            const i = index++;
            return (
              <Box key={a.key}>
                <Text inverse={i === selected}>{i === selected ? '>' : ' '}</Text>
                <Text color="cyan"> {a.key} </Text>
                <Box width={room}>
                  <Text bold={i === selected} {...(a.disabled ? { color: 'gray' } : {})}>
                    {truncate(a.label + (a.disabled ? `  (${a.disabled})` : ''), room)}
                  </Text>
                </Box>
                {flagWidth ? <Text color="gray">  {truncate(a.flag ?? '', flagWidth)}</Text> : null}
              </Box>
            );
          })}
        </Box>
      ))}
      {current?.hint ? <Text color="gray">{truncate(current.hint, inner)}</Text> : null}
      <Text color="gray">Enter or the letter to run · Esc to close</Text>
    </Box>
  );
}
