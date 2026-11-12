import { useRef, useState } from 'react';
import { JOB_KINDS } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { tipCard } from '../components/HoverCard.js';
import type { StepHooks } from '../components/JobButton.js';
import { useJobWait } from '../fixes/tree.js';
import { ACTIONS } from '../labels.js';
import { stepCard, stepJob } from '../run/next-step.js';
import { useServedParts } from '../served-parts.js';
import { tipEst } from '../spending.js';
import { useApp } from '../state.js';
import type { Price } from '../tests-estimates.js';
import { errorText } from '../toast.js';
import type { FoundCommit, NextStep } from '../types.js';

/**
 * What the page's lead says it reverts, so that Find breaking commit's drawer ends on the lead of its
 * own answer only (bisect-footer.tsx): the golden, the commit, and when the answer was kept (none
 * until the page has read it).
 */
const leadOf = (step: Extract<NextStep, { key: 'revert' }>, found: FoundCommit | null) => ({ 'data-next': 'revert', 'data-golden': step.golden, 'data-rev': step.rev, ...(found ? { 'data-at': String(found.at) } : {}) });

/**
 * Revert, wherever a crash's named commit leads to it: lime where it leads (`lead`, which a list's ⌘K
 * presses by `data-next`), plain beside another step, or as `className` says away from its run (a
 * row, a drawer: never `lead` there, so a page holds one). It waits while any job uses the working
 * tree, and while a Tests job runs (`useJobWait`, as the palette's entry waits), or as `why` says
 * where a list read the jobs once for every row; and always opens its dialog (RevertDialog.tsx),
 * whatever Spending says: it changes your working tree. `read` gets what the dialog shows first (the
 * commit, the estimate), the button busy meanwhile. Its card gives what the test bills as an amount
 * alone, the dialog the rest. None where the dashboard runs no revert, and in a copy, which holds no
 * dialog to open (served-parts.ts).
 */
export function RevertButton(p: {
  step: Extract<NextStep, { key: 'revert' }>;
  found: FoundCommit | null;
  estimate: Price;
  runId: string | null;
  lead?: boolean;
  className?: string;
  why?: string | null;
  on?: StepHooks;
  read?: () => Promise<FoundCommit | null>;
}) {
  const { step, found, estimate, runId, lead = false, why, read } = p;
  const app = useApp();
  const { RevertDialog } = useServedParts();
  const [open, setOpen] = useState<{ found: FoundCommit | null } | null>(null);
  const [reading, setReading] = useState(false);
  const out = useRef(false);
  const own = useJobWait(why === undefined ? stepJob(step) : null);
  if (!RevertDialog || !app.hasKind(JOB_KINDS.revert)) return null;
  const card = stepCard(step);
  const press = () => {
    if (!read) return setOpen({ found });
    if (out.current) return;
    out.current = true;
    setReading(true);
    void read()
      .then(
        (f) => setOpen({ found: f }),
        (err: unknown) => app.toast(errorText(err), 'error'),
      )
      .finally(() => {
        out.current = false;
        setReading(false);
      });
  };
  return (
    <>
      <ActionButton
        className={p.className ?? (lead ? 'btn lime' : 'btn')}
        why={why === undefined ? own : why}
        aria-busy={reading || undefined}
        {...(lead ? leadOf(step, found) : {})}
        {...p.on}
        data-tip={tipCard(card.title, card.rows, card.sub, card.cmd, estimate ? tipEst(estimate, true) : card.est)}
        onClick={() => app.guard(press)}
      >
        {ACTIONS.revert.label}
      </ActionButton>
      {open ? <RevertDialog step={step} found={read ? open.found : found} estimate={estimate} runId={runId} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
