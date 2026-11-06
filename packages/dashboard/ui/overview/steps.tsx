import { type ReactNode, useMemo, useRef, useState } from 'react';
import { GOLDEN_JOB_WORDS } from '../../../engine/src/golden-job-words.js';
import { consentAsked } from '../actions.js';
import { JOB_KINDS } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { ConfirmDialog, ConsentDialog } from '../components/Dialog.js';
import { tipCard } from '../components/HoverCard.js';
import { JobButton, type StepHooks, useBilledPress } from '../components/JobButton.js';
import { pressBilled } from '../spending.js';
import { fixAction, treeBusy } from '../fixes/model.js';
import { RunBlameButton } from '../fixes/RunBlame.js';
import { useServerJobs } from '../fixes/tree.js';
import { goldenName } from '../format.js';
import { testsBusy } from '../goldens.js';
import { ACTIONS, PUSH_LOCAL } from '../labels.js';
import { moreCard } from '../pages/tests-cards.js';
import { stepCard, stepJob } from '../run/next-step.js';
import { blameTitle, unknownBisect } from '../run/offers.js';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import { sentEstimate, tipEst } from '../spending.js';
import { useApp } from '../state.js';
import { bannerNormalizerAsk, gateAgainAsk, moreAttemptsAsk, rerunAsk, startTestsJob } from '../tests-ask.js';
import { errorText } from '../toast.js';
import type { LookStep, NeedsLookRow, NextStep } from '../types.js';
import { updatePlan } from '../update-plan.js';

/**
 * A Needs a look row's step, at its end: small and plain, never lime, labelled as the page it opens
 * leads with it, and running or asking from here as it would there (mock:MISSING.md:149). A list
 * carries no estimate, so a step asks for its own when the pointer or the focus reaches it, and a
 * press before it came waits for it; its card then says its sentence, its cost and its command. The
 * section reads the server's jobs once, for every row (`useLookWaits`). The dialogs a step asks in
 * load as it first asks: the Overview's script holds none of a fix's page.
 */

/** Migrate to <model>'s card, until the Migrate dialog of Changes words it. */
export const MIGRATE_SUB = 'Verify runs the agent live from the switched calls, writes stubbed';

/** What a step bills: undefined until its estimate comes, null for none. */
type Price = Estimate | null | undefined;

/** What a step that runs a job waits for, by the verb its reason says it in; `use`, how it uses the working tree. */
interface Job {
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

const FIX_JOBS: Record<Extract<LookStep, { of: 'fix' }>['lead']['key'], { kind: string; job: Job; ok: string }> = {
  repair: { kind: JOB_KINDS.repair, job: { verb: 'repair', tests: false, use: 'writes' }, ok: ACTIONS.runRepair.label },
  'blame-again': { kind: JOB_KINDS.blame, job: { verb: 'blame again', tests: false }, ok: 'Run command' },
  'blame-stronger': { kind: JOB_KINDS.blame, job: { verb: 'blame it', tests: false }, ok: 'Run command' },
  apply: { kind: JOB_KINDS.applyFix, job: { verb: 'apply the patch', tests: false, use: 'writes' }, ok: 'Run command' },
  mark: { kind: JOB_KINDS.applyFix, job: { verb: 'apply the patch', tests: false, use: 'writes' }, ok: 'Run command' },
};

/** The run steps a row runs from here; any other (a rule, a pack, an injection test, Replay, Compare) opens its page. */
const RUN_KINDS: Partial<Record<NextStep['key'], string>> = { blame: JOB_KINDS.blame, normalizer: JOB_KINDS.normalizeAndTest, 'update-golden': JOB_KINDS.testUpdate, 'rerun-test': JOB_KINDS.tests, 'gate-again': JOB_KINDS.tests, bisect: JOB_KINDS.bisect };

/** The job a row's step runs, and what it waits for; null for a link, none, or a step that opens its page instead. */
export function stepRun(s: LookStep | null): { kind: string; job: Job | null } | null {
  if (!s) return null;
  switch (s.of) {
    case 'link':
      return null;
    case 'fix':
      return FIX_JOBS[s.lead.key];
    case 'run': {
      const kind = RUN_KINDS[s.step.key];
      return kind ? { kind, job: stepJob(s.step) } : null;
    }
    case 'more':
    case 'rerun':
      return { kind: JOB_KINDS.tests, job: { verb: 'run it again', tests: true } };
    case 'update':
      return { kind: JOB_KINDS.testUpdate, job: { verb: 'update it', tests: true } };
    case 'push':
      return { kind: JOB_KINDS.push, job: null };
    case 'migrate':
      return { kind: JOB_KINDS.migrate, job: null };
  }
}

/** A step's label, as its button says it. */
export function stepLabel(s: LookStep): string {
  return s.of === 'run' ? s.step.label : s.of === 'fix' ? s.lead.label : s.label;
}

/** A step's card: its sentence and its command, for its hover and for ⌘K on its row. */
export function stepWords(s: LookStep): { sub: string | null; command: string | null } {
  switch (s.of) {
    case 'link':
      return { sub: s.title ?? null, command: null };
    case 'run': {
      const c = stepCard(s.step);
      return { sub: c.sub, command: c.cmd };
    }
    case 'fix':
      return { sub: s.lead.sub, command: s.lead.command ? `$ ${s.lead.command}` : null };
    case 'more':
      return { sub: moreCard(s.more).sub ?? null, command: `$ ${moreCard(s.more).command ?? ''}` };
    case 'update':
      return { sub: GOLDEN_JOB_WORDS.judgeOnce, command: `$ ${s.command}` };
    case 'push':
      return { sub: PUSH_LOCAL.sub, command: `$ ${s.command}` };
    case 'migrate':
      return { sub: MIGRATE_SUB, command: `$ ${s.command}` };
    case 'rerun':
      return { sub: s.sub, command: `$ ${s.command}` };
  }
}

/**
 * A step's estimate, asked for once the pointer or the focus reaches it (never as the page opens: a
 * list carries none), undefined until it comes and null for none. `when` runs what a press does with
 * it: at once where it has come, else once it has, so a press before it came waits for it.
 */
function usePriced(load: (() => Promise<Price>) | null): { estimate: Price; on: StepHooks; when: (f: (e: Price) => void) => () => void } {
  const [estimate, setEstimate] = useState<Price>(load ? undefined : null);
  const asked = useRef<Promise<Price> | null>(null);
  const prime = (): Promise<Price> =>
    (asked.current ??= (load ? load() : Promise.resolve(null))
      .then(
        (e) => e ?? null,
        () => null,
      )
      .then((e) => {
        setEstimate(e);
        return e;
      }));
  const when = (f: (e: Price) => void) => () => (estimate !== undefined ? f(estimate) : void prime().then(f));
  return { estimate, on: { onPointerEnter: () => void prime(), onFocus: () => void prime() }, when };
}

/** A job's start, with the yes a job asks for before it runs someone else's command (409), in its own dialog. */
function usePost(kind: string, ok: string): [(fields: Record<string, unknown>) => void, ReactNode] {
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

/** The dialog a step asks in, drawn once what it needs has come (the fix, the goldens, the run's offers, its script). */
function useAsking(): [ReactNode, (build: (close: () => void) => Promise<ReactNode>) => void] {
  const { toast } = useApp();
  const [node, setNode] = useState<ReactNode>(null);
  const close = () => setNode(null);
  return [node, (build) => void build(close).then(setNode, (err: unknown) => toast(errorText(err), 'error'))];
}

/**
 * A row's step: a link as itself; a job's button where this dashboard runs jobs, else `Open →`, as a
 * step that opens its page has (a read-only dashboard's rows each open what they are about).
 */
export function LookStepButton({ row, wait }: { row: NeedsLookRow; wait: LookWait | null }) {
  const app = useApp();
  const s = row.step;
  if (s?.of === 'link') {
    return (
      <a className="btn sm" href={s.href} {...(s.title ? { 'data-tip': tipCard(s.label, [], s.title) } : {})}>
        {s.label}
      </a>
    );
  }
  const run = stepRun(s);
  if (!s || !run || !wait || app.actionsOff || app.exported) return <span className="go">Open →</span>;
  const why = (app.hasKind(run.kind) ? null : 'This dashboard doesn’t run it: run the command in a terminal.') ?? wait(run.job);
  switch (s.of) {
    case 'fix':
      return <FixStep s={s} why={why} />;
    case 'run':
      return <RunStep s={s} why={why} />;
    case 'push':
    case 'migrate':
      return <StoreStep s={s} why={why} />;
    default:
      return <GoldenStep s={s} why={why} />;
  }
}

/** A fix's lead: Run repair, Run blame again, Run blame with stronger model…, Apply fix or Mark applied, each asking in the fix page's own dialog where it asks. */
function FixStep({ s, why }: { s: Extract<LookStep, { of: 'fix' }>; why: string | null }) {
  const app = useApp();
  const { fixId, lead } = s;
  const job = FIX_JOBS[lead.key];
  const applies = lead.key === 'apply' || lead.key === 'mark';
  const priced = usePriced(applies ? null : () => app.client.estimates.fixEstimates(fixId).then((e) => (lead.key === 'repair' ? e.repair : lead.key === 'blame-again' ? e.blameAgain : e.blameStronger)));
  const [post, consent] = usePost(job.kind, job.ok);
  const [asking, show] = useAsking();
  const fields = lead.key === 'blame-again' ? { fixId, again: true } : { fixId };
  const open = (e: Price) =>
    show(async (close) => {
      const fix = await app.client.fix(fixId);
      // As the fix's page leads (fixAction): a patch `fix apply` refuses is applied from nowhere, its page saying why.
      const act = applies ? fixAction(fix) : null;
      if (act?.kind === 'none') throw new Error(act.why);
      if (lead.key === 'repair' || applies) {
        const m = await import('../fixes/FixPage.js');
        return lead.key === 'repair' ? (
          <m.RepairDialog fix={fix} onClose={close} onRun={(repairer, sent) => app.guard(() => post({ fixId, repairer, ...sent }))} />
        ) : (
          <m.ApplyDialog fix={fix} label={act?.kind === 'apply' ? act.label : lead.label} onClose={close} onRun={(names) => app.guard(() => post({ fixId, ...(names ? { names } : {}) }))} />
        );
      }
      const m = await import('../fixes/BlameAgain.js');
      return m.blameNextAsk(fix, lead.key === 'blame-again' ? 'again' : 'stronger', e)((more) => app.guard(() => post({ ...fields, ...sentEstimate(e), ...more })), close);
    });
  // Run blame again starts by Spending once its estimate has come; the rest ask in their dialog, priced or not.
  const ask = lead.key === 'blame-again' ? priced.when((e) => void pressBilled({ estimate: e, start: (sent) => post({ ...fields, ...sent }), ask: () => open(e) })) : applies ? () => open(null) : priced.when(open);
  const words = stepWords(s);
  return (
    <>
      <JobButton
        className="btn sm"
        why={why}
        tip={lead.label}
        sub={words.sub}
        {...(words.command ? { command: words.command } : {})}
        {...(applies ? { bills: false } : { estimate: priced.estimate, form: lead.key !== 'blame-again' })}
        {...priced.on}
        start={applies ? ask : (sent) => post({ ...fields, ...sent })}
        ask={ask}
      >
        {lead.label}
      </JobButton>
      {asking}
      {consent}
    </>
  );
}

/** Update golden's dialog, for a golden on Tests' own plan: what it re-records, or the judge it asks once. */
function updateAsk(app: ReturnType<typeof useApp>, golden: string, estimate: Price): (close: () => void) => Promise<ReactNode> {
  return async (close) => {
    const [view, m] = await Promise.all([app.client.tests(), import('../components/UpdateGolden.js')]);
    const update = () => {
      const went = startTestsJob(app, JOB_KINDS.testUpdate, { golden, ...sentEstimate(estimate) });
      if (went) close();
      return went;
    };
    return <m.UpdateGoldenDialog plan={updatePlan(view, [golden], app.hasKind)} estimate={estimate} onUpdate={update} onClose={close} />;
  };
}

/** A golden's step on Tests: Run more attempts, Update golden or Re-run test, its price from Tests' estimates. */
function GoldenStep({ s, why }: { s: Extract<LookStep, { of: 'more' | 'update' | 'rerun' }>; why: string | null }) {
  const app = useApp();
  const priced = usePriced(() => app.client.estimates.testsEstimates().then((e) => e.goldens[s.golden]?.[s.of === 'rerun' ? 'rerun' : s.of] ?? null));
  const [asking, show] = useAsking();
  const e = priced.estimate;
  const name = goldenName(s.golden);
  // Tests' jobs post at once, priced: the server's question is their ask where they run live (tests-ask.ts).
  const go: (p: Price) => void =
    s.of === 'update'
      ? (p) => show(updateAsk(app, s.golden, p))
      : s.of === 'more'
        ? (p) => void startTestsJob(app, JOB_KINDS.tests, { ...s.more.job, ...sentEstimate(p) }, { ...moreAttemptsAsk(name, s.more), estimate: p })
        : (p) => void startTestsJob(app, JOB_KINDS.tests, { golden: s.golden, ...sentEstimate(p) }, { ...rerunAsk(name, s.golden), estimate: p });
  const words = stepWords(s);
  return (
    <>
      <JobButton className="btn sm" why={why} tip={s.label} sub={words.sub} command={words.command ?? undefined} estimate={e} {...priced.on} start={() => go(e)} ask={priced.when(go)}>
        {s.label}
      </JobButton>
      {asking}
    </>
  );
}

/** Push local runs, which bills nothing, and Migrate to <model>, which always asks. */
function StoreStep({ s, why }: { s: Extract<LookStep, { of: 'push' | 'migrate' }>; why: string | null }) {
  const app = useApp();
  const [post, consent] = usePost(s.of === 'push' ? JOB_KINDS.push : JOB_KINDS.migrate, 'Run command');
  const [asking, setAsking] = useState(false);
  const words = stepWords(s);
  const card = { tip: s.label, sub: words.sub, command: words.command ?? undefined };
  if (s.of === 'push') {
    const push = () => post({ all: true });
    return (
      <>
        <JobButton className="btn sm" why={why} {...card} bills={false} start={push} ask={push}>
          {s.label}
        </JobButton>
        {consent}
      </>
    );
  }
  const from = s.from.join(', ');
  const open = () => setAsking(true);
  return (
    <>
      <JobButton className="btn sm" why={why} {...card} estimate={null} start={open} ask={open}>
        {s.label}
      </JobButton>
      {asking ? (
        <ConfirmDialog
          title={`Migrate ${from} to ${s.to}`}
          lead={`Asks ${from}’s calls again under ${s.to} and verifies the runs whose decisions change.`}
          command={s.command}
          ok={s.label}
          onClose={() => setAsking(false)}
          onOk={() => app.guard(() => post({ to: s.to, from: s.from, goldens: s.goldens }))}
        />
      ) : null}
      {consent}
    </>
  );
}

/**
 * A run's step as its page leads with it: Run blame, Add normalizer and re-run, Update golden, Re-run
 * test, or Find breaking commit, each taking the step and the run's id, not the run's page, priced
 * from the run's own next step (`GET /api/runs/:id/next`).
 */
function RunStep({ s, why }: { s: Extract<LookStep, { of: 'run' }>; why: string | null }) {
  const app = useApp();
  const press = useBilledPress();
  const { runId, step } = s;
  const priced = usePriced(() => app.client.nextStep(runId).then((r) => (r.next?.key === step.key ? (r.next.estimate ?? null) : null)));
  const [asking, show] = useAsking();
  const e = priced.estimate;
  const c = stepCard(e ? { ...step, estimate: e } : step);
  if (step.key === 'blame') {
    return <RunBlameButton runId={runId} offer={step.offer} estimate={e} busy={why} on={priced.on} when={priced.when} title={blameTitle(step.offer)} tip={tipCard(c.title, c.rows, c.sub, c.cmd, c.est)} className="btn sm" {...(step.command ? { line: step.command } : {})} />;
  }
  const card = { tip: c.title, sub: c.sub, command: c.cmd ?? undefined };
  let go: (p: Price) => void;
  if (step.key === 'normalizer') go = (p) => void startTestsJob(app, JOB_KINDS.normalizeAndTest, { runId, ...sentEstimate(p) }, { ...bannerNormalizerAsk(step.test), estimate: p });
  else if (step.key === 'update-golden') go = (p) => show(updateAsk(app, step.golden, p));
  else if (step.key === 'rerun-test' || step.key === 'gate-again') {
    const name = goldenName(step.golden);
    go = (p) => void startTestsJob(app, JOB_KINDS.tests, { golden: step.golden, ...sentEstimate(p) }, { ...(step.key === 'gate-again' ? gateAgainAsk(name, step.golden) : rerunAsk(name, step.golden)), estimate: p });
  } else if (step.key === 'bisect') {
    // From where its golden last passed it starts by Spending; with no commit to start from, its dialog asks for one.
    const starts = step.starts;
    const bisect = (good: string | null, sent: Record<string, unknown>) => app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.bisect, { runId, good, ...sent })));
    go = (p) =>
      void app.client.offers(runId).then(
        (offers) => {
          // With no offer, as on the run's page: its dialog asks for the commit to start from.
          const b = offers?.bisect ?? unknownBisect(runId);
          const ask = () =>
            show(async (close) => {
              const m = await import('../run/RunDialogs.js');
              return <m.BisectDialog runId={runId} offer={b} onClose={close} onRun={bisect} />;
            });
          if (starts && b.good && !b.unavailable) press({ estimate: p, start: (sent) => void bisect(b.good, sent), ask });
          else ask();
        },
        (err: unknown) => app.toast(errorText(err), 'error'),
      );
    return (
      <>
        <ActionButton className="btn sm" why={why} {...card} est={tipEst(e, !starts)} {...priced.on} onClick={() => app.guard(priced.when(go))}>
          {step.label}
        </ActionButton>
        {asking}
      </>
    );
  } else return <span className="go">Open →</span>;
  return (
    <>
      <JobButton className="btn sm" why={why} {...card} estimate={e} {...priced.on} start={() => go(e)} ask={priced.when(go)}>
        {step.label}
      </JobButton>
      {asking}
    </>
  );
}
