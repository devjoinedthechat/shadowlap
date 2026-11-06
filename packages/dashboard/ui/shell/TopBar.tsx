import { Fragment, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import { tipCard } from '../components/HoverCard.js';
import { Brand, Icon } from '../components/Icon.js';
import { paletteKeyLabel } from '../dom.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { settingsTabLabel } from '../pages/settings/tabs.js';
import { shortId } from '../format.js';
import { knownParent, onParentNoted } from '../parents.js';
import { setupShowsOn } from '../projects.js';
import { href, type Route } from '../route.js';
import { useSingleKeys } from '../single-keys.js';
import { useApp } from '../state.js';
import { useFixCrumb } from '../fixes/data.js';
import { HelpMenu } from './HelpMenu.js';
import { crumbLineage, liveChip, parentCrumbKey } from './top.js';
import { unshownKey, useUnshown } from './unshown.js';
import { lastRunsHref } from '../runs-view.js';

/**
 * A crumb. Its face: `rt` a run's id (mono), `code` a fix's label, `word` a part of the page in the
 * UI face, none a plain word. `anc` for an ancestor, which gives way first; `parent` for the run's
 * own parent, what p opens, its about line on its card; `tip` a run's about line.
 */
type Crumb = { label: string; href?: string; face?: 'rt' | 'code' | 'word'; anc?: boolean; parent?: boolean; tip?: string | null };

/** What the page shows, as the crumbs name it: only its section where it can't show what it opened for (`unshown`). */
function crumbsFor(route: Route, lineageOf: (id: string) => Array<{ runId: string; about: string | null }>, o: { fixName: string | null; aboutOf: (id: string) => string | null; unshown: boolean }): Crumb[] {
  switch (route.page) {
    case 'runs':
      return [{ label: 'Runs' }];
    case 'run': {
      if (o.unshown) return [{ label: 'Runs', href: lastRunsHref() }];
      // The run's lineage by id, from its recording down to this run, each with its about line on hover.
      const lineage = lineageOf(route.id);
      const up = lineage.map((a, i): Crumb => ({ label: shortId(a.runId), href: href.run(a.runId), face: 'rt', anc: true, parent: i === lineage.length - 1, tip: a.about }));
      return [{ label: 'Runs', href: lastRunsHref() }, ...up, { label: shortId(route.id), face: 'rt', tip: o.aboutOf(route.id) }];
    }
    case 'compare':
      return [{ label: 'Compare' }];
    case 'fixes':
      if (!route.id) return [{ label: 'Fixes' }];
      return [{ label: 'Fixes', href: href.fixes() }, ...(o.unshown ? [] : [{ label: o.fixName ?? route.id, face: 'code' as const }])];
    case 'tests':
      return [{ label: 'Tests' }];
    case 'training':
      return [{ label: 'Training', href: href.training() }, { label: route.tab === 'tasks' ? 'Tasks' : 'Pairs', face: 'word' }];
    case 'settings':
      return [{ label: 'Settings', href: href.settings() }, { label: settingsTabLabel(route.tab), face: 'word' }];
    case 'new':
      return [{ label: confirmWords(ACTIONS.addProject.label) }];
    case 'setup':
      return [{ label: 'Set up' }];
    case 'store-setup':
      return [{ label: ACTIONS.setUpTeamStore.label }];
    default:
      return [];
  }
}

function CrumbWords({ c }: { c: Crumb }) {
  // The parent's about line is on its card, so it has no title of its own to show under it.
  if (c.face === 'rt')
    return (
      <b className="rt" title={c.parent ? undefined : (c.tip ?? undefined)}>
        {c.label}
      </b>
    );
  if (c.face === 'code')
    return (
      <b>
        <code>{c.label}</code>
      </b>
    );
  return c.face === 'word' ? <b>{c.label}</b> : <>{c.label}</>;
}

/** Where the bar is too short for the whole lineage, the oldest give way to "…" first; the run's own crumb stays. Fitted on each draw, as the window changes and once the fonts land. */
function useFitCrumbs(nav: RefObject<HTMLElement | null>): void {
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
    const fonts = typeof document.fonts?.addEventListener === 'function' ? document.fonts : null;
    window.addEventListener('resize', fit);
    fonts?.addEventListener('loadingdone', fit);
    return () => {
      window.removeEventListener('resize', fit);
      fonts?.removeEventListener('loadingdone', fit);
    };
  });
}

export function TopBar({ route }: { route: Route }) {
  const { runs, live, meta, sideOpen, setSideOpen, setPalette, conn, exported, loadedAt } = useApp();
  // The parent's crumb says its key only while single keys are on: drawn again as the switch moves.
  const singleKeys = useSingleKeys();
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
  const aboutOf = (id: string) => listed(id)?.about?.text ?? null;
  // A run or a fix the page can't show, or the setup in its place: only the section is named.
  const unshown = useUnshown(unshownKey(route)) || !!setupShowsOn(route, { exported, meta, runs });
  const crumbs = crumbsFor(route, lineageOf, { fixName, aboutOf, unshown });
  const nav = useRef<HTMLElement>(null);
  useFitCrumbs(nav);
  const ancestors = crumbs.filter((c) => c.anc).map((c) => c.label);
  const recording = exported ? [] : live.length ? live : (runs ?? []).filter((r) => r.status === 'running');
  const chip = liveChip({ recording, open: route.page === 'run' ? route.id : null, conn, loadedAt, aboutOf });
  return (
    <header className="top">
      <button className="ibtn menu-toggle" type="button" aria-label="Menu" aria-expanded={sideOpen} aria-controls="side" onClick={() => setSideOpen(!sideOpen)}>
        <Icon name="menu" />
      </button>
      {/* An exported copy's #/ is the run it opens on. */}
      <a className="brand" href={href.overview()} aria-label={exported ? 'Shadowlap exported copy, the run it opens on' : 'Shadowlap dashboard, overview'}>
        <Brand />
      </a>
      <nav className="crumbs" aria-label="Breadcrumb" ref={nav}>
        {crumbs.map((c, i) => {
          const card = c.parent ? { 'data-tip': tipCard('Open parent run', [], c.tip), ...parentCrumbKey(singleKeys) } : {};
          const crumb = (
            <>
              {i ? <i aria-hidden="true">/</i> : null}
              {c.href ? (
                <a href={c.href} {...card}>
                  <CrumbWords c={c} />
                </a>
              ) : (
                <span>
                  <CrumbWords c={c} />
                </span>
              )}
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
                  <i aria-hidden="true">/</i>
                  <span title={ancestors.join(' / ')}>…</span>
                </span>
              ) : null}
            </Fragment>
          );
        })}
      </nav>
      <div className="sp" />
      {chip ? (
        <a className="livechip" href={href.run(chip.runId)} data-tip={tipCard(chip.title, [], chip.line)}>
          <span className="dotlive" />
          {chip.words}
        </a>
      ) : null}
      {exported ? null : (
        <button className="search sbtn" type="button" aria-label={`Search or jump to (${paletteKeyLabel()})`} aria-keyshortcuts="Meta+K Control+K" onClick={() => conn !== 'expired' && setPalette(true)}>
          <Icon name="search" />
          <span className="st">Search or jump to…</span>
          <span className="kbd">{paletteKeyLabel()}</span>
        </button>
      )}
      <HelpMenu />
    </header>
  );
}
