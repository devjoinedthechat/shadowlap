import { UpdateGoldenDialog } from '../components/UpdateGolden.js';
import { NormalizeUpdateDialog } from '../pages/TestsDialogs.js';
import type { UpdatePlan } from '../update-plan.js';

/** What a test that diverged asks before its job: Update golden's plan, or the commands Add normalizer and update runs. */
export type DivergedAsk = { kind: 'update'; plan: UpdatePlan } | { kind: 'normalize'; name: string; steps: string[][] };

/**
 * The dialogs a test that diverged asks in (useDivergedJobs): Update golden's, which can add the
 * normalizer instead, and Add normalizer and update's, with both commands. Rarely opened, so a part
 * of its own (`onShow`), out of the run page's script.
 */
export function DivergedDialogs({ ask, onNormalize, onUpdate, onClose }: { ask: DivergedAsk; onNormalize: () => unknown; onUpdate: () => unknown; onClose: () => void }) {
  return ask.kind === 'update' ? <UpdateGoldenDialog plan={ask.plan} onInstead={onNormalize} onClose={onClose} onUpdate={onUpdate} /> : <NormalizeUpdateDialog name={ask.name} steps={ask.steps} onClose={onClose} onRun={onNormalize} />;
}
