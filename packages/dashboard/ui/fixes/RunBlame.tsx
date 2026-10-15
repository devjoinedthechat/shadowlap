import { useState } from 'react';
import { ApiError, JOB_KINDS } from '../api.js';
import { ConfirmDialog, PromptDialog } from '../components/Dialog.js';
import { shortId } from '../format.js';
import { useApp } from '../state.js';

/**
 * Run blame, for a failed run never blamed: a job that finds the model call where the run was lost
 * and opens or joins its fix. The server finds the check the run failed (the one its replay was judged
 * by, the fix its labels point to, or the agent's exit); when nothing says what a passing run must do,
 * this asks for it. A run whose command came from someone else's pack runs only once confirmed.
 */
export function RunBlameButton({ runId, expect, className = 'linkbtn' }: { runId: string; expect?: unknown; className?: string }) {
  const app = useApp();
  const [asking, setAsking] = useState<null | { kind: 'check' } | { kind: 'consent'; why: string; fields: Record<string, unknown> }>(null);
  const start = (fields: Record<string, unknown>) => {
    app.client.startJob(JOB_KINDS.blame, { runId, ...fields }).then(
      (job) => app.watchJob(Promise.resolve(job)),
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 422) setAsking({ kind: 'check' });
        else if (err instanceof ApiError && err.status === 409 && /imported pack/.test(err.message)) setAsking({ kind: 'consent', why: err.message, fields });
        else app.watchJob(Promise.reject(err));
      },
    );
  };
  return (
    <>
      <button className={className} type="button" disabled={!!app.actionsOff} title={app.actionsOff ?? 'Find the model call where this run was lost'} onClick={() => app.guard(() => start(expect !== undefined ? { expect } : {}))}>
        Run blame
      </button>
      {asking?.kind === 'check' ? (
        <PromptDialog
          title={`Blame ${shortId(runId)}`}
          text="Say what a passing run must do, as the expect object of an outcome check: blame asks the model calls again until the run does it."
          label="Check (JSON)"
          placeholder='{"tools":{"send_email":1}}'
          multiline
          ok="Run blame"
          command={`shadowlap blame ${shortId(runId)} --expect '<check>'`}
          onClose={() => setAsking(null)}
          onRun={(text) => {
            setAsking(null);
            start({ expect: text });
          }}
        />
      ) : null}
      {asking?.kind === 'consent' ? (
        <ConfirmDialog
          title="Run a command from an imported pack?"
          text={`${asking.why}.`}
          ok="Run blame"
          onClose={() => setAsking(null)}
          onOk={() => {
            const fields = asking.fields;
            setAsking(null);
            start({ ...fields, yes: true });
          }}
        />
      ) : null}
    </>
  );
}
