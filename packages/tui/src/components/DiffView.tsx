import { Box, Text } from 'ink';
import { endedEarlyCount, type DivergenceReport } from '@shadowlap/engine';
import { truncate, wrap } from '../render.js';

interface Props {
  divergence: DivergenceReport | null;
  width: number;
  height: number;
  scroll: number;
}

interface Line {
  text: string;
  color?: string;
  bold?: boolean;
}

function value(v: unknown, width: number): string[] {
  const s = typeof v === 'string' ? JSON.stringify(v) : (JSON.stringify(v) ?? String(v));
  return wrap(s, width);
}

export function diffLines(d: DivergenceReport | null, width: number): Line[] {
  if (!d) return [{ text: 'This run did not diverge.', color: 'green' }];
  const out: Line[] = [];
  if (d.type === 'ended_early') {
    out.push({ text: `✗ Ended early at call ${d.callNo} (${d.kind} ${d.name}): ${endedEarlyCount(d)} replayed`, color: 'red', bold: true });
    out.push({ text: `every request the agent sent matched, but it stopped before its recording did, without making #${d.callNo}`, color: 'gray' });
    return out;
  }
  out.push({ text: `✗ Diverged at call ${d.callNo} (${d.kind} ${d.name}): ${d.replayedBefore} calls replayed before divergence`, color: 'red', bold: true });
  switch (d.type) {
    case 'forced':
      out.push({ text: d.reason ?? 'forced live by --live-tool or --diverge-at', color: 'gray' });
      break;
    case 'beyond_recording':
      out.push({ text: 'beyond the recording: the agent made more calls than were recorded', color: 'gray' });
      break;
    case 'new_call':
      out.push({ text: `new call: ${d.reason ?? 'no recorded counterpart'}`, color: 'gray' });
      break;
    case 'request_changed':
      if (d.counterpart) out.push({ text: `compared with run ${d.counterpart.runId.slice(0, 10)}, call ${d.counterpart.callNo}`, color: 'gray' });
      out.push({ text: '' });
      for (const e of d.diff ?? []) {
        out.push({ text: `${e.op === 'changed' ? '~' : e.op === 'added' ? '+' : '-'} ${e.path}`, color: 'cyan', bold: true });
        if (e.op !== 'added') for (const l of value(e.before, width - 6)) out.push({ text: `    - ${l}`, color: 'red' });
        if (e.op !== 'removed') for (const l of value(e.after, width - 6)) out.push({ text: `    + ${l}`, color: 'green' });
        out.push({ text: '' });
      }
      for (const h of d.hints ?? []) {
        out.push({ text: `hint: ${h.message}`, color: 'yellow' });
        if (h.normalizer) {
          const n = h.normalizer;
          const args = [n.kind ? `--kind ${n.kind}` : '', n.name ? `--name ${JSON.stringify(n.name)}` : '', `--path '${n.path!}'`, n.pattern ? `--pattern ${n.pattern}` : ''].filter(Boolean).join(' ');
          out.push({ text: `      shadowlap normalize add ${args}`, color: 'yellow' });
        }
      }
      break;
  }
  return out;
}

export function DiffView({ divergence, width, height, scroll }: Props) {
  const inner = Math.max(20, width - 4);
  const lines = diffLines(divergence, inner);
  const bodyHeight = Math.max(1, height - 3);
  const offset = Math.min(scroll, Math.max(0, lines.length - bodyHeight));
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="double" borderColor="yellow" paddingX={1}>
      <Text bold>Divergence {lines.length > bodyHeight ? `(${offset + 1}–${Math.min(lines.length, offset + bodyHeight)}/${lines.length}, J/K to scroll)` : ''}  Esc to close</Text>
      {lines.slice(offset, offset + bodyHeight).map((l, i) => (
        <Text key={i} wrap="truncate" {...(l.color ? { color: l.color } : {})} bold={l.bold === true}>
          {truncate(l.text, inner) || ' '}
        </Text>
      ))}
    </Box>
  );
}
