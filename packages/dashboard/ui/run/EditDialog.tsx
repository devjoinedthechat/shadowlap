import { useState } from 'react';
import { liveFromPart } from '../../../engine/src/cost-words.js';
import type { ActionItem, CallDetail } from '../api.js';
import { Seg } from '../components/bits.js';
import { Dialog } from '../components/Dialog.js';
import { shortId } from '../format.js';
import { messageOf } from '../../../engine/src/message-of.js';
import { useApp } from '../state.js';
import { sentEstimate } from '../spending.js';
import { rowPriced, useRunEstimates } from './estimates.js';

/**
 * Edit and fork's dialog (EditAndFork.tsx): the result edited, as JSON or as text, or what a person
 * answered, checked here as it is written, then uploaded and forked with. A part of its own, which
 * loads the first time it shows (OnShow.tsx).
 */

/** The largest result the server takes (`OVERRIDE_LIMIT` in src/routes/forks.ts). */
export const EDIT_LIMIT = 2 * 1024 * 1024;

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
      return { error: `Not JSON: ${messageOf(err)}` };
    }
  } else body = JSON.stringify(text);
  return new TextEncoder().encode(body).length > EDIT_LIMIT ? { error: 'At most 2 MB.' } : { body };
}

export function EditDialog({ runId, detail, action, onFork, onClose }: { runId: string; detail: CallDetail; action: ActionItem; onFork: (fields: Record<string, unknown>) => Promise<void>; onClose: () => void }) {
  const app = useApp();
  const c = detail.call;
  const answer = action.key === 'u';
  const start = editStart(detail, answer);
  const [mode, setMode] = useState(start.mode);
  const [text, setText] = useState(start.text);
  const out = editBody(mode, text, answer);
  const n = c.callNo;
  const estimate = rowPriced(useRunEstimates(runId, n), action, false);
  // A run from someone else's pack runs their command: the action's own words say so first.
  const label = action.prompt?.label ?? '';
  const warning = /^This run came from /.test(label) ? label.slice(0, label.lastIndexOf('. ')) : null;
  const fork = () => {
    if ('error' in out) return false;
    return app.guard(
      () =>
        void app.client.upload(new Blob([out.body], { type: answer ? 'text/plain' : 'application/json' }), `${answer ? 'answer' : 'result'}-${n}.${answer ? 'txt' : 'json'}`).then(
          (up) => onFork({ runId, callNo: n, uploadId: up.uploadId, ...sentEstimate(estimate || null) }),
          (err: unknown) => app.watchJob(Promise.reject(err)),
        ),
    );
  };
  return (
    <Dialog
      title={answer ? `Edit and fork user reply at #${n}` : `Edit and fork #${n} ${c.name}`}
      lead={`The agent gets this ${answer ? 'reply' : 'result'} at #${n} instead of the recorded one.`}
      doc="overrideResult"
      warn={warning ? { text: warning } : null}
      command={`shadowlap replay ${shortId(runId)} --override ${n}=${answer ? '…' : '<this result>'}`}
      cost={{ price: 'Billed by your provider', parts: [liveFromPart('the next model call')], ...(estimate ? { estimate } : {}) }}
      ok="Edit and fork"
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
    </Dialog>
  );
}
