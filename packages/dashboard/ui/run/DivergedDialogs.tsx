import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import { UpdateGoldenDialog } from '../components/UpdateGolden.js';
import { NormalizeUpdateDialog } from '../pages/TestsDialogs.js';
import type { TestBannerOffer } from '../types.js';
import { updateGoldenCopy } from './dialog-copy.js';

/**
 * What a test that diverged asks before its job: Update golden's plan, or the commands Add normalizer
 * and update runs; each with what it bills where the page knows (`estimate`, undefined while it comes).
 */
export type DivergedAsk = ({ kind: 'update'; test: TestBannerOffer; callNo: number; canNormalize: boolean; replayChecks: number } | { kind: 'normalize'; name: string; steps: string[][] }) & { estimate?: Estimate | null | undefined };

/**
 * The dialogs a test that diverged asks in (useDivergedJobs): Update golden's, which can add the
 * normalizer instead, and Add normalizer and update's, with both commands. Rarely opened, so a part
 * of its own (`onShow`), out of the run page's script.
 */
export function DivergedDialogs({ ask, onNormalize, onUpdate, onClose }: { ask: DivergedAsk; onNormalize: (reason?: string) => unknown; onUpdate: (reason: string) => unknown; onClose: () => void }) {
  return ask.kind === 'update' ? <UpdateGoldenDialog plan={updateGoldenCopy(ask.test, ask.callNo, ask.canNormalize, ask.replayChecks)} estimate={ask.estimate} onInstead={onNormalize} onClose={onClose} onUpdate={onUpdate} /> : <NormalizeUpdateDialog name={ask.name} steps={ask.steps} estimate={ask.estimate} onClose={onClose} onRun={() => onNormalize()} />;
}
