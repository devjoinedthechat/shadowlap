import { useState } from 'react';
import { JOB_KINDS, type RunDetail, type RunOffers } from '../api.js';
import { Dialog, PromptDialog } from '../components/Dialog.js';
import { Popover } from '../components/Popover.js';
import { shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { href } from '../route.js';
import { useApp } from '../state.js';
import type { PendingAction } from './actions.js';
import { DatasetDialog } from './DatasetDialog.js';
import { redactRuleCount } from './provenance.js';
import { defaultPackFolder, shareItems, shareNote, type ShareKey } from './share.js';

/**
 * Share: the run as a share link (with a team store), an HTML file (with the runs it came from), a
 * pack, an eval dataset, an OpenTelemetry trace or a HAR, each when the server can make it, and how
 * many redaction rules each copy applies (decision 6). The copies run as jobs on the server, which
 * writes them into the project's `.shadowlap/exports/`; the HTML file and the HAR also download.
 */
export function ShareMenu({ anchor, run, offers, onClose, onAction }: { anchor: HTMLElement; run: RunDetail; offers: RunOffers | null; onClose: () => void; onAction: (p: PendingAction) => void }) {
  const app = useApp();
  const { client, toast, hasKind, meta, guard, actionsOff } = app;
  const [dialog, setDialog] = useState<'pack' | 'dataset' | 'otel' | null>(null);
  const id = run.run.runId;
  const packAction = run.actions.find((a) => a.key === 'p');
  // The rules a copy applies: what the server offers, else its count, else the run's provenance record.
  const prov = useLoad(() => (offers || typeof meta?.redactRules === 'number' || run.provenance ? null : client.provenance(id)), `${id}:provenance:${offers ? 1 : 0}`);
  const note = shareNote(offers, redactRuleCount(meta, run.provenance ?? prov.data));
  const close = () => {
    setDialog(null);
    onClose();
  };
  const job = (kind: string, fields: Record<string, unknown>) => guard(() => app.watchJob(client.startJob(kind, fields)));
  const kindOf: Record<ShareKey, string> = { link: JOB_KINDS.share, html: JOB_KINDS.exportHtml, pack: JOB_KINDS.pack, dataset: JOB_KINDS.dataset, otel: JOB_KINDS.otel, har: JOB_KINDS.har };
  const items = shareItems({ can: (key) => hasKind(kindOf[key]) || (key === 'pack' && !!packAction), team: offers?.team });
  const pick = (key: ShareKey) => {
    switch (key) {
      case 'link':
        onClose();
        return job(JOB_KINDS.share, { runId: id, lineage: true });
      case 'html':
        onClose();
        if (hasKind(JOB_KINDS.exportHtml)) return job(JOB_KINDS.exportHtml, { runId: id });
        // A server without the job: the file comes straight from it, as it always did.
        return guard(() =>
          client.exportHtml(id).then(
            (r) => toast(`Saved ${r.filename}${run.parent ? ' with the runs it came from' : ''} · ${r.redacted ? 'redaction rules applied' : 'no redaction rules to apply'}`),
            (err: unknown) => toast(err instanceof Error ? err.message : String(err)),
          ),
        );
      case 'pack':
        if (hasKind(JOB_KINDS.pack)) return setDialog('pack');
        onClose();
        return packAction ? onAction({ action: packAction, callNo: null }) : undefined;
      case 'dataset':
        return setDialog('dataset');
      case 'otel':
        return setDialog('otel');
      case 'har':
        onClose();
        return job(JOB_KINDS.har, { runId: id });
    }
  };
  if (dialog === 'pack')
    return (
      <PromptDialog
        title={`Pack ${shortId(id)}`}
        text="A folder to commit as a golden or send to someone: run.json, calls.jsonl and one file per blob. Redaction rules apply to the copy; the store is never changed."
        label="Folder, inside the project"
        initial={defaultPackFolder(id)}
        ok="Pack"
        command={`shadowlap pack ${shortId(id)} …`}
        onClose={close}
        onRun={(dir) => {
          close();
          job(JOB_KINDS.pack, { runId: id, dir });
        }}
      />
    );
  if (dialog === 'dataset') return <DatasetDialog ids={[id]} rules={offers?.copies.formats.find((f) => f.id === 'dataset')?.rules ?? null} onClose={close} />;
  if (dialog === 'otel') return <OtelDialog runId={id} rules={offers?.copies.formats.find((f) => f.id === 'otel')?.rules ?? null} onClose={close} onRun={(fields) => job(JOB_KINDS.otel, fields)} />;
  return (
    <Popover anchor={anchor} onClose={onClose} label="Share">
      <div className="pk">Share {shortId(id)}</div>
      {items.map((it) => (
        <button key={it.key} type="button" role="menuitem" disabled={!!actionsOff && it.key !== 'html'} title={actionsOff && it.key !== 'html' ? actionsOff : undefined} onClick={() => pick(it.key)}>
          <b>{it.label}</b>
          <small>{it.key === 'link' && offers?.team ? `a redacted report in ${offers.team.store} · expires in 7 days` : it.note}</small>
        </button>
      ))}
      <hr />
      <div className="pnote">
        {note.text}{' '}
        <a className="more" href={href.settings('redaction')}>
          {note.link}
        </a>
      </div>
    </Popover>
  );
}

function OtelDialog({ runId, rules, onClose, onRun }: { runId: string; rules: number | null; onClose: () => void; onRun: (fields: Record<string, unknown>) => void }) {
  const [to, setTo] = useState<'collector' | 'file'>('collector');
  const [where, setWhere] = useState('http://localhost:4318');
  return (
    <Dialog
      title="Export as an OpenTelemetry trace"
      text={`One trace: a span for the run and one per call, with the GenAI attributes plus origin, effect, fingerprint and cost. Its ids come from the run id, so exporting again updates the same trace.${rules ? ` It carries no prompt text; ${rules === 1 ? 'the redaction rule' : `the ${rules} redaction rules`} without a path apply to what it keeps.` : ''}`}
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
              setWhere(next === 'file' ? `${runId.slice(0, 10).toLowerCase()}.otel.json` : 'http://localhost:4318');
            }}
          >
            <option value="collector">a collector</option>
            <option value="file">a file</option>
          </select>
        </label>
        <label>
          {to === 'file' ? 'File, in .shadowlap/exports' : 'Endpoint'}
          <input type="text" spellCheck={false} value={where} onChange={(e) => setWhere(e.target.value)} />
        </label>
      </div>
    </Dialog>
  );
}
