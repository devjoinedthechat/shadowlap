import { useState } from 'react';
import { JOB_KINDS } from '../../api.js';
import { Dialog } from '../../components/Dialog.js';
import { addJobFooter } from '../../job-actions.js';
import { sentence } from '../../toast.js';
import type { JobView } from '../../types.js';
import { useApp } from '../../state.js';
import { CONFIG_FILE, editErrorText } from './common.js';
import { bytesText, gcDeleteCommand, gcDryRun, gcGivesBack, proposedCount, type GcDryRun } from './logic.js';
import { settingsChanged } from './events.js';
import { ActionButton } from '../../components/ActionButton.js';

/**
 * What Settings' jobs offer once they end, in the job drawer's way on: calibrate's "Add
 * normalizer", which adds exactly the normalizers it proposed, and a clean-up's "Delete N runs",
 * which confirms its dry run and deletes exactly the runs it listed. Plus Calibrate in the
 * palette's actions. Registered when the app loads, so they work from any page.
 */

function CalibrateFooter({ job, plain, done }: { job: JobView; plain?: boolean; done?: () => void }) {
  const app = useApp();
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const n = proposedCount(job);
  if (!n) return null;
  const add = async () => {
    setState('busy');
    try {
      const r = await app.client.settings.writeCalibration(job.id);
      setState('done');
      settingsChanged();
      done?.();
      app.toast(r.added.length ? `Added to ${CONFIG_FILE} · normalizer${r.added.length === 1 ? '' : 's'} ${r.added.map((x) => `#${x}`).join(', ')}` : `Already in ${CONFIG_FILE} · ${r.already.map((x) => `#${x}`).join(', ')}`);
    } catch (err) {
      setState('idle');
      app.toast(sentence(editErrorText(err)), 'error');
    }
  };
  return (
    <ActionButton className={plain ? 'btn' : 'btn lime'} disabled={state !== 'idle'} title={`Adds ${n === 1 ? 'the normalizer' : `the ${n} normalizers`} it found to ${CONFIG_FILE}, as --write does`} onClick={() => app.guard(() => void add())}>
      {state === 'done' ? 'Added' : n === 1 ? 'Add normalizer' : `Add ${n} normalizers`}
    </ActionButton>
  );
}

function CleanupFooter({ job }: { job: JobView }) {
  const app = useApp();
  const [asking, setAsking] = useState(false);
  const [started, setStarted] = useState(false);
  const dry = gcDryRun(job);
  if (!dry) return null;
  const runs = `${dry.count.toLocaleString('en-US')}\u00a0${dry.count === 1 ? 'run' : 'runs'}`;
  // No run old enough, but space to give back: a plain gc, which deletes no run.
  const freeOnly = dry.count === 0;
  const label = freeOnly ? `Free ${bytesText(gcGivesBack(dry))}` : `Delete ${runs}`;
  return (
    <>
      <ActionButton className="btn" disabled={started} onClick={() => app.guard(() => setAsking(true))}>
        {label}
      </ActionButton>
      {asking ? (
        <CleanupDialog
          dry={dry}
          label={label}
          onClose={() => setAsking(false)}
          onOk={() =>
            app.guard(() => {
              setStarted(true);
              app.watchJob(app.client.startJob(JOB_KINDS.gc, { confirm: job.id }));
            })
          }
        />
      ) : null}
    </>
  );
}

/** Delete N runs, or Free 53.5 MB where no run is old enough: exactly what the dry run found, or nothing if others match by then. */
export function CleanupDialog({ dry, label, onOk, onClose }: { dry: GcDryRun; label: string; onOk: () => unknown; onClose: () => void }) {
  const freeOnly = dry.count === 0;
  const one = dry.count === 1;
  const older = dry.olderThanDays !== null ? ` older than ${dry.olderThanDays} ${dry.olderThanDays === 1 ? 'day' : 'days'}` : dry.cutoff !== null ? ` that started before ${new Date(dry.cutoff).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : '';
  const withThem = dry.attempts ? `, ${one ? 'its' : 'their'} ${dry.attempts === 1 && one ? 'attempt' : `${dry.attempts.toLocaleString('en-US')} ${dry.attempts === 1 ? 'attempt' : 'attempts'}`} and` : ' and';
  const frees = gcGivesBack(dry);
  return (
    <Dialog
      title={`${label}?`}
      lead={freeOnly ? 'Removes blobs no run uses and compacts the store; no run is deleted.' : `Deletes ${one ? 'the run' : 'the runs'}${older}${withThem} the recorded data nothing else uses.`}
      doc="deletingRuns"
      warn={freeOnly ? null : { text: 'This can’t be undone', tone: 'red' }}
      facts={[frees ? { label: 'Frees', value: bytesText(frees) } : null, freeOnly ? null : { label: 'Left alone', value: 'runs still recording' }, freeOnly ? null : { label: 'If runs change', value: 'other runs matching by now stop it', quiet: 'nothing is deleted' }]}
      command={gcDeleteCommand(dry)}
      ok={label}
      tone={freeOnly ? 'lime' : 'danger'}
      onClose={onClose}
      onOk={onOk}
    />
  );
}

addJobFooter(JOB_KINDS.calibrate, CalibrateFooter);
addJobFooter(JOB_KINDS.gc, CleanupFooter);

