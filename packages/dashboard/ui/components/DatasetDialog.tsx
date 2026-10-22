import { useState } from 'react';
import { JOB_KINDS } from '../api.js';
import { num, shortId } from '../format.js';
import { datasetCommand, datasetFile, datasetTooMany } from '../run/share.js';
import { useApp } from '../state.js';
import { CmdLine, CopyButton } from './bits.js';
import { Dialog } from './Dialog.js';

/**
 * Runs as an eval dataset: a format and which calls become examples, run as the `export-dataset` job,
 * which writes one JSON line per example into the project's `.shadowlap/exports/` and names the file.
 * The one dialog for it: a run's Share menu and the Runs page's bulk bar both open it. `rules` is how
 * many redaction rules the copy applies, when the page knows (the server's offers); the dialog then
 * says so. Under the choices, the command the job runs: for a long pick its first ids and how many
 * more, whole behind Copy.
 */
export function DatasetDialog({ ids, rules = null, onClose }: { ids: string[]; rules?: number | null; onClose: () => void }) {
  const { client, watchJob, guard } = useApp();
  const [format, setFormat] = useState('jsonl');
  const [calls, setCalls] = useState('final');
  // Named when it opens, and sent with the job: the command below is the one that runs.
  const [file] = useState(() => datasetFile(ids, new Date()));
  const redaction = rules === null ? '' : rules ? ` ${rules === 1 ? 'The redaction rule applies' : `The ${rules} redaction rules apply`} to the conversations and answers it keeps.` : ' No redaction rules apply: the examples hold what was recorded.';
  const tooMany = datasetTooMany(ids.length);
  const cmd = datasetCommand(ids, { format, calls, file });
  return (
    <Dialog
      title={`Export ${ids.length === 1 ? shortId(ids[0]!) : `${num(ids.length)} runs`} as an eval dataset`}
      text={`One JSON line per example: the conversation exactly as the model saw it, its answer, and metadata with the labels, notes and check results.${redaction}${tooMany ? ` ${tooMany}` : ''}`}
      ok="Export"
      okDisabled={!!tooMany}
      onClose={onClose}
      onOk={() => {
        onClose();
        guard(() => watchJob(client.startJob(JOB_KINDS.dataset, { runIds: ids, format, calls, out: file })));
      }}
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
      <CmdLine>{cmd.shown}</CmdLine>
      {cmd.shown !== cmd.full ? (
        <div className="cmdcopy">
          <CopyButton text={cmd.full} label="the command">
            Copy the whole command
          </CopyButton>
        </div>
      ) : null}
    </Dialog>
  );
}
