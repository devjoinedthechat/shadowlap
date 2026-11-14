/**
 * Pull runs…, on Settings → Store: the runs named as the store lists them (an id, or a unique prefix
 * of one, as `shadowlap pull` takes them), and whether the runs pull requests' CI jobs pushed to their
 * own folders come too (`--include-pr`). No imports: the browser's bundle uses this file as it is
 * (the dialog's command), and the server builds the `pull` job with it, so the command the dialog
 * shows is the one that runs.
 */

/** At most this many runs named in one pull. */
export const PULL_MAX = 1000;

/** A run as the store lists it: its id, or a prefix of one of 4 characters or more, in any case, as the CLI matches them. */
const NAMED = /^[0-9A-Za-z]{4,26}$/;

/** What a field names, as typed: separated by spaces or commas. */
export const typedNames = (text: string): string[] => text.split(/[\s,]+/).filter(Boolean);

/** The runs a field names: each once, in capitals as the store's ids are. */
export function pullNames(text: string): string[] {
  return [...new Set(typedNames(text).map((n) => n.toUpperCase()))];
}

/** Why a run can't be named so, as typed, or null: nothing the CLI would read as a flag or a path reaches it. */
export function pullNameProblem(name: string): string | null {
  return NAMED.test(name) ? null : `${name.slice(0, 26)} is no run: name one by its id, or its first 4 characters or more`;
}

/** The pull's arguments: the runs named, if any, then `--include-pr` when asked. */
export function pullArgs(names: readonly string[], includePr: boolean): string[] {
  return ['pull', ...names, ...(includePr ? ['--include-pr'] : [])];
}
