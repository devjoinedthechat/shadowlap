import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { commandIsImported, hasRecordedCommand, type RunRecord } from '@shadowlap/engine';

/**
 * When `shadowlap test` asks before it runs a golden's recorded command. A golden's pack holds the
 * command its replay runs. One this machine recorded is the user's own; one the project's git
 * repository tracks is reviewed as its code is, which is where CI's goldens are. Any other came from
 * a pack someone sent, outside the repository or not added to it, and runs only once the user says
 * yes, as `replay` asks of an imported run.
 */

/**
 * Whether the project's git repository tracks a pack: its run.json is in the index of the repository
 * the project is in. A pack outside it (in another repository too), one reached through a symbolic
 * link, one not added, and any where the project is no git repository, isn't.
 */
export function packTracked(dir: string, projectDir: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', resolve(projectDir, dir, 'run.json')], { cwd: projectDir, stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/** Whether a golden's recorded command runs only after a yes: it came from elsewhere, and the repository doesn't track its pack. */
export function goldenNeedsConsent(run: RunRecord, dir: string, projectDir: string): boolean {
  return commandIsImported(run) && hasRecordedCommand(run) && !packTracked(dir, projectDir);
}

/** What a golden that wasn't run says. */
export function notRunMessage(dir: string): string {
  return `not run: its recorded command came from a pack this repository doesn't track. Pass --yes to run it (shadowlap test ${dir} --yes), or add the pack to the repository`;
}
