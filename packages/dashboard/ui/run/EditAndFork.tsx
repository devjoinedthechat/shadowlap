import { useState } from 'react';
import { consentAsked } from '../actions.js';
import { JOB_KINDS, type ActionItem, type CallDetail } from '../api.js';
import { ConsentDialog } from '../components/Dialog.js';
import { useApp } from '../state.js';
import { ActionButton } from '../components/ActionButton.js';
import { tipEst } from '../components/JobButton.js';
import { useServedParts } from '../served-parts.js';
import { heldRunEstimates } from './estimates.js';

/**
 * Edit this result and fork, from the inspector: a tool's recorded result, or what a person answered
 * (`user_input`), edited in place, then forked with it. It is the fork menu's own override
 * (`shadowlap replay --override`), the edited result sent to the server as an upload, which checks
 * it as untrusted data (UTF-8, at most 2 MB, JSON for a tool's result) and builds the command. A
 * model call's answer can't be edited: `--override` changes a tool's result or what a person
 * answered, nothing else. A run from someone else's pack, or a teammate's pulled from the team
 * store, forks with their command: the server refuses the fork until it is confirmed, a dialog
 * shows the command it named, and only its Run sends the yes, with the same upload. Its dialog asks
 * what the fork would bill as it opens, never as a call is selected, and the fork keeps what its
 * Cost line said; its card says the amount only where the fork menu has already asked at the call.
 */

/** The fork menu's override at this call, when it has one: a tool's result (`o`), or a person's answer (`u`). */
export function overrideAction(detail: Pick<CallDetail, 'actions'>): ActionItem | null {
  return detail.actions.find((a) => a.key === 'o' || a.key === 'u') ?? null;
}

export function EditAndFork({ runId, detail, live }: { runId: string; detail: CallDetail; live: boolean }) {
  const app = useApp();
  // Its dialog, which a run's page rarely opens: a part the served entry hands in, as Find breaking commit's is (OnShow.tsx). A copy draws none of this.
  const { EditDialog } = useServedParts();
  const [open, setOpen] = useState(false);
  const [consent, setConsent] = useState<{ fields: Record<string, unknown>; why: string; confirm: string } | null>(null);
  const action = overrideAction(detail);
  if (app.exported || !action || !app.hasKind(JOB_KINDS.override)) return null;
  const off = live ? 'Fork once the recording finishes' : (action.disabled ?? null);
  const held = heldRunEstimates(runId, detail.call.callNo);
  // The fork, once the edited result is uploaded; a 409 that names someone else's command asks first.
  const start = (fields: Record<string, unknown>) =>
    app.client.startJob(JOB_KINDS.override, fields).then(
      (job) => app.watchJob(Promise.resolve(job)),
      (err: unknown) => {
        const asked = fields.yes === undefined ? consentAsked(err) : null;
        if (asked) setConsent({ fields, ...asked });
        else app.watchJob(Promise.reject(err));
      },
    );
  return (
    <>
      <ActionButton className="linkbtn" why={off} tip="Edit and fork" sub="Fork with this result edited: every call before it replays" est={held ? tipEst(held.actions[action.key] ?? null, true) : null} onClick={() => app.guard(() => setOpen(true))}>
        Edit and fork…
      </ActionButton>
      {open && EditDialog ? <EditDialog runId={runId} detail={detail} action={action} onFork={start} onClose={() => setOpen(false)} /> : null}
      {consent ? (
        <ConsentDialog why={consent.why} ok="Run command" onClose={() => setConsent(null)} onOk={() => app.guard(() => void start({ ...consent.fields, yes: consent.confirm }))} />
      ) : null}
    </>
  );
}
