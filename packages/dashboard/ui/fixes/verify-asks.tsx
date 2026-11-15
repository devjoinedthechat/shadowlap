import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import { AskNote } from '../components/AskNote.js';
import { Dialog } from '../components/Dialog.js';
import { shortId } from '../format.js';
import { ACTIONS } from '../labels.js';
import type { VerifyStep } from '../types.js';
import { StopAtField, useStopAt } from './stop-at.js';

/**
 * What Run more attempts, Verify again and Verify this run ask, on the fix's page (VerifyStep.tsx)
 * and on a list row that leads with one (LeadDialog.tsx): apart from the Verify step, so a row's ask
 * loads none of it.
 */

/** Verify this run, or Verify these runs for more than one: the button's name wherever the page names it. */
export const leftLabel = (runs: readonly string[]) => (runs.length === 1 ? ACTIONS.verifyThisRun : ACTIONS.verifyTheseRuns).label;

/** Run more attempts' lead: verify has no --continue, so the attempts so far start over. */
const moreLead = (attempts: number): string => `Verifies the change again from the first attempt: the ${attempts.toLocaleString('en-US')} so far ${attempts === 1 ? 'doesn’t' : 'don’t'} carry over.`;

/**
 * Run more attempts' or Verify again's ask, above the threshold or with no estimate: what it runs, its
 * Cost line the estimate, and Stop at $, at the budget the command keeps (`keptBudget`), else empty.
 */
export function VerifyAsk({ more, attempts, estimate, onRun, onClose }: { more: Pick<NonNullable<VerifyStep['more']>, 'kind' | 'command'> & { keptBudget?: string | null }; attempts: number; estimate: Estimate | null | undefined; onRun: (fields: Record<string, unknown>) => boolean; onClose: () => void }) {
  const stop = useStopAt(more.keptBudget);
  const label = more.kind === 'more' ? ACTIONS.runMoreAttempts.label : ACTIONS.verifyAgain.label;
  const lead = more.kind === 'more' ? moreLead(attempts) : 'Verifies the same runs again from the first attempt, once the judge answers.';
  return (
    <Dialog title={label} lead={lead} doc="verify" command={stop.command(more.command)} cost={{ price: 'Billed by your provider', estimate }} footNote={<AskNote estimate={estimate} />} ok={label} onOk={() => onRun(stop.fields)} onClose={onClose}>
      <StopAtField typed={stop.typed} setTyped={stop.setTyped} />
    </Dialog>
  );
}

/** Verify this run's title, a fix's and a preview's: `Verify change on <id>`, or on N runs. */
export function VerifyChangeTitle({ runs }: { runs: readonly string[] }) {
  if (runs.length !== 1) return <>{`Verify change on ${runs.length} runs`}</>;
  return (
    <>
      Verify change on <code>{shortId(runs[0]!)}</code>
    </>
  );
}

/**
 * Verify this run's ask, above the threshold or with no estimate (`Verify change on <run>`): the
 * failing runs no accepted verify checked, verified on the code as it is now, its Cost line the
 * estimate, and its way on the first focus.
 */
export function VerifyLeftAsk({ left, estimate, onRun, onClose }: { left: { runs: readonly string[]; command: string }; estimate: Estimate | null | undefined; onRun: (fields: Record<string, unknown>) => boolean; onClose: () => void }) {
  const stop = useStopAt(null);
  const one = left.runs.length === 1;
  const title = <VerifyChangeTitle runs={left.runs} />;
  const label = leftLabel(left.runs);
  const lead = one ? 'Verifies the code as it is now on the failing run the change wasn’t verified on.' : 'Verifies the code as it is now on the failing runs the change wasn’t verified on.';
  return (
    <Dialog title={title} lead={lead} doc="verify" command={stop.command(left.command)} cost={{ price: 'Billed by your provider', estimate }} footNote={<AskNote estimate={estimate} />} ok={label} onOk={() => onRun(stop.fields)} onClose={onClose}>
      <StopAtField typed={stop.typed} setTyped={stop.setTyped} />
    </Dialog>
  );
}

/**
 * Verify your change's ask, above the threshold or with no estimate: a change made by hand, verified
 * on the code as it is now on the fix's failing runs, the runs held out and the good runs it keeps,
 * under its check; its Cost line the estimate, and Stop at $.
 */
export function VerifyChangeAsk({ change, estimate, onRun, onClose }: { change: { runs: readonly string[]; command: string }; estimate: Estimate | null | undefined; onRun: (fields: Record<string, unknown>) => boolean; onClose: () => void }) {
  const stop = useStopAt(null);
  const label = ACTIONS.verifyYourChange.label;
  return (
    <Dialog title={label} lead="Verifies your change, the code as it is now, on the failing runs, the runs held out and the good runs kept, under the fix’s check." doc="verify" command={stop.command(change.command)} cost={{ price: 'Billed by your provider', estimate }} footNote={<AskNote estimate={estimate} />} ok={label} onOk={() => onRun(stop.fields)} onClose={onClose}>
      <StopAtField typed={stop.typed} setTyped={stop.setTyped} />
    </Dialog>
  );
}
