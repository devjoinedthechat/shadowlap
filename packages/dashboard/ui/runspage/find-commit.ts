import { shortId } from '../format.js';
import { commandText } from '../goldens.js';
import type { BisectChoices } from '../types.js';

/**
 * What Find breaking commit asks for: the bisect job's fields and the command the dialog shows. No DOM
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

/**
 * How the runs at a commit went, as a choice in the dialog says it: `3 passed`, `1 of 3 failed`, and
 * a golden's inconclusive results counted apart, neither passed nor failed: `1 of 3 inconclusive`,
 * `1 of 3 failed, 1 inconclusive`.
 */
export function revisionTally(r: Pick<BisectChoices['revisions'][number], 'runs' | 'failed' | 'inconclusive'>): string {
  const unsure = r.inconclusive ?? 0;
  if (!r.failed && !unsure) return `${r.runs} passed`;
  if (!r.failed) return `${unsure} of ${r.runs} inconclusive`;
  return `${r.failed} of ${r.runs} failed${unsure ? `, ${unsure} inconclusive` : ''}`;
}

/** The command the dialog shows, as the job will run it: with the check each replay is judged by when the job passes one (`--expect`). */
export function bisectCommand(runId: string, choices: Pick<BisectChoices, 'bad' | 'target' | 'fork' | 'expect'>, good: string): string {
  const what = choices.target.kind === 'golden' ? choices.target.golden : shortId(runId);
  const expect = choices.expect && Object.keys(choices.expect).length ? ['--expect', JSON.stringify(choices.expect)] : [];
  return commandText(['bisect', what, '--good', good.trim() || '<commit>', '--bad', bisectUpTo(choices), ...expect, ...(choices.fork ? ['--fork'] : [])]);
}

/**
 * What the search costs, as Find breaking commit's dialogs say it. A run that failed on its own is
 * replayed with `--fork`: one live replay decides each commit, so a failure that doesn't happen
 * every time can pass at a commit that has it. A golden that may fork runs live from where it
 * diverges; any other replay is free.
 */
export function bisectCost(choices: Pick<BisectChoices, 'fork' | 'live'>): string {
  if (choices.fork) return 'One live replay decides each commit, from where its requests differ: it costs tokens, and a failure that doesn’t happen every time can pass at a commit that has it.';
  return choices.live ? 'Its replays run live from where they diverge, so this costs tokens.' : 'Replays are free, so this costs no tokens.';
}
