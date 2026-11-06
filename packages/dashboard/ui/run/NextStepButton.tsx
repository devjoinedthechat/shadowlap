import { useMemo, useState } from 'react';
import { consentAsked } from '../actions.js';
import { JOB_KINDS, type RunDetail, type RunOffers } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { ConfirmDialog, ConsentDialog, PromptDialog } from '../components/Dialog.js';
import { useBilledPress } from '../components/JobButton.js';
import { tipCard, tipText } from '../components/HoverCard.js';
import { Icon, type IconName } from '../components/Icon.js';
import { namedIn } from '../components/Id.js';
import { goldenName, shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { RunBlameButton } from '../fixes/RunBlame.js';
import { TestsJobButton } from '../fixes/TestsJobButton.js';
import { useJobWait, useTreeBusy } from '../fixes/tree.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { href } from '../route.js';
import { compareTarget } from '../runs.js';
import { shortcut } from '../shortcuts.js';
import { sentEstimate } from '../spending.js';
import { useApp } from '../state.js';
import { gateAgainAsk, rerunAsk, startTestsJob } from '../tests-ask.js';
import type { NextStep } from '../types.js';
import type { PendingAction } from './actions.js';
import { useDivergedJobs } from './diverged.js';
import { checksOf } from './model.js';
import { blameBesideCard, gateEntry, replayAction, stepCard, stepCostLine, stepEstimate, stepJob, type StepCard } from './next-step.js';
import { blameTitle } from './offers.js';
import { PACK_HOLDS, packRunCommand, redactsFact } from './share.js';

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
      {...(lime ? { 'data-next': 'replay' } : {})}
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
      <button className="btn" type="button" disabled title={r.status === 'running' ? 'Nothing to compare yet: replay or fork it once it finishes' : 'Nothing to compare yet: replay it or fork it first'} {...shortcut('compare')}>
        {ACTIONS.compare.label}
      </button>
    );
  }
  const other = pair[0] === r.runId ? pair[1] : pair[0];
  const label = r.parentRunId ? ACTIONS.compareWithParent.label : run.children.find((c) => c.runId === other)?.kind === 'fork' ? ACTIONS.compareWithFork.label : ACTIONS.compareWithReplay.label;
  const tip = tipCard(`Against ${shortId(other)}`, [], runs?.find((x) => x.runId === other)?.about?.text, `$ shadowlap diff ${shortId(pair[0])} ${shortId(pair[1])}`);
  return (
    <a className="btn" href={href.compare(pair[0], pair[1])} data-tip={tip} {...shortcut('compare')}>
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
      {asking ? (
        <ConfirmDialog
          title={`Update ${goldenName(step.golden)}?`}
          lead={step.sub ? `${step.sub}.` : `Re-records ${goldenName(step.golden)}, for a change you meant.`}
          doc="goldenUpdates"
          command={step.command ?? null}
          cost={stepCostLine(step)}
          ok={step.label}
          onClose={() => setAsking(false)}
          onOk={() => app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.testUpdate, { golden: step.golden })))}
        />
      ) : null}
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
  return <RunBlameButton runId={runId} offer={step.blame.offer} estimate={stepEstimate(step.blame, step.later)} title={blameTitle(step.blame.offer)} tip={tipOf(blameBesideCard(step.blame, step.later))} className="btn" />;
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

/** What a step that tests for injection says it does: a test run again plants what the last one planted. */
const INJECTION_LEADS: Record<'injection-test' | 'injection-again', string> = {
  'injection-test': 'Plants each payload, with its own canary, in the run’s untrusted reads and runs the agent from the call that reads it.',
  'injection-again': 'Plants the same payloads in the same reads again.',
};

/**
 * Run injection test… and Re-run injection test: what it plants and bills, why the last test leads
 * to it, then the `injection` job, which asks again for a command someone else recorded, as every
 * such command is asked (ConsentDialog).
 */
function InjectionStep({ step }: { step: Extract<NextStep, { key: 'injection-test' | 'injection-again' }> }) {
  const app = useApp();
  const [asking, setAsking] = useState<null | { kind: 'step' } | { kind: 'consent'; why: string; confirm: string }>(null);
  const busy = useTreeBusy('reads', stepJob(step)!.verb);
  const title = confirmWords(step.label);
  const id = shortId(step.runId);
  const fields = step.key === 'injection-again' ? { runId: step.runId, repeat: step.job.repeat, ...(step.job.templates.length ? { templates: step.job.templates } : {}), baselines: step.job.baselines, liveReads: step.job.liveReads } : { runId: step.runId };
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
      {asking?.kind === 'step' ? (
        <ConfirmDialog
          title={namedIn(`${title} on ${id}`, id)}
          lead={INJECTION_LEADS[step.key]}
          doc="injectionTests"
          warn={step.sub ? { text: step.sub } : null}
          command={step.command ?? null}
          cost={stepCostLine(step)}
          ok={title}
          onClose={() => setAsking(null)}
          onOk={() => start()}
        />
      ) : null}
      {asking?.kind === 'consent' ? <ConsentDialog why={asking.why} ok={title} onClose={() => setAsking(null)} onOk={() => start(asking.confirm)} /> : null}
    </>
  );
}

/** Pack as golden… and Pack with injection gate…: the run packed into a folder of the goldens, named for the run; a gate's entry, which this leaves to you, goes under `tests` in the config, for the folder as you name it. */
function PackStep({ step, offers }: { step: Extract<NextStep, { key: 'pack' | 'pack-gate' }>; offers: RunOffers | null }) {
  const app = useApp();
  const [asking, setAsking] = useState(false);
  const id = shortId(step.runId);
  const gate = step.key === 'pack-gate' ? step.gate : null;
  return (
    <>
      <ActionButton className="btn lime" data-next={step.key} data-tip={tipOf(stepCard(step))} onClick={() => app.guard(() => setAsking(true))}>
        {step.label}
      </ActionButton>
      {asking ? (
        <PromptDialog
          title={namedIn(gate ? `Pack ${id} with injection gate?` : `Pack ${id} as golden?`, id)}
          lead={gate ? 'Packs the run as a golden that fails while a tool call carries a planted payload’s canary.' : 'Packs the run as a golden that CI replays on every commit.'}
          doc={gate ? 'injectionGate' : 'makeGolden'}
          facts={[
            { label: 'Changes', value: 'your working tree', quiet: 'the golden’s folder' },
            PACK_HOLDS,
            redactsFact(offers?.copies.formats.find((f) => f.id === 'pack')?.rules ?? null),
            gate ? { label: 'Then', value: 'you add the entry below to `shadowlap.config.json`', quiet: 'it gives the golden its gate' } : null,
          ]}
          label="Folder, inside the project"
          initial={step.folder}
          command={(dir) => packRunCommand(step.runId, dir)}
          {...(gate ? { after: (dir: string) => <pre className="codebox gateentry">{gateEntry(dir || '…', gate)}</pre> } : {})}
          cost={stepCostLine(step)}
          ok={confirmWords(step.label)}
          onClose={() => setAsking(false)}
          onRun={(dir) => app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.pack, { runId: step.runId, dir })))}
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
      <a className="btn lime" href={step.href} data-next={step.key} data-tip={tipOf(stepCard(step))} {...(step.key === 'compare' ? shortcut('compare') : {})}>
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
