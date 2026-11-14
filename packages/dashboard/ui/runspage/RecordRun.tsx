import { useEffect, useState } from 'react';
import { RECORD_PART } from '../../../engine/src/cost-words.js';
import { JOB_KINDS } from '../api.js';
import { Dialog, pressWayOn } from '../components/Dialog.js';
import { RecordRunDialog } from '../components/RecordRunDialog.js';
import { useTreeBusy } from '../fixes/tree.js';
import { ACTIONS, confirmWords } from '../labels.js';
import type { RecordConfirmation } from '../projects-api.js';
import { confirmedRecording, RECORD_PLACEHOLDER } from '../projects.js';
import { guardedWayOn, useApp } from '../state.js';
import { errorText } from '../toast.js';

/** The first run of a command in this folder, as the server planned it: its question, and the job its yes starts. */
type Asking = { confirm: RecordConfirmation; command: string; project: string };

/**
 * Record run…, from Runs' header and the palette: the setup's Record, on a project at any stage.
 * Its field starts from the command the setup records with (`SetupView.command`), read as it opens;
 * what is typed before that arrives stays. Record run plans the command as the setup does (`POST
 * /api/setup/record`, which changes nothing): one this folder ran before starts its job at once; one
 * it never ran, or ran with its model calls going elsewhere, asks first in the setup's own dialog,
 * whose yes starts it. A refusal keeps the dialog open with what was typed, its words as the warning.
 * It waits while a repair or an apply holds the working tree, as the server would refuse it then.
 * The job's drawer offers Watch live while it records.
 */
export function RecordRunAsks({ onClose }: { onClose: () => void }) {
  const { client, guard, watchJob, meta } = useApp();
  const project = meta?.project?.id ?? '';
  const [typed, setTyped] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const tree = useTreeBusy('reads', 'record');
  useEffect(() => {
    let shown = true;
    const fill = (command: string) => shown && setTyped((was) => was ?? command);
    client.projects.setup().then(
      (v) => fill(v?.command ?? ''),
      () => fill(''),
    );
    return () => {
      shown = false;
    };
  }, [client]);
  const command = (typed ?? '').trim();
  // The server's refusal keeps the dialog open with what was typed.
  const start = (fields: { project: string; command: string; confirmed?: true }): Promise<boolean> =>
    client.startJob(JOB_KINDS.record, fields).then(
      (job) => {
        watchJob(Promise.resolve(job));
        return true;
      },
      (err: unknown) => {
        setRefused(errorText(err));
        return false;
      },
    );
  const record = (): Promise<boolean> => {
    setRefused(null);
    return client.projects.planRecording(project, command).then(
      (plan) => {
        if (!plan.confirm) return start({ project, command });
        setAsking({ confirm: plan.confirm, command, project });
        return false;
      },
      (err: unknown) => {
        setRefused(errorText(err));
        return false;
      },
    );
  };
  if (asking) return <RecordRunDialog confirm={asking.confirm} onClose={onClose} onOk={() => guard(() => watchJob(client.startJob(JOB_KINDS.record, confirmedRecording(asking))))} />;
  const name = confirmWords(ACTIONS.recordRun.label);
  return (
    <Dialog
      title={name}
      lead="Records one run: every model and tool call."
      doc="quickstart"
      warn={refused ? { text: refused, written: true } : null}
      command={`shadowlap run -- ${command || RECORD_PLACEHOLDER}`}
      cost={{ price: 'Billed by your provider', parts: [RECORD_PART] }}
      ok={name}
      okDisabled={!command}
      okWhy={tree}
      onOk={() => guardedWayOn(guard, record)}
      onClose={onClose}
    >
      <div className="form one">
        <label>
          Command
          <input
            type="text"
            spellCheck={false}
            autoComplete="off"
            value={typed ?? ''}
            placeholder="python agent.py"
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                pressWayOn(e.currentTarget);
              }
            }}
          />
        </label>
      </div>
    </Dialog>
  );
}
