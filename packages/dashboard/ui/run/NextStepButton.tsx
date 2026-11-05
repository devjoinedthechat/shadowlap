import { useMemo, useState } from 'react';
import { JOB_KINDS, type RunDetail, type RunOffers } from '../api.js';
import { ConfirmDialog, PromptDialog } from '../components/Dialog.js';
import { tipCard } from '../components/HoverCard.js';
import { Icon, type IconName } from '../components/Icon.js';
import { goldenName, shortId } from '../format.js';
import { commandText } from '../goldens.js';
import { useLoad } from '../hooks.js';
import { RunBlameButton } from '../fixes/RunBlame.js';
import { TestsJobButton } from '../fixes/TestsJobButton.js';
import { useJobWait, useTreeBusy } from '../fixes/tree.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { href } from '../route.js';
import { compareTarget } from '../runs.js';
import { useApp } from '../state.js';
import { startTestsJob } from '../tests-ask.js';
import type { NextStep } from '../types.js';
import type { PendingAction } from './actions.js';
import { useDivergedJobs } from './diverged.js';
import { checksOf } from './model.js';
import { blameBesideCard, gateEntry, replayAction, stepAsk, stepCard, stepCost, stepJob, type StepCard } from './next-step.js';
import { blameTitle } from './offers.js';

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
  return useMemo(() => (whole ? { ...run, next: whole } : run), [run, whole]);
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
  return tipCard(card.title, card.rows, card.sub);
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
  const { actionsOff } = useApp();
  const action = replayAction(step) ?? run.actions.find((a) => a.key === 'r');
  const off = step?.off ?? actionsOff ?? action?.disabled ?? null;
  const target = step?.key === 'replay' && step.runId !== run.run.runId ? { runId: step.runId } : {};
  return (
    <button
      className={lime && (!off || off === step?.off) ? 'btn lime' : 'btn'}
      type="button"
      disabled={!!off || !action}
      {...(lime ? { 'data-next': 'replay' } : {})}
      {...(off ? { title: off } : step ? { 'data-tip': tipOf(stepCard(step)) } : {})}
      onClick={() => action && onAction({ action, callNo: null, ...target })}
    >
      <Icon name="replay" />
      {step?.label ?? 'Replay'}
    </button>
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
      <button className="btn" type="button" disabled title={r.status === 'running' ? 'Nothing to compare yet: replay or fork it once it finishes' : 'Nothing to compare yet: replay it or fork it first'}>
        {ACTIONS.compare.label}
      </button>
    );
  }
  const other = pair[0] === r.runId ? pair[1] : pair[0];
  const label = r.parentRunId ? ACTIONS.compareWithParent.label : run.children.find((c) => c.runId === other)?.kind === 'fork' ? ACTIONS.compareWithFork.label : ACTIONS.compareWithReplay.label;
  const tip = tipCard(`Against ${shortId(other)}`, [{ label: '$', value: `shadowlap diff ${shortId(pair[0])} ${shortId(pair[1])}` }], runs?.find((x) => x.runId === other)?.about?.text);
  return (
    <a className="btn" href={href.compare(pair[0], pair[1])} data-tip={tip}>
      {label}
    </a>
  );
}

/** Add normalizer and re-run, and Update golden: the jobs of a test that diverged. */
function DivergedStep({ run, step, offers }: StepProps & { step: Extract<NextStep, { key: 'normalizer' | 'update-golden' }> }) {
  const app = useApp();
  // The server's, until the page's offers come.
  const test = offers?.test ?? step.test;
  const jobs = useDivergedJobs(run, test, checksOf(run).length);
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
      {asking ? (
        <ConfirmDialog
          title={`Update ${goldenName(step.golden)}?`}
          text={stepAsk(step)}
          ok={step.label}
          {...(step.command ? { command: step.command } : {})}
          onClose={() => setAsking(false)}
          onOk={() => {
            setAsking(false);
            app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.testUpdate, { golden: step.golden })));
          }}
        />
      ) : null}
    </>
  );
}

/** Re-run test: the golden's test again, a gate's too, asking first where it runs live (tests-ask.ts). */
function RerunStep({ step }: { step: Extract<NextStep, { key: 'rerun-test' | 'gate-again' }> }) {
  const app = useApp();
  const name = goldenName(step.golden);
  return (
    <TestsJobButton className="btn lime" verb={stepJob(step)!.verb} off={app.actionsOff} tip={tipOf(stepCard(step))} lead={step.key} onClick={() => startTestsJob(app, JOB_KINDS.tests, { golden: step.golden }, { title: `Re-run ${name}`, ok: 'Re-run', commands: [commandText(['test', step.golden])] })}>
      {step.label}
    </TestsJobButton>
  );
}

/**
 * Find breaking commit, for a test replay: from where its golden last passed, it starts on the click,
 * offline and free; else its dialog asks for a commit.
 */
function BisectStep({ run, step, offers, onFindCommit }: StepProps & { step: Extract<NextStep, { key: 'bisect' }> }) {
  const app = useApp();
  const runId = run.run.runId;
  const b = offers?.bisect ?? null;
  const good = step.starts && !b?.unavailable ? (b?.good ?? null) : null;
  return (
    <TestsJobButton className="btn lime" verb={stepJob(step)!.verb} off={app.actionsOff} tip={tipOf(stepCard(step))} lead="bisect" onClick={() => (good ? app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.bisect, { runId, good }))) : onFindCommit())}>
      {step.label}
    </TestsJobButton>
  );
}

/** Run blame beside a crash's Find breaking commit, plain, with what it runs and bills on hover: whether an answer of the model's lost the run, until the commit is named. */
export function BlameBesideButton({ runId, step }: { runId: string; step: NextStep | null }) {
  if (step?.key !== 'bisect' || !step.blame) return null;
  return <RunBlameButton runId={runId} failed={step.blame.offer.failed} title={blameTitle(step.blame.offer)} tip={tipOf(blameBesideCard(step.blame))} className="btn" />;
}

/** Add normalizer on a replay: the run's own action, the rule its divergence proposes. */
function RuleStep({ run, step, onAction }: StepProps) {
  const { actionsOff } = useApp();
  const action = run.actions.find((a) => a.key === 'n');
  if (!action) return null;
  const off = actionsOff ?? action.disabled;
  return (
    <button className={off ? 'btn' : 'btn lime'} type="button" disabled={!!off} data-next={step.key} {...(off ? { title: off } : { 'data-tip': tipOf(stepCard(step)) })} onClick={() => onAction({ action, callNo: null })}>
      {step.label}
    </button>
  );
}

/** Run injection test… and Re-run injection test: what it runs and bills, then the `injection` job, which asks again for a command someone else recorded. */
function InjectionStep({ step }: { step: Extract<NextStep, { key: 'injection-test' | 'injection-again' }> }) {
  const app = useApp();
  const [asking, setAsking] = useState(false);
  const busy = useTreeBusy('reads', stepJob(step)!.verb);
  const off = app.actionsOff ?? busy;
  const title = confirmWords(step.label);
  const fields = step.key === 'injection-again' ? { runId: step.runId, repeat: step.job.repeat, ...(step.job.templates.length ? { templates: step.job.templates } : {}), baselines: step.job.baselines, liveReads: step.job.liveReads } : { runId: step.runId };
  return (
    <>
      <button className={off ? 'btn' : 'btn lime'} type="button" disabled={!!off} data-next={step.key} {...(off ? { title: off } : { 'data-tip': tipOf(stepCard(step)) })} onClick={() => app.guard(() => setAsking(true))}>
        {step.label}
      </button>
      {asking ? (
        <ConfirmDialog
          title={`${title} on ${shortId(step.runId)}?`}
          text={stepAsk(step)}
          ok={title}
          {...(step.command ? { command: step.command } : {})}
          onClose={() => setAsking(false)}
          onOk={() => {
            setAsking(false);
            startTestsJob(app, JOB_KINDS.injection, fields, { title, ok: title, ...(step.command ? { commands: [step.command] } : {}) });
          }}
        />
      ) : null}
    </>
  );
}

/** Pack as golden… and Pack with injection gate…: the run packed into a folder of the goldens, named for the run; a gate's entry, which this leaves to you, goes under `tests` in the config, for the folder as you name it. */
function PackStep({ step }: { step: Extract<NextStep, { key: 'pack' | 'pack-gate' }> }) {
  const app = useApp();
  const [asking, setAsking] = useState(false);
  const off = app.actionsOff;
  const id = shortId(step.runId);
  const gate = step.key === 'pack-gate' ? step.gate : null;
  const cost = stepCost(step);
  return (
    <>
      <button className={off ? 'btn' : 'btn lime'} type="button" disabled={!!off} data-next={step.key} {...(off ? { title: off } : { 'data-tip': tipOf(stepCard(step)) })} onClick={() => app.guard(() => setAsking(true))}>
        {step.label}
      </button>
      {asking ? (
        <PromptDialog
          title={gate ? `Pack ${id} with injection gate?` : `Pack ${id} as golden?`}
          text={gate ? `It packs the run. Add the entry below to shadowlap.config.json, which gives it its gate.${cost ? ` Each test of it costs ${cost}.` : ''}` : 'A golden is a recording CI replays on every commit. Redaction rules apply to the copy; the store is never changed.'}
          label="Folder, inside the project"
          initial={step.folder}
          command={(dir) => `shadowlap pack ${id} ${dir || '…'}`}
          {...(gate ? { after: (dir: string) => <pre className="codebox gateentry">{gateEntry(dir || '…', gate)}</pre> } : {})}
          ok={confirmWords(step.label)}
          onClose={() => setAsking(false)}
          onRun={(dir) => {
            setAsking(false);
            app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.pack, { runId: step.runId, dir })));
          }}
        />
      ) : null}
    </>
  );
}

export function NextStepButton(props: StepProps) {
  const { run, step, onAction } = props;
  if (step.href) {
    const icon = ICONS[step.key];
    return (
      <a className="btn lime" href={step.href} data-next={step.key} data-tip={tipOf(stepCard(step))}>
        {icon ? <Icon name={icon} /> : null}
        {step.label}
      </a>
    );
  }
  switch (step.key) {
    case 'replay':
      return <ReplayButton run={run} step={step} lime onAction={onAction} />;
    case 'blame':
      return <RunBlameButton runId={run.run.runId} failed={step.offer.failed} title={blameTitle(step.offer)} tip={tipOf(stepCard(step))} className="btn lime" icon lead {...(step.capture ? { capture: true } : {})} {...(step.command ? { line: step.command } : {})} />;
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
      return <PackStep step={step} />;
    default:
      return null;
  }
}
