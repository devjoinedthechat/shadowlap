import { Fragment } from 'react';
import { Brand, Icon } from '../components/Icon.js';
import { settingsTabLabel } from '../pages/settings/tabs.js';
import { shortId } from '../format.js';
import { href, type Route } from '../route.js';
import { useApp } from '../state.js';
import { useFixCrumb } from '../fixes/data.js';
import { useTeamStore } from '../teamstore.js';

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
  const { runs, live, sideOpen, setSideOpen, setHelp, conn, exported } = useApp();
  const parentOf = (id: string) => runs?.find((r) => r.runId === id || r.runId.startsWith(id))?.parentRunId ?? null;
  // A fix goes by its label (Fixes / refund-bug), once the fixes read model has named it.
  const fixName = useFixCrumb(route.page === 'fixes' ? route.id : null);
  const crumbs = crumbsFor(route, parentOf, fixName);
  const recording = live[0]?.runId ?? runs?.find((r) => r.status === 'running')?.runId ?? null;
  // A project with a team store reads "team", as the design labels it: its runs are the team's.
  const store = useTeamStore();
  return (
    <header className="top">
      <button className="ibtn menu-toggle" type="button" aria-label="Menu" aria-expanded={sideOpen} aria-controls="side" onClick={() => setSideOpen(!sideOpen)}>
        <Icon name="menu" />
      </button>
      <a className="brand" href={exported ? href.runs() : href.overview()} aria-label={exported ? 'Shadowlap, runs' : 'Shadowlap dashboard, overview'}>
        <Brand />
      </a>
      <span className="pill" title={!exported && store ? `team store ${store.url}` : undefined}>
        {exported ? 'exported' : store ? 'team' : 'dashboard'}
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
      {recording && conn === 'ok' ? (
        <a className="livechip" href={href.run(recording)}>
          <span className="dotlive" />
          recording {shortId(recording)}
        </a>
      ) : null}
      <button className="ibtn" id="helpBtn" type="button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts  ?" onClick={() => conn !== 'expired' && setHelp(true)}>
        <Icon name="keys" />
      </button>
    </header>
  );
}
