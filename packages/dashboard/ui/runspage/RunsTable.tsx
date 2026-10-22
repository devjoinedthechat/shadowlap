import { memo } from 'react';
import { RunIcon } from '../components/RunIcon.js';
import { MiniStrip } from '../components/Strip.js';
import { rowOpen, SortTh } from '../components/Table.js';
import { num, shortId, whenShort } from '../format.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { runOrigins, runSpent, runStatus, runSublineParts, type RunSort } from '../runs.js';
import type { RunListItem } from '../types.js';
import { localTitle } from './bulk.js';
import { Person } from './people.js';

/**
 * The Runs table: a run's id under its icon and what it is, who made it (with a team store), its
 * labels, its calls by origin, calls, what it spent live, how it came out (a fork, what came of its
 * writes by a neutral dot, or the check it failed) and when. It fits from 1024px up without scrolling
 * sideways: long commands are cut with an ellipsis, Labels hides below 1380px, By and Calls by origin
 * below 1140px, and a fork's status wraps onto the row's second line rather than widen its column.
 * A row opens its run unless a control in it was used.
 */

export type TableRun = RunListItem & { local?: boolean; localAttempts?: { run: boolean; attempts: number }; ci?: string | null };

/** A status kept whole between its dots, so it wraps after a dot only: `forked ·` / `2 writes blocked`. */
const afterDots = (text: string) =>
  text
    .split(' · ')
    .map((p) => p.replace(/ /g, '\u00a0'))
    .join('\u00a0· ');

export function RunsTable({
  rows,
  picked,
  selectable,
  byColumn,
  you = null,
  sort,
  onSort,
  onPick,
  onPickAll,
  now,
}: {
  rows: readonly TableRun[];
  /** The runs picked, by id. */
  picked: { has(runId: string): boolean };
  selectable: boolean;
  /** A team store is set: who made each run, and the local tag. */
  byColumn: boolean;
  /** Who this machine records as: "you" in the By column. */
  you?: string | null;
  sort: RunSort;
  onSort: (s: RunSort) => void;
  onPick: (run: TableRun, on: boolean) => void;
  onPickAll: (on: boolean) => void;
  now: number;
}) {
  const allOn = rows.length > 0 && rows.every((r) => picked.has(r.runId));
  return (
    <table className="t runst">
      <thead>
        <tr>
          {selectable ? (
            <th className="selcell">
              <input type="checkbox" aria-label="Select every run shown" checked={allOn} onChange={(e) => onPickAll(e.target.checked)} />
            </th>
          ) : null}
          <th>Run</th>
          {byColumn ? <th className="hide-md">By</th> : null}
          <th className="hide-lg">Labels</th>
          <th className="hide-md">Calls by origin</th>
          <SortTh by="calls" sort={sort} onSort={onSort}>
            Calls
          </SortTh>
          <SortTh by="spent" sort={sort} onSort={onSort} className="num hide-sm">
            Spent
          </SortTh>
          <th>Status</th>
          <SortTh by="when" sort={sort} onSort={onSort} className="num hide-sm">
            When
          </SortTh>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <Row key={r.runId} run={r} on={picked.has(r.runId)} selectable={selectable} byColumn={byColumn} you={!!you && r.author === you} onPick={onPick} now={now} />
        ))}
      </tbody>
    </table>
  );
}

const Row = memo(function Row({ run: r, on, selectable, byColumn, you, onPick, now }: { run: TableRun; on: boolean; selectable: boolean; byColumn: boolean; you: boolean; onPick: (run: TableRun, on: boolean) => void; now: number }) {
  const out = runStatus(r);
  const sub = runSublineParts(r);
  const spent = runSpent(r);
  const origins = runOrigins(r);
  return (
    <tr className={on ? 'picked' : undefined} onClick={rowOpen(() => navigate(href.run(r.runId)))}>
      {selectable ? (
        <td className="selcell">
          <input type="checkbox" aria-label={`Select ${shortId(r.runId)}`} checked={on} onChange={(e) => onPick(r, e.target.checked)} />
        </td>
      ) : null}
      <td className="runcell">
        <span className="rid">
          <RunIcon run={r} />
          <a className="rlink" href={href.run(r.runId)}>
            <code>{shortId(r.runId)}</code>
          </a>
          {byColumn && r.local ? (
            <span className="tag-local" title={localTitle(r.localAttempts)}>
              local
            </span>
          ) : null}
        </span>
        <span className="rsub" title={r.source ? `from ${r.source}` : r.command}>
          {sub.what} · <code>{sub.source}</code>
        </span>
      </td>
      {byColumn ? (
        <td className="hide-md bycell">
          <Person author={r.author ?? null} ci={r.ci ?? null} you={you} />
        </td>
      ) : null}
      <td className="hide-lg labcell">
        {r.labels.map((l) => (
          <span className="chip" key={l}>
            {l}
          </span>
        ))}
      </td>
      <td className="hide-md">{origins ? <MiniStrip origins={origins} /> : null}</td>
      <td className="num">{num(r.calls)}</td>
      <td className="num hide-sm">
        {spent.text}
        {spent.captured ? <span className="nil"> as captured</span> : null}
      </td>
      <td>
        {out.check ? (
          // The check it failed, under the words, as wide as the column already is: whole on hover.
          <span className="st err named">
            <i />
            <span className="stw">
              {out.text}
              <span className="sr">: </span>
              <span className="stc" title={`check failed: “${out.check}”`}>
                “{out.check}”
              </span>
            </span>
          </span>
        ) : (
          <span className={`st ${out.tone}`} aria-label={out.tone === 'n' ? 'nothing to report' : undefined}>
            {out.tone === 'n' ? null : <i />}
            {afterDots(out.text)}
          </span>
        )}
      </td>
      <td className="num hide-sm">{whenShort(r.startedAt, now)}</td>
    </tr>
  );
});
