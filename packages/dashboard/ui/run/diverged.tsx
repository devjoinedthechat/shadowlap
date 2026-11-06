import { useState } from 'react';
import { JOB_KINDS, type RunDetail } from '../api.js';
import { UpdateGoldenDialog } from '../components/UpdateGolden.js';
import { goldenName } from '../format.js';
import { NormalizeUpdateDialog } from '../pages/TestsDialogs.js';
import { useApp } from '../state.js';
import { bannerNormalizerAsk, startTestsJob } from '../tests-ask.js';
import type { TestBannerOffer } from '../types.js';
import { divergedActions, updateGoldenCopy } from './offers.js';

/**
 * The jobs of a test that diverged, wherever they are offered: the header's next step and the plain
 * buttons its banner keeps. Add normalizer and re-run adds the rule and runs its golden again, Update
 * golden re-records it; each is the tests' job. When the rule alone can't make the replay match, the
 * job updates the golden after it, live, so it asks first in the Tests screen's dialog. A server
 * without the jobs falls back to the run's own normalizer action. A golden whose test runs live (an
 * injection gate) asks first, as Tests does (tests-ask.ts).
 */
export function useDivergedJobs(run: RunDetail, test: TestBannerOffer | null, replayChecks: number) {
  const app = useApp();
  const [dialog, setDialog] = useState<'update' | 'normalize' | null>(null);
  const r = run.run;
  const acts = divergedActions({ test, hasNormalizeJob: app.hasKind(JOB_KINDS.normalizeAndTest), hasUpdateJob: app.hasKind(JOB_KINDS.testUpdate), action: run.actions.some((a) => a.key === 'n'), actionsOff: app.actionsOff });
  const add = acts.normalizer;
  const addNormalizer = () => startTestsJob(app, JOB_KINDS.normalizeAndTest, { runId: r.runId }, bannerNormalizerAsk(test));
  const dialogs = (
    <>
      {dialog === 'update' && test ? (
        <UpdateGoldenDialog
          plan={updateGoldenCopy(test, r.divergence?.callNo ?? 1, add?.kind === 'job', replayChecks)}
          onInstead={addNormalizer}
          onClose={() => setDialog(null)}
          onUpdate={() => app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.testUpdate, { golden: test.golden })))}
        />
      ) : null}
      {dialog === 'normalize' && test && add?.kind === 'job' && add.asks ? (
        <NormalizeUpdateDialog
          name={goldenName(test.golden)}
          steps={add.asks}
          onClose={() => setDialog(null)}
          onRun={addNormalizer}
        />
      ) : null}
    </>
  );
  return {
    acts,
    /** Add normalizer, asking first where it re-records the golden after the rule. */
    normalize: () => (add?.kind === 'job' && add.asks ? app.guard(() => setDialog('normalize')) : addNormalizer()),
    /** Update golden, which always asks. */
    update: () => app.guard(() => setDialog('update')),
    dialogs,
  };
}
