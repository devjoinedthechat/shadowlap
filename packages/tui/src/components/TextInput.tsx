import { Box, Text, useInput } from 'ink';
import { useRef, useState } from 'react';
import { useTheme } from '../theme.js';

interface Props {
  label: string;
  initial?: string;
  placeholder?: string;
  active: boolean;
  /**
   * The label on its own lines, with the value under it and the keys under that: for a prompt whose
   * label can be longer than the terminal is wide (a fork's, which names the call and may carry a
   * pack's warning), so it wraps by itself and never into the value.
   */
  stacked?: boolean;
  /** Inline: the line's width. The label, the value's end and the cursor always fit; the keys when there is room. */
  width?: number;
  /** Words for Enter in the inline hint: `apply` for a filter, which applies as you type. */
  enterDoes?: string;
  /** Enter runs what the pane shows, its primary action (blame's, which asks models live): the key in lime, as the dashboard's primary button is. */
  primary?: boolean;
  onChange?: (value: string) => void;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** Characters of the value shown while editing. */
const SHOWN = 240;

/** A single-line editor: printable keys append, backspace deletes, Enter submits, Esc cancels. */
export function TextInput({ label, initial = '', placeholder = '', active, stacked = false, width = 80, enterDoes = 'confirm', primary = false, onChange, onSubmit, onCancel }: Props) {
  const theme = useTheme();
  const enter = primary ? (
    <Text color={theme.ok} bold>
      Enter
    </Text>
  ) : (
    'Enter'
  );
  const [value, setValue] = useState(initial);
  // Keystrokes can arrive faster than React re-renders; the ref is always current, the state drives display.
  const current = useRef(initial);
  const update = (next: string) => {
    current.current = next;
    setValue(next);
    onChange?.(next);
  };
  useInput(
    (input, key) => {
      if (key.escape) onCancel();
      else if (key.return) onSubmit(current.current);
      else if (key.backspace || key.delete) update(current.current.slice(0, -1));
      else if (key.ctrl && input === 'u') update('');
      else if (!key.ctrl && !key.meta && input && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow && !key.tab) update(current.current + input);
    },
    { isActive: active },
  );
  if (stacked) {
    // A long value (a recorded tool result to edit) shows its end, where typing happens.
    const shown = value.length > SHOWN ? `…${value.slice(-(SHOWN - 1))}` : value;
    return (
      <Box flexDirection="column">
        <Text bold>{label}</Text>
        {/* One Text, so a long value wraps as a paragraph, the cursor at its end. */}
        <Text>
          <Text>› </Text>
          {value ? shown : <Text color={theme.dim}>{placeholder}</Text>}
          <Text inverse> </Text>
        </Text>
        <Text color={theme.dim}>{enter} to confirm · Esc to cancel</Text>
      </Box>
    );
  }
  // One line: ` label value█   Enter apply · Esc cancel`, the value's end shown where it is too long.
  const does = ` ${enterDoes} · Esc cancel`;
  const keys = `   Enter${does}`;
  const room = Math.max(4, width - label.length - 3);
  const fits = (value || placeholder).length + keys.length <= room;
  const shown = value.length > room ? `…${value.slice(-(room - 1))}` : value;
  return (
    <Box height={1} width={width} flexShrink={0}>
      <Text wrap="truncate">
        {' '}
        <Text bold>{label}</Text>{' '}
        {value ? <Text>{shown}</Text> : null}
        <Text inverse> </Text>
        {!value && placeholder ? <Text color={theme.faint}>{placeholder.slice(0, Math.max(0, room - 1))}</Text> : null}
        {fits ? (
          <Text color={theme.dim}>
            {'   '}
            {enter}
            {does}
          </Text>
        ) : null}
      </Text>
    </Box>
  );
}
