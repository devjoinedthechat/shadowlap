import { JOB_KINDS } from '../../api.js';
import { num } from '../../format.js';
import { ONLY_PROJECT, useProjectRemoval } from '../../project-actions.js';
import { useApp } from '../../state.js';
import { LoadProblem, Loading, useSettingsData } from './common.js';
import { bytesText } from './logic.js';

/**
 * Project: its name, store, runs and attempts, the store's size and the dashboard's address; Clean
 * up old runs (a dry run first, then "Delete N runs" from the drawer); and Remove from dashboard,
 * which opens the projects' own dialog.
 */
export function ProjectTab() {
  const app = useApp();
  const { client } = app;
  const { data, error } = useSettingsData(() => client.settings.project(), 'settings:project');
  const removal = useProjectRemoval();
  if (error && !data) return <LoadProblem error={error} />;
  if (!data) return <Loading title="Project" />;
  const project = { name: data.name, path: data.folder };
  const blocked = removal ? removal.blocked(project) : ONLY_PROJECT;
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
          {bytesText(data.store.bytes)} <small>blobs shared between runs{data.store.free > 1024 * 1024 ? ` · ${bytesText(data.store.free)} a clean-up gives back` : ''}</small>
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
        <button className="btn quiet dz push" type="button" disabled={!removal || !!blocked || !!app.actionsOff} title={blocked ?? app.actionsOff ?? `Forget ${data.name} here; its folder, store and goldens stay on disk`} onClick={() => removal && app.guard(() => removal.open(project))}>
          Remove from dashboard
        </button>
      </div>
    </section>
  );
}
