import { shortId } from '../format.js';
import type { BisectChoices } from '../types.js';

/**
 * What Find the commit asks for: the bisect job's fields and the command the dialog shows. No DOM
 * here: the tests import it.
 */

/** Where the search ends: the failure's own commit, or HEAD when this checkout doesn't have it (another's, or uncommitted changes). */
export function bisectUpTo(choices: Pick<BisectChoices, 'bad'>): string {
  return choices.bad ?? 'HEAD';
}

/**
 * The bisect job's fields. The end is always named: left out, the job would take the failure's own
 * commit from the run, which may be a teammate's that isn't here.
 */
export function bisectRequest(runId: string, choices: Pick<BisectChoices, 'bad'>, good: string): { runId: string; good: string; bad: string } {
  return { runId, good: good.trim(), bad: bisectUpTo(choices) };
}

/** The command the dialog shows, as the job will run it. */
export function bisectCommand(runId: string, choices: Pick<BisectChoices, 'bad' | 'target' | 'fork'>, good: string): string {
  const what = choices.target.kind === 'golden' ? choices.target.golden : shortId(runId);
  return `shadowlap bisect ${what} --good ${good.trim() || '<commit>'} --bad ${bisectUpTo(choices)}${choices.fork ? ' --fork' : ''}`;
}
