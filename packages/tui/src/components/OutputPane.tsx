import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import type { ChildProcess } from 'node:child_process';
import { truncate } from '../render.js';

interface Props {
  title: string;
  child: ChildProcess;
  width: number;
  height: number;
  active: boolean;
  /** Called once with the exit code and the id of a run the command created, if any. */
  onExit: (code: number | null, createdRunId: string | null) => void;
  onClose: () => void;
  onOpenRun: (runId: string) => void;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const RUN_LINE = /(?:recording|replaying) run ([0-9A-Z]{26})/;

/** Streams a spawned CLI command's output; when it exits, offers to open the run it created. */
export function OutputPane({ title, child, width, height, active, onExit, onClose, onOpenRun }: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [exit, setExit] = useState<{ code: number | null; runId: string | null } | null>(null);

  useEffect(() => {
    let buffer = '';
    let runId: string | null = null;
    const push = (chunk: Buffer) => {
      buffer += chunk.toString('utf8').replace(ANSI, '');
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      if (parts.length) {
        for (const p of parts) {
          const m = RUN_LINE.exec(p);
          if (m) runId = m[1]!;
        }
        setLines((prev) => [...prev, ...parts].slice(-500));
      }
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    const onExitEvent = (code: number | null) => {
      if (buffer) setLines((prev) => [...prev, buffer].slice(-500));
      setExit({ code, runId });
      onExit(code, runId);
    };
    child.once('exit', onExitEvent);
    child.once('error', (err) => {
      setLines((prev) => [...prev, `failed to start: ${err.message}`]);
      onExitEvent(127);
    });
    return () => {
      child.stdout?.off('data', push);
      child.stderr?.off('data', push);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [child]);

  useInput(
    (input, key) => {
      if (!exit) return; // let it finish
      if (key.escape || input === 'q') onClose();
      else if (key.return && exit.runId) onOpenRun(exit.runId);
    },
    { isActive: active },
  );

  const inner = Math.max(20, width - 4);
  const body = Math.max(1, height - 4);
  const visible = lines.slice(-body);
  const status = exit
    ? exit.code === 0
      ? `done${exit.runId ? ` · Enter opens run ${exit.runId.slice(0, 10)}` : ''} · Esc closes`
      : `exited with code ${exit.code ?? '?'} · Esc closes`
    : 'running…';
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor={exit ? (exit.code === 0 ? 'green' : 'red') : 'yellow'} paddingX={1}>
      <Text bold>{truncate(title, inner)}</Text>
      {visible.map((l, i) => (
        <Text key={i} wrap="truncate">
          {truncate(l, inner) || ' '}
        </Text>
      ))}
      <Box flexGrow={1} />
      <Text color="gray">{status}</Text>
    </Box>
  );
}
