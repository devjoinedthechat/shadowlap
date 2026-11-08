import { useState } from 'react';
import { JOB_KINDS } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { tipCard } from '../components/HoverCard.js';
import { useJobWait } from '../fixes/tree.js';
import { ACTIONS } from '../labels.js';
import { stepCard, stepJob } from '../run/next-step.js';
import { useServedParts } from '../served-parts.js';
import { tipEst } from '../spending.js';
import { useApp } from '../state.js';
import type { Price } from '../tests-estimates.js';
import type { FoundCommit, NextStep } from '../types.js';

/**
 * What the page's lead says it reverts, so that Find breaking commit's drawer ends on the lead of its
 * own answer only (bisect-footer.tsx): the golden, the commit, and when the answer was kept (none
 * until the page has read it).
 */
const leadOf = (step: Extract<NextStep, { key: 'revert' }>, found: FoundCommit | null) => ({ 'data-next': 'revert', 'data-golden': step.golden, 'data-rev': step.rev, ...(found ? { 'data-at': String(found.at) } : {}) });

/**
 * Revert, wherever a crash's named commit leads to it: lime where it leads (`lead`, which a list's ⌘K
 * presses by `data-next`), plain beside another step. It waits while any job uses the working tree,
 * and while a Tests job runs (`useJobWait`, as the palette's entry waits), and always opens its dialog
 * (RevertDialog.tsx), whatever Spending says: it changes your working tree. Its card gives what the
 * test bills as an amount alone, the dialog the rest. None where the dashboard runs no revert, and in
 * a copy, which holds no dialog to open (served-parts.ts).
 */
export function RevertButton({ step, found, estimate, runId, lead = false }: { step: Extract<NextStep, { key: 'revert' }>; found: FoundCommit | null; estimate: Price; runId: string | null; lead?: boolean }) {
  const app = useApp();
  const { RevertDialog } = useServedParts();
  const [open, setOpen] = useState(false);
  const wait = useJobWait(stepJob(step));
  if (!RevertDialog || !app.hasKind(JOB_KINDS.revert)) return null;
  const card = stepCard(step);
  return (
    <>
      <ActionButton className={lead ? 'btn lime' : 'btn'} why={wait} {...(lead ? leadOf(step, found) : {})} data-tip={tipCard(card.title, card.rows, card.sub, card.cmd, estimate ? tipEst(estimate, true) : card.est)} onClick={() => app.guard(() => setOpen(true))}>
        {ACTIONS.revert.label}
      </ActionButton>
      {open ? <RevertDialog step={step} found={found} estimate={estimate} runId={runId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
