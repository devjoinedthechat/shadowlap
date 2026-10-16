import { useState } from 'react';
import { ApiError, JOB_KINDS } from '../api.js';
import { CmdLine } from '../components/bits.js';
import { ConfirmDialog, Dialog } from '../components/Dialog.js';
import { shortId } from '../format.js';
import { useApp } from '../state.js';
import { parseCheck } from './model.js';
import { useTreeBusy } from './tree.js';

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
  const busy = useTreeBusy('reads', 'blame');
  const [asking, setAsking] = useState<null | { kind: 'check' } | { kind: 'consent'; why: string; fields: Record<string, unknown> }>(null);
  const why = app.actionsOff ?? busy;
  /**
   * Starts the blame. What the check dialog should show instead comes back: why the server refused
   * the check it was given. Anything else closes the dialog: the job, the consent it needs, or its
   * failure in the drawer.
   */
  const start = (fields: Record<string, unknown>): Promise<string | null> =>
    app.client.startJob(JOB_KINDS.blame, { runId, ...fields }).then(
      (job) => {
        setAsking(null);
        app.watchJob(Promise.resolve(job));
        return null;
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 422) {
          setAsking({ kind: 'check' });
          return 'expect' in fields ? err.message : null;
        }
        if (err instanceof ApiError && err.status === 400 && 'expect' in fields) return err.message;
        if (err instanceof ApiError && err.status === 409 && /imported pack/.test(err.message)) setAsking({ kind: 'consent', why: err.message, fields });
        else {
          setAsking(null);
          app.watchJob(Promise.reject(err));
        }
        return null;
      },
    );
  const failedText = failed.length ? `It failed “${failed[0]}”${failed.length > 1 ? ` and ${failed.length - 1} more` : ''}, a check shadowlap.config.json doesn’t give. ` : '';
  return (
    <>
      <button className={className} type="button" disabled={!!why} title={why ?? 'Find the model call where this run was lost'} onClick={() => app.guard(() => void start({}))}>
        Run blame
      </button>
      {asking?.kind === 'check' ? (
        <CheckDialog
          runId={runId}
          text={`${failedText}Say what a passing run must do, as the expect object of an outcome check: blame asks the model calls again until the run does it.`}
          onClose={() => setAsking(null)}
          onRun={(expect) => start({ expect })}
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
            void start({ ...fields, yes: true });
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The check a blame needs, typed as JSON. It is read before anything is sent, and the dialog stays
 * open, with what was typed, until the job has started: a check that isn't an object, or one the
 * server refuses, says why under the field.
 */
function CheckDialog({ runId, text, onClose, onRun }: { runId: string; text: string; onClose: () => void; onRun: (expect: Record<string, unknown>) => Promise<string | null> }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const submit = () => {
    if (sending || !value.trim()) return;
    const check = parseCheck(value);
    if ('error' in check) {
      setError(check.error);
      return;
    }
    setSending(true);
    void onRun(check.expect).then((refused) => {
      setSending(false);
      if (refused) setError(refused);
    });
  };
  return (
    <Dialog title={`Blame ${shortId(runId)}`} text={text} ok="Run blame" okDisabled={!value.trim() || sending} onOk={submit} onClose={onClose}>
      <div className="form one">
        <label>
          Check (JSON)
          <textarea
            value={value}
            placeholder='{"tools":{"send_email":1}}'
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
          />
        </label>
      </div>
      {error ? (
        <p className="fieldnote err" role="alert">
          {error}
        </p>
      ) : null}
      <CmdLine>{`shadowlap blame ${shortId(runId)} --expect '<check>'`}</CmdLine>
    </Dialog>
  );
}
