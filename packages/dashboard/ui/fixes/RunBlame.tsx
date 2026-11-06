import { useState } from 'react';
import { probesPart } from '../../../engine/src/cost-words.js';
import { consentAsked } from '../actions.js';
import { ApiError, JOB_KINDS } from '../api.js';
import { ConsentDialog, Dialog, PromptDialog, pressWayOn } from '../components/Dialog.js';
import { Icon } from '../components/Icon.js';
import { namedIn } from '../components/Id.js';
import { shortId } from '../format.js';
import type { ShortcutMark } from '../shortcuts.js';
import { guardedWayOn, useApp } from '../state.js';
import { errorText } from '../toast.js';
import { parseCheck } from './model.js';
import { useTreeBusy } from './tree.js';
import { ACTIONS } from '../labels.js';
import { ActionButton } from '../components/ActionButton.js';

/**
 * Run blame, for a failed run never blamed: a job that finds the model call where the run was lost
 * and opens or joins its fix. The server finds the check the run failed (its own --expect, the
 * config's tests for the recording it replays, the fix it fails in or its labels point to, or the
 * agent's exit); when nothing says what a passing run must do, this asks for it, naming the checks
 * the run failed (`failed`). A run whose command came from someone else's pack runs only once
 * confirmed; a capture, which has none, asks for yours first (`capture`). Disabled, with the reason,
 * where nothing runs or while a repair or an apply changes the working tree the agent would run from.
 */
export function RunBlameButton({
  runId,
  failed = [],
  className = 'linkbtn',
  title = 'Find the model call where this run was lost',
  tip,
  icon = false,
  lead = false,
  capture = false,
  line,
  mark,
  fold,
}: {
  runId: string;
  failed?: readonly string[];
  className?: string;
  /** The hover when nothing stops it. */
  title?: string;
  /** Or a hover card. */
  tip?: string;
  /** With the fix loop's icon, as the run page's lead button. */
  icon?: boolean;
  /** It is the run's next step, which the palette presses. */
  lead?: boolean;
  capture?: boolean;
  /** The command it runs, where it knows it: a capture's asks for what fills in its `<your command>`. */
  line?: string;
  /** Its key, where it is the run's next step. */
  mark?: ShortcutMark;
  /** A run header's plain button, which folds into its … menu by this name. */
  fold?: string;
}) {
  const app = useApp();
  const busy = useTreeBusy('reads', 'blame');
  const [asking, setAsking] = useState<null | { kind: 'command' } | { kind: 'check'; command: string | null } | { kind: 'consent'; why: string; confirm: string; fields: Record<string, unknown> }>(null);
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
          setAsking({ kind: 'check', command: typeof fields.command === 'string' ? fields.command : null });
          return 'expect' in fields ? err.message : null;
        }
        if (err instanceof ApiError && err.status === 400 && 'expect' in fields) return err.message;
        // No answer came: the check dialog stays, with what was typed and why.
        if (!(err instanceof ApiError) && 'expect' in fields) return errorText(err);
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
      <ActionButton
        className={className}
        why={busy}
        {...(tip ? { 'data-tip': tip } : { title })}
        {...(lead ? { 'data-next': 'blame' } : {})}
        {...(fold ? { 'data-fold': fold } : {})}
        onClick={() => app.guard(() => (capture ? setAsking({ kind: 'command' }) : void start({})))}
        {...mark}
      >
        {icon ? <Icon name="loop" /> : null}
        {ACTIONS.runBlame.label}
      </ActionButton>
      {asking?.kind === 'command' ? (
        <PromptDialog
          title={namedIn(`${ACTIONS.runBlame.label} on ${shortId(runId)}`, shortId(runId))}
          lead="Finds the model call that lost the run."
          doc="blame"
          label={`${shortId(runId)} came from a capture and has no command. What starts your agent?`}
          placeholder="python agent.py"
          command={(command) => (line ?? `shadowlap blame ${shortId(runId)} -- <your command>`).replace('<your command>', () => command || '<your command>')}
          cost={{ price: 'Billed by your provider', parts: [probesPart()] }}
          ok={ACTIONS.runBlame.label}
          onClose={() => setAsking(null)}
          onRun={(command) => app.guard(() => void start({ command }))}
        />
      ) : null}
      {asking?.kind === 'check' ? (
        <CheckDialog
          runId={runId}
          line={failedLine}
          command={asking.command}
          onClose={() => setAsking(null)}
          onRun={(expect) => guardedWayOn(app.guard, () => start({ expect, ...(asking.command ? { command: asking.command } : {}) })) || Promise.resolve(null)}
        />
      ) : null}
      {asking?.kind === 'consent' ? (
        <ConsentDialog
          why={asking.why}
          ok={ACTIONS.runBlame.label}
          onClose={() => setAsking(null)}
          onOk={() => app.guard(() => void start({ ...asking.fields, yes: asking.confirm }))}
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
export function CheckDialog({ runId, line, command = null, onClose, onRun }: { runId: string; line: string | null; /** A capture's, which it runs the blame with. */ command?: string | null; onClose: () => void; onRun: (expect: Record<string, unknown>) => Promise<string | null> }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const check = parseCheck(value);
    if ('error' in check) {
      setError(check.error);
      return false;
    }
    // What it starts closes it, or asks in its place; it stays only for what it says here.
    return onRun(check.expect).then((refused) => {
      if (refused) setError(refused);
      return false;
    });
  };
  return (
    <Dialog
      title={namedIn(`${ACTIONS.runBlame.label} on ${shortId(runId)}`, shortId(runId))}
      lead="Finds the model call that lost the run."
      doc="blame"
      warn={line ? { text: line } : null}
      command={`shadowlap blame ${shortId(runId)} --expect ${value.trim() ? `'${value.trim().replace(/'/g, `'\\''`)}'` : `'<check>'`}${command ? ` -- ${command}` : ''}`}
      cost={{ price: 'Billed by your provider', parts: [probesPart()] }}
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
