import type { CoverageNotPacked } from './store/coverage.js';

/*
 * Production coverage's words that the CLI's report and the dashboard's Not covered both say, in a
 * module with nothing of node in it, so the browser reads them as they are (coverage.ts re-exports
 * them for every other reader).
 */

/** Where a behaviour first differs from its nearest golden: what it does there, and what the golden does (null where a path has ended). */
export interface NearestDiffers {
  step: number;
  seen: string | null;
  golden: string | null;
}

/**
 * Where a behaviour parts from its nearest golden, after the steps they share, as the CLI's report
 * says it on its own line: `then it calls <x> where the golden calls <y>`, `then it calls <x> where
 * the golden has stopped`, `then it stops where the golden calls <y>`. Null when the two take the same
 * steps and only end another way (the report then says {@link ENDS_ANOTHER_WAY}). `name` shows each
 * tool's name as its reader prints it: the CLI passes its terminal-safe `safe`.
 */
export function nearestThen(differs: NearestDiffers | null, name: (tool: string) => string = (tool) => tool): string | null {
  if (!differs) return null;
  if (differs.seen === null) return `then it stops where the golden calls ${name(differs.golden ?? '')}`;
  return differs.golden === null ? `then it calls ${name(differs.seen)} where the golden has stopped` : `then it calls ${name(differs.seen)} where the golden calls ${name(differs.golden)}`;
}

/** What follows the steps a behaviour shares with its nearest golden where the two take the same steps and only end another way. */
export const ENDS_ANOTHER_WAY = 'but it ends another way';

/** Why the last `coverage --pack` couldn't pack a behaviour, as the CLI's report and Tests' Not covered say it (`--json` has the sentence). */
export const NOT_PACKED: Readonly<Record<CoverageNotPacked, string>> = {
  'no-command': 'nothing says what starts the agent (give its command after --, with {message} where its input goes)',
  'other-message': 'the command given starts the agent with another first message than production',
  'not-reproduced': 'the agent no longer does this (--fork with --expect keeps it as a golden that forks)',
  'agent-error': 'the agent failed on what production got back',
  gone: 'its runs are no longer in the store',
};

/** {@link NOT_PACKED}'s words before their brackets: what a row says, the whole sentence on its card. */
export const notPackedHead = (reason: CoverageNotPacked): string => NOT_PACKED[reason].replace(/\s*\(.*\)$/, '');

/** The checks `coverage --pack --fork --expect` gives as its example: what a golden that forks is judged by. */
export const PACK_EXPECT_EXAMPLE = '{"tools":{"issue_refund":0}}';
