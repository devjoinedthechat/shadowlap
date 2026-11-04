import { Box, Text, useInput } from 'ink';
import { quoteArgv, safeLine } from '@shadowlap/engine';
import type { FixJob } from '../fix-actions.js';
import { useTheme } from '../theme.js';
import { TextInput } from './TextInput.js';

interface Props {
  job: FixJob;
  /** Why it is shown once more: what it runs changed since the user was asked. */
  again?: string;
  width: number;
  height: number;
  /** The user said yes: Enter (`typed` false), or `yes` typed to the question about someone else's runs (`typed` true). */
  onYes: (typed: boolean) => void;
  /** Anything but `yes` typed to the question: nothing runs, and it says so. */
  onDecline: () => void;
  onCancel: () => void;
}

/**
 * Repair or verify the run's fix, shown before it runs as the dashboard's Repair from here dialog
 * shows it: the fix, who a repair asks for candidates (and so whose account pays), why it would end
 * with no fix to try, and the exact command line. A line that runs a command from someone else's
 * pack or the team store runs only once `yes` is typed to the question naming it; one the repairer
 * can't be asked for runs nothing.
 */
export function FixJobView({ job, again, width, height, onYes, onDecline, onCancel }: Props) {
  const theme = useTheme();
  const asks = !!job.ask && !job.blocked;
  useInput(
    (input, key) => {
      if (key.escape || input === 'q') onCancel();
      else if (key.return && !job.blocked && !job.ask) onYes(false);
    },
    { isActive: !asks },
  );
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" {...(job.blocked ? { borderColor: theme.err } : job.ask ? { borderColor: theme.warn } : {})} paddingX={1}>
      <Text wrap="truncate">
        <Text bold>{job.label}</Text>
        {job.fix ? <Text color={theme.dim}> · {safeLine(`${job.fix.id} ${job.fix.title}`)}</Text> : null}
      </Text>
      <Text color={theme.dim}>{job.hint}</Text>
      {again ? <Text color={theme.warn}>{again}</Text> : null}
      {job.who ? <Text color={theme.dim}>It asks {safeLine(job.who)} for candidates, so that account pays for them.</Text> : null}
      {job.aside ? <Text color={theme.warn}>{job.aside}</Text> : null}
      <Text>
        <Text color={theme.dim}>It runs </Text>
        {quoteArgv(['shadowlap', ...job.args])}
        <Text color={theme.dim}>, and asks models live, which costs.</Text>
      </Text>
      {job.blocked ? (
        <>
          <Text color={theme.err}>{safeLine(job.blocked.replace(/\.$/, ''))}. Nothing runs.</Text>
          <Text color={theme.dim}>Esc goes back</Text>
        </>
      ) : job.ask ? (
        <>
          <Text color={theme.warn}>{safeLine(job.ask.text)}.</Text>
          <TextInput
            stacked
            label="Type yes to run it:"
            placeholder="yes"
            active
            onSubmit={(value) => (/^y(es)?$/i.test(value.trim()) ? onYes(true) : onDecline())}
            onCancel={onCancel}
          />
        </>
      ) : (
        <Text color={theme.dim}>
          {/* The pane's primary action, in the one lime a page's primary action takes. */}
          <Text color={theme.ok} bold>
            Enter
          </Text>{' '}
          runs it · Esc goes back
        </Text>
      )}
    </Box>
  );
}
