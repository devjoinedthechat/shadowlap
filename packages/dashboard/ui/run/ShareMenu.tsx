import { useState } from 'react';
import { JOB_KINDS, type RunDetail, type RunOffers } from '../api.js';
import { Dialog, PromptDialog } from '../components/Dialog.js';
import { tipCard } from '../components/HoverCard.js';
import { Popover } from '../components/Popover.js';
import { shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { href } from '../route.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';
import type { PendingAction } from './actions.js';
import { DatasetDialog } from '../components/DatasetDialog.js';
import { redactRuleCount } from './provenance.js';
import { defaultPackFolder, EXPORTS, htmlCopyVia, PACK_HOLDS, redactsFact, shareCommand, shareDialog, shareItemOff, shareItems, shareNote, shareWhy, type ShareKey } from './share.js';
// The share job's drawer offers the link it made.
import './share-link.js';

/**
 * Share: the run as a share link (with a team store), an HTML file (with the runs it came from), a
 * pack, an eval dataset, an OpenTelemetry trace or a HAR, each when the server can make it, and how
 * many redaction rules each copy applies (decision 6). The copies run as jobs on the server, which
 * writes them into the project's `.shadowlap/exports/`; the HTML file and the HAR also download. Where
 * jobs can't run (a read-only dashboard), the HTML file still downloads straight from the server, and
 * nothing is copied while the run records (share.ts decides both).
 */
export function ShareMenu({ anchor, run, offers, onClose, onAction }: { anchor: HTMLElement; run: RunDetail; offers: RunOffers | null; onClose: () => void; onAction: (p: PendingAction) => void }) {
  const app = useApp();
  const { client, toast, hasKind, meta, guard, actionsOff } = app;
  const [dialog, setDialog] = useState<'pack' | 'dataset' | 'otel' | null>(null);
  const id = run.run.runId;
  const packAction = run.actions.find((a) => a.key === 'p');
  const live = run.run.status === 'running';
  // The rules a copy applies: what the server offers, else its count, else the run's provenance record
  // (not while the run records: nothing is copied until it ends).
  const prov = useLoad(() => (offers || live || typeof meta?.redactRules === 'number' || run.provenance ? null : client.provenance(id)), `${id}:provenance:${offers ? 1 : 0}:${live ? 1 : 0}`);
  const note = shareNote(offers, redactRuleCount(meta, run.provenance ?? prov.data));
  const close = () => {
    setDialog(null);
    onClose();
  };
  const job = (kind: string, fields: Record<string, unknown>) => guard(() => app.watchJob(client.startJob(kind, fields)));
  const kindOf: Record<ShareKey, string> = { link: JOB_KINDS.share, html: JOB_KINDS.exportHtml, pack: JOB_KINDS.pack, dataset: JOB_KINDS.dataset, otel: JOB_KINDS.otel, har: JOB_KINDS.har };
  const items = shareItems({ can: (key) => hasKind(kindOf[key]) || (key === 'pack' && !!packAction), team: offers?.team });
  const pick = (key: ShareKey) => {
    if (shareItemOff(key, { actionsOff, live })) return;
    switch (key) {
      case 'link':
        onClose();
        return job(JOB_KINDS.share, { runId: id, lineage: true });
      case 'html':
        onClose();
        if (htmlCopyVia({ actionsOff, hasJob: hasKind(JOB_KINDS.exportHtml) }) === 'job') return job(JOB_KINDS.exportHtml, { runId: id });
        // Where jobs can't run (read-only), or a server without the job: the file comes straight from it.
        return guard(() =>
          void client.exportHtml(id).then(
            (r) => toast(`Saved ${r.filename}${run.parent ? ' with the runs it came from' : ''} · ${r.redacted ? 'redaction rules applied' : 'no redaction rules to apply'}`),
            (err: unknown) => toast(errorText(err), 'error'),
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
        {...shareDialog('pack', [id])}
        lead="Packs the run into a folder to commit as a golden or send to someone."
        doc="packs"
        facts={[PACK_HOLDS, redactsFact(offers?.copies.formats.find((f) => f.id === 'pack')?.rules ?? null)]}
        label="Folder, inside the project"
        initial={defaultPackFolder(id)}
        command={(dir) => `shadowlap pack ${shortId(id)} ${dir || '…'}`}
        onClose={close}
        onRun={(dir) => job(JOB_KINDS.pack, { runId: id, dir })}
      />
    );
  if (dialog === 'dataset') return <DatasetDialog ids={[id]} rules={offers?.copies.formats.find((f) => f.id === 'dataset')?.rules ?? null} onClose={close} />;
  if (dialog === 'otel') return <OtelDialog runId={id} rules={offers?.copies.formats.find((f) => f.id === 'otel')?.rules ?? null} onClose={close} onRun={(fields) => job(JOB_KINDS.otel, fields)} />;
  return (
    <Popover anchor={anchor} onClose={onClose} label="Share" className="fkm">
      <div className="pk">
        Share <code className="rnm">{shortId(id)}</code>
      </div>
      {items.map((it) => {
        const off = shareItemOff(it.key, { actionsOff, live });
        return (
          <button key={it.key} type="button" role="menuitem" disabled={!!off} title={off ?? undefined} data-tip={off ? undefined : tipCard(it.label, [], shareWhy(it, offers?.team), shareCommand(it, id))} onClick={() => pick(it.key)}>
            <b>{it.label}</b>
            <small>{it.flag}</small>
          </button>
        );
      })}
      <hr />
      <div className="pnote">
        {note.text}{' '}
        {/* A menu holds menu items only: the way to the rules is one, as a screen reader moves through them. */}
        <a className="more" role="menuitem" href={href.settings('redaction')}>
          {note.link}
        </a>
      </div>
    </Popover>
  );
}

export function OtelDialog({ runId, rules, onClose, onRun }: { runId: string; rules: number | null; onClose: () => void; onRun: (fields: Record<string, unknown>) => boolean }) {
  const [to, setTo] = useState<'collector' | 'file'>('collector');
  const [where, setWhere] = useState('http://localhost:4318');
  return (
    <Dialog
      {...shareDialog('otel', [runId])}
      lead="Exports the run as one trace: a span for the run and one per call."
      doc="traces"
      facts={[redactsFact(rules, true), { label: 'Re-export', value: 'updates the same trace', quiet: 'its ids come from the run’s' }]}
      command={`shadowlap export otel ${shortId(runId)} ${to === 'file' ? `--out ${EXPORTS}/${where.trim() || '…'}` : `--endpoint ${where.trim() || '…'}`}`}
      okDisabled={!where.trim()}
      onClose={onClose}
      onOk={() => onRun({ runId, ...(to === 'file' ? { out: where.trim() } : { endpoint: where.trim() }) })}
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
