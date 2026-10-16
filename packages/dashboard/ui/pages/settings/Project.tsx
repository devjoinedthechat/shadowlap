import { useState } from 'react';
import { JOB_KINDS } from '../../api.js';
import { num } from '../../format.js';
import { ONLY_PROJECT, useProjectRemoval } from '../../project-actions.js';
import { useApp } from '../../state.js';
import { LoadProblem, Loading, useSettingsData } from './common.js';
import { bytesText, sizeNote } from './logic.js';

/**
 * Project: its name, store, runs and attempts, the store's size and the dashboard's address; Clean
 * up old runs (a dry run first, then "Delete N runs" from the drawer, or with no run old enough
 * "Free X" for what deleted runs left unused); and Remove from dashboard, which opens the projects
 * feature's own dialog, here in the page.
 */
export function ProjectTab() {
  const app = useApp();
  const { client } = app;
  const { data, error } = useSettingsData(() => client.settings.project(), 'settings:project');
  const removal = useProjectRemoval();
  const [removing, setRemoving] = useState(false);
  if (error && !data) return <LoadProblem error={error} />;
  if (!data) return <Loading title="Project" />;
  const current = removal?.current() ?? null;
  const blocked = current ? current.blocked : ONLY_PROJECT;
  const canClean = !app.actionsOff && app.hasKind(JOB_KINDS.gc);
  const cleanTitle = app.actionsOff ?? (!app.hasKind(JOB_KINDS.gc) ? 'This dashboard doesn’t run gc: shadowlap gc --older-than 30 --dry-run in a terminal' : `shadowlap gc --older-than ${data.cleanup.olderThanDays} --dry-run: shows what it would free, then asks before deleting`);
  return (
    <section className="panel set">
      <header>
        <h2>Project</h2>
      </header>
      <dl className="kvs">
        <dt>Name</dt>
        <dd>{data.name}</dd>
        <dt>Store</dt>
        <dd title={data.store.path ?? undefined}>{data.shown.store ?? 'in memory: nothing is kept'}</dd>
        <dt>Runs</dt>
        <dd>
          {num(data.runs)} {data.attempts ? <small>and {num(data.attempts)} {data.attempts === 1 ? 'attempt' : 'attempts'}</small> : null}
          {data.running ? <small> · {data.running} recording now</small> : null}
          {data.abandoned ? <small className="warn"> · {data.abandoned} left recording by a process that stopped; Clean up marks {data.abandoned === 1 ? 'it' : 'them'} interrupted</small> : null}
        </dd>
        <dt>Size</dt>
        <dd>
          {bytesText(data.store.bytes)} <small>{sizeNote(data.store.free, data.running)}</small>
        </dd>
        <dt>Dashboard</dt>
        <dd>
          {data.address ?? location.host} <small>local only, refuses other hosts</small>
        </dd>
      </dl>
      <div className="pbody setfoot">
        <button className="btn" type="button" disabled={!canClean} title={cleanTitle} onClick={() => app.guard(() => app.watchJob(client.startJob(JOB_KINDS.gc, { olderThanDays: data.cleanup.olderThanDays })))}>
          Clean up old runs
        </button>
        {/* A read-only dashboard's reason first: it changes nothing, whichever project it shows. */}
        <button className="btn quiet dz push" type="button" disabled={!!blocked || !!app.actionsOff} title={app.actionsOff ?? blocked ?? `Forget ${data.name} here; its folder, store and goldens stay on disk`} onClick={() => app.guard(() => setRemoving(true))}>
          Remove from dashboard
        </button>
      </div>
      {removing && removal && current ? <removal.Dialog id={current.id} onClose={() => setRemoving(false)} /> : null}
    </section>
  );
}
