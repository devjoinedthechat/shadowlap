import { Fragment, useSyncExternalStore } from 'react';
import { Brand, Icon } from '../components/Icon.js';
import { settingsTabLabel } from '../pages/settings/tabs.js';
import { shortId } from '../format.js';
import { knownParent, onParentNoted } from '../parents.js';
import { href, type Route } from '../route.js';
import { useApp } from '../state.js';
import { useFixCrumb } from '../fixes/data.js';
import { useTeamStore } from '../teamstore.js';
import { crumbParent, liveChip, topPill } from './top.js';

type Crumb = { label: string; href?: string; mono?: boolean };

function crumbsFor(route: Route, parentOf: (id: string) => string | null, fixName: string | null = null): Crumb[] {
  switch (route.page) {
    case 'runs':
      return [{ label: 'Runs' }];
    case 'run': {
      const parent = parentOf(route.id);
      return [{ label: 'Runs', href: href.runs() }, ...(parent ? [{ label: shortId(parent), href: href.run(parent), mono: true }] : []), { label: shortId(route.id), mono: true }];
    }
    case 'compare':
      return [{ label: 'Compare' }];
    case 'fixes':
      return route.id ? [{ label: 'Fixes', href: href.fixes() }, { label: fixName ?? route.id, mono: true }] : [{ label: 'Fixes' }];
    case 'tests':
      return [{ label: 'Tests' }];
    case 'training':
      return [{ label: 'Training', href: href.training() }, { label: route.tab === 'tasks' ? 'Tasks' : 'Pairs', mono: true }];
    case 'settings':
      return [{ label: 'Settings', href: href.settings() }, { label: settingsTabLabel(route.tab), mono: true }];
    case 'new':
      return [{ label: 'Add a project' }];
    case 'setup':
      return [{ label: 'Set up' }];
    default:
      return [];
  }
}

export function TopBar({ route }: { route: Route }) {
  const { runs, live, sideOpen, setSideOpen, setHelp, conn, exported, meta, actionsOff, loadedAt } = useApp();
  const listed = (id: string) => runs?.find((r) => r.runId === id || (id.length >= 10 && r.runId.startsWith(id))) ?? null;
  const shown = route.page === 'run' ? listed(route.id) : null;
  // A run the list leaves out (an attempt bundled under its run, or one older than the newest 500)
  // names its parent in its own detail, which its page loads: the crumb waits for that, asking nothing.
  const ask = route.page === 'run' && !shown && !exported ? route.id : null;
  const loaded = useSyncExternalStore(onParentNoted, () => (ask ? knownParent(ask) : undefined));
  const parentOf = () => crumbParent({ listed: shown, loaded, exported, holds: (id) => !!listed(id) });
  // A fix goes by its label (Fixes / refund-bug), once the fixes read model has named it.
  const fixName = useFixCrumb(route.page === 'fixes' ? route.id : null);
  const crumbs = crumbsFor(route, parentOf, fixName);
  // A dashboard that changes nothing says read-only where an exported copy says it is one; one with a
  // team store says team.
  const store = useTeamStore();
  const pill = topPill({ exported, readOnly: !!meta && !exported && (meta.readOnly === true || !meta.actions), actionsOff, store: store?.url ?? null });
  const chip = liveChip({ recording: live[0]?.runId ?? runs?.find((r) => r.status === 'running')?.runId ?? null, conn, loadedAt });
  return (
    <header className="top">
      <button className="ibtn menu-toggle" type="button" aria-label="Menu" aria-expanded={sideOpen} aria-controls="side" onClick={() => setSideOpen(!sideOpen)}>
        <Icon name="menu" />
      </button>
      <a className="brand" href={exported ? href.runs() : href.overview()} aria-label={exported ? 'Shadowlap, runs' : 'Shadowlap dashboard, overview'}>
        <Brand />
      </a>
      <span className="pill" title={pill.title ?? undefined}>
        {pill.word}
      </span>
      <nav className="crumbs" aria-label="Breadcrumb">
        {crumbs.map((c, i) => {
          const inner = c.mono ? <b>{c.label}</b> : c.label;
          return (
            <Fragment key={`${i}-${c.label}`}>
              {i ? <i>/</i> : null}
              {c.href ? <a href={c.href}>{inner}</a> : <span>{inner}</span>}
            </Fragment>
          );
        })}
      </nav>
      <div className="sp" />
      {chip ? (
        <a className="livechip" href={href.run(chip.runId)} title={chip.title ?? undefined}>
          <span className="dotlive" />
          recording {shortId(chip.runId)}
        </a>
      ) : null}
      <button className="ibtn" id="helpBtn" type="button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts  ?" onClick={() => conn !== 'expired' && setHelp(true)}>
        <Icon name="keys" />
      </button>
    </header>
  );
}
