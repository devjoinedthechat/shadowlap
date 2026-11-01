/**
 * Small things the CLI, the terminal UI, the dashboard and its pages each put in words the same way:
 * a count with its noun, a run's and a fix's short id, a part of a date in two digits, the failure
 * `--fail-at` gives a tool. No imports: the dashboard's pages bundle it as it is.
 */

/** A count with its noun: `1 run`, `3 runs`, `2 copies` (`many` where an s won't do). */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The s a count's noun takes: `change${pluralS(n)}`. */
export const pluralS = (n: number) => (n === 1 ? '' : 's');

/** A run id as the commands print it and take it: its first ten characters (the CLI takes any unique prefix). */
export function shortRunId(runId: string): string {
  return runId.slice(0, 10);
}

/** A fix id as the list shows it: `fx-` and the first ten characters, which `fix show` takes as a prefix. */
export const shortFixId = (fixId: string): string => fixId.slice(0, 13);

/** A part of a date or a time in two digits: `07`. */
export const twoDigits = (n: number) => String(n).padStart(2, '0');

/** A failure `--fail-at` gives a tool, in words: `a timeout`, `an error`, `HTTP 503`. */
export function toolFailure(what: string): string {
  if (/^timeout$/i.test(what)) return 'a timeout';
  if (/^\d{3}$/.test(what)) return `HTTP ${what}`;
  return 'an error';
}
