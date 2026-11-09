import { useState } from 'react';
import { JOB_KINDS, type RunDetail, type RunOffers } from '../api.js';
import { PromptDialog } from '../components/Dialog.js';
import { Popover } from '../components/Popover.js';
import { shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { href } from '../route.js';
import { useApp } from '../state.js';
import { useServedParts } from '../served-parts.js';
import { errorText } from '../toast.js';
import type { PendingAction } from './actions.js';
import { namedIn } from '../components/Id.js';
import { onShow } from '../components/OnShow.js';
import { redactRuleCount } from './provenance.js';
import { defaultPackFolder, htmlCopyVia, PACK_HOLDS, REDACTION_SETTINGS, redactsFact, shareCommand, shareDialog, shareItemOff, shareItems, shareNote, shareWhy, STILL_RECORDING_CARD, type ShareKey } from './share.js';
import { packRunCommand } from './share-steps.js';
import { ActionButton } from '../components/ActionButton.js';

/** Export dataset…'s and Export OpenTelemetry trace…'s dialogs: rarely opened from a run's page, so each a part of its own, which loads as it first shows. */
const DatasetDialog = onShow(() => import('../components/DatasetDialog.js').then((m) => m.DatasetDialog));
const OtelDialog = onShow(() => import('./OtelDialog.js').then((m) => m.OtelDialog));

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
  const [dialog, setDialog] = useState<'pack' | 'dataset' | 'otel' | 'security' | null>(null);
  const { SecurityReportDialog } = useServedParts();
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
  const kindOf: Record<Exclude<ShareKey, 'security'>, string> = { link: JOB_KINDS.share, html: JOB_KINDS.exportHtml, pack: JOB_KINDS.pack, dataset: JOB_KINDS.dataset, otel: JOB_KINDS.otel, har: JOB_KINDS.har };
  const items = shareItems({ can: (key) => hasKind(kindOf[key]) || (key === 'pack' && !!packAction), team: offers?.team, security: offers?.security });
  // A download, as the HTML file's is: the file, then whether the project's rules masked it.
  const saved = (r: { filename: string; redacted: boolean }, also = '') => toast(`Saved ${r.filename}${also} · ${r.redacted ? 'redaction rules applied' : 'no redaction rules to apply'}`);
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
            (r) => saved(r, run.parent ? ' with the runs it came from' : ''),
            (err: unknown) => toast(errorText(err), 'error'),
          ),
        );
      case 'security':
        return setDialog('security');
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
        title={namedIn(shareDialog('pack', [id]).title, shortId(id))}
        lead="Packs the run into a folder to commit as a golden or send to someone."
        doc="packs"
        facts={[PACK_HOLDS, redactsFact(offers?.copies.formats.find((f) => f.id === 'pack')?.rules ?? null)]}
        label="Folder, inside the project"
        initial={defaultPackFolder(id)}
        command={(dir) => packRunCommand(id, dir)}
        onClose={close}
        onRun={(dir) => job(JOB_KINDS.pack, { runId: id, dir })}
      />
    );
  if (dialog === 'security' && offers?.security && SecurityReportDialog) return <SecurityReportDialog resultId={offers.security.resultId} mode={offers.security.mode} runId={id} onClose={close} />;
  if (dialog === 'dataset') return <DatasetDialog ids={[id]} rules={offers?.copies.formats.find((f) => f.id === 'dataset')?.rules ?? null} onClose={close} />;
  if (dialog === 'otel') return <OtelDialog runId={id} rules={offers?.copies.formats.find((f) => f.id === 'otel')?.rules ?? null} onClose={close} onRun={(fields) => job(JOB_KINDS.otel, fields)} />;
  return (
    <Popover anchor={anchor} onClose={onClose} label={`Share ${shortId(id)}`} className="fkm">
      <div className="pk">
        Share <code className="rnm">{shortId(id)}</code>
      </div>
      {items.map((it) => {
        const off = shareItemOff(it.key, { actionsOff, live });
        return (
          <ActionButton key={it.key} role="menuitem" why={off} reads={it.key === 'html' || it.key === 'security'} tip={it.label} whyTip={live ? STILL_RECORDING_CARD : undefined} sub={shareWhy(it, offers?.team)} command={shareCommand(it, id) ?? undefined} onClick={() => pick(it.key)}>
            <b>{it.label}</b>
            {it.flag ? <small>{it.flag}</small> : null}
          </ActionButton>
        );
      })}
      <hr />
      <div className="pnote">
        {note.text}{' '}
        {/* A menu holds menu items only: the way to the rules is one, as a screen reader moves through them. */}
        <a className="more nw" role="menuitem" href={href.settings('redaction')}>
          {REDACTION_SETTINGS}
        </a>
      </div>
    </Popover>
  );
}
