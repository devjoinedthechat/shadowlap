import { useEffect, useMemo, useState } from 'react';
import { isObject } from '../../../engine/src/is-object.js';
import { JOB_KINDS, type JobView } from '../api.js';
import { JobButton } from '../components/JobButton.js';
import { UpdateGoldenDialog } from '../components/UpdateGolden.js';
import { useLoad } from '../hooks.js';
import { addJobFooter } from '../job-actions.js';
import { ACTIONS } from '../labels.js';
import { testsJob } from '../pages/tests-cards.js';
import { href } from '../route.js';
import { sentEstimate } from '../spending.js';
import { useApp } from '../state.js';
import { updatesPrice, useTestsEstimates, type Price } from '../tests-estimates.js';
import { maskFirst } from '../update-plan.js';
import { updateOutdatedAsk } from './dialog-words.js';
import { leadWait } from './list.js';
import { outdatedOf } from './model.js';
import { onThisPage, readPageFixAgain, usePageFix } from './page-fix.js';
import { RowStep } from './RowStep.js';
import { useServerJobs } from './tree.js';

/**
 * What a fix's jobs end on in the drawer, each kind's footer registered here and nowhere else
 * (`addJobFooter` keeps one a kind, so what a later slice adds to these drawers composes here). A
 * blame, a repair and a verify end on the fix's next step while its page is on the screen; elsewhere
 * the CLI's Open fix leads, and they draw nothing. An apply ends on Update goldens, else Open goldens
 * in Tests. Only the Fixes chunk loads it (pages/Fixes.tsx), so a job of these kinds started before
 * Fixes or a fix was opened ends on the CLI's links alone.
 */

/** Open goldens in Tests: an apply's way on when no other golden diverged, the page being a name. */
export const OPEN_GOLDENS = 'Open goldens in Tests';

/** When this page first saw each job's end, by its own clock: the page's read of the fix says what the job left once it started since. */
const endsSeen = new Map<string, number>();
function endSeen(jobId: string): number {
  const at = endsSeen.get(jobId) ?? Date.now();
  endsSeen.set(jobId, at);
  return at;
}

/** A verify the gate accepted: its page leads with what comes next, so its drawer adds nothing. */
const accepted = (job: JobView): boolean => job.kind === JOB_KINDS.verify && isObject(job.result) && job.result.verdict === 'accepted';

/**
 * A blame's, a repair's or a verify's way on, on its fix's page: the fix's next step (`lead`), from the
 * page's own read once it was read since the job ended (else it asks the page to read it again), run or
 * asked as the page's button does, plain while the page leads with it. The page follows the job to what
 * it wrote (page-fix.ts), so the CLI's link into the fix is left out as this page's. Nothing after a
 * verify the gate accepted, off the fix's page, or for a job of no fix.
 */
function NextStepFooter({ job, plain }: { job: JobView; plain?: boolean }) {
  const app = useApp();
  const page = usePageFix();
  const fixId = job.done && job.fixId && page?.fix.fixId === job.fixId && onThisPage(href.fixes(job.fixId)) ? job.fixId : null;
  const fresh = !!fixId && !!page && page.at >= endSeen(job.id);
  useEffect(() => {
    if (fixId && !fresh) readPageFixAgain();
  }, [fixId, fresh]);
  const lead = fresh && !accepted(job) ? (page?.fix.lead ?? null) : null;
  const jobs = useServerJobs(!!lead);
  if (!fixId || !page || !lead) return null;
  const why = leadWait(lead, { jobs, folder: app.meta?.project?.path ?? null, hasKind: app.hasKind });
  return <RowStep fixId={fixId} lead={lead} why={why} version={String(page.at)} className={plain ? 'btn' : 'btn lime'} fix={page.fix} />;
}

/**
 * The apply drawer's last word. Where the patch made other goldens diverge, Update goldens re-records
 * them (`shadowlap test <goldens> --update`), asking first, as the Tests screen's Update goldens does;
 * its card and its dialog's Cost line say what re-recording them together would bill (`GET
 * /api/tests/estimates`, read once the apply has ended), and the job keeps the estimate shown. Where
 * the last replay of one diverged on a value made anew every run (their divergences on Tests, `GET
 * /api/tests`, read then too), the dialog leads with Add normalizer and update, one job that adds
 * each rule once and then updates them all (`test-update` with `normalize`). Where none diverged, an
 * apply that ended well opens the goldens it copied, in Tests, unless Tests is the page on the screen.
 */
function ApplyFooter({ job, plain, done }: { job: JobView; plain?: boolean; done?: () => void }) {
  const app = useApp();
  const [asking, setAsking] = useState<{ estimate: Price; ask: ReturnType<typeof updateOutdatedAsk> } | null>(null);
  const [started, setStarted] = useState(false);
  const outdated = outdatedOf(job.result);
  const names = outdated.map((g) => g.golden).join('\n');
  const paths = useMemo(() => (names ? names.split('\n') : []), [names]);
  const shows = job.done && paths.length > 0 && app.hasKind(JOB_KINDS.testUpdate);
  const prices = useTestsEstimates(shows ? job.id : null, paths);
  const tests = useLoad(() => (shows ? app.client.tests() : null), shows ? `apply-goldens:${job.id}` : '').data;
  const lime = plain ? 'btn' : 'btn lime';
  if (job.done && job.code === 0 && !paths.length && !onThisPage(href.tests()))
    return (
      <a className={lime} href={href.tests()} onClick={() => done?.()}>
        {OPEN_GOLDENS}
      </a>
    );
  if (!shows) return null;
  // The dialog keeps what it opened with, so a read that lands while it is open never moves its buttons.
  const ask = updateOutdatedAsk(outdated, tests ? maskFirst(tests, paths, app.hasKind) : undefined);
  const card = { tip: ACTIONS.updateGoldens.label, command: ask.command };
  const start = (fields: Record<string, unknown>, estimate: Price) => {
    const went = app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.testUpdate, { ...fields, ...sentEstimate(estimate) })));
    if (went) setStarted(true);
    return went;
  };
  const instead = asking?.ask.instead;
  return (
    <>
      <JobButton className={lime} disabled={started} {...testsJob(card, updatesPrice(prices, paths), (e) => app.guard(() => setAsking({ estimate: e, ask })))}>
        {ACTIONS.updateGoldens.label}
      </JobButton>
      {asking ? (
        <UpdateGoldenDialog
          plan={asking.ask}
          estimate={asking.estimate}
          onClose={() => setAsking(null)}
          onUpdate={() => start(asking.ask.fields, asking.estimate)}
          {...(instead?.run === 'normalize-update-all' ? { onInstead: () => start({ goldens: instead.goldens, normalize: true }, asking.estimate) } : {})}
        />
      ) : null}
    </>
  );
}

addJobFooter(JOB_KINDS.blame, NextStepFooter);
addJobFooter(JOB_KINDS.repair, NextStepFooter);
addJobFooter(JOB_KINDS.verify, NextStepFooter);
addJobFooter(JOB_KINDS.applyFix, ApplyFooter);
