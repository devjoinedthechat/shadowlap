import { useState } from 'react';
import { JOB_KINDS } from '../api.js';
import { shortId } from '../format.js';
import { datasetCommand, datasetFile, datasetTooMany, shareDialog } from '../run/share.js';
import { redactsFact } from '../run/share-steps.js';
import { useApp } from '../state.js';
import { Dialog } from './Dialog.js';
import { namedIn } from './Id.js';

/**
 * Runs as an eval dataset: a format and which calls become examples, run as the `export-dataset` job,
 * which writes one JSON line per example into the project's `.shadowlap/exports/` and names the file.
 * The one dialog for it: a run's Share menu and the Runs page's bulk bar both open it. `rules` is how
 * many redaction rules the copy applies, when the page knows (the server's offers); its row then says
 * so. Under the choices, the command the job runs: for a long pick its first ids and how many more,
 * whole behind its Copy.
 */
export function DatasetDialog({ ids, rules = null, onClose }: { ids: string[]; rules?: number | null; onClose: () => void }) {
  const { client, watchJob, guard } = useApp();
  const [format, setFormat] = useState('jsonl');
  const [calls, setCalls] = useState('final');
  // Named when it opens, and sent with the job: the command below is the one that runs.
  const [file] = useState(() => datasetFile(ids, new Date()));
  const tooMany = datasetTooMany(ids.length);
  const cmd = datasetCommand(ids, { format, calls, file });
  return (
    <Dialog
      {...shareDialog('dataset', ids)}
      title={ids.length === 1 ? namedIn(shareDialog('dataset', ids).title, shortId(ids[0]!)) : shareDialog('dataset', ids).title}
      lead="Exports each example as one JSON line: the conversation as the model saw it, and its answer."
      doc="datasets"
      warn={tooMany ? { text: tooMany.replace(/\.$/, '') } : null}
      facts={[{ label: 'Metadata', value: 'the labels, notes and check results' }, redactsFact(rules)]}
      command={{ command: cmd.shown, ...(cmd.shown !== cmd.full ? { full: cmd.full } : {}) }}
      okDisabled={!!tooMany}
      onClose={onClose}
      onOk={() => guard(() => watchJob(client.startJob(JOB_KINDS.dataset, { runIds: ids, format, calls, out: file })))}
    >
      <div className="form">
        <label>
          Format
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="jsonl">jsonl</option>
            <option value="braintrust">braintrust</option>
            <option value="langfuse">langfuse</option>
            <option value="openai-chat">openai-chat</option>
          </select>
        </label>
        <label>
          Examples
          <select value={calls} onChange={(e) => setCalls(e.target.value)}>
            <option value="final">Last model call of each run</option>
            <option value="model">Every model call</option>
          </select>
        </label>
      </div>
    </Dialog>
  );
}
