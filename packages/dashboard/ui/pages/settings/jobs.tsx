import { useState } from 'react';
import { JOB_KINDS } from '../../api.js';
import { Dialog } from '../../components/Dialog.js';
import { mergeTreeJobs, treeBusy, type TreeJob } from '../../fixes/model.js';
import { addJobFooter } from '../../job-actions.js';
import { addPaletteSource, paletteSourcesChanged } from '../../palette-sources.js';
import { sentence } from '../../toast.js';
import type { JobView } from '../../types.js';
import { useApp } from '../../state.js';
import { CONFIG_FILE, editErrorText } from './common.js';
import { bytesText, gcDeleteCommand, gcDryRun, gcGivesBack, proposedCount, type GcDryRun } from './logic.js';
import { settingsChanged } from './events.js';
import { ACTIONS } from '../../labels.js';

/**
 * What Settings' jobs offer once they end, in the job drawer's footer: calibrate's "Add it
 * (--write)", which adds exactly the normalizers it proposed, and a clean-up's "Delete N runs",
 * which confirms its dry run and deletes exactly the runs it listed. Plus Calibrate in the
 * palette's actions. Registered when the app loads, so they work from any page.
 */

function CalibrateFooter({ job }: { job: JobView }) {
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
      app.toast(r.added.length ? `Added to ${CONFIG_FILE} · normalizer${r.added.length === 1 ? '' : 's'} ${r.added.map((x) => `#${x}`).join(', ')}` : `Already in ${CONFIG_FILE} · ${r.already.map((x) => `#${x}`).join(', ')}`);
    } catch (err) {
      setState('idle');
      app.toast(sentence(editErrorText(err)), 'error');
    }
  };
  return (
    <button className="btn lime" type="button" disabled={state !== 'idle' || !!app.actionsOff} title={app.actionsOff ?? `Adds ${n === 1 ? 'the normalizer' : `the ${n} normalizers`} it found to ${CONFIG_FILE}, as --write does`} onClick={() => app.guard(() => void add())}>
      {state === 'done' ? 'Added' : n === 1 ? 'Add it (--write)' : 'Add them (--write)'}
    </button>
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
      <button className="btn" type="button" disabled={started || !!app.actionsOff} title={app.actionsOff ?? undefined} onClick={() => app.guard(() => setAsking(true))}>
        {label}
      </button>
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

/** The jobs the server last listed (every tab's and the terminal's): whether a repair holds the working tree. */
let listedJobs: TreeJob[] | null = null;

// Calibrate replays the agent from the project's working tree: like its button on Matching, the
// palette's entry waits while a repair or an apply holds the tree, and is left out until then, as
// it is on a read-only dashboard. The list is read again as the palette opens; an open palette
// reads its sources again when what it says changed.
addPaletteSource(({ app }) => {
  if (app.exported || !app.hasKind(JOB_KINDS.calibrate)) return [];
  const folder = app.meta?.project?.path ?? null;
  const held = () => treeBusy(mergeTreeJobs(listedJobs, app.jobs), 'reads', 'calibrate', folder);
  const before = held();
  if (!app.actionsOff) {
    app.client.jobs().then(
      (list) => {
        listedJobs = list;
        if (held() !== before) paletteSourcesChanged();
      },
      () => undefined,
    );
  }
  if (before) return [];
  return [{ group: 'Actions', label: ACTIONS.calibrate.label, hint: 'propose normalizers', job: true, run: () => app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.calibrate, {}))) }];
});
