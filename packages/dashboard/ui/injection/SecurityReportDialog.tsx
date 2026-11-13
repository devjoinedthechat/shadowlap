import { Dialog } from '../components/Dialog.js';
import { namedIn } from '../components/Id.js';
import { failedRead } from '../components/States.js';
import { minuteStamp, plural, shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { ACTIONS } from '../labels.js';
import { redactsFact } from '../run/share-facts.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';
import type { InjectionRow } from '../types.js';

const LEAD: Readonly<Record<InjectionRow['mode'], string>> = {
  plant: 'Writes one HTML file for a security review: the matrix, the proof of each obeyed or influenced cell, and the payloads.',
  clean: 'Writes one HTML file for a security review: each write asked about, its verdict and the clean attempts.',
};

/** The toast once the file is saved: how many rules masked it, and that the canaries stayed, as the preview counted them. */
export function reportSaved(file: string, redacted: boolean, rules: number | null): string {
  if (!redacted) return `Saved ${file} · no redaction rules to apply`;
  return `Saved ${file} · ${rules ? plural(rules, 'redaction rule') : 'redaction rules'} applied; canaries kept`;
}

/**
 * Share's Security report (and Tests', once a golden's report draws its button): what the file is
 * for, where it comes from (the kept result: nothing runs again), that it opens offline, the rules
 * that mask it with two values they mask and each canary it keeps unmasked, as the server's preview
 * reads them from the same masks the download applies, and the file it saves. Download report saves
 * it, in a read-only dashboard too. A part the served dashboard hands in: a copy keeps no results.
 */
export function SecurityReportDialog({ resultId, mode, runId, onClose }: { resultId: string; mode: InjectionRow['mode']; runId: string; onClose: () => void }) {
  const { client, guard, toast } = useApp();
  const preview = useLoad(() => client.injectionPreview(resultId), `report-preview:${resultId}`);
  const p = preview.data;
  const id = shortId(runId);
  const download = () => guard(() => void client.injectionReport(resultId).then((r) => toast(reportSaved(r.filename, r.redacted, p?.rules ?? null)), (err: unknown) => toast(errorText(err), 'error')));
  return (
    <Dialog
      title={namedIn(`Download security report for ${id}`, id)}
      lead={LEAD[mode]}
      doc="injectionReport"
      facts={[
        p ? { label: 'From', value: `the result kept ${minuteStamp(p.at)}`, quiet: `${mode === 'plant' ? plural(p.attempts, 'attempt') : plural(p.attempts, 'clean attempt')} · nothing runs again` } : null,
        { label: 'Opens', value: 'offline', quiet: 'no script, nothing fetched' },
        redactsFact(p?.rules ?? null),
      ]}
      factsUnder={p ? [{ label: 'Saves', value: `\`${p.file}\`` }] : undefined}
      ok={ACTIONS.securityReport.confirm}
      onClose={onClose}
      onOk={download}
    >
      {preview.error ? <div className="ibar err">{failedRead(preview.error)}</div> : null}
      {p?.masks.map((m) => (
        <div className="injmask" key={`${m.at}:${m.before}`}>
          <span className="chip">{m.at}</span>
          <span className="del">{m.before}</span>
          <span className="sr"> masked as </span>
          <span className="add">{m.after}</span>
        </div>
      ))}
      {p?.canaries.map((c) => (
        <div className="injmask" key={`${c.at}:${c.value}`}>
          <span className="chip">{c.at}</span>
          <span>{c.value}</span>
          <span className="why">kept: a canary is the proof, and no rule touches one</span>
        </div>
      ))}
    </Dialog>
  );
}
