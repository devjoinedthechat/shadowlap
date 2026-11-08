import { useSyncExternalStore } from 'react';
import { JOB_KINDS, type JobView } from '../api.js';
import { addJobFooter, type JobFooter } from '../job-actions.js';
import { ACTIONS } from '../labels.js';

/**
 * Where Find breaking commit's drawer ends, whichever page it ran from: once the search named the
 * first bad commit and the page has read it, on Revert, the step that took its place (the page's
 * lead, `data-next="revert"`, on a crash's run page and on Tests alike). Pressing it presses the
 * page's own, so it waits and asks as that does, and it claims the drawer's way on (`data-way`).
 * Else it draws nothing, and the CLI's link (Open Tests, Open run) is the way on. The served entry
 * (App.tsx) registers it, as a search runs from every page that leads with it, and a copy runs none.
 */

const LEAD = '#view [data-next="revert"]';

const leadNow = (): HTMLElement | null => document.querySelector<HTMLElement>(LEAD);

/** Draws again as the page does: its lead comes once the page has read what the search found. */
function subscribe(on: () => void): () => void {
  const view = document.querySelector('#view');
  if (!view || typeof MutationObserver === 'undefined') return () => undefined;
  const watch = new MutationObserver(on);
  watch.observe(view, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-next'] });
  return () => watch.disconnect();
}

/** Whether the search named a first bad commit: its result's `first` (a miss has none). */
const named = (job: JobView): boolean => !!(job.result as { first?: unknown } | null | undefined)?.first;

const BisectFooter: JobFooter = ({ job, plain }) => {
  const lead = useSyncExternalStore(subscribe, leadNow, () => null);
  if (!job.done || !named(job) || !lead) return null;
  return (
    <button type="button" className={plain ? 'btn' : 'btn lime'} data-way onClick={() => lead.click()}>
      {ACTIONS.revert.label}
    </button>
  );
};

addJobFooter(JOB_KINDS.bisect, BisectFooter);
