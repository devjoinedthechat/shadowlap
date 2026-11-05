import { useState } from 'react';
import { consentAsked } from '../actions.js';
import { ApiError, JOB_KINDS } from '../api.js';
import { ConsentDialog, Dialog, pressWayOn } from '../components/Dialog.js';
import { Icon } from '../components/Icon.js';
import { namedIn } from '../components/Id.js';
import { shortId } from '../format.js';
import { useApp } from '../state.js';
import { parseCheck } from './model.js';
import { useTreeBusy } from './tree.js';
import { ACTIONS } from '../labels.js';

/**
 * Run blame, for a failed run never blamed: a job that finds the model call where the run was lost
 * and opens or joins its fix. The server finds the check the run failed (its own --expect, the
 * config's tests for the recording it replays, the fix it fails in or its labels point to, or the
 * agent's exit); when nothing says what a passing run must do, this asks for it, naming the checks
 * the run failed (`failed`). A run whose command came from someone else's pack runs only once
 * confirmed. Disabled, with the reason, where nothing runs or while a repair or an apply changes the
 * working tree the agent would run from.
 */
export function RunBlameButton({ runId, failed = [], className = 'linkbtn', title = 'Find the model call where this run was lost', icon = false }: { runId: string; failed?: readonly string[]; className?: string; /** The hover when nothing stops it. */ title?: string; /** With the fix loop's icon, as the run page's lead button. */ icon?: boolean }) {
  const app = useApp();
  const busy = useTreeBusy('reads', 'blame');
  const [asking, setAsking] = useState<null | { kind: 'check' } | { kind: 'consent'; why: string; confirm: string; fields: Record<string, unknown> }>(null);
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
        const asked = fields.yes === undefined ? consentAsked(err) : null;
        if (asked) setAsking({ kind: 'consent', ...asked, fields });
        else {
          setAsking(null);
          app.watchJob(Promise.reject(err));
        }
        return null;
      },
    );
  const failedLine = failed.length ? `It failed “${failed[0]!}”${failed.length > 1 ? ` and ${failed.length - 1} more` : ''}, a check shadowlap.config.json doesn’t give` : null;
  return (
    <>
      <button className={className} type="button" disabled={!!why} title={why ?? title} onClick={() => app.guard(() => void start({}))}>
        {icon ? <Icon name="loop" /> : null}
        {ACTIONS.runBlame.label}
      </button>
      {asking?.kind === 'check' ? (
        <CheckDialog
          runId={runId}
          line={failedLine}
          onClose={() => setAsking(null)}
          onRun={(expect) => start({ expect })}
        />
      ) : null}
      {asking?.kind === 'consent' ? (
        <ConsentDialog
          why={asking.why}
          ok={ACTIONS.runBlame.label}
          onClose={() => setAsking(null)}
          onOk={() => {
            void start({ ...asking.fields, yes: asking.confirm });
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
export function CheckDialog({ runId, line, onClose, onRun }: { runId: string; line: string | null; onClose: () => void; onRun: (expect: Record<string, unknown>) => Promise<string | null> }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const check = parseCheck(value);
    if ('error' in check) {
      setError(check.error);
      return false;
    }
    return onRun(check.expect).then((refused) => {
      if (refused) setError(refused);
      return !refused;
    });
  };
  return (
    <Dialog
      title={namedIn(`${ACTIONS.runBlame.label} on ${shortId(runId)}`, shortId(runId))}
      lead="Finds the model call that lost the run."
      doc="blame"
      warn={line ? { text: line } : null}
      command={`shadowlap blame ${shortId(runId)} --expect ${value.trim() ? `'${value.trim().replace(/'/g, `'\\''`)}'` : `'<check>'`}`}
      cost={{ price: 'Billed by your provider', parts: ['live from each probe, writes stubbed'] }}
      ok={ACTIONS.runBlame.label}
      okDisabled={!value.trim()}
      onOk={submit}
      onClose={onClose}
    >
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
                pressWayOn(e.currentTarget);
              }
            }}
          />
        </label>
      </div>
      <p className="muted fieldhint">What a passing run must do, as an outcome check’s expect object</p>
      {error ? (
        <p className="fieldnote err" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
