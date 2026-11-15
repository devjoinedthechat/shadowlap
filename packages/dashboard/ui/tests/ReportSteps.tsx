import { useState, type ReactNode } from 'react';
import { ActionButton } from '../components/ActionButton.js';
import { tipCard } from '../components/HoverCard.js';
import { JobButton } from '../components/JobButton.js';
import { RunBlameButton } from '../fixes/RunBlame.js';
import { divergenceButtons, findCommitButton, findCommitWait } from '../goldens.js';
import { ACTIONS } from '../labels.js';
import { moreCard, normalizeCard, testsJob, updateCard } from '../pages/tests-cards.js';
import { FindCommitButton } from '../pages/TestsDialogs.js';
import { useServedParts } from '../served-parts.js';
import { useApp } from '../state.js';
import { goldenPrice } from '../tests-estimates.js';
import type { DivergenceView, FailureView, GoldenReport, InconclusiveView, NextStep, ReportPart, TestsAnswer } from '../types.js';
import { stepFor, type Lead } from './lead.js';
import { LeadButton, type LeadPress } from './Verdict.js';

/**
 * A report's next steps, plain (the verdict's lime is the page's): the golden's own step as the
 * server leads it (next-step.ts, the run page's rule), then what else its report offers, from the
 * page's own helpers: a divergence's normalizer, Update golden beside it, and Find breaking commit
 * (never where Update golden leads); a crash's Run blame beside its step, from the step's own offer; Find breaking
 * commit where it is offered, kept off with why for a pack that can't be read; Run more attempts and
 * Update golden for an inconclusive golden; an injection gate's Security report. A golden whose checks changed since its last test offers Run
 * tests alone, the whole session as the page's header runs it, as more attempts or a commit search
 * would judge checks the config no longer holds; one whose own recording fails a check added since
 * leads with Edit check…. Open proof is the header's link, never a step. A press opens the report,
 * so a job's end has a part to hand the focus to (⌘K presses these while it is folded).
 */
export function ReportSteps({ report, view, press, onPress }: { report: GoldenReport; view: TestsAnswer; press: LeadPress; onPress: () => void }) {
  const { hasKind: has } = useApp();
  const golden = report.golden;
  const step = view.steps?.[golden];
  const out = step?.key === 'run-tests' ? [press.runTests ? <RunTestsStep key="step" step={step} job={press.runTests} wait={press.wait} /> : null] : reportSteps(report, view, has, press);
  if (!out.some(Boolean)) return null;
  return (
    <div className="actions" onClickCapture={onPress}>
      {out}
    </div>
  );
}

/** Run tests, plain, as the page's header runs it, saying on its card what it judges. */
function RunTestsStep({ step, job, wait }: { step: Extract<NextStep, { key: 'run-tests' }>; job: NonNullable<LeadPress['runTests']>; wait: LeadPress['wait'] }) {
  return (
    <JobButton className="btn" why={wait('run the tests')} {...job} sub={step.sub}>
      {step.label}
    </JobButton>
  );
}

/** The golden's own step, plain, then its report's other buttons, an injection gate's Security report last. */
function reportSteps(report: GoldenReport, view: TestsAnswer, has: (kind: string) => boolean, press: LeadPress): ReactNode[] {
  const golden = report.golden;
  const d = view.divergences.find((x) => x.golden === golden);
  const f = view.failures.find((x) => x.golden === golden);
  const v = view.inconclusive.find((x) => x.golden === golden);
  const runId = (d ?? f ?? v)?.runId ?? null;
  const found = stepFor(view, golden, has, runId, !!press.edit);
  const lead = found?.kind === 'proof' ? null : found;
  const leads = (kind: Lead['kind']) => lead?.kind === kind;
  const at: Siblings = { has, press, leads, step: view.steps?.[golden] };
  const out: ReactNode[] = [lead ? <LeadButton key="step" lead={lead} p={press} lime={false} /> : null, ...(d ? divergenceSiblings(d, at) : []), ...(f ? failureSiblings(f, runId, at) : []), ...(v ? inconclusiveSiblings(v, at) : [])];
  const security = report.parts.find((p): p is Extract<ReportPart, { kind: 'injection-attempts' }> => p.kind === 'injection-attempts')?.security;
  if (security) out.push(<SecurityReport key="security" security={security} />);
  return out;
}

/** What a report's siblings of its step read: the jobs the server runs, the page's presses, whether the step is already of a kind, and the server's step. */
interface Siblings {
  has: (kind: string) => boolean;
  press: LeadPress;
  leads: (kind: Lead['kind']) => boolean;
  step: NextStep | undefined;
}

/**
 * A divergence's normalizer (or Re-run test once its rule is in), Update golden beside that step
 * only, as the mock offers it, and Find breaking commit, never where Update golden leads.
 */
function divergenceSiblings(d: DivergenceView, { has, press, leads, step }: Siblings): ReactNode[] {
  const b = divergenceButtons(d, has);
  const n = b.normalize;
  // Without the server's step, the normalizer's button is the first.
  const normalizer = step ? step.key === 'normalizer' || step.key === 'rerun-test' : !!n;
  return [
    n && !leads('normalize') ? (
      <JobButton key="normalize" className="btn" why={press.wait(n.run === 'rerun' ? 'run it again' : 'add the normalizer')} {...testsJob(normalizeCard(d, n), goldenPrice(press.prices, d.golden, n.run === 'rerun' ? 'rerun' : 'normalize'), (e) => press.onNormalize(d, e))}>
        {n.label}
      </JobButton>
    ) : null,
    b.update && normalizer && !leads('update') ? <UpdateButton key="update" golden={d.golden} judge={null} press={press} /> : null,
    b.bisect && !leads('bisect') && step?.key !== 'update-golden' ? <FindCommitButton key="bisect" f={d} live={press.live(d)} why={press.wait('find the breaking commit')} onBisect={() => press.onFind(d)} /> : null,
    step?.key !== 'update-golden' ? unreadFindCommit(d, has) : null,
  ];
}

/** Find breaking commit for a golden whose pack can't be read: kept in its place, its card and a press saying why it can't search (findCommitWait). */
function unreadFindCommit(f: DivergenceView | FailureView, has: (kind: string) => boolean): ReactNode {
  const why = findCommitWait(f, has);
  return why ? (
    <ActionButton key="unread" className="btn" why={why}>
      {ACTIONS.findBreakingCommit.label}
    </ActionButton>
  ) : null;
}

/** A crash's Run blame beside its step, from the step's own offer (none where a fix holds the run); Find breaking commit where it is offered. */
function failureSiblings(f: FailureView, runId: string | null, { has, press, leads, step }: Siblings): ReactNode[] {
  const blame = step?.key === 'bisect' || step?.key === 'revert' ? step.blame : null;
  return [
    blame && runId && has('blame') && !leads('blame') ? <RunBlameButton key="blame" runId={runId} offer={blame.offer} estimate={blame.estimate ?? null} line={blame.command} tip={tipCard(ACTIONS.runBlame.label, [], blame.sub, blame.command)} className="btn" /> : null,
    findCommitButton(f, has) && !leads('bisect') ? <FindCommitButton key="bisect" f={f} live={press.live(f)} why={press.wait('find the breaking commit')} onBisect={() => press.onFind(f)} /> : null,
    unreadFindCommit(f, has),
  ];
}

/** An inconclusive golden's Run more attempts, which carries its attempts over, and Update golden for a judge it couldn't ask offline. */
function inconclusiveSiblings(v: InconclusiveView, { has, press, leads }: Siblings): ReactNode[] {
  const more = v.gate?.more;
  return [
    more && has('test') && !leads('more') ? (
      <JobButton key="more" className="btn" why={press.wait('run the tests')} {...testsJob(moreCard(more), goldenPrice(press.prices, v.golden, 'more'), (e) => press.onMore(v, e))}>
        {ACTIONS.runMoreAttempts.label}
      </JobButton>
    ) : null,
    v.judge?.update && has('test-update') && !leads('update') ? <UpdateButton key="update" golden={v.golden} judge={v.judge.update} press={press} /> : null,
  ];
}

function UpdateButton({ golden, judge, press }: { golden: string; judge: readonly string[] | null; press: LeadPress }) {
  return (
    <JobButton className="btn" why={press.wait('update it')} {...testsJob(updateCard(golden, judge), goldenPrice(press.prices, golden, 'update'), (e) => press.onUpdate(golden, e))}>
      {ACTIONS.updateGolden.label}
    </JobButton>
  );
}

/**
 * Security report: the injection gate's kept result as its HTML report, in the dialog Share's opens
 * (injection/SecurityReportDialog.tsx, a part the served dashboard hands in, its script asked for as
 * the pointer or the focus reaches the button), which says what the file is for, what its rules mask
 * and each canary it keeps, then saves it. A script that didn't come says so in the shared toast,
 * the focus kept on the button (pages/served.tsx). None where the part isn't handed in.
 */
function SecurityReport({ security }: { security: { resultId: string; runId: string } }) {
  const { SecurityReportDialog } = useServedParts();
  const [open, setOpen] = useState(false);
  if (!SecurityReportDialog) return null;
  const ahead = () => SecurityReportDialog.preload();
  return (
    <>
      <button type="button" className="btn" onPointerEnter={ahead} onFocus={ahead} onClick={() => setOpen(true)}>
        {ACTIONS.securityReport.label}
      </button>
      {/* An injection gate's kept result is the plant test's, never a --clean answer's. */}
      {open ? <SecurityReportDialog resultId={security.resultId} mode="plant" runId={security.runId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
