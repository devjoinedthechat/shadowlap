import { Box, Text, useInput } from 'ink';
import { useRef, useState } from 'react';

interface Props {
  label: string;
  initial?: string;
  placeholder?: string;
  active: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** Characters of the value shown while editing. */
const SHOWN = 240;

/** A single-line editor: printable keys append, backspace deletes, Enter submits, Esc cancels. */
export function TextInput({ label, initial = '', placeholder = '', active, onSubmit, onCancel }: Props) {
  const [value, setValue] = useState(initial);
  // Keystrokes can arrive faster than React re-renders; the ref is always current, the state drives display.
  const current = useRef(initial);
  const update = (next: string) => {
    current.current = next;
    setValue(next);
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
  // A long value (a recorded tool result to edit) shows its end, where typing happens.
  const shown = value.length > SHOWN ? `…${value.slice(-(SHOWN - 1))}` : value;
  return (
    <Box>
      <Text bold>{label} </Text>
      {value ? <Text>{shown}</Text> : <Text color="gray">{placeholder}</Text>}
      <Text inverse> </Text>
      <Text color="gray">  Enter to confirm · Esc to cancel</Text>
    </Box>
  );
}
