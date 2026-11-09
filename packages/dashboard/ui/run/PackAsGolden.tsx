import { useState } from 'react';
import { consentAsked } from '../actions.js';
import { JOB_KINDS, type RunOffers } from '../api.js';
import { TestsJobButton } from '../fixes/TestsJobButton.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { useServedParts, type StepDialogProps } from '../served-parts.js';
import { guardedWayOn, useApp } from '../state.js';
import { errorText } from '../toast.js';
import { PACK_VERB } from './share.js';

/*
 * Pack as golden…'s button and what its dialog runs, in a module of their own: the run page's header
 * and step show them, and so does Tests' empty state, which loads none of the run page's other steps.
 */

/**
 * A step's dialog, Pack as golden…'s too, from the part the served dashboard hands in
 * (run/StepDialogs.tsx): none in a copy, which draws no step that asks.
 */
export function StepDialogPart(props: StepDialogProps) {
  const { StepDialog } = useServedParts();
  return StepDialog ? <StepDialog {...props} /> : null;
}

/**
 * Pack as golden…, lime where it leads and plain beside another step: the run packed into a folder
 * of the goldens, named for the run, then its test, as one job (`pack-test`), leaving the config as it
 * is. It waits while a Tests job holds the goldens. A start the server refuses keeps the dialog open
 * with its words, as a folder taken or a bad one is; a recording from elsewhere asks first, since its
 * test runs the command it was recorded with, and a start refused after that yes opens the dialog
 * again on the folder tried, with the server's words. `label` names the run where nothing else on the
 * page does: Tests' `Pack <id> as golden…`.
 */
export function PackAsGolden({ runId, folder, offers, lead, tip, fold, label = ACTIONS.packAsGolden.label }: { runId: string; folder: string; offers: RunOffers | null; lead: boolean; tip: string; fold?: string; label?: string }) {
  const app = useApp();
  // The dialog, on the folder last tried, with the server's words where it refused it.
  const [asking, setAsking] = useState<{ dir: string; refused: string | null } | null>(null);
  const [consent, setConsent] = useState<{ why: string; confirm: string; golden: string } | null>(null);
  const start = (golden: string, yes?: string): Promise<boolean> =>
    app.client.startJob(JOB_KINDS.keepGolden, { runId, golden, ...(yes ? { yes } : {}) }).then(
      (job) => {
        app.watchJob(Promise.resolve(job));
        return true;
      },
      (err: unknown) => {
        const asked = yes === undefined ? consentAsked(err) : null;
        if (asked) setConsent({ why: asked.why, confirm: asked.confirm, golden });
        else {
          setConsent(null);
          setAsking({ dir: golden, refused: errorText(err) });
        }
        return Boolean(asked);
      },
    );
  return (
    <>
      <TestsJobButton verb={PACK_VERB} off={null} className={lead ? 'btn lime' : 'btn'} tip={tip} {...(lead ? { lead: 'pack' } : {})} {...(fold ? { fold } : {})} onClick={() => app.guard(() => setAsking({ dir: folder, refused: null }))}>
        {label}
      </TestsJobButton>
      {asking ? <StepDialogPart ask={{ kind: 'pack', runId, dir: asking.dir, refused: asking.refused, offers, onRun: (dir) => guardedWayOn(app.guard, () => start(dir)) }} onClose={() => setAsking(null)} /> : null}
      {consent ? <StepDialogPart ask={{ kind: 'consent', why: consent.why, ok: confirmWords(ACTIONS.packAsGolden.label), onOk: () => guardedWayOn(app.guard, () => start(consent.golden, consent.confirm)) }} onClose={() => setConsent(null)} /> : null}
    </>
  );
}
