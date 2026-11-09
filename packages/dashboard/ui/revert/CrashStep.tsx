import { JOB_KINDS, type Client } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { useBilledPress } from '../components/JobButton.js';
import { stepCard } from '../run/next-step.js';
import { unknownBisect } from '../run/offers.js';
import { tipEst } from '../spending.js';
import { useApp } from '../state.js';
import { useAsking, usePriced } from '../step-asks.js';
import type { Price } from '../tests-estimates.js';
import { errorText } from '../toast.js';
import type { FoundCommit, NextStep } from '../types.js';
import { RevertButton } from './RevertButton.js';

/**
 * A crash's own step away from its run's page: Find breaking commit, then Revert once it named the
 * commit, on a Fixes row, a Needs a look row, a fix's head, and where Run blame with stronger
 * model's drawer ends on its fix's lead. Both run on the crashed run, not on a fix, and are priced
 * as its run's step is (`GET /api/runs/:id/next`): as the pointer or the focus reaches them, or as
 * they first show where they lead the page. Find breaking commit presses as the run's page does,
 * from where its golden last passed by Spending, its dialog asking for a commit to start from where
 * there is none, the run's offers read as it is pressed. Revert always opens its dialog
 * (RevertButton.tsx), with the commit the page has or, on a row, the one its run's offers name.
 */

/** A crash's step: what a fix whose blame no model rescued leads with (fix-lead.ts). */
type CrashStep = Extract<NextStep, { key: 'bisect' | 'revert' }>;

export interface CrashStepProps {
  runId: string;
  step: CrashStep;
  /** Why it can't start now, from the jobs its list or page read once (fixes/lead.ts `leadWait`), or null. */
  why: string | null;
  className?: string;
  /** Where it leads its page (a fix's head): its estimate asked as it shows, and Revert the page's lead, which ⌘K and Find breaking commit's drawer press. */
  lead?: boolean;
  /** The commit Find breaking commit named, where the page has it (a fix's detail); else Revert reads its run's offers as it is pressed. */
  found?: FoundCommit | null;
}

/** The run's step's estimate, while its step is still this one; null for none. */
const stepPrice = (client: Pick<Client, 'nextStep'>, runId: string, key: CrashStep['key']) => (): Promise<Price> => client.nextStep(runId).then((r) => (r.next?.key === key ? (r.next.estimate ?? null) : null));

export function CrashStepButton(p: CrashStepProps) {
  return p.step.key === 'bisect' ? <BisectStepButton {...p} step={p.step} /> : <RevertStepButton {...p} step={p.step} />;
}

function BisectStepButton({ runId, step, why, className = 'btn sm', lead = false }: CrashStepProps & { step: Extract<CrashStep, { key: 'bisect' }> }) {
  const app = useApp();
  const press = useBilledPress();
  const priced = usePriced(stepPrice(app.client, runId, 'bisect'), lead);
  const [asking, show] = useAsking();
  const e = priced.estimate;
  const c = stepCard(e ? { ...step, estimate: e } : step);
  // From where its golden last passed it starts by Spending; with no commit to start from, its dialog asks for one.
  const starts = step.starts;
  const bisect = (good: string | null, sent: Record<string, unknown>) => app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.bisect, { runId, good, ...sent })));
  const go = (p: Price) =>
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
      <ActionButton className={className} why={why} tip={c.title} sub={c.sub} command={c.cmd ?? undefined} est={tipEst(e, !starts)} {...priced.on} onClick={() => app.guard(priced.when(go))}>
        {step.label}
      </ActionButton>
      {asking}
    </>
  );
}

function RevertStepButton({ runId, step, why, className = 'btn sm', lead = false, found }: CrashStepProps & { step: Extract<CrashStep, { key: 'revert' }> }) {
  const app = useApp();
  const priced = usePriced(stepPrice(app.client, runId, 'revert'), lead);
  // What its dialog shows comes before it opens: the estimate, and the commit where the page has none.
  const commit = (): Promise<FoundCommit | null> => (found !== undefined ? Promise.resolve(found) : app.client.offers(runId).then((o) => o?.commit ?? null));
  const read = () => Promise.all([commit(), new Promise<Price>((done) => priced.when(done)())]).then(([c]) => c);
  return <RevertButton step={step} found={found ?? null} estimate={priced.estimate} runId={runId} lead={lead} className={className} why={why} on={priced.on} read={read} />;
}
