import { useMemo, useState } from 'react';
import { JOB_KINDS } from '../api.js';
import { updateOutdatedAsk } from '../fixes/dialog-words.js';
import type { OutdatedGolden } from '../fixes/model.js';
import { useLoad } from '../hooks.js';
import { ACTIONS } from '../labels.js';
import { testsJob } from '../pages/tests-cards.js';
import { sentEstimate } from '../spending.js';
import { useApp } from '../state.js';
import { useTestsEstimates, type Price } from '../tests-estimates.js';
import { updatesPrice } from '../tests-prices.js';
import { maskFirst } from '../update-plan.js';
import { JobButton } from './JobButton.js';
import { UpdateGoldenDialog } from './UpdateGolden.js';

/**
 * Update goldens on the goldens an apply left behind (Apply fix's and Apply config change's drawer, a
 * migration's page while any waits): it re-records them (`shadowlap test <goldens> --update`), asking
 * first, as the Tests screen's Update goldens does. Its card and its dialog's Cost line say what
 * re-recording them together would bill (`GET /api/tests/estimates`), and the job keeps the estimate
 * shown. Where the last replay of one diverged on a value made anew every run (their divergences on
 * Tests, `GET /api/tests`), the dialog leads with Add normalizer and update, one job that adds each
 * rule once and then updates them all. `id` keys its reads (the job's, the migration's); `sub` is its
 * card's line. Nothing where none waits or the server can't update goldens.
 */
export function UpdateOutdated({ outdated, id, lime, sub }: { outdated: readonly OutdatedGolden[]; id: string; lime: boolean; sub?: string | undefined }) {
  const app = useApp();
  const [asking, setAsking] = useState<{ estimate: Price; ask: ReturnType<typeof updateOutdatedAsk> } | null>(null);
  const [started, setStarted] = useState(false);
  const names = outdated.map((g) => g.golden).join('\n');
  const paths = useMemo(() => (names ? names.split('\n') : []), [names]);
  const shows = paths.length > 0 && app.hasKind(JOB_KINDS.testUpdate);
  const prices = useTestsEstimates(shows ? id : null, paths);
  const tests = useLoad(() => (shows ? app.client.tests() : null), shows ? `apply-goldens:${id}` : '').data;
  if (!shows) return null;
  // The dialog keeps what it opened with, so a read that lands while it is open never moves its buttons.
  const ask = updateOutdatedAsk(outdated, tests ? maskFirst(tests, paths, app.hasKind) : undefined);
  const card = { tip: ACTIONS.updateGoldens.label, ...(sub ? { sub } : {}), command: ask.command };
  const start = (fields: Record<string, unknown>, estimate: Price) => {
    const went = app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.testUpdate, { ...fields, ...sentEstimate(estimate) })));
    if (went) setStarted(true);
    return went;
  };
  const instead = asking?.ask.instead;
  return (
    <>
      <JobButton className={lime ? 'btn lime' : 'btn'} disabled={started} {...testsJob(card, updatesPrice(prices, paths), (e) => app.guard(() => setAsking({ estimate: e, ask })))}>
        {ACTIONS.updateGoldens.label}
      </JobButton>
      {asking ? (
        <UpdateGoldenDialog
          plan={asking.ask}
          estimate={asking.estimate}
          onClose={() => setAsking(null)}
          onUpdate={() => start(asking.ask.fields, asking.estimate)}
          {...(instead?.run === 'normalize-update-all' ? { onInstead: () => start({ goldens: instead.goldens, normalize: true }, asking.estimate) } : {})}
        />
      ) : null}
    </>
  );
}
