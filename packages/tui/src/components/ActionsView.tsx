import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { truncate } from '../render.js';

export { buildActions, notRun, type Action } from '../actions.js';
import type { Action } from '../actions.js';

interface Props {
  actions: Action[];
  width: number;
  height: number;
  active: boolean;
  cliAvailable: boolean;
  onPick: (action: Action) => void;
  onClose: () => void;
}

export function ActionsView({ actions, width, height, active, cliAvailable, onPick, onClose }: Props) {
  const [selected, setSelected] = useState(0);
  useInput(
    (input, key) => {
      if (key.escape || input === ':' || input === 'q') onClose();
      else if (key.downArrow || input === 'j') setSelected((s) => Math.min(actions.length - 1, s + 1));
      else if (key.upArrow || input === 'k') setSelected((s) => Math.max(0, s - 1));
      else if (key.return && actions[selected]) onPick(actions[selected]!);
      else {
        const hit = actions.find((a) => a.key === input);
        if (hit) onPick(hit);
      }
    },
    { isActive: active },
  );
  const inner = Math.max(20, width - 4);
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>Actions {cliAvailable ? '' : '(unavailable: no CLI attached)'}</Text>
      {actions.map((a, i) => (
        <Box key={a.key}>
          <Text inverse={i === selected}>{i === selected ? '>' : ' '}</Text>
          <Text color="cyan"> {a.key} </Text>
          <Text bold={i === selected} {...(a.disabled ? { color: 'gray' } : {})}>
            {truncate(a.label + (a.disabled ? `  (${a.disabled})` : ''), inner - 5)}
          </Text>
        </Box>
      ))}
      <Text color="gray">Enter or the letter to run · Esc to close</Text>
    </Box>
  );
}
