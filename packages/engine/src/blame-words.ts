/**
 * How a blame that placed the failure on no call is said, wherever it is shown: blame's report and
 * `shadowlap show`, the terminal UI, and the dashboard's run page, Needs a look, Fixes and Activity.
 * No imports: the dashboard's pages bundle it as it is.
 */

/**
 * A blame whose first probe couldn't tell a rescue from a loss (blame.ts `unsettledFirst`), in a few
 * words: inconclusive, the word every gate that couldn't decide within its attempts is said in.
 */
export const INCONCLUSIVE_FIRST = 'inconclusive at the first model call';

/** The same words heading a report or a step: `Inconclusive at the first model call`. */
export const INCONCLUSIVE_FIRST_HEAD = INCONCLUSIVE_FIRST.charAt(0).toUpperCase() + INCONCLUSIVE_FIRST.slice(1);

/**
 * A blame that placed the failure on no call: inconclusive at the first model call when its first
 * probe couldn't tell; else not rescued from any model call where its bound bears that out (`any`),
 * or only from the first, as blame's report heads it then (blame.ts `unrescuedHead`).
 */
export const unrescuedWords = (unsettled: boolean, any = true): string => (unsettled ? INCONCLUSIVE_FIRST : `not rescued from ${any ? 'any' : 'the first'} model call`);

/**
 * A blame that found no call, in one word, as a list or a job's status line says it: `inconclusive`
 * when its first probe couldn't tell, `not rescued` when no call rescues the run, `stopped` when it
 * was cut short, by hand or at its budget, before the search finished.
 */
export function blameStateWord(outcome: 'unrescuable' | 'stopped', unsettled: boolean): 'inconclusive' | 'not rescued' | 'stopped' {
  if (outcome === 'stopped') return 'stopped';
  return unsettled ? 'inconclusive' : 'not rescued';
}
