import { memo, useRef } from 'react';
import { aboutForms, orderForms } from '../about.js';
import { AboutLine, useFitAbouts } from '../components/About.js';
import { RunIcon } from '../components/RunIcon.js';
import { MiniStrip } from '../components/Strip.js';
import { rowOpen, SortTh } from '../components/Table.js';
import { num, shortId, whenShort } from '../format.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { kindWord, runOrigins, runSource, runSpent, runStatus, sideStatus, type RunSort } from '../runs.js';
import type { RunListItem } from '../types.js';
import { localTitle } from './bulk.js';
import { ByAvatar } from './people.js';

/**
 * The Runs table, one row a run: its id (decision 10: the id is its name), then what it was about in
 * a column of its own, fitted at whole words, with its labels as chips at the column's end; who made
 * it (with a team store, as their avatar, the name on hover, so every row keeps one line), its calls
 * by origin, calls, what it spent live, how it came out (a fork, what came of its writes by a neutral
 * dot, or the check it failed, wrapping onto the row's second line rather than widen its column) and
 * when.
 * What only adds to a row gives way, measured after layout rather than at fixed widths, while About
 * would get less than 200px, or a labelled row less than its shortest about line beside its labels:
 * first the strip of calls by origin, then the labels, then By. Only when About would get less even
 * then, or on a tablet or a phone, does the about line go under the id. A row opens its run unless a
 * control in it was used.
 */

/**
 * Which columns give way so About keeps its room (the mock's fitRunsTable): the classes on the table
 * say what is left out (`no-org`, `no-labs`, `no-by`), `stacked` puts the about line under the id,
 * and `tight` lets a status wrap after its dot where the table is still wider than its panel.
 */
export function fitRunsTable(scope: HTMLElement): void {
  // Only a page that lays itself out can be measured (a test's document without layout is left whole), as fitAbouts has it.
  if (typeof getComputedStyle !== 'function' || typeof document === 'undefined' || typeof document.createRange !== 'function') return;
  const t = scope.matches('table.runst') ? scope : scope.querySelector<HTMLElement>('table.runst');
  const th = t?.querySelector<HTMLElement>('th.abcol');
  if (!t || !th) return;
  const panel = t.closest<HTMLElement>('.tscroll');
  t.classList.remove('stacked', 'tight', 'no-org', 'no-labs', 'no-by');
  const wide = innerWidth > 1000;
  // The room the labels need: the widest row's labels, the gap, its shortest about line and the cell's padding.
  let need = 0;
  if (wide) {
    const pen = document.createElement('canvas').getContext('2d');
    for (const labs of t.querySelectorAll<HTMLElement>('.abcell .labs')) {
      const a = labs.parentElement?.querySelector<HTMLElement>('.rab');
      if (!a || !pen) continue;
      pen.font = getComputedStyle(a).font;
      const forms = orderForms(aboutForms({ text: a.dataset.about ?? '', from: (a.dataset.from ?? 'user') as 'user' }), (x) => pen.measureText(x).width).filter((f) => f.t);
      const min = forms.length ? Math.min(...forms.map((f) => f.w)) : 0;
      need = Math.max(need, labs.getBoundingClientRect().width + 12 + min + 25);
    }
  }
  const room = (cls?: string) => {
    if (cls) t.classList.add(cls);
    const w = th.getBoundingClientRect().width;
    return w >= 200 && (t.classList.contains('no-labs') || w >= need);
  };
  const by = !!t.querySelector('th.bycol');
  if (wide && (room() || room('no-org') || room('no-labs') || (by && room('no-by')))) return;
  t.classList.add('stacked', 'no-org', 'no-labs', 'no-by');
  if (panel && t.getBoundingClientRect().width > panel.clientWidth + 1) t.classList.add('tight');
}

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
  const table = useRef<HTMLTableElement>(null);
  useFitAbouts(table, fitRunsTable);
  return (
    <table className="t runst" ref={table} aria-label="Runs">
      <thead>
        <tr>
          {selectable ? (
            <th className="selcell">
              <input type="checkbox" aria-label="Select every run shown" checked={allOn} onChange={(e) => onPickAll(e.target.checked)} />
            </th>
          ) : null}
          <th>Run</th>
          <th className="abcol">About</th>
          {byColumn ? <th className="bycol">By</th> : null}
          <th className="orgcol">Calls by origin</th>
          <SortTh by="calls" sort={sort} onSort={onSort}>
            Calls
          </SortTh>
          <SortTh by="spent" sort={sort} onSort={onSort} className="num">
            Spent
          </SortTh>
          <th>Status</th>
          <SortTh by="when" sort={sort} onSort={onSort} className="num">
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
  const spent = runSpent(r);
  const origins = runOrigins(r);
  // What the run was about: the server's line, else (an older server) its command, its last resort.
  const about = r.about ?? { text: runSource(r), from: 'command' as const };
  // What needs a look, after the about line where it goes under the id (a phone, where Status is off-screen).
  const st = sideStatus(r);
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
          {/* The id's hover has the run's kind, parent and command. */}
          <a className="rlink" href={href.run(r.runId)} title={`${kindWord(r)}${r.parentRunId ? ` of ${shortId(r.parentRunId)}` : ''} · ${r.source ? `from ${r.source}` : r.command}`}>
            <code>{shortId(r.runId)}</code>
          </a>
          {byColumn && r.local ? (
            <span className="tag-local" title={localTitle(r.localAttempts)}>
              local
            </span>
          ) : null}
        </span>
        <span className="rsub rline">
          <AboutLine about={about} />
          {st ? (
            <span className="rso">
              <span className="dot">·</span>
              {st.tone ? <em className={st.tone === 'warn' ? 'inc' : undefined}>{st.text}</em> : st.text}
            </span>
          ) : null}
        </span>
      </td>
      <td className="abcell">
        <span className="abw">
          <AboutLine about={about} />
          {r.labels.length ? (
            <span className="labs">
              {r.labels.map((l) => (
                <span className="chip" key={l}>
                  {l}
                </span>
              ))}
            </span>
          ) : null}
        </span>
      </td>
      {byColumn ? (
        <td className="bycell">
          <ByAvatar author={r.author ?? null} ci={r.ci ?? null} you={you} />
        </td>
      ) : null}
      <td className="orgcell">{origins ? <MiniStrip origins={origins} /> : null}</td>
      <td className="num">{num(r.calls)}</td>
      <td className="num">
        {spent.text}
        {spent.captured ? <span className="nil"> as captured</span> : null}
      </td>
      <td className="stcell">
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
      <td className="num">{whenShort(r.startedAt, now)}</td>
    </tr>
  );
});
