import { useState } from 'react';
import { createPortal } from 'react-dom';
import { JOB_KINDS } from '../../api.js';
import { Dialog } from '../../components/Dialog.js';
import { mergeTreeJobs, treeBusy, type TreeJob } from '../../fixes/model.js';
import { addJobFooter } from '../../job-actions.js';
import { addPaletteSource, paletteSourcesChanged } from '../../palette-sources.js';
import { sentence } from '../../toast.js';
import type { JobView } from '../../types.js';
import { useApp } from '../../state.js';
import { CONFIG_FILE, CommandLine, editErrorText } from './common.js';
import { UNUSED_WORTH, bytesText, gcDeleteCommand, gcDryRun, gcGivesBack, proposedCount } from './logic.js';
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
  const runs = `${dry.count.toLocaleString('en-US')} ${dry.count === 1 ? 'run' : 'runs'}`;
  const since = dry.olderThanDays !== null ? `They started more than ${dry.olderThanDays} ${dry.olderThanDays === 1 ? 'day' : 'days'} ago.` : dry.cutoff !== null ? `They started before ${new Date(dry.cutoff).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.` : '';
  // No run old enough, but space to give back: a plain gc, which deletes no run.
  const freeOnly = dry.count === 0;
  const label = freeOnly ? `Free ${bytesText(gcGivesBack(dry))}` : `Delete ${runs}`;
  return (
    <>
      <button className="btn" type="button" disabled={started || !!app.actionsOff} title={app.actionsOff ?? undefined} onClick={() => app.guard(() => setAsking(true))}>
        {label}
      </button>
      {/* Over the page, not inside the drawer, whose header and footer styles would reach it. */}
      {asking ? createPortal(
        <Dialog
          title={`${label}?`}
          text={
            freeOnly
              ? `No run is deleted. ${dry.bytes ? `Blobs no run uses are removed (${bytesText(dry.bytes)})` : 'Nothing any run uses is removed'}, and the store is compacted${dry.free >= UNUSED_WORTH ? `, giving back ${bytesText(dry.free)} that deleted runs left unused` : ''}.`
              : `${since} Blobs no other run uses go with them${dry.bytes ? `, freeing ${bytesText(dry.bytes)}` : ''}. Runs still recording are never touched. This can’t be undone; if other runs match by now, nothing is deleted.`
          }
          ok={label}
          tone={freeOnly ? 'lime' : 'danger'}
          {...(freeOnly ? {} : { initialFocus: 'cancel' as const })}
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
  return [{ group: 'Actions', label: 'Calibrate', hint: 'propose normalizers', run: () => app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.calibrate, {}))) }];
});
