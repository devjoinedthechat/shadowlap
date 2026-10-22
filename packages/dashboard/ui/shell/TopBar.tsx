import { Fragment, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { Spin } from '../components/bits.js';
import { Brand, Icon } from '../components/Icon.js';
import { settingsTabLabel } from '../pages/settings/tabs.js';
import { shortId } from '../format.js';
import { knownParent, onParentNoted } from '../parents.js';
import { href, type Route } from '../route.js';
import { useApp } from '../state.js';
import { useFixCrumb } from '../fixes/data.js';
import { useServerJobs } from '../fixes/tree.js';
import { runningChip } from '../jobs.js';
import { useTeamStore } from '../teamstore.js';
import { crumbLineage, liveChip, topPill } from './top.js';

/** A crumb; `run` for a run's id (its about line on hover), `anc` for an ancestor, which gives way first. */
type Crumb = { label: string; href?: string; mono?: boolean; run?: boolean; anc?: boolean; tip?: string | null };

function crumbsFor(route: Route, lineageOf: (id: string) => Array<{ runId: string; about: string | null }>, fixName: string | null = null, aboutOf: (id: string) => string | null = () => null): Crumb[] {
  switch (route.page) {
    case 'runs':
      return [{ label: 'Runs' }];
    case 'run':
      // The run's lineage by id, from its recording down to this run, each with its about line on hover.
      return [{ label: 'Runs', href: href.runs() }, ...lineageOf(route.id).map((a) => ({ label: shortId(a.runId), href: href.run(a.runId), mono: true, run: true, anc: true, tip: a.about })), { label: shortId(route.id), mono: true, run: true, tip: aboutOf(route.id) }];
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
    case 'store-setup':
      return [{ label: 'Set up the store' }];
    default:
      return [];
  }
}

export function TopBar({ route }: { route: Route }) {
  const { runs, live, sideOpen, setSideOpen, setHelp, conn, exported, meta, actionsOff, loadedAt, jobs, openJob } = useApp();
  const listed = (id: string) => runs?.find((r) => r.runId === id || (id.length >= 10 && r.runId.startsWith(id))) ?? null;
  const shown = route.page === 'run' ? listed(route.id) : null;
  // A run the list leaves out (an attempt bundled under its run, or one older than the newest 500)
  // names its parent in its own detail, which its page loads: the crumbs wait for that, asking
  // nothing, and are drawn again once it is noted. Each step of the lineage reads the parents noted.
  const ask = route.page === 'run' && !shown && !exported ? route.id : null;
  useSyncExternalStore(onParentNoted, () => (ask ? knownParent(ask) : undefined));
  const lineageOf = (id: string) => crumbLineage(id, { listed, loaded: knownParent, exported, holds: (x) => !!listed(x) });
  // A fix goes by its label (Fixes / refund-bug), once the fixes read model has named it.
  const fixName = useFixCrumb(route.page === 'fixes' ? route.id : null);
  const crumbs = crumbsFor(route, lineageOf, fixName, (id) => listed(id)?.about?.text ?? null);
  const nav = useRef<HTMLElement>(null);
  // Where the bar is too short for the whole lineage, the oldest give way to "…" first; the run's own crumb stays.
  useLayoutEffect(() => {
    const el = nav.current;
    if (!el) return;
    const fit = () => {
      const anc = [...el.querySelectorAll<HTMLElement>('[data-anc]')];
      const gap = el.querySelector<HTMLElement>('.cgap');
      for (const a of anc) a.hidden = false;
      if (gap) gap.hidden = true;
      if (!gap || !el.getClientRects().length) return;
      for (let i = 0; i < anc.length && el.scrollWidth > el.clientWidth + 0.5; i++) {
        anc[i]!.hidden = true;
        gap.hidden = false;
      }
    };
    fit();
    addEventListener('resize', fit);
    return () => removeEventListener('resize', fit);
  });
  const ancestors = crumbs.filter((c) => c.anc).map((c) => c.label);
  // A dashboard that changes nothing says read-only where an exported copy says it is one; one with a
  // team store says team.
  const store = useTeamStore();
  const pill = topPill({ exported, readOnly: !!meta && !exported && (meta.readOnly === true || !meta.actions), actionsOff, store: store?.url ?? null });
  const chip = liveChip({ recording: live[0]?.runId ?? runs?.find((r) => r.status === 'running')?.runId ?? null, conn, loadedAt });
  // The jobs running, from every tab, and the drawer of one whose drawer was closed, to open again.
  const running = runningChip(useServerJobs(), jobs.find((w) => w.open)?.job.id ?? null);
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
      <nav className="crumbs" aria-label="Breadcrumb" ref={nav}>
        {crumbs.map((c, i) => {
          const inner = c.mono ? (
            <b className={c.anc ? 'rt' : undefined} title={c.tip ?? undefined}>
              {c.label}
            </b>
          ) : (
            c.label
          );
          const crumb = (
            <>
              {i ? <i>/</i> : null}
              {c.href ? <a href={c.href}>{inner}</a> : <span>{inner}</span>}
            </>
          );
          return (
            <Fragment key={`${i}-${c.label}`}>
              {c.anc ? (
                <span className="cg" data-anc="">
                  {crumb}
                </span>
              ) : (
                crumb
              )}
              {i === 0 && ancestors.length ? (
                <span className="cg cgap" hidden>
                  <i>/</i>
                  <span title={ancestors.join(' / ')}>…</span>
                </span>
              ) : null}
            </Fragment>
          );
        })}
      </nav>
      <div className="sp" />
      {running && conn !== 'expired' ? (
        <button className="livechip jobchip" type="button" title={running.title} onClick={() => openJob(running.opens)}>
          <Spin />
          <span>
            {running.count} {running.count === 1 ? 'job' : 'jobs'}
            <span className="jrun"> running</span>
          </span>
        </button>
      ) : null}
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
