import { memo, useMemo, type CSSProperties } from 'react';
import type { RunListItem } from '../api.js';
import { RunIcon } from '../components/RunIcon.js';
import { Icon, type IconName } from '../components/Icon.js';
import { paletteKeyLabel } from '../dom.js';
import { num, shortId, whenShort } from '../format.js';
import { href, navSection, type Route } from '../route.js';
import { copyCompares, isAttempt, runTree, sideLine, treeLines } from '../runs.js';
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
    ? [['runs', 'runs', 'Runs', href.runs(), count], ...(copyCompares(meta?.runIds) ? [['compare', 'compare', 'Compare', href.compare(), null] as [string, IconName, string, string, number | null]] : [])]
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

/**
 * The branch lines of a run in the tree, as the design draws them: on through the row under each
 * ancestor with a later sibling (`tl`), bending into this run's icon (`te`), and down from its icon
 * to the runs under it (`tc`). Level k's line runs under the icon of the run at depth k - 1.
 */
function TreeLines({ depth, on, kids }: { depth: number; on: readonly boolean[]; kids: boolean }) {
  if (!depth && !kids) return null;
  const at = (k: number) => ({ '--k': k }) as CSSProperties;
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
 * grid nests it.
 */
export const RecentRuns = memo(function RecentRuns({ runs, current, loading }: { runs: RunListItem[]; current: string | null; loading: boolean }) {
  const tree = useMemo(() => treeLines(runTree(runs).slice(0, RECENT)), [runs]);
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
      {tree.map(({ run: r, depth, on, kids }) => {
        const line = sideLine(r);
        const here = current !== null && (r.runId === current || (current.length >= 10 && r.runId.startsWith(current)));
        return (
          <a key={r.runId} className="run" style={{ '--d': depth } as CSSProperties} href={href.run(r.runId)} aria-current={here ? 'true' : 'false'} title={r.source ? `from ${r.source}` : r.command}>
            <TreeLines depth={depth} on={on} kids={kids} />
            <RunIcon run={r} />
            <span className="r1">
              <span className="id">{shortId(r.runId)}</span>
              <span className="when">{whenShort(r.startedAt, now)}</span>
            </span>
            <span className="r2">
              {line.err ? <em>{line.err}</em> : line.warn ? <em className="inc">{line.warn}</em> : null}
              {line.text}
            </span>
          </a>
        );
      })}
    </div>
  );
});
