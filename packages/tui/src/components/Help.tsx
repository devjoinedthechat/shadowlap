import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { truncate } from '../render.js';
import { useTheme } from '../theme.js';

export type HelpContext = 'runs' | 'timeline';

interface Group {
  title: string;
  keys: Array<readonly [string, string]>;
}

/** The keys of the view help was opened from, grouped by what they are for. */
export const HELP: Record<HelpContext, Group[]> = {
  runs: [
    {
      title: 'Move',
      keys: [['↑ ↓  j k  g G', 'select a run; g G ends, PgUp PgDn pages']],
    },
    {
      title: 'Runs',
      keys: [
        ['enter', 'open the run: its calls and what each sent and got back'],
        ['/', 'filter by id, command, revision or label; esc clears'],
        ['o', 'open the run in the dashboard'],
        ['x', 'delete the selected run with its attempts, as rm does; asks first'],
        ['+ -', 'mark it good (a fix must keep it working) or bad (one to fix)'],
        ['a', 'list the attempts folded under their runs one by one, or fold them'],
        ['esc  q', 'quit'],
      ],
    },
  ],
  timeline: [
    {
      title: 'Move',
      keys: [
        ['↑ ↓  j k  g G', 'move in the focused pane; g G ends, PgUp PgDn pages'],
        ['← →  h l', 'focus the calls or the inspector'],
        ['J K  z', 'scroll the inspector from the calls; z widens it'],
      ],
    },
    {
      title: 'Look',
      keys: [
        ['tab  1–6', 'the call’s four tabs, a fork’s diff, then the run'],
        ['v  b', 'the run: why it failed, blame, its fix; b where it was lost'],
        ['space  < >', 'play the response at its recorded pacing; < > speed'],
        ['y  w', 'copy the request (or response); w writes the call to a file'],
      ],
    },
    {
      title: 'Find',
      keys: [
        ['/', 'filter calls as you type'],
        ['f', 'only the calls that ran live, replayed, or were fenced'],
        ['[ ]', 'previous, next call that ran live, was fenced or failed'],
        ['n  d', 'the call the run forked at; d what changed and what it did'],
      ],
    },
    {
      title: 'Act',
      keys: [
        [':', 'fork menu: fork here, repeat, stub writes, find the commit'],
        ['p  o', 'the parent run; o opens this call in the dashboard'],
        ['+ -', 'mark the run good (a fix must keep it working) or bad'],
        ['esc  q', 'back one step (filter, zoom, focus); q back to the runs'],
      ],
    },
  ],
};

const KEY = 15;
type HelpLine = { kind: 'title'; text: string } | { kind: 'key'; key: string; does: string };

function linesOf(groups: Group[]): HelpLine[] {
  return groups.flatMap((g) => [{ kind: 'title', text: g.title } as const, ...g.keys.map(([key, does]) => ({ kind: 'key', key, does }) as const)]);
}

/**
 * The keys, for the view it was opened from. Two columns when the terminal is wide enough, and when
 * it is too short for them all, j/k scroll; any other key closes it.
 */
export function Help({ width, height, context = 'timeline', onClose }: { width: number; height: number; context?: HelpContext; onClose?: () => void }) {
  const theme = useTheme();
  const [scroll, setScroll] = useState(0);
  const groups = HELP[context];
  // Border (2), padding (2); the title and the legend lines take one row each, the hint one more.
  const inner = Math.max(10, width - 6);
  const bodyRows = Math.max(1, height - 2 - 3);
  // One column when it fits; two side by side when the terminal is wide enough; otherwise j/k scroll.
  const twoColumns = linesOf(groups).length > bodyRows && inner >= 96 && groups.length > 1;
  let columns: HelpLine[][];
  if (twoColumns) {
    // Groups in order, split where the two columns come out closest in length.
    const all = groups.map((g) => linesOf([g]).length);
    let best = 1;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (let k = 1; k < groups.length; k++) {
      const left = all.slice(0, k).reduce((a, b) => a + b, 0) + k - 1;
      const right = all.slice(k).reduce((a, b) => a + b, 0) + groups.length - k - 1;
      if (Math.abs(left - right) < bestDiff) [best, bestDiff] = [k, Math.abs(left - right)];
    }
    columns = [linesOf(groups.slice(0, best)), linesOf(groups.slice(best))];
  } else columns = [linesOf(groups)];
  const tallest = Math.max(...columns.map((c) => c.length));
  const max = Math.max(0, tallest - bodyRows);
  const offset = Math.min(scroll, max);
  const colWidth = twoColumns ? Math.floor((inner - 4) / 2) : inner;

  useInput(
    (input, key) => {
      if (max && (input === 'j' || key.downArrow)) setScroll((s) => Math.min(max, s + 1));
      else if (max && (input === 'k' || key.upArrow)) setScroll((s) => Math.max(0, s - 1));
      else onClose?.();
    },
    { isActive: !!onClose },
  );

  const draw = (l: HelpLine | undefined, i: number) => {
    if (!l) return <Text key={i}> </Text>;
    if (l.kind === 'title') {
      return (
        <Text key={i} color={theme.accent} bold>
          {l.text}
        </Text>
      );
    }
    return (
      <Text key={i} wrap="truncate">
        <Text bold>{truncate(l.key, KEY - 1).padEnd(KEY)}</Text>
        <Text color={theme.dim}>{truncate(l.does, Math.max(1, colWidth - KEY))}</Text>
      </Text>
    );
  };
  const origins: Array<[string, string | undefined]> = [
    ['live', theme.origin.live],
    ['replayed', theme.origin.replayed],
    ['overridden', theme.origin.overridden],
    ['injected', theme.origin.injected],
    ['blocked', theme.origin.blocked],
    ['stubbed', theme.origin.stubbed],
  ];

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor={theme.accent} paddingX={2}>
      <Text wrap="truncate">
        <Text bold>Keys</Text>
        <Text color={theme.dim}>{context === 'runs' ? ' · runs' : ' · calls and inspector'}</Text>
      </Text>
      <Box flexDirection="row" height={bodyRows} flexShrink={0}>
        {columns.map((col, c) => (
          <Box key={c} flexDirection="column" width={colWidth} marginRight={c === 0 && twoColumns ? 4 : 0}>
            {col.slice(offset, offset + bodyRows).map(draw)}
          </Box>
        ))}
      </Box>
      <Text wrap="truncate">
        <Text color={theme.dim}>origins </Text>
        {origins.map(([name, color]) => (
          <Text key={name} {...(color ? { color } : {})}>
            {name}{' '}
          </Text>
        ))}
      </Text>
      <Text color={theme.faint} wrap="truncate">
        {max ? `j/k scroll (${offset + 1}–${Math.min(tallest, offset + bodyRows)} of ${tallest}) · any other key closes` : 'any key closes'}
      </Text>
    </Box>
  );
}
