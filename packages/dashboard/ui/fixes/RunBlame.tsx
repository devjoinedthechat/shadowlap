import { useState } from 'react';
import { ApiError, JOB_KINDS } from '../api.js';
import { ConfirmDialog, PromptDialog } from '../components/Dialog.js';
import { shortId } from '../format.js';
import { useApp } from '../state.js';
import { treeBusy } from './model.js';
import { useTreeJobs } from './tree.js';

/**
 * Run blame, for a failed run never blamed: a job that finds the model call where the run was lost
 * and opens or joins its fix. The server finds the check the run failed (its own --expect, the
 * config's tests for the recording it replays, the fix it fails in or its labels point to, or the
 * agent's exit); when nothing says what a passing run must do, this asks for it, naming the checks
 * the run failed (`failed`). A run whose command came from someone else's pack runs only once
 * confirmed. Disabled, with the reason, where nothing runs or while a repair or an apply changes the
 * working tree the agent would run from.
 */
export function RunBlameButton({ runId, failed = [], className = 'linkbtn' }: { runId: string; failed?: readonly string[]; className?: string }) {
  const app = useApp();
  const tree = useTreeJobs();
  const [asking, setAsking] = useState<null | { kind: 'check' } | { kind: 'consent'; why: string; fields: Record<string, unknown> }>(null);
  const why = app.actionsOff ?? treeBusy(tree, 'reads', 'blame');
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
  const failedText = failed.length ? `It failed “${failed[0]}”${failed.length > 1 ? ` and ${failed.length - 1} more` : ''}, a check shadowlap.config.json doesn’t give. ` : '';
  return (
    <>
      <button className={className} type="button" disabled={!!why} title={why ?? 'Find the model call where this run was lost'} onClick={() => app.guard(() => start({}))}>
        Run blame
      </button>
      {asking?.kind === 'check' ? (
        <PromptDialog
          title={`Blame ${shortId(runId)}`}
          text={`${failedText}Say what a passing run must do, as the expect object of an outcome check: blame asks the model calls again until the run does it.`}
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
