import { useCallback, useEffect, useRef, useState } from 'react';
import type { Meta } from '../api.js';
import { Icon } from '../components/Icon.js';
import { Popover, useMenu } from '../components/Popover.js';
import { compactPath, projectOfStore } from '../format.js';
import { addPaletteSource } from '../palette-sources.js';
import { ONLY_PROJECT, provideProjectRemoval } from '../project-actions.js';
import { onProjectSwitched, type ProjectsView } from '../projects-api.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { copyLine } from '../runs.js';
import { useApp, type AppState } from '../state.js';
import { RemoveProjectDialog } from './RemoveProject.js';

/**
 * The project at the top of the sidebar, and the switcher behind it: each project on this machine
 * with its folder and runs, the current one marked, those still being set up, Add project…, and ×
 * to remove one while there is more than one. Switching swaps the dashboard onto that project's
 * store and opens the Overview. A dashboard that serves one store (an exported copy, `--read-only`)
 * shows the project alone.
 */

export function projectOf(meta: Meta | null): { name: string; path: string } | null {
  if (meta?.project) return meta.project;
  return meta?.dbPath ? projectOfStore(meta.dbPath) : null;
}

/** The last list the switcher loaded: what the palette's Projects group offers. */
let lastList: ProjectsView | null = null;

/** Where a switch made from this page lands once the project's meta has arrived: its Overview, or the page a link named. */
let landing: { id: string; to: string } | null = null;

/** The same page, however its hash is written: `#/`, `#` and none are the Overview. */
const samePage = (a: string, b: string) => a.replace(/^#\/?/, '') === b.replace(/^#\/?/, '');

/**
 * Switches to a project and opens its Overview, where the setup shows while it has no runs, or the
 * page `to` names in it (a link of a job that ran there).
 */
export async function switchProject(app: AppState, id: string, to: string = href.overview()): Promise<void> {
  const current = app.meta?.project?.id;
  if (id !== current) {
    try {
      await app.client.projects.select(id);
    } catch (err) {
      app.toast(err instanceof Error ? err.message : String(err));
      return;
    }
    landing = { id, to };
    await app.reload();
  }
  if (!samePage(location.hash, to)) navigate(to);
}

// The palette's Projects group: switch to each of the others.
addPaletteSource(({ app }) =>
  (lastList?.items ?? [])
    .filter((p) => !p.current)
    .map((p) => ({ group: 'Projects' as const, label: `Switch to ${p.name}`, hint: p.path, run: () => app.guard(() => void switchProject(app, p.id)) })),
);

export function ProjectBlock({ meta }: { meta: Meta | null }) {
  const p = projectOf(meta);
  if (meta?.static) {
    return (
      <div className="proj is-static">
        <span className="pa">S</span>
        <span className="pn">
          <b>Exported copy</b>
          <small>{copyLine(meta.runIds)}</small>
        </span>
      </div>
    );
  }
  if (meta?.project?.id) return <ProjectSwitcher meta={meta} />;
  const name = p?.name ?? 'this store';
  return (
    <div className="proj is-static" title={p?.path ?? meta?.dbPath ?? undefined}>
      <span className="pa">{name.charAt(0).toUpperCase()}</span>
      <span className="pn">
        <b>{name}</b>
        <small>{p ? compactPath(p.path, 30) : meta?.dbPath ? compactPath(meta.dbPath, 30) : '…'}</small>
      </span>
    </div>
  );
}

/** The letter on a project's badge. */
const initial = (name: string) => (/[\p{L}\p{N}]/u.exec(name.normalize('NFC'))?.[0] ?? '?').toUpperCase();

function ProjectSwitcher({ meta }: { meta: Meta }) {
  const app = useApp();
  const { client, guard } = app;
  const menu = useMenu();
  const [list, setList] = useState<ProjectsView | null>(lastList);
  const [removing, setRemoving] = useState<string | null>(null);
  const project = meta.project!;
  const id = project.id!;
  const seen = useRef(id);

  const load = useCallback(() => {
    client.projects.list().then(
      (v) => {
        lastList = v;
        setList(v);
      },
      () => undefined,
    );
  }, [client]);

  // Loaded once, and again whenever the project changes; the menu loads it afresh as it opens.
  useEffect(() => load(), [load, id]);

  // Settings → Project's "Remove from dashboard" opens this same dialog for the current project.
  const several = list ? list.items.length > 1 : true;
  useEffect(() => provideProjectRemoval({ current: () => ({ id, blocked: several ? null : ONLY_PROJECT }), Dialog: RemoveProjectDialog }), [id, several]);

  // A switch made elsewhere (another tab, a removed project) lands on the Overview; one made here
  // where it was asked to (the Overview, or a job's link in the project it ran in).
  useEffect(() => {
    if (seen.current === id) return;
    seen.current = id;
    const to = landing?.id === id ? landing.to : href.overview();
    landing = null;
    if (!samePage(location.hash, to)) navigate(to);
  }, [id]);
  // A change asked for here was refused because the dashboard switched elsewhere: turn to that project at once.
  const { reload } = app;
  useEffect(() => onProjectSwitched(() => void reload()), [reload]);

  const pick = (pid: string) => {
    menu.close();
    guard(() => void switchProject(app, pid));
  };
  const items = list?.items ?? [];
  return (
    <>
      <button
        className="proj"
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        title={list?.notice ?? project.notice ?? project.path}
        onClick={(e) => {
          if (!menu.open) load();
          menu.toggle(e.currentTarget);
        }}
      >
        <span className="pa">{initial(project.name)}</span>
        <span className="pn">
          <b>{project.name}</b>
          <small>{project.display ?? compactPath(project.path, 30)}</small>
        </span>
        <Icon name="caret" className="caret" />
      </button>
      {menu.open ? (
        <Popover anchor={menu.anchor} onClose={menu.close} align="left" matchWidth label="Projects" className="projmenu">
          <div className="pk">{list?.heading ?? 'Projects on this machine'}</div>
          {items.map((p) => (
            <div className="prow" key={p.id}>
              <button
                type="button"
                role="menuitem"
                onClick={() => pick(p.id)}
                title={p.why ?? undefined}
                aria-keyshortcuts={p.removable ? 'Delete' : undefined}
                onKeyDown={(e) => {
                  // The × shows under the pointer only: from the keyboard, Delete on the project removes it.
                  if (!p.removable || (e.key !== 'Delete' && e.key !== 'Backspace')) return;
                  e.preventDefault();
                  menu.close();
                  setRemoving(p.id);
                }}
              >
                <b>
                  {p.name}
                  {p.current ? <span className="cur">current</span> : null}
                </b>
                <small>{p.detail}</small>
              </button>
              {p.removable ? (
                <button
                  type="button"
                  className="px"
                  aria-label={p.removeLabel}
                  title="Remove from the dashboard"
                  onClick={() => {
                    menu.close();
                    setRemoving(p.id);
                  }}
                >
                  ×
                </button>
              ) : null}
            </div>
          ))}
          <hr />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              menu.close();
              navigate(href.newProject());
            }}
          >
            <b>{list?.add.label ?? 'Add project…'}</b>
            <small>{list?.add.hint ?? 'a folder with your agent’s code'}</small>
          </button>
          <div className="pnote">{list?.notice ?? project.notice ?? list?.note ?? 'Each project keeps its own store.'}</div>
        </Popover>
      ) : null}
      {removing ? (
        <RemoveProjectDialog
          id={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            load();
          }}
        />
      ) : null}
    </>
  );
}
