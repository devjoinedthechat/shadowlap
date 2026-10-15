import { useState } from 'react';
import { JOB_KINDS, type RunDetail } from '../api.js';
import { Dialog, PromptDialog } from '../components/Dialog.js';
import { Popover } from '../components/Popover.js';
import { shortId } from '../format.js';
import { DatasetDialog } from '../pages/Runs.js';
import { href } from '../route.js';
import { useApp } from '../state.js';
import type { PendingAction } from './actions.js';

/**
 * Share: the run as an HTML file (with the runs it came from), a pack, an eval dataset, an
 * OpenTelemetry trace or a HAR, each when the server can make it, and how many redaction rules a
 * copy applies.
 */
export function ShareMenu({ anchor, run, onClose, onAction }: { anchor: HTMLElement; run: RunDetail; onClose: () => void; onAction: (p: PendingAction) => void }) {
  const app = useApp();
  const { client, toast, hasKind, meta, guard, actionsOff } = app;
  const [dialog, setDialog] = useState<'pack' | 'dataset' | 'otel' | null>(null);
  const id = run.run.runId;
  const low = shortId(id).toLowerCase();
  const packAction = run.actions.find((a) => a.key === 'p');
  const rules = meta?.redactRules;
  const close = () => {
    setDialog(null);
    onClose();
  };
  const item = (label: string, note: string, onPick: () => void, disabled?: string | null) => (
    <button type="button" role="menuitem" disabled={!!disabled} title={disabled ?? undefined} onClick={onPick}>
      <b>{label}</b>
      <small>{note}</small>
    </button>
  );
  const job = (kind: string, fields: Record<string, unknown>) => guard(() => app.watchJob(client.startJob(kind, fields)));
  if (dialog === 'pack')
    return (
      <PromptDialog
        title={`Pack ${shortId(id)}`}
        text="A folder to commit as a golden or send to someone: run.json, calls.jsonl and one file per blob. Redaction rules apply to the copy; the store is never changed."
        label="Folder"
        initial={`share/${low}`}
        ok="Pack"
        onClose={close}
        onRun={(dir) => {
          close();
          job(JOB_KINDS.pack, { runId: id, dir });
        }}
      />
    );
  if (dialog === 'dataset') return <DatasetDialog ids={[id]} onClose={close} />;
  if (dialog === 'otel') return <OtelDialog runId={id} onClose={close} onRun={(fields) => job(JOB_KINDS.otel, fields)} />;
  return (
    <Popover anchor={anchor} onClose={onClose} label="Share">
      <div className="pk">Share {shortId(id)}</div>
      {item('HTML file', 'export html · these views in one file that opens anywhere', () => {
        onClose();
        guard(() =>
          client.exportHtml(id).then(
            (r) => toast(`Saved ${r.filename}${run.parent ? ' with the runs it came from' : ''} · ${r.redacted ? 'redaction rules applied' : 'no redaction rules to apply'}`),
            (err: unknown) => toast(err instanceof Error ? err.message : String(err)),
          ),
        );
      })}
      {hasKind(JOB_KINDS.pack)
        ? item('Pack', 'pack · a folder for a golden, or for a colleague to replay', () => setDialog('pack'), actionsOff)
        : packAction
          ? item(
              'Pack',
              'pack · a folder for a golden, or for a colleague to replay',
              () => {
                onClose();
                onAction({ action: packAction, callNo: null });
              },
              actionsOff ?? packAction.disabled,
            )
          : null}
      {hasKind(JOB_KINDS.dataset) ? item('Dataset for evals', 'export dataset · JSONL, Braintrust, Langfuse or OpenAI chat', () => setDialog('dataset'), actionsOff) : null}
      {hasKind(JOB_KINDS.otel) ? item('OpenTelemetry trace', 'export otel · a span per call, for the tools you already use', () => setDialog('otel'), actionsOff) : null}
      {hasKind(JOB_KINDS.har)
        ? item(
            'HAR',
            'export har · the model calls, for anything that reads HTTP archives',
            () => {
              onClose();
              job(JOB_KINDS.har, { runId: id });
            },
            actionsOff,
          )
        : null}
      <hr />
      <div className="pnote">
        {typeof rules === 'number' ? (
          rules ? (
            <>
              {rules} redaction {rules === 1 ? 'rule applies' : 'rules apply'} to every copy.{' '}
              <a className="more" href={href.settings('redaction')}>
                Settings
              </a>
            </>
          ) : (
            <>
              No redaction rules yet: a copy holds what was recorded.{' '}
              <a className="more" href={href.settings('redaction')}>
                Add some
              </a>
            </>
          )
        ) : (
          'The redaction rules in shadowlap.config.json apply to every copy.'
        )}
      </div>
    </Popover>
  );
}

function OtelDialog({ runId, onClose, onRun }: { runId: string; onClose: () => void; onRun: (fields: Record<string, unknown>) => void }) {
  const [to, setTo] = useState<'collector' | 'file'>('collector');
  const [where, setWhere] = useState('http://localhost:4318');
  return (
    <Dialog
      title="Export as an OpenTelemetry trace"
      text="One trace: a span for the run and one per call, with the GenAI attributes plus origin, effect, fingerprint and cost. Its ids come from the run id, so exporting again updates the same trace."
      ok="Export"
      okDisabled={!where.trim()}
      onClose={onClose}
      onOk={() => {
        onClose();
        onRun({ runId, ...(to === 'file' ? { out: where.trim() } : { endpoint: where.trim() }) });
      }}
    >
      <div className="form">
        <label>
          Send to
          <select
            value={to}
            onChange={(e) => {
              const next = e.target.value === 'file' ? 'file' : 'collector';
              setTo(next);
              setWhere(next === 'file' ? 'trace.json' : 'http://localhost:4318');
            }}
          >
            <option value="collector">a collector</option>
            <option value="file">a file</option>
          </select>
        </label>
        <label>
          {to === 'file' ? 'File' : 'Endpoint'}
          <input type="text" spellCheck={false} value={where} onChange={(e) => setWhere(e.target.value)} />
        </label>
      </div>
    </Dialog>
  );
}
