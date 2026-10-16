import { useState } from 'react';
import { ApiError, JOB_KINDS, type BlameOffer } from '../api.js';
import { ConfirmDialog } from '../components/Dialog.js';
import { useApp } from '../state.js';
import { blameHover, blameReply, blameRequest } from './offers.js';
import { BlameDialog } from './RunDialogs.js';

/**
 * Run blame, in the banner of a failed run never blamed: the fixes' `blame` job, which finds the model
 * call where the run was lost and opens or joins its fix. It sends the run alone, and the job finds
 * the check itself, as the CLI judges the run; when nothing names it the job answers 422 and this asks
 * for it. A run whose command came from someone else's pack runs only once confirmed (409, then
 * `yes`). Shown dimmed where it can't run, with why or the command to run instead.
 */
export function RunBlame({ runId, offer }: { runId: string; offer: BlameOffer }) {
  const app = useApp();
  const [asking, setAsking] = useState<null | { kind: 'check' } | { kind: 'consent'; why: string; fields: Record<string, unknown> }>(null);
  const canBlame = app.hasKind(JOB_KINDS.blame);
  const off = app.actionsOff;
  const start = (fields: Record<string, unknown>) =>
    app.client.startJob(JOB_KINDS.blame, fields).then(
      (job) => app.watchJob(Promise.resolve(job)),
      (err: unknown) => {
        const reply = err instanceof ApiError ? blameReply(err) : null;
        if (reply === 'check') setAsking({ kind: 'check' });
        else if (reply === 'consent') setAsking({ kind: 'consent', why: (err as Error).message, fields });
        else app.watchJob(Promise.reject(err));
      },
    );
  return (
    <>
      <button className="linkbtn" type="button" disabled={!canBlame || !!off} title={blameHover(runId, offer, { canBlame, actionsOff: off })} onClick={() => app.guard(() => void start(blameRequest(runId)))}>
        Run blame
      </button>
      {asking?.kind === 'check' ? (
        <BlameDialog
          runId={runId}
          offer={offer}
          onClose={() => setAsking(null)}
          onRun={(expect) => {
            setAsking(null);
            void start(blameRequest(runId, { expect }));
          }}
        />
      ) : null}
      {asking?.kind === 'consent' ? (
        <ConfirmDialog
          title="Run a command from an imported pack?"
          text={`${asking.why.replace(/\.?$/, '.')}`}
          ok="Run blame"
          onClose={() => setAsking(null)}
          onOk={() => {
            const fields = asking.fields;
            setAsking(null);
            void start({ ...fields, yes: true });
          }}
        />
      ) : null}
    </>
  );
}
