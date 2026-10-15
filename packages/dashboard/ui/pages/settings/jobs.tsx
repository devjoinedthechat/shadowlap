import { useState } from 'react';
import { createPortal } from 'react-dom';
import { JOB_KINDS } from '../../api.js';
import { Dialog } from '../../components/Dialog.js';
import { addJobFooter } from '../../job-actions.js';
import { addPaletteSource } from '../../palette-sources.js';
import type { JobView } from '../../types.js';
import { useApp } from '../../state.js';
import { CONFIG_FILE, CommandLine, editErrorText } from './common.js';
import { bytesText, gcDeleteCommand, gcDryRun, proposedCount } from './logic.js';
import { settingsChanged } from './events.js';

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
      app.toast(editErrorText(err));
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
  const runs = `${dry.count.toLocaleString('en-US')} ${dry.count === 1 ? 'run' : 'runs'}`;
  const since = dry.olderThanDays !== null ? `They started more than ${dry.olderThanDays} ${dry.olderThanDays === 1 ? 'day' : 'days'} ago.` : dry.cutoff !== null ? `They started before ${new Date(dry.cutoff).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.` : '';
  return (
    <>
      <button className="btn" type="button" disabled={started || !!app.actionsOff} title={app.actionsOff ?? undefined} onClick={() => app.guard(() => setAsking(true))}>
        Delete {runs}
      </button>
      {/* Over the page, not inside the drawer, whose header and footer styles would reach it. */}
      {asking ? createPortal(
        <Dialog
          title={`Delete ${runs}?`}
          text={`${since} Blobs no other run uses go with them${dry.bytes ? `, freeing ${bytesText(dry.bytes)}` : ''}. Runs still recording are never touched. This can’t be undone; if other runs match by now, nothing is deleted.`}
          ok={`Delete ${runs}`}
          tone="danger"
          onClose={() => setAsking(false)}
          onOk={() => {
            setAsking(false);
            setStarted(true);
            app.watchJob(app.client.startJob(JOB_KINDS.gc, { confirm: job.id }));
          }}
        >
          <CommandLine command={gcDeleteCommand(dry)} />
        </Dialog>,
        document.body,
      ) : null}
    </>
  );
}

addJobFooter(JOB_KINDS.calibrate, CalibrateFooter);
addJobFooter(JOB_KINDS.gc, CleanupFooter);

addPaletteSource(({ app }) =>
  app.exported || !app.hasKind(JOB_KINDS.calibrate)
    ? []
    : [{ group: 'Actions', label: 'Calibrate', hint: 'propose normalizers', run: () => app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.calibrate, {}))) }],
);
