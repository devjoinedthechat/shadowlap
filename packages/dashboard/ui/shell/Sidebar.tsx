import { memo, useMemo } from 'react';
import type { RunListItem } from '../api.js';
import { RunIcon } from '../components/RunIcon.js';
import { Icon, type IconName } from '../components/Icon.js';
import { paletteKeyLabel } from '../dom.js';
import { num, shortId, whenShort } from '../format.js';
import { href, navSection, type Route } from '../route.js';
import { isAttempt, runTree, sideLine } from '../runs.js';
import { useApp } from '../state.js';
import { ProjectBlock } from './ProjectBlock.js';

/** How many of the newest runs (with their families) the sidebar lists; Runs has the rest. */
const RECENT = 60;

export function Sidebar({ route }: { route: Route }) {
  const { meta, runs, exported, sideOpen, setPalette, conn } = useApp();
  const listed = useMemo(() => (runs ?? []).filter((r) => !isAttempt(r)), [runs]);
  const section = navSection(route);
  const count = meta?.counts?.runs ?? listed.length;
  const items: Array<[string, IconName, string, string, number | null]> = exported
    ? [
        ['runs', 'runs', 'Runs', href.runs(), count],
        ['compare', 'compare', 'Compare', href.compare(), null],
      ]
    : [
        ['overview', 'home', 'Overview', href.overview(), null],
        ['runs', 'runs', 'Runs', href.runs(), count],
        ['compare', 'compare', 'Compare', href.compare(), null],
        ['fixes', 'loop', 'Fixes', href.fixes(), null],
        ['tests', 'tests', 'Tests', href.tests(), null],
        ['training', 'target', 'Training', href.training(), null],
      ];
  return (
    <aside className={`side${sideOpen ? ' open' : ''}`} id="side" aria-label="Navigation">
      <div className="side-top">
        <ProjectBlock meta={meta} />
        {exported ? null : (
          <button className="search sbtn" type="button" aria-label={`Search or jump to (${paletteKeyLabel()})`} onClick={() => conn !== 'expired' && setPalette(true)}>
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
      <RecentRuns runs={listed} current={route.page === 'run' ? route.id : null} loading={runs === null} />
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

const RecentRuns = memo(function RecentRuns({ runs, current, loading }: { runs: RunListItem[]; current: string | null; loading: boolean }) {
  const tree = useMemo(() => runTree(runs).slice(0, RECENT), [runs]);
  const now = Date.now();
  if (loading) return <div className="runs" />;
  if (!runs.length)
    return (
      <div className="runs">
        <div className="empty">No runs yet.</div>
      </div>
    );
  return (
    <div className="runs" tabIndex={-1}>
      {tree.map(({ run: r, depth }) => {
        const line = sideLine(r);
        const here = current !== null && (r.runId === current || (current.length >= 10 && r.runId.startsWith(current)));
        return (
          <a key={r.runId} className={`run${depth > 0 ? ' child' : ''}`} href={href.run(r.runId)} aria-current={here ? 'true' : 'false'} title={r.source ? `from ${r.source}` : r.command}>
            <RunIcon run={r} />
            <span className="r1">
              <span className="id">{shortId(r.runId)}</span>
              <span className="when">{whenShort(r.startedAt, now)}</span>
            </span>
            <span className="r2">
              {line.err ? <em>{line.err}</em> : null}
              {line.text}
            </span>
          </a>
        );
      })}
    </div>
  );
});
