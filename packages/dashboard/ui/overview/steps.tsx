import { useState } from 'react';
import { GOLDEN_JOB_WORDS } from '../../../engine/src/golden-job-words.js';
import { JOB_KINDS } from '../api.js';
import { tipCard } from '../components/HoverCard.js';
import { JobButton } from '../components/JobButton.js';
import { MigrateAsk } from '../components/MigrateAsk.js';
import { LEAD_KIND, LEAD_VERB, leadCard } from '../fixes/lead.js';
import { RowStep } from '../fixes/RowStep.js';
import { goldenName } from '../format.js';
import { PUSH_LOCAL } from '../labels.js';
import { moreCard } from '../pages/tests-cards.js';
import { stepCard } from '../run/next-step.js';
import { sentEstimate } from '../spending.js';
import { useApp } from '../state.js';
import { type Job, type LookWait, type Price, RunStep, runStepJob, stepWhy, updateAsk, useAsking, usePost, usePriced } from '../steps/RunStep.js';
import { moreAttemptsAsk, rerunAsk, startTestsJob } from '../tests-ask.js';
import type { LookStep, NeedsLookRow } from '../types.js';

/**
 * A Needs a look row's step, at its end: small and plain, never lime, labelled as the page it opens
 * leads with it, and running or asking from here as it would there (mock:MISSING.md:149). A list
 * carries no estimate, so a step asks for its own when the pointer or the focus reaches it, and a
 * press before it came waits for it; its card then says its sentence, its cost and its command. The
 * section reads the server's jobs once, for every row (`useLookWaits`). A run's step is the one Runs'
 * issues draw (steps/RunStep.tsx); a fix's row has the step its row on Fixes has (fixes/RowStep.tsx).
 * The dialogs a step asks in load as it first asks: the Overview's script holds none of a fix's page.
 */

/** Migrate to <model>'s card, until the Migrate dialog of Changes words it. */
export const MIGRATE_SUB = 'Verify runs the agent live from the switched calls, writes stubbed';

/** The job a row's step runs, and what it waits for; null for a link, none, or a step that opens its page instead. */
export function stepRun(s: LookStep | null): { kind: string; job: Job | null } | null {
  if (!s) return null;
  switch (s.of) {
    case 'link':
      return null;
    case 'fix':
      // As Fixes' row waits (lead.ts `leadWait`): the job its lead starts, and how it uses the working tree.
      return { kind: LEAD_KIND[s.lead.key], job: { verb: LEAD_VERB[s.lead.key], tests: false, use: s.lead.use } };
    case 'run':
      return runStepJob(s.step);
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
      return { sub: leadCard(s.lead), command: `$ ${s.lead.command}` };
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
 * A row's step: a link as itself; a job's button where this dashboard runs jobs, else `Open →`, as a
 * step that opens its page has (a read-only dashboard's rows each open what they are about).
 */
export function LookStepButton({ row, wait, version }: { row: NeedsLookRow; wait: LookWait | null; version: string }) {
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
  const why = stepWhy(app.hasKind, run, wait);
  switch (s.of) {
    case 'fix':
      // A fix's lead, as its row on Fixes draws and presses it; `version`, the list's answer its prices last as long as.
      return <RowStep fixId={s.fixId} lead={s.lead} why={why} version={version} />;
    case 'run':
      return <RunStep s={s} why={why} />;
    case 'push':
    case 'migrate':
      return <StoreStep s={s} why={why} />;
    default:
      return <GoldenStep s={s} why={why} />;
  }
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
  const open = () => setAsking(true);
  return (
    <>
      <JobButton className="btn sm" why={why} {...card} estimate={null} start={open} ask={open}>
        {s.label}
      </JobButton>
      {asking ? <MigrateAsk from={s.from} to={s.to} command={s.command} ok={s.label} onClose={() => setAsking(false)} onOk={() => app.guard(() => post({ to: s.to, from: s.from, goldens: s.goldens }))} /> : null}
      {consent}
    </>
  );
}
