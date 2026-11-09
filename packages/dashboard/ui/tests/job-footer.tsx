import { useSyncExternalStore } from 'react';
import { JOB_KINDS } from '../api.js';
import { addJobFooter, type JobFooter } from '../job-actions.js';
import { currentRoute } from '../router.js';

/**
 * Where a test job's drawer ends, over Tests: on the step the page leads with once it has read what
 * the job changed (the first failure's next step, as the verdict draws it), so the drawer sits over
 * the page and still ends on what to do next. Update goldens ends the same way, on the step of the
 * first golden still failing after it. On another page the drawer's link to Tests is the way on, and
 * this draws nothing. Pressing it presses the verdict's own step, so it asks and waits as that does.
 */

/** The step Tests leads with as its view was last read (`at`, this browser's clock), or none. */
let lead: { label: string; at: number } | null = null;
const listeners = new Set<() => void>();

/** What Tests' verdict leads with, each time the page reads its view; null once it leads with nothing or closes. */
export function keepLead(label: string | null): void {
  lead = label ? { label, at: Date.now() } : null;
  for (const on of listeners) on();
}

const subscribe = (on: () => void) => {
  listeners.add(on);
  return () => {
    listeners.delete(on);
  };
};

/** The verdict's step on the page: its lime button, or the same button waiting. */
export const verdictStep = (): HTMLElement | null => document.querySelector<HTMLElement>('.verdict.tv > .actions button, .verdict.tv > .actions a');

const TestsJobFooter: JobFooter = ({ job, plain }) => {
  const now = useSyncExternalStore(subscribe, () => lead);
  // Read after the job ended: the page's view from before it would lead with what the job just did.
  if (!job.done || !now || now.at < (job.endedAt ?? 0) || currentRoute().page !== 'tests') return null;
  return (
    <button type="button" className={plain ? 'btn' : 'btn lime'} onClick={() => verdictStep()?.click()}>
      {now.label}
    </button>
  );
};

addJobFooter(JOB_KINDS.tests, TestsJobFooter);
addJobFooter(JOB_KINDS.testUpdate, TestsJobFooter);
