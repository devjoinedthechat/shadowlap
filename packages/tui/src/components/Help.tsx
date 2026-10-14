import { Box, Text } from 'ink';

const ROWS: Array<[string, string]> = [
  ['↑/↓  j/k', 'move in the focused pane'],
  ['←/→  h/l', 'focus the call list or the inspector'],
  ['PgUp/PgDn  g/G', 'page, first/last'],
  ['Enter', 'open run (runs view)'],
  ['Tab / Shift-Tab, 1–4', 'inspector tabs: conversation / request / response / meta'],
  ['J/K', 'scroll the inspector or the diff from the list'],
  ['space', 'play the selected response at recorded pacing'],
  ['+ / -', 'play speed ×1 ×2 ×4 instant'],
  ['/', 'filter calls (or runs) by text; Esc clears'],
  ['f', 'cycle origin filter: all / live / replayed / fenced'],
  ['[ / ]', 'previous / next call that ran live, was fenced, or failed'],
  ['n', 'jump to the divergence (forks only)'],
  ['d', 'divergence diff'],
  [':', 'actions: replay, fork (force tool live, diverge here, override, inject, model), add normalizer, pack'],
  ['y', 'copy the request (or the response, on that tab) to the clipboard'],
  ['w', 'write the call\'s request and response to a JSON file in the working directory'],
  ['p', 'open the parent run'],
  ['o', 'open the run, at the selected call, in the dashboard: charts, search, compare'],
  ['x', 'delete the selected run (runs view; asks first)'],
  ['?', 'this help'],
  ['Esc / q', 'back / quit'],
];

export function Help({ width, height }: { width: number; height: number }) {
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="cyan" paddingX={2}>
      <Text bold>Keys</Text>
      {ROWS.map(([k, v]) => (
        <Box key={k}>
          <Text color="cyan">{k.padEnd(22)}</Text>
          <Text wrap="truncate">{v}</Text>
        </Box>
      ))}
      <Text color="gray">Origins: live · replayed (cyan) · blocked (red) · stubbed (yellow) · overridden (magenta). Press any key to close.</Text>
    </Box>
  );
}
