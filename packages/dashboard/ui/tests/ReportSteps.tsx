import type { ReactNode } from 'react';
import { tipCard } from '../components/HoverCard.js';
import { JobButton } from '../components/JobButton.js';
import { RunBlameButton } from '../fixes/RunBlame.js';
import { divergenceButtons, findCommitButton } from '../goldens.js';
import { ACTIONS } from '../labels.js';
import { moreCard, normalizeCard, testsJob, updateCard } from '../pages/tests-cards.js';
import { FindCommitButton } from '../pages/TestsDialogs.js';
import { savedWords } from '../saved-words.js';
import { useApp } from '../state.js';
import { goldenPrice } from '../tests-estimates.js';
import { errorText } from '../toast.js';
import type { DivergenceView, FailureView, GoldenReport, InconclusiveView, NextStep, TestsAnswer } from '../types.js';
import { stepFor, type Lead } from './lead.js';
import { LeadButton, type LeadPress } from './Verdict.js';

/**
 * A report's next steps, plain (the verdict's lime is the page's): the golden's own step as the
 * server leads it (next-step.ts, the run page's rule), then what else its report offers, from the
 * page's own helpers: a divergence's normalizer, Update golden and Find breaking commit (never where
 * Update golden leads); a crash's Run blame beside its step, from the step's own offer; Find breaking
 * commit where it is offered; Run more attempts and Update golden for an inconclusive golden; an
 * injection gate's Security report. A press opens the report, so a job's end has a part to hand
 * the focus to (⌘K presses these while it is folded).
 */
export function ReportSteps({ report, view, press, onPress }: { report: GoldenReport; view: TestsAnswer; press: LeadPress; onPress: () => void }) {
  const { hasKind: has } = useApp();
  const golden = report.golden;
  const d = view.divergences.find((x) => x.golden === golden);
  const f = view.failures.find((x) => x.golden === golden);
  const v = view.inconclusive.find((x) => x.golden === golden);
  const runId = (d ?? f ?? v)?.runId ?? null;
  const lead = stepFor(view, golden, has, runId);
  const leads = (kind: Lead['kind']) => lead?.kind === kind;
  const step = view.steps?.[golden];
  const at: Siblings = { has, press, leads, step };
  const out: ReactNode[] = [lead ? <LeadButton key="step" lead={lead} p={press} lime={false} /> : null, ...(d ? divergenceSiblings(d, at) : []), ...(f ? failureSiblings(f, runId, at) : []), ...(v ? inconclusiveSiblings(v, at) : [])];
  const security = report.parts.find((p) => p.kind === 'injection-attempts')?.resultId;
  if (security) out.push(<SecurityReport key="security" resultId={security} />);
  if (!out.some(Boolean)) return null;
  return (
    <div className="actions" onClickCapture={onPress}>
      {out}
    </div>
  );
}

/** What a report's siblings of its step read: the jobs the server runs, the page's presses, whether the step is already of a kind, and the server's step. */
interface Siblings {
  has: (kind: string) => boolean;
  press: LeadPress;
  leads: (kind: Lead['kind']) => boolean;
  step: NextStep | undefined;
}

/** A divergence's normalizer (or Re-run test once its rule is in), Update golden, and Find breaking commit, never where Update golden leads. */
function divergenceSiblings(d: DivergenceView, { has, press, leads, step }: Siblings): ReactNode[] {
  const b = divergenceButtons(d, has);
  const n = b.normalize;
  return [
    n && !leads('normalize') ? (
      <JobButton key="normalize" className="btn" why={press.wait(n.run === 'rerun' ? 'run it again' : 'add the normalizer')} {...testsJob(normalizeCard(d, n), goldenPrice(press.prices, d.golden, n.run === 'rerun' ? 'rerun' : 'normalize'), (e) => press.onNormalize(d, e))}>
        {n.label}
      </JobButton>
    ) : null,
    b.update && !leads('update') ? <UpdateButton key="update" golden={d.golden} judge={null} press={press} /> : null,
    b.bisect && !leads('bisect') && step?.key !== 'update-golden' ? <FindCommitButton key="bisect" f={d} live={press.live(d)} why={press.wait('find the breaking commit')} onBisect={() => press.onFind(d)} /> : null,
  ];
}

/** A crash's Run blame beside its step, from the step's own offer (none where a fix holds the run); Find breaking commit where it is offered. */
function failureSiblings(f: FailureView, runId: string | null, { has, press, leads, step }: Siblings): ReactNode[] {
  const blame = step?.key === 'bisect' || step?.key === 'revert' ? step.blame : null;
  return [
    blame && runId && has('blame') && !leads('blame') ? <RunBlameButton key="blame" runId={runId} offer={blame.offer} estimate={blame.estimate ?? null} line={blame.command} tip={tipCard(ACTIONS.runBlame.label, [], blame.sub, blame.command)} className="btn" /> : null,
    findCommitButton(f, has) && !leads('bisect') ? <FindCommitButton key="bisect" f={f} live={press.live(f)} why={press.wait('find the breaking commit')} onBisect={() => press.onFind(f)} /> : null,
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

/** Security report: the injection gate's kept result as its HTML report, saved as Share's is, with whether the project's rules masked it. */
function SecurityReport({ resultId }: { resultId: string }) {
  const { client, guard, toast } = useApp();
  const save = () => guard(() => void client.injectionReport(resultId).then((r) => toast(savedWords(r)), (err: unknown) => toast(errorText(err), 'error')));
  return (
    <button type="button" className="btn" onClick={save}>
      Security report
    </button>
  );
}
