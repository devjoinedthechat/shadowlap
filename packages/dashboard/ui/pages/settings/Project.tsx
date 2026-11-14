import { useState } from 'react';
import { JOB_KINDS } from '../../api.js';
import { num } from '../../format.js';
import { ONLY_PROJECT, useProjectRemoval } from '../../project-actions.js';
import { useLoad } from '../../hooks.js';
import { useApp } from '../../state.js';
import { LoadProblem, Loading, useFolderGone, useSettingsData } from './common.js';
import { bytesText, sizeNote } from './logic.js';
import { ActionButton } from '../../components/ActionButton.js';
import { Section } from '../../components/Section.js';
import { Code, Words } from '../../components/Copy.js';
import { DotParts } from '../../components/DotParts.js';
import { SpendingRow } from './SpendingRow.js';
import { HealthRow } from './Health.js';

/**
 * Project: what Shadowlap is here (its version, its licence, no account), then the project's name,
 * store, runs and attempts, the store's size and the dashboard's address, what is data as code, and
 * what the server ignored of this machine's settings and why (MachineRow); Spending, when a billed
 * job asks before it starts (SpendingRow); Health, `shadowlap doctor`'s checks (HealthRow); Clean up old runs (a dry run first, then "Delete N runs" from the drawer, or with no run old enough
 * "Free X" for what deleted runs left unused); and Remove project…, which opens the projects
 * feature's own dialog, here in the page.
 */
export function ProjectTab() {
  const app = useApp();
  const { client } = app;
  const { data, error, reload } = useSettingsData(() => client.settings.project(), 'settings:project');
  const machine = useMachineWarnings();
  const removal = useProjectRemoval();
  const [removing, setRemoving] = useState(false);
  const gone = useFolderGone();
  if (error && !data) return <LoadProblem error={error} retry={reload} />;
  if (!data) return <Loading title="Project" />;
  const current = removal?.current() ?? null;
  const blocked = current ? current.blocked : ONLY_PROJECT;
  const canClean = !app.actionsOff && !gone && app.hasKind(JOB_KINDS.gc);
  const cleanTitle = app.actionsOff ?? gone ?? (!app.hasKind(JOB_KINDS.gc) ? 'This dashboard doesn’t run gc: shadowlap gc --older-than 30 --dry-run in a terminal' : null);
  const version = app.meta?.version ?? null;
  return (
    <Section className="set" title="Project">
      <dl className="kvs">
        <dt>Shadowlap</dt>
        <dd>
          {version ? `${version}\u00a0· ` : null}
          <small>
            <DotParts parts={['open source, Apache-2.0', 'no account, no limits on runs']} />
          </small>
        </dd>
        <dt>Name</dt>
        <dd>
          <code>{data.name}</code>
        </dd>
        <dt>Store</dt>
        <dd title={data.store.path ?? undefined}>{data.shown.store ? <Code>{data.shown.store}</Code> : <Words>in memory: nothing is kept</Words>}</dd>
        {/* With the folder gone there is no store to count: the store shown is an empty stand-in. */}
        <dt>Runs</dt>
        {gone ? (
          <dd className="muted">
            <Words>not read: the folder is gone</Words>
          </dd>
        ) : (
          <dd>
            {num(data.runs)}{' '}
            <small>
              <Words>{`and ${num(data.attempts)} ${data.attempts === 1 ? 'attempt' : 'attempts'}`}</Words>
            </small>
            {/* each dot kept with the part before it */}
            {data.running ? <small>{`\u00a0· `}<Words>{`${data.running} recording now`}</Words></small> : null}
            {data.abandoned ? <small className="warn">{`\u00a0· `}<Words>{`${data.abandoned} left recording by a process that stopped; Clean up marks ${data.abandoned === 1 ? 'it' : 'them'} interrupted`}</Words></small> : null}
          </dd>
        )}
        <dt>Size</dt>
        {gone ? (
          <dd className="muted">
            <Words>not read: the folder is gone</Words>
          </dd>
        ) : (
          <dd>
            {bytesText(data.store.bytes)}{' '}
            <small>
              <DotParts parts={sizeNote(data.store.free, data.running).split(' · ')} />
            </small>
          </dd>
        )}
        <dt>Dashboard</dt>
        <dd>
          <code>{data.address ?? location.host}</code>{' '}
          <small>
            <Words>local only, refuses other hosts</Words>
          </small>
        </dd>
        <MachineRow warnings={machine} />
      </dl>
      <SpendingRow shown={machine} />
      <HealthRow />
      <div className="pbody setfoot">
        <ActionButton
          className="btn"
          why={canClean ? null : cleanTitle}
          tip="Clean up old runs"
          sub="Shows what it would free, then asks before deleting"
          command={`$ shadowlap gc --older-than ${data.cleanup.olderThanDays} --dry-run`}
          onClick={() => app.guard(() => app.watchJob(client.startJob(JOB_KINDS.gc, { olderThanDays: data.cleanup.olderThanDays })))}
        >
          Clean up old runs
        </ActionButton>
        {/* A read-only dashboard's reason first: it changes nothing, whichever project it shows. */}
        <ActionButton className="btn quiet dz push" why={blocked} title={`Forget ${data.name} here; its folder, store and goldens stay on disk`} onClick={() => app.guard(() => setRemoving(true))}>
          Remove project…
        </ActionButton>
      </div>
      {removing && removal && current ? <removal.Dialog id={current.id} onClose={() => setRemoving(false)} /> : null}
    </Section>
  );
}

const NONE: readonly string[] = [];

/** What the server ignored of this machine's settings, and why (a relative SHADOWLAP_HOME), as the project list says it; none from a server that serves one store. */
function useMachineWarnings(): readonly string[] {
  const { client } = useApp();
  return useLoad(() => client.projects.list(), 'settings:projects').data?.warnings ?? NONE;
}

/** This machine: what the server ignored of its settings, and why, a line each, in amber; no row while it ignored nothing. */
function MachineRow({ warnings }: { warnings: readonly string[] }) {
  if (!warnings.length) return null;
  return (
    <>
      <dt>This machine</dt>
      <dd className="setwarn">
        {warnings.map((w) => (
          <span key={w} className="ln">
            {w}
          </span>
        ))}
      </dd>
    </>
  );
}
