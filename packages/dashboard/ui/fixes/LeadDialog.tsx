import { sentEstimate } from '../spending.js';
import type { FixDetail, FixLead } from '../types.js';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import { BlameAgainDialog, StrongerDialog } from './BlameAgain.js';
import { ApplyDialog, RepairDialog } from './FixDialogs.js';
import { VerifyAsk, VerifyLeftAsk } from './verify-asks.js';

/**
 * The dialog a list row's fix lead opens (RowStep.tsx): the one the fix's page opens for the same
 * button. In a script of its own that loads the first time it shows, so a list that leads with a
 * fix (the Overview's Needs a look) loads none of a fix's page until a step asks.
 */

/** What a press opened: an ask from the lead alone, or a dialog that shows the fix, with the label its page gives the button now (`label`). */
export type LeadOpen = { kind: 'ask'; estimate: Estimate | null | undefined } | { kind: 'fix'; fix: FixDetail; estimate: Estimate | null | undefined; label: string };

export function LeadDialog({ lead, open, run, close }: { lead: FixLead; open: LeadOpen; run: (fields: Record<string, unknown>) => boolean; close: () => void }) {
  const sent = sentEstimate(open.estimate);
  if (open.kind === 'fix') {
    if (lead.key === 'repair') return <RepairDialog fix={open.fix} onClose={close} onRun={(repairer, more) => run({ repairer, ...more })} />;
    if (lead.key === 'apply') return <ApplyDialog fix={open.fix} label={open.label} onClose={close} onRun={(names) => run(names ? { names } : {})} />;
    return <StrongerDialog fix={open.fix} onClose={close} onRun={(model, more) => run({ ...sent, model, ...more })} />;
  }
  if (lead.key === 'blame-again')
    return <BlameAgainDialog again={{ kind: lead.stopped ? 'stopped' : 'unsettled', gate: lead.gate, soFar: lead.soFar, lastGood: lead.lastGood, command: lead.command }} estimate={open.estimate} onRun={() => run(sent)} onClose={close} />;
  if (lead.key === 'more' || lead.key === 'again') return <VerifyAsk more={{ kind: lead.key, command: lead.command }} attempts={lead.attempts} estimate={open.estimate} onRun={() => run(sent)} onClose={close} />;
  if (lead.key === 'verify-left') return <VerifyLeftAsk left={lead} estimate={open.estimate} onRun={() => run(sent)} onClose={close} />;
  return null;
}
