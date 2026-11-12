import { useState } from 'react';
import { JOB_KINDS, type ActionItem, type RunDetail, type RunOffers } from '../api.js';
import { consentAsked } from '../actions.js';
import { ConsentDialog } from '../components/Dialog.js';
import { useApp } from '../state.js';
import { bisectBlocked, unknownBisect } from './offers.js';
import { useBilledPress } from '../components/JobButton.js';
import { sentEstimate } from '../spending.js';
import { rowPriced, type RowPrice } from './estimates.js';
import { onShow } from '../components/OnShow.js';
import { TestDialogPart } from '../injection/test-part.js';
import { PresetsDialogPart } from '../presets/part.js';
import type { TestOpener } from './ForkMenu.js';
import type { UntrustedView } from '../types.js';

/** The dialog an action asks in, a part of its own: it loads the first time an action asks something first (OnShow.tsx). */
const ActionDialog = onShow(() => import('./ActionDialog.js').then((m) => m.ActionDialog));
/** Find breaking commit's dialog, which a run's page rarely opens: a part of its own, with Delete run's (OnShow.tsx). */
const BisectDialog = onShow(() => import('./RunDialogs.js').then((m) => m.BisectDialog));

/**
 * Running a run's actions, the fork menu's (ForkMenu.tsx) among them, and the dialog an action asks
 * its one thing in. The browser names the action; the server builds the command line.
 */

export interface PendingAction {
  action: ActionItem;
  callNo: number | null;
  /** The call's recorded result, to start an override from. */
  recorded?: unknown;
  callName?: string;
  /** The call is a model call, as Run live's ask words it. */
  modelCall?: boolean;
  /** The run it acts on, where it isn't the page's: Replay recording replays the recording a replay came from. */
  runId?: string;
  /**
   * What it bills, as the fork menu's row said it (`rowPriced`): false for a row that bills nothing.
   * Left out (a key, the banner), the runner tells a row that bills nothing by its key and the run.
   */
  estimate?: RowPrice;
  /** Plant instruction…'s Judged by, as its dialog sent it: the text of its `--expect`. */
  expect?: string;
}

/**
 * Starts an action, or opens its dialog when it asks for something first, or only whether to start
 * (`asksFirst`: a fork's Repeat 5 times, whose attempts run live). Find breaking commit, which the
 * fork menu lists with the whole run's actions, is the tests' `bisect` job: its dialog asks for a
 * commit where the run still worked. A replay of a run from someone else's pack, or a teammate's
 * pulled from the team store, runs their command: the server refuses it until it is confirmed, and
 * says the command, which a dialog shows, and only its Run sends the yes.
 */
export function useActionRunner(runId: string, capture = false, offers: RunOffers | null = null, forkAt?: number | null, record?: Pick<RunDetail['run'], 'meta'>) {
  const app = useApp();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [bisecting, setBisecting] = useState(false);
  const [consent, setConsent] = useState<{ p: PendingAction; value?: string; why: string; confirm: string } | null>(null);
  const [testing, setTesting] = useState<Parameters<TestOpener> | null>(null);
  const [presets, setPresets] = useState<string | null>(null);
  const test: TestOpener = (...t) => app.guard(() => setTesting(t));
  const findCommit = () => {
    if (app.actionsOff) return app.toast(app.actionsOff);
    const blocked = bisectBlocked(runId, offers?.bisect ?? null, app.hasKind(JOB_KINDS.bisect));
    if (blocked) return app.toast(blocked);
    app.guard(() => setBisecting(true));
  };
  const press = useBilledPress();
  // Each start sends the estimate the row or its ask showed, the consent's yes too, so the drawer says the same.
  const start = (p: PendingAction, value?: string, yes?: string) =>
    app.guard(
      () =>
        void app.client.action(p.runId ?? runId, p.action.key, p.callNo, value, yes, { ...sentEstimate(p.estimate || null), ...(p.expect ? { expect: p.expect } : {}) }).then(
          (job) => app.watchJob(Promise.resolve(job)),
          (err: unknown) => {
            const asked = yes === undefined ? consentAsked(err) : null;
            if (asked) setConsent({ p, ...(value !== undefined ? { value } : {}), ...asked });
            else app.watchJob(Promise.reject(err));
          },
        ),
    );
  // A prompt opens its dialog on every setting, as a form does; a row that bills nothing starts; the rest follow Spending.
  const run = (p: PendingAction) => {
    if (p.action.disabled) return app.toast(p.action.disabled);
    if (app.actionsOff) return app.toast(app.actionsOff);
    // Run error-path presets… (`c`) asks in its own dialog, which prices the picks.
    if (p.action.key === 'c') return app.guard(() => setPresets(p.runId ?? runId));
    const priced = 'estimate' in p ? p.estimate : rowPriced(undefined, p.action, forkAt != null || !!p.action.asksFirst);
    if (p.action.prompt) app.guard(() => setPending(p));
    else if (priced === false) app.guard(() => start(p));
    else press({ estimate: priced, start: () => start(p), ask: () => setPending(p) });
  };
  const dialog = pending ? (
    <ActionDialog
      runId={pending.runId ?? runId}
      capture={capture}
      forkAt={forkAt}
      pending={pending}
      expect={record?.meta?.expect}
      onClose={() => setPending(null)}
      onRun={(v, estimate, expect) => start({ ...pending, estimate, ...(expect ? { expect } : {}) }, v)}
    />
  ) : consent ? (
    <ConsentDialog
      why={consent.why}
      ok="Run command"
      onClose={() => setConsent(null)}
      onOk={() => start(consent.p, consent.value, consent.confirm)}
    />
  ) : bisecting ? (
    <BisectDialog
      runId={runId}
      offer={offers?.bisect ?? unknownBisect(runId)}
      onClose={() => setBisecting(false)}
      onRun={(good, sent) => app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.bisect, { runId, good, ...sent })))}
    />
  ) : testing ? (
    <TestDialogPart runId={runId} reads={testing[0]} estimate={testing[1]} onClose={() => setTesting(null)} />
  ) : presets ? (
    <PresetsDialogPart runId={presets} onClose={() => setPresets(null)} />
  ) : null;
  return { run, dialog, findCommit, test };
}

/** Run injection test… where the page offers it, the fork menu's row and the palette's: none on an injection test's attempt. */
export function testOpeners(attempt: unknown, untrusted: ReadonlyMap<number, UntrustedView>, test: TestOpener): { menu?: TestOpener; palette?: { reads: number; open: () => void } } {
  return attempt ? {} : { menu: test, palette: { reads: untrusted.size, open: () => test([...untrusted.values()], undefined) } };
}
