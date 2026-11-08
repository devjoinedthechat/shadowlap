import { useSyncExternalStore } from 'react';
import { JOB_KINDS, type JobView } from '../api.js';
import { addJobFooter, type JobFooter } from '../job-actions.js';
import { ACTIONS } from '../labels.js';

/**
 * Where Find breaking commit's drawer ends, whichever page it ran from: once the search named a
 * golden's first bad commit and the page has read that answer, on Revert, the step that took its
 * place (the page's lead, `data-next="revert"`, on a crash's run page and on Tests alike). Only the
 * lead of that answer: the golden searched, the commit named, kept once the search had started
 * (RevertButton.tsx's `data-golden`, `data-rev` and `data-at`), never another golden's, nor the lead
 * of an older answer the page still shows. Pressing it presses the page's own, so it waits and asks
 * as that does, and it claims the drawer's way on (`data-way`). Else it draws nothing, and the CLI's
 * link (Open Tests, Open run) is the way on. The served entry (App.tsx) registers it, as a search
 * runs from every page that leads with it, and a copy runs none.
 */

const LEADS = '#view [data-next="revert"]';

/** What lead attributes the footer reads: the page redraws them as it reads a new answer. */
const READ = ['data-next', 'data-golden', 'data-rev', 'data-at'];

/** Draws again as the page does: its lead comes once the page has read what the search found. */
function subscribe(on: () => void): () => void {
  const view = document.querySelector('#view');
  if (!view || typeof MutationObserver === 'undefined') return () => undefined;
  const watch = new MutationObserver(on);
  watch.observe(view, { subtree: true, childList: true, attributes: true, attributeFilter: READ });
  return () => watch.disconnect();
}

/** The answer a search gave, as its result says it: the golden it searched and the commit it named; null for a run's search, or one that named none. */
export function searchAnswer(job: Pick<JobView, 'result'>): { golden: string; rev: string } | null {
  const r = job.result as { target?: { kind?: unknown; name?: unknown }; first?: { short?: unknown } | null } | null | undefined;
  return r?.target?.kind === 'golden' && typeof r.target.name === 'string' && typeof r.first?.short === 'string' ? { golden: r.target.name, rev: r.first.short } : null;
}

/** The page's lead for that answer, kept no earlier than the search started (`startedAt`, as the answer's `at`, on the server's clock), or none. */
function leadFor(answer: { golden: string; rev: string } | null, startedAt: number): HTMLElement | null {
  if (!answer) return null;
  const leads = [...document.querySelectorAll<HTMLElement>(LEADS)];
  return leads.find((b) => b.getAttribute('data-golden') === answer.golden && b.getAttribute('data-rev') === answer.rev && Number(b.getAttribute('data-at') ?? -1) >= startedAt) ?? null;
}

const BisectFooter: JobFooter = ({ job, plain }) => {
  const answer = job.done ? searchAnswer(job) : null;
  const lead = useSyncExternalStore(subscribe, () => leadFor(answer, job.startedAt), () => null);
  if (!lead) return null;
  return (
    <button type="button" className={plain ? 'btn' : 'btn lime'} data-way onClick={() => lead.click()}>
      {ACTIONS.revert.label}
    </button>
  );
};

addJobFooter(JOB_KINDS.bisect, BisectFooter);
