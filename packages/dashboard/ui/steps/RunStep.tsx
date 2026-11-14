import { reasonField } from '../update-reason.js';
import { type ReactNode, useMemo, useState } from 'react';
import { consentAsked } from '../actions.js';
import { JOB_KINDS } from '../api.js';
import { ConsentDialog } from '../components/Dialog.js';
import { tipCard } from '../components/HoverCard.js';
import { JobButton } from '../components/JobButton.js';
import { treeBusy } from '../fixes/model.js';
import { RunBlameButton } from '../fixes/RunBlame.js';
import { useServerJobs } from '../fixes/tree.js';
import { goldenName } from '../format.js';
import { testsBusy } from '../goldens.js';
import { CrashStepButton } from '../revert/CrashStep.js';
import { stepCard, stepJob } from '../run/next-step.js';
import { blameTitle } from '../run/offers.js';
import { sentEstimate } from '../spending.js';
import { useApp } from '../state.js';
import { useAsking, usePriced } from '../step-asks.js';
import { bannerNormalizerAsk, gateAgainAsk, rerunAsk, sessionAsk, startTestsJob } from '../tests-ask.js';
import type { Price } from '../tests-estimates.js';
import type { NextStep } from '../types.js';
import { updatePlan } from '../update-plan.js';

/**
 * A run's step drawn in a list's row, small and plain, as its page leads with it: Needs a look's
 * (overview/steps.tsx) and Runs › Failed's issues' (runspage/IssuesTable.tsx). A list carries no
 * estimate, so a step asks for its own when the pointer or the focus reaches it, and a press before
 * it came waits for it; its card then says its sentence, its cost and its command. A list reads the
 * server's jobs once, for every row (`useLookWaits`). A crash's Find breaking commit and Revert are
 * revert/CrashStep.tsx's, as a fix's row whose lead they are draws them. The dialogs a step asks in
 * load as it first asks: neither list's script holds a run's page. What a step reads as it is looked
 * at or pressed, its estimate and the dialog it asks in, is step-asks.ts'.
 */

/** What a step bills: undefined until its estimate comes, null for none. */
export type { Price };

/** What a step that runs a job waits for, by the verb its reason says it in; `use`, how it uses the working tree. */
export interface Job {
  verb: string;
  tests: boolean;
  use?: 'reads' | 'writes';
}

/** Why a job can't start now, as the server would refuse it, from the section's one read of the jobs. */
export type LookWait = (job: Job | null) => string | null;

/** The section's one read of the server's jobs (trap 13), mounted only while a row carries a job step. */
export function useLookWaits(): LookWait {
  const { meta } = useApp();
  const jobs = useServerJobs();
  const path = meta?.project?.path ?? null;
  const id = meta?.project?.id ?? null;
  return useMemo(() => (job) => (job ? ((job.tests ? testsBusy(jobs, job.verb, id) : null) ?? treeBusy(jobs, job.use ?? 'reads', job.verb, path)) : null), [jobs, path, id]);
}

/**
 * The run steps a row runs from here, Run tests among them, Tests' whole session, where a golden's
 * checks changed since its last test; Edit check opens the check builder on Needs a look
 * (overview/steps.tsx `LookStepButton`); any other (a rule, a pack, an injection test, Replay,
 * Compare) opens its page.
 */
export const RUN_KINDS: Partial<Record<NextStep['key'], string>> = { blame: JOB_KINDS.blame, normalizer: JOB_KINDS.normalizeAndTest, 'update-golden': JOB_KINDS.testUpdate, 'rerun-test': JOB_KINDS.tests, 'gate-again': JOB_KINDS.tests, 'run-tests': JOB_KINDS.tests, bisect: JOB_KINDS.bisect, revert: JOB_KINDS.revert };

/** Why a list row's step can't start now: a job this dashboard doesn't run, else what `wait` says of the server's jobs; null where it can. */
export function stepWhy(hasKind: (kind: string) => boolean, run: { kind: string; job: Job | null }, wait: LookWait): string | null {
  return (hasKind(run.kind) ? null : 'This dashboard doesn’t run it: run the command in a terminal.') ?? wait(run.job);
}

/** The job a run's step runs from a list's row, and what it waits for; null for one that opens its page instead (a rule, a pack, an injection test, Replay, Compare). */
export function runStepJob(step: NextStep): { kind: string; job: Job | null } | null {
  const kind = RUN_KINDS[step.key];
  return kind ? { kind, job: stepJob(step) } : null;
}

/** A job's start, with the yes a job asks for before it runs someone else's command (409), in its own dialog. */
export function usePost(kind: string, ok: string): [(fields: Record<string, unknown>) => void, ReactNode] {
  const app = useApp();
  const [consent, setConsent] = useState<{ why: string; confirm: string; fields: Record<string, unknown> } | null>(null);
  const post = (fields: Record<string, unknown>) =>
    void app.client.startJob(kind, fields).then(
      (job) => app.watchJob(Promise.resolve(job)),
      (err: unknown) => {
        const asked = fields.yes === undefined ? consentAsked(err) : null;
        if (asked) setConsent({ ...asked, fields });
        else app.watchJob(Promise.reject(err));
      },
    );
  const node = consent ? <ConsentDialog why={consent.why} ok={ok} onClose={() => setConsent(null)} onOk={() => app.guard(() => post({ ...consent.fields, yes: consent.confirm }))} /> : null;
  return [post, node];
}

/** Update golden's dialog, for a golden on Tests' own plan: what it re-records, or the judge it asks once. */
export function updateAsk(app: ReturnType<typeof useApp>, golden: string, estimate: Price): (close: () => void) => Promise<ReactNode> {
  return async (close) => {
    const [view, m] = await Promise.all([app.client.tests(), import('../components/UpdateGolden.js')]);
    const update = (reason: string) => {
      const went = startTestsJob(app, JOB_KINDS.testUpdate, { golden, ...reasonField(reason), ...sentEstimate(estimate) });
      if (went) close();
      return went;
    };
    return <m.UpdateGoldenDialog plan={updatePlan(view, [golden], app.hasKind)} estimate={estimate} onUpdate={update} onClose={close} />;
  };
}

/**
 * A run's step as its page leads with it: Run blame, Add normalizer and re-run, Update golden, Re-run
 * test, Run tests, Find breaking commit or Revert, each taking the step and the run's id, not the
 * run's page, priced from the run's own next step (`GET /api/runs/:id/next`). A crash's Find
 * breaking commit and Revert are revert/CrashStep.tsx's, as on a fix's row: Revert always opens its
 * dialog, with the commit its run's offers name. Small and plain, or as its list draws its lead
 * (`className`).
 */
export function RunStep({ s, why, className = 'btn sm' }: { s: { runId: string; step: NextStep }; why: string | null; className?: string }) {
  const { runId, step } = s;
  if (step.key === 'bisect' || step.key === 'revert') return <CrashStepButton runId={runId} step={step} why={why} className={className} />;
  return <JobStep runId={runId} step={step} why={why} className={className} />;
}

/** Any other run's step that starts a job from a list's row; `Open →` for one that opens its page instead. */
function JobStep({ runId, step, why, className }: { runId: string; step: NextStep; why: string | null; className: string }) {
  const app = useApp();
  const priced = usePriced(() => app.client.nextStep(runId).then((r) => (r.next?.key === step.key ? (r.next.estimate ?? null) : null)));
  const [asking, show] = useAsking();
  const e = priced.estimate;
  const c = stepCard(e ? { ...step, estimate: e } : step);
  if (step.key === 'blame') {
    return <RunBlameButton runId={runId} offer={step.offer} estimate={e} busy={why} on={priced.on} when={priced.when} title={blameTitle(step.offer)} tip={tipCard(c.title, c.rows, c.sub, c.cmd, c.est)} className={className} {...(step.command ? { line: step.command } : {})} />;
  }
  const card = { tip: c.title, sub: c.sub, command: c.cmd ?? undefined };
  let go: (p: Price) => void;
  if (step.key === 'normalizer') go = (p) => void startTestsJob(app, JOB_KINDS.normalizeAndTest, { runId, ...sentEstimate(p) }, { ...bannerNormalizerAsk(step.test), estimate: p });
  else if (step.key === 'update-golden') go = (p) => show(updateAsk(app, step.golden, p));
  else if (step.key === 'rerun-test' || step.key === 'gate-again') {
    const name = goldenName(step.golden);
    go = (p) => void startTestsJob(app, JOB_KINDS.tests, { golden: step.golden, ...sentEstimate(p) }, { ...(step.key === 'gate-again' ? gateAgainAsk(name, step.golden) : rerunAsk(name, step.golden)), estimate: p });
  } else if (step.key === 'run-tests') go = (p) => void startTestsJob(app, JOB_KINDS.tests, sentEstimate(p), { ...sessionAsk(step.command ?? ''), estimate: p });
  else return <span className="go">Open →</span>;
  return (
    <>
      <JobButton className={className} why={why} {...card} estimate={e} {...priced.on} start={() => go(e)} ask={priced.when(go)}>
        {step.label}
      </JobButton>
      {asking}
    </>
  );
}
