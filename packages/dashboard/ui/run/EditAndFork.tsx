import { useState } from 'react';
import { JOB_KINDS, type ActionItem, type CallDetail } from '../api.js';
import { CmdLine, Seg } from '../components/bits.js';
import { Dialog } from '../components/Dialog.js';
import { shortId } from '../format.js';
import { useApp } from '../state.js';

/**
 * Edit this result and fork, from the inspector: a tool's recorded result, or what a person answered
 * (`user_input`), edited in place, then forked with it. It is the fork menu's own override
 * (`shadowlap replay --override`), the edited result sent to the server as an upload, which checks
 * it as untrusted data (UTF-8, at most 2 MB, JSON for a tool's result) and builds the command. A
 * model call's answer can't be edited: `--override` changes a tool's result or what a person
 * answered, nothing else.
 */

/** The largest result the server takes (`OVERRIDE_LIMIT` in src/routes/forks.ts). */
export const EDIT_LIMIT = 2 * 1024 * 1024;

/** The fork menu's override at this call, when it has one: a tool's result (`o`), or a person's answer (`u`). */
export function overrideAction(detail: Pick<CallDetail, 'actions'>): ActionItem | null {
  return detail.actions.find((a) => a.key === 'o' || a.key === 'u') ?? null;
}

/** What the editor opens with: the recorded result, as JSON laid out to edit, or as text when it is a string. */
export function editStart(detail: Pick<CallDetail, 'result'>, answer: boolean): { mode: 'json' | 'text'; text: string } {
  const recorded = (detail.result as { result?: unknown } | null)?.result;
  if (answer) {
    const text = typeof recorded === 'string' ? recorded : recorded && typeof recorded === 'object' && typeof (recorded as { text?: unknown }).text === 'string' ? (recorded as { text: string }).text : '';
    return { mode: 'text', text };
  }
  if (typeof recorded === 'string') return { mode: 'text', text: recorded };
  return { mode: 'json', text: recorded === undefined ? '{}' : JSON.stringify(recorded, null, 2) };
}

/**
 * What goes to the server, or why it can't: JSON as written (the server parses it), text as a JSON
 * string, a person's answer as its text.
 */
export function editBody(mode: 'json' | 'text', text: string, answer: boolean): { body: string } | { error: string } {
  if (answer) return text.trim() ? { body: text } : { error: 'Write what the person answers.' };
  let body = text;
  if (mode === 'json') {
    try {
      JSON.parse(text);
    } catch (err) {
      return { error: `Not JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
  } else body = JSON.stringify(text);
  return new TextEncoder().encode(body).length > EDIT_LIMIT ? { error: 'At most 2 MB.' } : { body };
}

export function EditAndFork({ runId, detail, live }: { runId: string; detail: CallDetail; live: boolean }) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const action = overrideAction(detail);
  if (app.exported || !action || !app.hasKind(JOB_KINDS.override)) return null;
  const off = live ? 'Fork once the recording finishes' : (app.actionsOff ?? action.disabled ?? null);
  return (
    <>
      <button className="linkbtn" type="button" disabled={!!off} title={off ?? 'Fork with this result edited: every call before it replays'} onClick={() => app.guard(() => setOpen(true))}>
        Edit and fork…
      </button>
      {open ? <EditDialog runId={runId} detail={detail} action={action} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function EditDialog({ runId, detail, action, onClose }: { runId: string; detail: CallDetail; action: ActionItem; onClose: () => void }) {
  const app = useApp();
  const c = detail.call;
  const answer = action.key === 'u';
  const start = editStart(detail, answer);
  const [mode, setMode] = useState(start.mode);
  const [text, setText] = useState(start.text);
  const out = editBody(mode, text, answer);
  const n = c.callNo;
  // A run from someone else's pack runs their command: the action's own words say so first.
  const label = action.prompt?.label ?? '';
  const warning = /^This run came from /.test(label) ? label.slice(0, label.lastIndexOf('. ') + 1) : null;
  const fork = () => {
    if ('error' in out) return;
    onClose();
    app.guard(() =>
      app.watchJob(
        app.client
          .upload(new Blob([out.body], { type: answer ? 'text/plain' : 'application/json' }), `${answer ? 'answer' : 'result'}-${n}.${answer ? 'txt' : 'json'}`)
          .then((up) => app.client.startJob(JOB_KINDS.override, { runId, callNo: n, uploadId: up.uploadId })),
      ),
    );
  };
  return (
    <Dialog
      title={answer ? `Answer #${n} differently and fork` : `Edit #${n} ${c.name}’s result and fork`}
      text={
        <>
          {warning ? <b className="warnline">{warning} </b> : null}
          The fork replays every call before #{n}, gives the agent this {answer ? 'answer' : 'result'} at #{n}, and runs on live from there, its writes fenced.
        </>
      }
      ok="Fork"
      okDisabled={'error' in out}
      onOk={fork}
      onClose={onClose}
      className="editfork"
    >
      {answer ? null : (
        <div className="editmode">
          <Seg
            label="Write the result as"
            items={[
              { key: 'json', label: 'JSON' },
              { key: 'text', label: 'Text' },
            ]}
            value={mode}
            onChange={(k) => setMode(k)}
          />
          <span>{mode === 'json' ? 'as the tool returns it' : 'sent as one string'}</span>
        </div>
      )}
      <label className="editfield">
        <span className="sr">{answer ? `What the person answers at #${n}` : `The result of #${n} ${c.name}`}</span>
        <textarea value={text} spellCheck={false} rows={12} onChange={(e) => setText(e.target.value)} aria-invalid={'error' in out} aria-describedby="editforkWhy" />
      </label>
      <p id="editforkWhy" className={`fieldnote${'error' in out ? ' err' : ''}`} role={'error' in out ? 'alert' : undefined}>
        {'error' in out ? out.error : `${new TextEncoder().encode(out.body).length.toLocaleString('en-US')} bytes, checked again by the dashboard before it forks.`}
      </p>
      <CmdLine>{`shadowlap replay ${shortId(runId)} --override ${n}=${answer ? '…' : '<this result>'}`}</CmdLine>
    </Dialog>
  );
}
