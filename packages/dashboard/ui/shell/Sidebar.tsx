import { memo, useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import type { RunListItem } from '../api.js';
import { AboutLine, useFitAbouts } from '../components/About.js';
import { RunIcon } from '../components/RunIcon.js';
import { Icon, type IconName } from '../components/Icon.js';
import { cssVars, paletteKeyLabel } from '../dom.js';
import { num, shortId, whenShort } from '../format.js';
import { useLatest } from '../hooks.js';
import { useListKeys, type RowScope } from '../list-keys.js';
import { runRowScope } from '../run-row.js';
import { href, navSection, type Route } from '../route.js';
import { copyCompares, isAttempt, RECENT_RUNS, runTree, sideLine, sideStatus, treeLines } from '../runs.js';
import { useApp } from '../state.js';
import { lessPending, usePendingHidden, useStillCounted, withoutPending } from '../pending-delete.js';
import { ProjectBlock } from './ProjectBlock.js';
import { useLastRunsHref } from '../runs-view.js';

/** How long the drawer takes to show: it slides in hidden from the focus, and a hidden element can't take it. */
const DRAWER_SHOWS_MS = 40;

/** The phone's drawer has opened: its first item takes the focus once it shows, and a click beside it closes it, its button taking the focus. Hands back what undoes that. */
function drawerOpened(aside: RefObject<HTMLElement | null>, close: () => void): () => void {
  const timer = setTimeout(() => aside.current?.querySelector<HTMLElement>('a[href], button')?.focus({ preventScroll: true }), DRAWER_SHOWS_MS);
  const beside = (e: Event) => {
    if ((e.target as Element | null)?.closest?.('#side, .menu-toggle, #menu, #layer')) return;
    close();
    document.querySelector<HTMLElement>('.menu-toggle')?.focus({ preventScroll: true });
  };
  document.addEventListener('click', beside, true);
  return () => {
    clearTimeout(timer);
    document.removeEventListener('click', beside, true);
  };
}

export function Sidebar({ route }: { route: Route }) {
  const { meta, runs, exported, sideOpen, setPalette, setSideOpen, conn, toast } = useApp();
  // A run a delete waits to take is gone from here as from Runs' table, and from the count (pending-delete.ts).
  const hidden = usePendingHidden();
  const gone = useStillCounted(meta);
  const listed = useMemo(() => withoutPending(runs ?? [], hidden).filter((r) => !isAttempt(r)), [runs, hidden]);
  // On a phone the sidebar is a drawer: closed while the focus was in it (Esc, a pick), the focus goes
  // back to the menu button that opened it, rather than to nothing once the drawer is hidden.
  const aside = useRef<HTMLElement>(null);
  const wasOpen = useRef(sideOpen);
  useEffect(() => {
    if (wasOpen.current && !sideOpen && aside.current?.contains(document.activeElement)) document.querySelector<HTMLElement>('.menu-toggle')?.focus();
    wasOpen.current = sideOpen;
    if (!sideOpen) return;
    return drawerOpened(aside, () => setSideOpen(false));
  }, [sideOpen, setSideOpen]);
  // ⌘K on a run here offers its actions, as on a row of Runs, with nothing to select.
  const runsNow = useLatest(runs);
  const rowActions = useCallback((r: RunListItem) => (exported ? null : runRowScope(r, { runs: runsNow.current ?? [], toast })), [exported, runsNow, toast]);
  const section = navSection(route);
  const count = lessPending(meta?.counts?.runs, gone) ?? listed.length;
  // The nav's Runs opens the view Runs showed last; the list's `all` below, every run.
  const runsTo = useLastRunsHref();
  const items: Array<[string, IconName, string, string, number | null]> = exported
    ? [['runs', 'runs', 'Runs', runsTo, count], ...(copyCompares(meta?.runIds) ? [['compare', 'compare', 'Compare', href.compare(), null] as [string, IconName, string, string, number | null]] : [])]
    : [
        ['overview', 'home', 'Overview', href.overview(), null],
        ['runs', 'runs', 'Runs', runsTo, count],
        ['compare', 'compare', 'Compare', href.compare(), null],
        ['fixes', 'loop', 'Fixes', href.fixes(), null],
        ['tests', 'tests', 'Tests', href.tests(), null],
        ['training', 'target', 'Training', href.training(), null],
      ];
  return (
    <aside className={`side${sideOpen ? ' open' : ''}`} id="side" aria-label="Navigation" ref={aside}>
      <div className="side-top">
        <ProjectBlock meta={meta} />
        {exported ? null : (
          <button className="search sbtn" type="button" aria-label={`Search or jump to (${paletteKeyLabel()})`} aria-keyshortcuts="Meta+K Control+K" onClick={() => conn !== 'expired' && setPalette(true)}>
            <Icon name="search" />
            <span className="st">Search or jump to…</span>
            <span className="kbd">{paletteKeyLabel()}</span>
          </button>
        )}
      </div>
      <nav className="navlist" aria-label="Sections">
        {items.map(([key, icon, label, to, n]) => (
          <a key={key} href={to} aria-current={section === key ? 'page' : undefined}>
            <Icon name={icon} />
            {label}
            {n !== null ? <span className="count">{num(n)}</span> : null}
          </a>
        ))}
      </nav>
      <div className="side-k">
        Recent runs<a href={href.runs()}>all</a>
      </div>
      <RecentRuns runs={listed} current={route.page === 'run' ? route.id : null} loading={runs === null} rowActions={rowActions} />
      {exported ? null : (
        <div className="side-foot">
          <nav className="navlist" aria-label="Project settings">
            <a href={href.settings()} aria-current={section === 'settings' ? 'page' : undefined}>
              <Icon name="gear" />
              Settings
            </a>
          </nav>
        </div>
      )}
    </aside>
  );
}

/**
 * The branch lines of a run in the tree, as the design draws them: on through the row under each
 * ancestor with a later sibling (`tl`), bending into this run's icon (`te`), and down from its icon
 * to the runs under it (`tc`). Level k's line runs under the icon of the run at depth k - 1.
 */
function TreeLines({ depth, on, kids }: { depth: number; on: readonly boolean[]; kids: boolean }) {
  if (!depth && !kids) return null;
  const at = (k: number) => cssVars({ '--k': k });
  return (
    <span className="tree" aria-hidden="true">
      {on.map((more, k) => (more ? <i key={k} className="tl" style={at(k + 1)} /> : null))}
      {depth ? <i className="te" style={at(depth)} /> : null}
      {kids ? <i className="tc" style={at(depth + 1)} /> : null}
    </span>
  );
}

/**
 * The newest runs as a tree as deep as each family goes: a run's replays and forks a step in under
 * it, and theirs under them, so a fork of a fork sits under the fork it came from, as the Overview's
 * grid nests it. Two lines a run: its id and when, then its about line (decision 10), fitted to the
 * room it gets, followed only by what needs a look or how far a recording has got. Under a parent,
 * a run's about line is what it changed. A server that sends no about line gets the old line.
 */
export const RecentRuns = memo(function RecentRuns({ runs, current, loading, rowActions }: { runs: RunListItem[]; current: string | null; loading: boolean; rowActions?: (r: RunListItem) => RowScope | null }) {
  const tree = useMemo(() => treeLines(runTree(runs).slice(0, RECENT_RUNS)), [runs]);
  const now = Date.now();
  const box = useRef<HTMLDivElement>(null);
  useFitAbouts(box);
  // The arrows and j and k walk these with the focus on one; each stays its own Tab stop, Enter its link's.
  useListKeys({ rows: tree, keyOf: (x) => href.run(x.run.runId), root: box, actions: rowActions ? (x) => rowActions(x.run) : null, beside: true });
  if (loading) return <div className="runs" />;
  if (!runs.length)
    return (
      <div className="runs">
        <div className="empty">No runs yet.</div>
      </div>
    );
  return (
    <div className="runs" tabIndex={-1} ref={box}>
      {tree.map(({ run: r, depth, on, kids }) => {
        const here = current !== null && (r.runId === current || (current.length >= 10 && r.runId.startsWith(current)));
        const st = r.about ? sideStatus(r) : null;
        const line = r.about ? null : sideLine(r);
        return (
          <a key={r.runId} className="run" data-rowkey={href.run(r.runId)} style={cssVars({ '--d': depth })} href={href.run(r.runId)} aria-current={here ? 'true' : 'false'} title={r.source ? `from ${r.source}` : r.command}>
            <TreeLines depth={depth} on={on} kids={kids} />
            <RunIcon run={r} />
            <span className="r1">
              <span className="id">{shortId(r.runId)}</span>
              <span className="when">{whenShort(r.startedAt, now)}</span>
            </span>
            {line ? (
              <span className="r2">
                {line.err ? <em>{line.err}</em> : line.warn ? <em className="inc">{line.warn}</em> : null}
                {line.text}
              </span>
            ) : (
              <span className="r2">
                <AboutLine about={r.about} className="ra" />
                {st ? (
                  <span className="r2s" data-gives="">
                    <span className="dot">·</span>
                    {st.tone ? <em className={st.tone === 'warn' ? 'inc' : undefined}>{st.text}</em> : st.text}
                  </span>
                ) : null}
              </span>
            )}
          </a>
        );
      })}
    </div>
  );
});
