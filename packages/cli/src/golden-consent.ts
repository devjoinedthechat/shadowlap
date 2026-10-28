import { goldenNeedsConsent, type RunRecord } from '@shadowlap/engine';
import { confirmImportedCommand } from './shared.js';

/**
 * When a command that runs a golden's recorded command asks first (`shadowlap test`, `bisect`,
 * `injection`, `decisions`, `migrate`, `tasks score`): the rule is the engine's (golden-consent.ts).
 * A golden this machine recorded, or one the project's git repository tracks, runs as it is; any
 * other asks at a terminal, runs with `--yes`, and without a terminal (CI) isn't run, saying why.
 */
export { goldenNeedsConsent, packTracked } from '@shadowlap/engine';

/** What a golden that wasn't run says; `again` is the command that runs it with a yes. */
export function notRunMessage(dir: string, again = `shadowlap test ${dir} --yes`): string {
  return `not run: its recorded command came from a pack this repository doesn't track. Pass --yes to run it (${again}), or add the pack to the repository`;
}

/** Asks whether a golden from someone else's pack may run its recorded command, as `replay` asks of an imported run; `again` runs it with a yes. */
export function confirmGolden(run: RunRecord, dir: string, again = `shadowlap test ${dir} --yes`): Promise<boolean> {
  return confirmImportedCommand(run, run.command.argv, again, `Its pack isn't one this repository tracks. Pass --yes to run it (${again}), or add the pack to the repository.`);
}

/**
 * A golden's recorded run as a question about it names it, from its pack's head (packHeadRun): its
 * id and command, marked as a pack's.
 */
export function headRunRecord(head: { runId: string; argv: string[] }): RunRecord {
  return { runId: head.runId, parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: { argv: head.argv, cwd: '' }, codeVersion: null, startedAt: 0, endedAt: null, meta: { commandFromImport: true } };
}

/**
 * Whether a golden's recorded command may run: true when it needs no yes, or `yes` was given, else
 * the answer to the question (none without a terminal: false).
 */
export async function goldenConsented(run: RunRecord, dir: string, projectDir: string, yes: boolean | undefined, again: string): Promise<boolean> {
  if (yes || !goldenNeedsConsent(run, dir, projectDir)) return true;
  return confirmGolden(run, dir, again);
}
