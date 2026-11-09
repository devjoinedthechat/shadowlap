import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import { AskNote } from '../components/AskNote.js';
import { ConfirmDialog } from '../components/Dialog.js';
import { shortId } from '../format.js';
import { ACTIONS } from '../labels.js';
import type { VerifyStep } from '../types.js';

/**
 * What Run more attempts, Verify again and Verify this run ask, on the fix's page (VerifyStep.tsx)
 * and on a list row that leads with one (LeadDialog.tsx): apart from the Verify step, so a row's ask
 * loads none of it.
 */

/** Verify this run, or Verify these runs for more than one: the button's name wherever the page names it. */
export const leftLabel = (runs: readonly string[]) => (runs.length === 1 ? ACTIONS.verifyThisRun : ACTIONS.verifyTheseRuns).label;

/** Run more attempts' lead: verify has no --continue, so the attempts so far start over. */
const moreLead = (attempts: number): string => `Verifies the change again from the first attempt: the ${attempts.toLocaleString('en-US')} so far ${attempts === 1 ? 'doesn’t' : 'don’t'} carry over.`;

/** Run more attempts' or Verify again's ask, above the threshold or with no estimate: what it runs, and its Cost line the estimate. */
export function VerifyAsk({ more, attempts, estimate, onRun, onClose }: { more: Pick<NonNullable<VerifyStep['more']>, 'kind' | 'command'>; attempts: number; estimate: Estimate | null | undefined; onRun: () => boolean; onClose: () => void }) {
  const label = more.kind === 'more' ? ACTIONS.runMoreAttempts.label : ACTIONS.verifyAgain.label;
  const lead = more.kind === 'more' ? moreLead(attempts) : 'Verifies the same runs again from the first attempt, once the judge answers.';
  return <ConfirmDialog title={label} lead={lead} doc="verify" command={more.command} cost={{ price: 'Billed by your provider', estimate }} footNote={<AskNote estimate={estimate} />} ok={label} onOk={onRun} onClose={onClose} />;
}

/**
 * Verify this run's ask, above the threshold or with no estimate (`Verify change on <run>`): the
 * failing runs no accepted verify checked, verified on the code as it is now, its Cost line the
 * estimate, and its way on the first focus.
 */
export function VerifyLeftAsk({ left, estimate, onRun, onClose }: { left: { runs: readonly string[]; command: string }; estimate: Estimate | null | undefined; onRun: () => boolean; onClose: () => void }) {
  const one = left.runs.length === 1;
  const title = one ? (
    <>
      Verify change on <code>{shortId(left.runs[0]!)}</code>
    </>
  ) : (
    `Verify change on ${left.runs.length} runs`
  );
  const label = leftLabel(left.runs);
  const lead = one ? 'Verifies the code as it is now on the failing run the change wasn’t verified on.' : 'Verifies the code as it is now on the failing runs the change wasn’t verified on.';
  return <ConfirmDialog title={title} lead={lead} doc="verify" command={left.command} cost={{ price: 'Billed by your provider', estimate }} footNote={<AskNote estimate={estimate} />} ok={label} onOk={onRun} onClose={onClose} />;
}
