import { useEffect, useRef } from 'react';
import { isObject } from '../../../engine/src/is-object.js';
import { MANY_READS } from '../../src/injection-defaults.js';
import { JOB_KINDS, type JobView } from '../api.js';
import { tipCard } from '../components/HoverCard.js';
import { addJobFooter, type JobFooter } from '../job-actions.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { currentRoute } from '../router.js';
import { useKeptStep } from '../run/kept-step.js';
import { openResults } from '../run/panel-state.js';
import type { NextStep } from '../types.js';

/*
 * What an injection test's drawer, a cause's and Pack with injection gate's end on, over the run's
 * page: the step that page leads with once it has read what the job left, pressed as the page's own
 * lime button is, so it asks and waits as that does. Open proof is the CLI's link, so a footer holds
 * only what starts a job. Registered by the dialogs that start these jobs (TestDialog.tsx,
 * StepDialogs.tsx), parts a copy never draws: a copy runs nothing.
 */

/** The steps each job's end offers, as its run's page leads with them. */
const OFFERED: Readonly<Record<'test' | 'gate', ReadonlySet<NextStep['key']>>> = {
  // A test that showed too little runs again as it ran; a cause's answer that a read caused a write packs the run with its gate.
  test: new Set<NextStep['key']>(['injection-again', 'pack-gate']),
  // A gate that showed too little: Re-run test.
  gate: new Set<NextStep['key']>(['gate-again']),
};

/** The card each offered step says: what it runs again. */
const SUBS: Partial<Record<NextStep['key'], string>> = {
  'injection-again': 'The same command once more',
  'pack-gate': 'A golden with an injection gate: it fails while the agent obeys a planted instruction',
  'gate-again': 'Runs the golden and its injection gate again',
};

/** Whether the page on the screen is `runId`'s. */
function onRunPage(runId: string | null): runId is string {
  const r = currentRoute();
  return !!runId && r.page === 'run' && r.id === runId;
}

/**
 * The results a test of one run opens at its end on that run's page: a plant of eight reads or fewer
 * that ran an attempt (a test of more waits under its finding to be opened), keyed as the finding's
 * toggle opens them.
 */
export function resultsToOpen(result: unknown): { runId: string; key: string } | null {
  const r = isObject(result) ? result : null;
  const reports = Array.isArray(r?.results) ? r.results : [];
  const one: unknown = reports.length === 1 ? reports[0] : null;
  if (!isObject(one) || one.mode !== 'plant' || typeof one.runId !== 'string' || typeof one.resultId !== 'string') return null;
  const attempts = isObject(r?.totals) ? Number(r.totals.attempts) : 0;
  return Array.isArray(one.reads) && one.reads.length <= MANY_READS && attempts > 0 ? { runId: one.runId, key: `injection:${one.resultId}` } : null;
}

/** Opens the results of a test that ends while its drawer is open over its run's page: once, as it ends, never for one that had ended before. */
function useResultsAtEnd(job: JobView): void {
  const running = useRef(!job.done);
  useEffect(() => {
    if (!job.done || !running.current) return;
    running.current = false;
    const open = job.code === 0 || job.code === 1 || job.code === 3 ? resultsToOpen(job.result) : null;
    if (open && onRunPage(open.runId)) openResults(open.runId, open.key);
  }, [job.done, job.code, job.result]);
}

/** The step the run's page leads with, read since the job ended, where this job's end offers it: none elsewhere, or before the page has read it. */
function StepFooter({ job, plain, offered }: { job: JobView; plain?: boolean | undefined; offered: ReadonlySet<NextStep['key']> }) {
  const kept = useKeptStep();
  if (!job.done || !kept || !offered.has(kept.key) || kept.runId !== job.runId || kept.at < (job.endedAt ?? 0) || !onRunPage(job.runId)) return null;
  const key = kept.key;
  return (
    <button type="button" className={plain ? 'btn' : 'btn lime'} data-tip={tipCard(confirmWords(kept.label), [], SUBS[key] ?? null)} onClick={() => document.querySelector<HTMLElement>(`#view [data-next="${key}"]`)?.click()}>
      {kept.label}
    </button>
  );
}

const TestFooter: JobFooter = ({ job, plain }) => {
  useResultsAtEnd(job);
  return <StepFooter job={job} plain={plain} offered={OFFERED.test} />;
};

/** Pack as golden… ends on the CLI's links; Pack with injection gate…, the same kind, on Re-run test where its gate showed too little. */
const PackFooter: JobFooter = ({ job, plain }) => (job.title === ACTIONS.packWithGate.doing ? <StepFooter job={job} plain={plain} offered={OFFERED.gate} /> : null);

addJobFooter(JOB_KINDS.injection, TestFooter);
addJobFooter(JOB_KINDS.keepGolden, PackFooter);
