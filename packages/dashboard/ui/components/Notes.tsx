import { useEffect, useState } from 'react';
import type { Client } from '../api.js';
import { ago } from '../format.js';

/**
 * Labels on a run and notes on a call: what people know that the recording can't. Both are written
 * straight to the store, and only from a dashboard started with actions enabled.
 */

export function LabelsBar({ client, runId, labels, enabled }: { client: Client; runId: string; labels: string[]; enabled: boolean }) {
  const [shown, setShown] = useState(labels);
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setShown(labels), [labels.join('\n')]);
  if (!shown.length && !enabled) return null;
  const change = async (add: string[], remove: string[]) => {
    setError(null);
    try {
      setShown((await client.labels(runId, add, remove)).labels);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };
  return (
    <div className="labels" aria-label="Labels">
      {shown.map((l) => (
        <span className="label-chip" key={l}>
          {l}
          {enabled ? (
            <button type="button" aria-label={`Remove label ${l}`} title="Remove" onClick={() => void change([], [l])}>
              ×
            </button>
          ) : null}
        </span>
      ))}
      {enabled && !adding ? (
        <button type="button" className="textbtn" onClick={() => setAdding(true)}>
          + label
        </button>
      ) : null}
      {adding ? (
        <form
          className="label-form"
          onSubmit={(e) => {
            e.preventDefault();
            const v = value.trim();
            if (!v) return setAdding(false);
            void change([v], []).then((ok) => {
              if (ok) {
                setValue('');
                setAdding(false);
              }
            });
          }}
        >
          <input
            className="field-input compact"
            id="label-input"
            autoFocus
            placeholder="bug, good, refund-flow"
            value={value}
            maxLength={40}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (setAdding(false), setValue(''))}
            onBlur={() => !value.trim() && setAdding(false)}
            aria-label="New label"
          />
        </form>
      ) : null}
      {error ? <span className="err note">{error}</span> : null}
    </div>
  );
}

export function CallNotes({ client, runId, callNo, notes, enabled }: { client: Client; runId: string; callNo: number; notes: Array<{ text: string; at: number }>; enabled: boolean }) {
  const [shown, setShown] = useState(notes);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (!shown.length && !enabled) return null;
  return (
    <section className="notes" aria-label="Notes">
      <h3 className="section-label">Notes</h3>
      {shown.length ? (
        <ul className="note-list">
          {shown.map((n, i) => (
            <li key={i}>
              <p>{n.text}</p>
              <span className="muted">{ago(n.at)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {enabled ? (
        <form
          className="note-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            setSaving(true);
            setError(null);
            client
              .note(runId, callNo, text)
              .then((r) => {
                setShown(r.notes);
                setText('');
              })
              .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
              .finally(() => setSaving(false));
          }}
        >
          <textarea className="field-input" id={`note-${callNo}`} rows={2} placeholder="What happened here, and why it matters" value={text} onChange={(e) => setText(e.target.value)} aria-label="New note on this call" />
          <div className="note-actions">
            {error ? <span className="err note">{error}</span> : null}
            <button type="submit" className="btn small" disabled={saving || !text.trim()}>
              Add note
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
