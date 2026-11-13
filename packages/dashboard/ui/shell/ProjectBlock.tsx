import { useCallback, useEffect, useRef, useState } from 'react';
import type { Meta } from '../api.js';
import { tipCard } from '../components/HoverCard.js';
import { Icon } from '../components/Icon.js';
import { Popover, useMenu } from '../components/Popover.js';
import { compactPath, projectOfStore } from '../format.js';
import { confirmWords } from '../labels.js';
import { addPaletteSource } from '../palette-sources.js';
import { ONLY_PROJECT, onProjectsChanged, provideProjectRemoval } from '../project-actions.js';
import { expectProject, onProjectSwitched, takeDialogDropped, takeLanding, type ProjectsView } from '../projects-api.js';
import { exportedLine, exportedNote, keepsPageOnSwitch, switchedText, switchToLabel } from '../projects.js';
import { projectInitial as initial } from '../../src/project-initial.js';
import { href, parseRoute } from '../route.js';
import { navigate } from '../router.js';
import { useApp, type AppState } from '../state.js';
import { errorText } from '../toast.js';
import { flush } from '../pending-delete.js';
import { ActionButton, useActionWait } from '../components/ActionButton.js';
import { useServedParts, type ServedParts } from '../served-parts.js';

/**
 * The project at the top of the sidebar, and the switcher behind it: each project on this machine
 * with its runs and its folder on its hover card, the current one checked, those still being set up,
 * Add project…, and × to remove one while there is more than one. Switching swaps the dashboard onto
 * that project's store and opens the Overview. A dashboard that serves one store (an exported copy,
 * `--read-only`) shows the project alone.
 */

export function projectOf(meta: Meta | null): { name: string; path: string } | null {
  if (meta?.project) return meta.project;
  return meta?.dbPath ? projectOfStore(meta.dbPath) : null;
}

/** The last list the switcher loaded: what the palette's Projects group offers. */
let lastList: ProjectsView | null = null;



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
      // A delete waiting out its toast goes to this project's store first.
      await flush();
      await app.client.projects.select(id);
    } catch (err) {
      app.toast(errorText(err), 'error');
      return;
    }
    expectProject(id, to);
    await app.reload();
  }
  if (!samePage(location.hash, to)) navigate(to);
}

// The palette's Projects group: switch to each of the others.
addPaletteSource(({ app }) =>
  (lastList?.items ?? [])
    .filter((p) => !p.current)
    .map((p) => ({ group: 'Projects' as const, label: switchToLabel(p.name), hint: p.path, run: () => app.guard(() => void switchProject(app, p.id)) })),
);

export function ProjectBlock({ meta }: { meta: Meta | null }) {
  // The Remove dialog, handed in by the served entry: rarely opened, so its code waits out of the first look until the switcher opens.
  const { RemoveProject } = useServedParts();
  const p = projectOf(meta);
  // An exported copy says what it is in the switcher's place: what it holds, when it was made, that it reads only.
  if (meta?.static) {
    return (
      <div className="expblock">
        <b>Exported copy</b>
        <span>{exportedLine(meta.counts?.runs ?? meta.runIds?.length ?? 0, meta.exportedAt ?? null)}</span>
        <small>{exportedNote(meta.redacted)}</small>
      </div>
    );
  }
  if (meta?.project?.id) return <ProjectSwitcher meta={meta} RemoveProject={RemoveProject} />;
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

function ProjectSwitcher({ meta, RemoveProject }: { meta: Meta; RemoveProject: ServedParts['RemoveProject'] }) {
  const app = useApp();
  const removeWait = useActionWait();
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

  // Loaded once, and again whenever the project changes or a removed one comes back; the menu loads it afresh as it opens.
  useEffect(() => load(), [load, id]);
  useEffect(() => onProjectsChanged(load), [load]);

  // Settings → Project's Remove project… opens this same dialog for the current project.
  const several = list ? list.items.length > 1 : true;
  useEffect(() => (RemoveProject ? provideProjectRemoval({ current: () => ({ id, blocked: several ? null : ONLY_PROJECT }), Dialog: RemoveProject }) : undefined), [id, several, RemoveProject]);

  // A switch made here lands where it was asked to (the Overview, or a job's link in the project it
  // ran in). One made elsewhere (another tab, a project removed there) keeps a page every project
  // has, with what is typed on it, and reads the current project; a page that names a run or a fix
  // of the other project goes to the Overview. A dialog that asked about the other project closes
  // (Dialog), never to act on this one. The toast says what happened.
  const refused = useRef(false);
  const shownName = useRef(project.name);
  const { reload, toast } = app;
  useEffect(() => {
    const from = shownName.current;
    shownName.current = project.name;
    if (seen.current === id) return;
    seen.current = id;
    const mine = takeLanding(id);
    // A change refused for the project it showed, or a dialog that asked about it and closed: nothing was done there.
    const wasRefused = takeDialogDropped() || refused.current;
    refused.current = false;
    if (mine !== null) {
      if (!samePage(location.hash, mine)) navigate(mine);
      return;
    }
    if (!keepsPageOnSwitch(parseRoute(location.hash))) navigate(href.overview());
    toast(switchedText({ from, to: project.name, refused: wasRefused }));
  }, [id, project.name, toast]);
  // A change asked for here was refused because the dashboard switched elsewhere: turn to that project at once.
  useEffect(
    () =>
      onProjectSwitched(() => {
        refused.current = true;
        void reload();
      }),
    [reload],
  );

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
          if (!menu.open) {
            load();
            RemoveProject?.preload();
          }
          menu.toggle(e.currentTarget);
        }}
      >
        <span className="pa">{initial(project.name)}</span>
        <span className="pn">
          <b>{project.name}</b>
          {/* A long folder keeps its last folders; the whole path is on hover. */}
          <small>{compactPath(project.display ?? project.path, 30)}</small>
        </span>
        <Icon name="caret" className="caret" />
      </button>
      {menu.open ? (
        <Popover
          anchor={menu.anchor}
          onClose={menu.close}
          align="start"
          label="Projects"
          className="projmenu curmark narrow"
          onKeys={(e) => {
            // → reaches a row's ×; Delete on the project removes it too.
            if (e.key !== 'Delete' && e.key !== 'Backspace') return false;
            const row = items.find((p) => p.id === (document.activeElement as HTMLElement | null)?.getAttribute('data-project'));
            if (!row?.removable) return false;
            e.preventDefault();
            if (removeWait) {
              app.toast(removeWait);
              return true;
            }
            menu.close();
            setRemoving(row.id);
            return true;
          }}
        >
          <div className="pk">{list?.heading ?? 'Projects on this machine'}</div>
          {items.map((p) => (
            <div className="prow" key={p.id}>
              <button type="button" role="menuitemradio" aria-checked={!!p.current} data-project={p.id} onClick={() => pick(p.id)} data-tip={tipCard(p.name, [], p.why ?? `${p.path}${p.settingUp ? ' · setting up' : ''}`)} aria-keyshortcuts={p.removable ? 'Delete' : undefined}>
                <b>{p.name}</b>
                <small>{p.detail}</small>
              </button>
              {p.removable ? (
                <ActionButton
                  role="menuitem"
                  className="px"
                  aria-label={p.removeLabel}
                  title="Remove project…"
                  onClick={() => {
                    menu.close();
                    setRemoving(p.id);
                  }}
                >
                  ×
                </ActionButton>
              ) : null}
            </div>
          ))}
          <hr />
          <button
            type="button"
            role="menuitem"
            data-tip={tipCard(confirmWords(list?.add.label ?? 'Add project…'), [], list?.add.hint ?? 'A folder with your agent’s code')}
            onClick={() => {
              menu.close();
              navigate(href.newProject());
            }}
          >
            <b>{list?.add.label ?? 'Add project…'}</b>
          </button>
          <div className="pnote">{list?.notice ?? project.notice ?? list?.note ?? 'Each project keeps its own store.'}</div>
        </Popover>
      ) : null}
      {removing && RemoveProject ? (
        <RemoveProject
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
