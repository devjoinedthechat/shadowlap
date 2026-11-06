import { useState } from 'react';
import type { NextStepKey } from '../../src/next-step.js';
import { GOLDEN_JOB_WORDS } from '../../../engine/src/golden-job-words.js';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import { JOB_KINDS, type RunDetail } from '../api.js';
import type { TestsCard } from '../fixes/TestsJobButton.js';
import { commandText } from '../goldens.js';
import { onShow } from '../components/OnShow.js';
import { goldenName } from '../format.js';
import { ACTIONS } from '../labels.js';
import { sentEstimate } from '../spending.js';
import { useApp, type AppState } from '../state.js';
import { bannerNormalizerAsk, startTestsJob } from '../tests-ask.js';
import type { TestBannerOffer } from '../types.js';
import type { DivergedAsk } from './DivergedDialogs.js';
import { divergedActions, updateGoldenCopy, type NormalizerChoice } from './offers.js';

/** What a diverged test's jobs bill, where the page knows: none, or undefined while it is worked out, and each asks. */
export interface DivergedPrices {
  normalize?: Estimate | null | undefined;
  update?: Estimate | null | undefined;
}

/** What a test that diverged offers, by the jobs this server runs. */
function jobsOffered(app: Pick<AppState, 'hasKind' | 'actionsOff'>, run: RunDetail, test: TestBannerOffer | null) {
  return divergedActions({ test, hasNormalizeJob: app.hasKind(JOB_KINDS.normalizeAndTest), hasUpdateJob: app.hasKind(JOB_KINDS.testUpdate), action: run.actions.some((a) => a.key === 'n'), actionsOff: app.actionsOff });
}

/** Whether the banner of a test that diverged draws a job's button: one the header's next step doesn't lead with. */
export function bannerJobsShown(app: Pick<AppState, 'hasKind' | 'actionsOff'>, run: RunDetail, test: TestBannerOffer | null, leads: (key: NextStepKey) => boolean): boolean {
  const acts = jobsOffered(app, run, test);
  return (acts.normalizer?.kind === 'job' && !leads('normalizer')) || (!!acts.update && !leads('update-golden'));
}

/** The dialogs it asks in: rarely opened, so a part of their own, which loads as one first shows. */
const DivergedDialogs = onShow(() => import('./DivergedDialogs.js').then((m) => m.DivergedDialogs));

/**
 * The jobs of a test that diverged, wherever they are offered: the header's next step and the plain
 * buttons its banner keeps. Add normalizer and re-run adds the rule and runs its golden again, Update
 * golden re-records it; each is the tests' job. When the rule alone can't make the replay match, the
 * job updates the golden after it, live, so it asks first in the Tests screen's dialog. A server
 * without the jobs falls back to the run's own normalizer action. A golden whose test runs live (an
 * injection gate) asks first, as Tests does (tests-ask.ts), by Spending where `prices` holds its
 * estimate; each job keeps the estimate it starts with.
 */
export function useDivergedJobs(run: RunDetail, test: TestBannerOffer | null, replayChecks: number, prices: DivergedPrices = {}) {
  const app = useApp();
  const [dialog, setDialog] = useState<'update' | 'normalize' | null>(null);
  const r = run.run;
  const acts = jobsOffered(app, run, test);
  const add = acts.normalizer;
  const addNormalizer = () => startTestsJob(app, JOB_KINDS.normalizeAndTest, { runId: r.runId, ...sentEstimate(prices.normalize) }, { ...bannerNormalizerAsk(test), estimate: prices.normalize });
  const ask: DivergedAsk | null = !test
    ? null
    : dialog === 'update'
      ? { kind: 'update', plan: updateGoldenCopy(test, r.divergence?.callNo ?? 1, add?.kind === 'job', replayChecks), estimate: prices.update }
      : dialog === 'normalize' && add?.kind === 'job' && add.asks
        ? { kind: 'normalize', name: goldenName(test.golden), steps: add.asks, estimate: prices.normalize }
        : null;
  const dialogs = ask && test ? <DivergedDialogs ask={ask} onNormalize={addNormalizer} onClose={() => setDialog(null)} onUpdate={() => app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.testUpdate, { golden: test.golden, ...sentEstimate(prices.update) })))} /> : null;
  return {
    acts,
    /** What its jobs bill, as their cards say it and they keep it. */
    prices,
    /** Add normalizer, asking first where it re-records the golden after the rule. */
    normalize: () => (add?.kind === 'job' && add.asks ? app.guard(() => setDialog('normalize')) : addNormalizer()),
    /** Update golden, which always asks. */
    update: () => app.guard(() => setDialog('update')),
    dialogs,
  };
}

/**
 * The cards of a diverged test's buttons on its banner, in the run's next step's words: what Add
 * normalizer does, by whether its rule alone makes the replay match, and Update golden, each with the
 * command it runs.
 */
export function bannerCards(test: TestBannerOffer | null, add: NormalizerChoice): { normalize?: TestsCard; update?: TestsCard } {
  if (!test) return {};
  const remakes = add?.kind === 'job' && !!add.asks;
  const normalize = { tip: add?.kind === 'job' ? add.label : ACTIONS.addNormalizer.label, sub: remakes ? GOLDEN_JOB_WORDS.masksThenRemakes : GOLDEN_JOB_WORDS.masksThenReplays, command: (test.normalizeAndTest ?? []).map(commandText).join(' && ') };
  return { normalize, update: { tip: ACTIONS.updateGolden.label, sub: GOLDEN_JOB_WORDS.remade, command: commandText(['test', test.golden, '--update']) } };
}
