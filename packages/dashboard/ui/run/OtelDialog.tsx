import { useState } from 'react';
import { Dialog } from '../components/Dialog.js';
import { shortId } from '../format.js';
import { jobCommand, quoteArg } from '../job-title.js';
import { EXPORTS, shareDialog } from './share.js';
import { redactsFact } from './share-facts.js';

/**
 * Export OpenTelemetry trace…: the run as one trace, sent to a collector or written to a file in the
 * project's exports. Rarely opened from a run's page (Share, ShareMenu.tsx), so a part of its own,
 * which loads as it first shows.
 */
export function OtelDialog({ runId, rules, onClose, onRun }: { runId: string; rules: number | null; onClose: () => void; onRun: (fields: Record<string, unknown>) => boolean }) {
  const [to, setTo] = useState<'collector' | 'file'>('collector');
  const [where, setWhere] = useState('http://localhost:4318');
  return (
    <Dialog
      {...shareDialog('otel', [runId])}
      lead="Exports the run as one trace: a span for the run and one per call."
      doc="traces"
      facts={[redactsFact(rules, true), { label: 'Re-export', value: 'updates the same trace', quiet: 'its ids come from the run’s' }]}
      command={`${jobCommand(['export', 'otel', shortId(runId)])} ${to === 'file' ? `--out ${where.trim() ? quoteArg(`${EXPORTS}/${where.trim()}`) : `${EXPORTS}/…`}` : `--endpoint ${where.trim() ? quoteArg(where.trim()) : '…'}`}`}
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
