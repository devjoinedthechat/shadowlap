import { InvalidArgumentError } from 'commander';
import { messageOf, type DecisionsReport, type StoreOf } from '@shadowlap/engine';
import { DecisionsError } from './decisions.js';
import { openStore, type GlobalOpts } from './shared.js';
import { palette as p } from './ui.js';

/**
 * `decisions --from-code --test-session <id>`: what the working tree's prompt and tools decide
 * differently on the goldens' recordings, kept as that test session's pull request comment part, as
 * the GitHub Action's `decisions: true` asks it on a pull request. The store keeps each part of a
 * session's comment apart (setTestSessionComment), so keeping this one leaves the session's cost per
 * run as `test` kept it.
 */

/** The test session `--test-session` names, or null; refused unless the preview is `--from-code`'s, and with `--verify`, which asks nothing. */
export function testSessionFlag(flags: { testSession?: string; fromCode?: boolean; verify?: string }): string | null {
  if (flags.testSession === undefined) return null;
  if (flags.verify !== undefined || !flags.fromCode) throw new InvalidArgumentError('--test-session keeps a preview of the prompt and tools your working tree sends with a test session: give it with --from-code, and not with --verify');
  return flags.testSession;
}

/** Refuses a test session the store has no record of, in the store's words, before anything is asked: a typo never pays for a preview. */
export function testSessionKnown(store: StoreOf<'tests'>, sessionId: string | null): void {
  if (sessionId !== null && !store.getTestSession(sessionId)) throw new DecisionsError(`unknown test session ${sessionId}`);
}

/** Keeps the preview as the test session's decisions part once the preview itself is kept (its dc-… id); what can't be kept is said. */
export function keepDecisionsPart(opts: GlobalOpts, sessionId: string | null, report: Pick<DecisionsReport, 'decisionsId'>): void {
  if (sessionId === null || !report.decisionsId) return;
  try {
    const store = openStore(opts);
    try {
      store.setTestSessionComment(sessionId, { decisions: report.decisionsId });
    } finally {
      store.close();
    }
  } catch (err) {
    process.stderr.write(p.yellow(`[shadowlap] the preview was not kept with test session ${sessionId}: ${messageOf(err)}\n`));
  }
}
