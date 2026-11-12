import { useEffect, useMemo, useState } from 'react';
import { consentAsked } from '../actions.js';
import { JOB_KINDS, type RunDetail, type RunOffers } from '../api.js';
import { ActionButton, useOfflineLink } from '../components/ActionButton.js';
import { useBilledPress } from '../components/JobButton.js';
import { tipCard, tipText } from '../components/HoverCard.js';
import { Icon, type IconName } from '../components/Icon.js';
import { goldenName, shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { RunBlameButton } from '../fixes/RunBlame.js';
import { TestsJobButton } from '../fixes/TestsJobButton.js';
import { useJobWait, useTreeBusy } from '../fixes/tree.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { href } from '../route.js';
import { compareTarget, outcomeOf } from '../runs.js';
import { shortcut } from '../shortcuts.js';
import { sentEstimate } from '../spending.js';
import { useApp } from '../state.js';
import { gateAgainAsk, rerunAsk, startTestsJob } from '../tests-ask.js';
import type { NextStep } from '../types.js';
import type { PendingAction } from './actions.js';
import { useDivergedJobs } from './diverged.js';
import { checksOf, runLikeOf } from './model.js';
import { blameBesideCard, replayAction, stepCard, stepEstimate, stepJob, type StepCard } from './next-step.js';
import { keepStep } from './kept-step.js';
import { blameTitle } from './offers.js';
import { PackAsGolden, StepDialogPart } from './PackAsGolden.js';
import { PackWithGatePart, TestDialogPart } from '../injection/test-part.js';
import { packRunCommand } from './share-steps.js';

/**
 * The header's one lime button, drawn from the step the server worked out (src/next-step.ts): a link
 * to what it opens, or the job it runs, each waiting as that job's own button waits. Its hover says
 * what it does, what it bills and what it runs. `data-next` names the step, for the palette to press.
 */

/**
 * The run with its next step whole: what a page's answer leaves out where it would read a long run's
 * calls (`later`), what it bills or a verdict that changes what leads, is asked for alone, as its
 * outcome is (useJudged), and again whenever the page's answer moves. Nothing else asks again: on a
 * run nothing moves, no page loads.
 */
export function useWholeStep(run: RunDetail): RunDetail {
  const { client } = useApp();
  const ask = !!run.next?.later && run.run.status !== 'running';
  const asked = useLoad(() => (ask ? client.nextStep(run.run.runId) : null), ask ? run.run.runId : 'none', run.next);
  const whole = ask ? asked.data?.next : null;
  const done = useMemo(() => (whole ? { ...run, next: whole } : run), [run, whole]);
  // Kept for a drawer whose job ended here, to offer what the page now leads with (ui/injection/job-footer.tsx).
  useEffect(() => keepStep(done.run.runId, done.next ?? null), [done]);
  useEffect(() => () => keepStep(null, null), []);
  return done;
}

/**
 * Why a run's next step can't start now, as its button says it, for what offers the step elsewhere:
 * what it runs waiting for a job, or Replay's or the rule's own action saying why not.
 */
export function useStepWait(run: RunDetail, step: NextStep | null): string | null {
  const wait = useJobWait(stepJob(step));
  if (!step || step.href) return null;
  const own = step.key === 'replay' ? 'r' : step.key === 'rule' ? 'n' : null;
  return wait ?? (own ? (run.actions.find((a) => a.key === own)?.disabled ?? null) : null);
}

/** A step's hover card. */
function tipOf(card: StepCard): string {
  return tipCard(card.title, card.rows, card.sub, card.cmd, card.est);
}

const ICONS: Partial<Record<NextStep['key'], IconName>> = { compare: 'compare', fix: 'loop' };

interface StepProps {
  run: RunDetail;
  step: NextStep;
  offers: RunOffers | null;
  onAction: (p: PendingAction) => void;
  onFindCommit: () => void;
}

/** Replay, as the header keeps it: the lime one where nothing else needs doing, else plain. On a clean or a test replay it replays the recording that replay came from. */
export function ReplayButton({ run, step, lime, onAction }: { run: RunDetail; step: NextStep | null; lime: boolean; onAction: (p: PendingAction) => void }) {
  const action = replayAction(step) ?? run.actions.find((a) => a.key === 'r');
  const target = step?.key === 'replay' && step.runId !== run.run.runId ? { runId: step.runId } : {};
  return (
    <ActionButton
      className={lime ? 'btn lime' : 'btn'}
      why={step?.off ?? action?.disabled}
      disabled={!action}
      {...(lime ? { 'data-next': 'replay' } : { 'data-fold': 'replay' })}
      {...(step ? { 'data-tip': tipOf(stepCard(step)) } : action ? { 'data-tip': tipText(ACTIONS.replay.label) } : {})}
      onClick={() => action && onAction({ action, callNo: null, ...target })}
      {...shortcut('replay')}
    >
      <Icon name="replay" />
      {step?.label ?? 'Replay'}
    </ActionButton>
  );
}

/**
 * Compare, plain beside a next step that isn't it: with its parent, else with the fork or the replay
 * made from it, with the `shadowlap diff` it matches and what that run was about on hover; off, saying
 * what would make something to compare, with nothing to compare yet. A copy holds what it holds.
 */
export function CompareButton({ run }: { run: RunDetail }) {
  const { exported, runs } = useApp();
  const r = run.run;
  const pair = compareTarget(r, run.children);
  if (!pair) {
    if (exported) return null;
    return (
      <button className="btn" type="button" data-fold="compare" disabled title={r.status === 'running' ? 'Nothing to compare yet: replay or fork it once it finishes' : 'Nothing to compare yet: replay it or fork it first'} {...shortcut('compare')}>
        {ACTIONS.compare.label}
      </button>
    );
  }
  const other = pair[0] === r.runId ? pair[1] : pair[0];
  const label = r.parentRunId ? ACTIONS.compareWithParent.label : run.children.find((c) => c.runId === other)?.kind === 'fork' ? ACTIONS.compareWithFork.label : ACTIONS.compareWithReplay.label;
  const tip = tipCard(`Against ${shortId(other)}`, [], runs?.find((x) => x.runId === other)?.about?.text, `$ shadowlap diff ${shortId(pair[0])} ${shortId(pair[1])}`);
  return (
    <a className="btn" href={href.compare(pair[0], pair[1])} data-fold="compare" data-tip={tip} {...shortcut('compare')}>
      {label}
    </a>
  );
}

/** Add normalizer and re-run, and Update golden: the jobs of a test that diverged. */
function DivergedStep({ run, step, offers }: StepProps & { step: Extract<NextStep, { key: 'normalizer' | 'update-golden' }> }) {
  const app = useApp();
  // The server's, until the page's offers come.
  const test = offers?.test ?? step.test;
  const jobs = useDivergedJobs(run, test, checksOf(run).length, step.key === 'normalizer' ? { normalize: stepEstimate(step) } : { update: stepEstimate(step) });
  return (
    <>
      <TestsJobButton className="btn lime" verb={stepJob(step)!.verb} off={app.actionsOff} tip={tipOf(stepCard(step))} lead={step.key} onClick={step.key === 'normalizer' ? jobs.normalize : jobs.update}>
        {step.label}
      </TestsJobButton>
      {jobs.dialogs}
    </>
  );
}

/** Update golden where no divergence says what changed: a judge's verdict the pack lacks, which it asks once. It asks first, for what it does. */
function UpdateStep({ step }: { step: Extract<NextStep, { key: 'normalizer' | 'update-golden' }> }) {
  const app = useApp();
  const [asking, setAsking] = useState(false);
  return (
    <>
      <TestsJobButton className="btn lime" verb={stepJob(step)!.verb} off={app.actionsOff} tip={tipOf(stepCard(step))} lead={step.key} onClick={() => app.guard(() => setAsking(true))}>
        {step.label}
      </TestsJobButton>
      {asking ? <StepDialogPart ask={{ kind: 'update', step, onOk: () => app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.testUpdate, { golden: step.golden }))) }} onClose={() => setAsking(false)} /> : null}
    </>
  );
}

/** Re-run test: the golden's test again, a gate's too, asking first where it runs live (tests-ask.ts), by Spending where its price is known. */
function RerunStep({ step }: { step: Extract<NextStep, { key: 'rerun-test' | 'gate-again' }> }) {
  const app = useApp();
  const name = goldenName(step.golden);
  const estimate = stepEstimate(step);
  const say = { ...(step.key === 'gate-again' ? gateAgainAsk(name, step.golden) : rerunAsk(name, step.golden)), estimate };
  return (
    <TestsJobButton className="btn lime" verb={stepJob(step)!.verb} off={app.actionsOff} tip={tipOf(stepCard(step))} lead={step.key} onClick={() => startTestsJob(app, JOB_KINDS.tests, { golden: step.golden, ...sentEstimate(estimate) }, say)}>
      {step.label}
    </TestsJobButton>
  );
}

/**
 * Find breaking commit, for a test replay: from where its golden last passed, it starts on the click
 * by Spending, offline and free, else its dialog asks; with no commit to start from, its dialog asks
 * for one.
 */
function BisectStep({ run, step, offers, onFindCommit }: StepProps & { step: Extract<NextStep, { key: 'bisect' }> }) {
  const app = useApp();
  const press = useBilledPress();
  const runId = run.run.runId;
  const b = offers?.bisect ?? null;
  const good = step.starts && !b?.unavailable ? (b?.good ?? null) : null;
  const start = (sent: Record<string, unknown>) => app.watchJob(app.client.startJob(JOB_KINDS.bisect, { runId, good, ...sent }));
  return (
    <TestsJobButton className="btn lime" verb={stepJob(step)!.verb} off={app.actionsOff} tip={tipOf(stepCard(step))} lead="bisect" onClick={() => (good ? press({ estimate: stepEstimate(step), start, ask: onFindCommit }) : onFindCommit())}>
      {step.label}
    </TestsJobButton>
  );
}

/** Run blame beside a crash's Find breaking commit, plain, with what it runs and bills on hover: whether an answer of the model's lost the run, until the commit is named. */
export function BlameBesideButton({ runId, step }: { runId: string; step: NextStep | null }) {
  if (step?.key !== 'bisect' || !step.blame) return null;
  return <RunBlameButton runId={runId} offer={step.blame.offer} estimate={stepEstimate(step.blame, step.later)} title={blameTitle(step.blame.offer)} tip={tipOf(blameBesideCard(step.blame, step.later))} className="btn" fold="blame" />;
}

/** Add normalizer on a replay: the run's own action, the rule its divergence proposes. */
function RuleStep({ run, step, onAction }: StepProps) {
  const action = run.actions.find((a) => a.key === 'n');
  if (!action) return null;
  return (
    <ActionButton className="btn lime" why={action.disabled} data-next={step.key} data-tip={tipOf(stepCard(step))} onClick={() => onAction({ action, callNo: null })}>
      {step.label}
    </ActionButton>
  );
}

/**
 * Run injection test… opens its dialog (TestDialog.tsx), why the last test leads to it its amber
 * line; Re-run injection test confirms what it plants again and bills. Each starts the `injection`
 * job, which asks again for a command someone else recorded, as every such command is asked (ConsentDialog).
 */
function InjectionStep({ step }: { step: Extract<NextStep, { key: 'injection-test' | 'injection-again' }> }) {
  const app = useApp();
  const [asking, setAsking] = useState<null | { kind: 'step' } | { kind: 'consent'; why: string; confirm: string }>(null);
  const busy = useTreeBusy('reads', stepJob(step)!.verb);
  const title = confirmWords(step.label);
  // The job keeps the estimate its card and Cost line said, so its drawer says it too; the consent's yes sends it again.
  const again = step.key === 'injection-again' ? step.job : null;
  const fields = { runId: step.runId, ...(again ? { repeat: again.repeat, ...(again.templates.length ? { templates: again.templates } : {}), baselines: again.baselines, liveReads: again.liveReads, again: true } : {}), ...sentEstimate(stepEstimate(step)) };
  const start = (yes?: string) =>
    app.guard(() => {
      void app.client.startJob(JOB_KINDS.injection, yes === undefined ? fields : { ...fields, yes }).then(
        (job) => app.watchJob(Promise.resolve(job)),
        (err: unknown) => {
          const asked = yes === undefined ? consentAsked(err) : null;
          if (asked) setAsking({ kind: 'consent', ...asked });
          else app.watchJob(Promise.reject(err));
        },
      );
    });
  return (
    <>
      <ActionButton className="btn lime" why={busy} data-next={step.key} data-tip={tipOf(stepCard(step))} onClick={() => app.guard(() => setAsking({ kind: 'step' }))}>
        {step.label}
      </ActionButton>
      {asking?.kind === 'step' ? step.key === 'injection-test' ? <TestDialogPart runId={step.runId} why={step.sub} estimate={stepEstimate(step)} onClose={() => setAsking(null)} /> : <StepDialogPart ask={{ kind: 'injection', step, onOk: () => start() }} onClose={() => setAsking(null)} /> : null}
      {asking?.kind === 'consent' ? <StepDialogPart ask={{ kind: 'consent', why: asking.why, ok: title, onOk: () => start(asking.confirm) }} onClose={() => setAsking(null)} /> : null}
    </>
  );
}

/**
 * The folder a plain Pack as golden… packs into, where the header shows one: a recording a golden can
 * be made from whose first fact is no failure by today's checks (`judged`, the page's: undefined while
 * they judge it, when none shows yet), beside a step that isn't packing it already. A golden made
 * from a failing run would pass on the failure.
 */
export function plainPackFolder(run: RunDetail, offers: RunOffers | null, next: NextStep | null, judged: RunDetail['judged']): string | null {
  if (!offers?.keep || judged === undefined || next?.key === 'pack' || next?.key === 'pack-gate') return null;
  return outcomeOf({ ...runLikeOf(run), judged }).tone === 'err' ? null : offers.keep.folder;
}

/** Its card where another step leads, as the lead's says it. */
export function packTip(runId: string, folder: string): string {
  return tipCard('Pack as golden', [], 'A golden that CI replays on every commit', `$ ${packRunCommand(runId, folder)}`);
}

/**
 * Pack as golden… beside another step that leads, an injection test's or a preset's: plain, and the
 * header folds it into … second, after Replay. None where `plainPackFolder` finds no folder.
 */
export function PlainPackAsGolden({ run, offers, next, judged }: { run: RunDetail; offers: RunOffers | null; next: NextStep | null; judged: RunDetail['judged'] }) {
  const folder = plainPackFolder(run, offers, next, judged);
  const runId = run.run.runId;
  return folder ? <PackAsGolden runId={runId} folder={folder} offers={offers} lead={false} tip={packTip(runId, folder)} fold="pack" /> : null;
}

/** Pack as golden… where it leads, and Pack with injection gate…: the run packed into a folder of the goldens, named for the run, then tested, the gate written into its tests entry between the two (injection/PackWithGate.tsx). Each waits as Tests' jobs do. */
function PackStep({ step, offers }: { step: Extract<NextStep, { key: 'pack' | 'pack-gate' }>; offers: RunOffers | null }) {
  const app = useApp();
  const [asking, setAsking] = useState(false);
  if (step.key === 'pack') return <PackAsGolden runId={step.runId} folder={step.folder} offers={offers} lead tip={tipOf(stepCard(step))} />;
  return (
    <>
      <TestsJobButton className="btn lime" verb={stepJob(step)!.verb} off={app.actionsOff} tip={tipOf(stepCard(step))} lead={step.key} onClick={() => app.guard(() => setAsking(true))}>
        {step.label}
      </TestsJobButton>
      {asking ? <PackWithGatePart runId={step.runId} folder={step.folder} gate={step.gate} estimate={stepEstimate(step)} offers={offers} onClose={() => setAsking(false)} /> : null}
    </>
  );
}

/** The steps whose link opens an attempt, which waits while the server is out of reach, as every link to one does. */
const TO_ATTEMPT = new Set(['injection-proof', 'preset-proof']);

export function NextStepButton(props: StepProps) {
  const { run, step, onAction } = props;
  const offline = useOfflineLink();
  if (step.href) {
    const icon = ICONS[step.key];
    return (
      <a className="btn lime" href={step.href} data-next={step.key} data-tip={tipOf(stepCard(step))} onClick={TO_ATTEMPT.has(step.key) ? offline : undefined} {...(step.key === 'compare' ? shortcut('compare') : {})}>
        {icon ? <Icon name={icon} /> : null}
        {step.label}
      </a>
    );
  }
  switch (step.key) {
    case 'replay':
      return <ReplayButton run={run} step={step} lime onAction={onAction} />;
    case 'blame':
      return <RunBlameButton runId={run.run.runId} offer={step.offer} estimate={stepEstimate(step)} title={blameTitle(step.offer)} tip={tipOf(stepCard(step))} className="btn lime" icon lead mark={shortcut('blame')} {...(step.capture ? { capture: true } : {})} {...(step.command ? { line: step.command } : {})} />;
    case 'normalizer':
    case 'update-golden':
      return step.key === 'update-golden' && !(props.offers?.test ?? step.test) ? <UpdateStep step={step} /> : <DivergedStep {...props} step={step} />;
    case 'rerun-test':
    case 'gate-again':
      return <RerunStep step={step} />;
    case 'bisect':
      return <BisectStep {...props} step={step} />;
    case 'rule':
      return <RuleStep {...props} />;
    case 'injection-test':
    case 'injection-again':
      return <InjectionStep step={step} />;
    case 'pack':
    case 'pack-gate':
      return <PackStep step={step} offers={props.offers} />;
    default:
      return null;
  }
}
