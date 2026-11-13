import { memo, useRef } from 'react';
import { aboutForms, orderForms } from '../about.js';
import { AboutLine, useFitAbouts } from '../components/About.js';
import { Id } from '../components/Id.js';
import { RunIcon } from '../components/RunIcon.js';
import { Status } from '../components/Status.js';
import { glossed } from '../components/Term.js';
import { MiniStrip } from '../components/MiniStrip.js';
import { rowOpen, SortTh } from '../components/Table.js';
import { num, shortId, whenShort } from '../format.js';
import { labelTerm } from '../../src/links.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { useWindow } from '../run/window-hook.js';
import { kindWord, outcomeOf, runOrigins, runSource, runSpent, sideStatus, TODAY, type OutcomeOf, type RunLike, type RunOutcomeWords, type RunSort } from '../runs.js';
import { tipCard } from '../components/HoverCard.js';
import { outcomeTip } from '../outcome-tip.js';
import type { ChipCounts, RunListItem } from '../types.js';
import { EmptyLine, ErrorState, failedRead, Skeleton } from '../components/States.js';
import { localTitle } from './bulk.js';
import { ByAvatar } from './people.js';
import { RunKey } from '../components/RunKey.js';
import { markKey, MARKS, type RunMark } from '../runkey.js';
import { useListKeys, type RowScope } from '../list-keys.js';
import { singleKeysOn } from '../single-keys.js';

/**
 * The Runs table, one row a run: its id (decision 10: the id is its name), then what it was about in
 * a column of its own, fitted at whole words, with its labels as chips at the column's end; who made
 * it (with a team store, as their avatar, the name on hover, so every row keeps one line), its calls
 * by origin, calls, what it spent live, how it came out, in one line (a fork, what came of its writes
 * by a neutral dot, its terms defined; the check a run failed, on hover) and when.
 * What only adds to a row gives way, measured after layout rather than at fixed widths, while About
 * would get less than 200px, or a labelled row less than its shortest about line beside its labels:
 * first the strip of calls by origin, then the labels, then By. Only when About would get less even
 * then, or on a tablet or a phone, does the about line go under the id. On a phone a row is the run
 * and when it started: its calls, what it spent and its Status give way, and what needs a look
 * follows the about line instead. A row opens its run unless a control in it was used. Past
 * `WHOLE_UP_TO` rows, only those in view and a screenful either side are drawn (window-hook.ts).
 */

/**
 * Which columns give way so About keeps its room (the mock's fitRunsTable): the classes on the table
 * say what is left out (`no-org`, `no-labs`, `no-by`), `stacked` puts the about line under the id,
 * and `tight` lets a status wrap after its dot where the table is still wider than its panel.
 */
export function fitRunsTable(scope: HTMLElement): void {
  // Only a page in a window can be measured: a test's document with none is left as it is.
  if (typeof innerWidth !== 'number') return;
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

/** A row is a run, its about line under its id or beside it: one shape, measured once drawn. The page scrolls them; the table only sideways. */
const RUN_ROWS = { keyOf: (r: TableRun) => r.runId, shapeOf: () => 'run', estimate: () => 52, box: (list: HTMLElement) => list.closest<HTMLElement>('.page') };
/**
 * Up to this many rows the table draws them all: its columns are as wide as the rows drawn need, and
 * fitRunsTable fits it to their labels, so a window would move them as it scrolls. Past it, the window.
 */
export const WHOLE_UP_TO = 200;
const NO_ROWS: readonly TableRun[] = [];

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
  onMark = null,
  markOff = null,
  rowActions = null,
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
  /**
   * The good/bad key on each row (runkey.ts), heard on + and - from a row with the focus too; null for
   * a table that changes nothing (an exported copy). Good and bad are then the key's, never chips.
   */
  onMark?: ((run: TableRun, m: RunMark, from?: HTMLElement) => void) | null;
  /** Why the key can't change anything here (a read-only dashboard): its buttons are off, with this on hover. */
  markOff?: string | null;
  /** What ⌘K offers on a row with the focus in it. */
  rowActions?: ((run: TableRun) => RowScope | null) | null;
}) {
  const allOn = rows.length > 0 && rows.every((r) => picked.has(r.runId));
  const table = useRef<HTMLTableElement>(null);
  useFitAbouts(table, fitRunsTable);
  const whole = rows.length <= WHOLE_UP_TO;
  const win = useWindow(whole ? NO_ROWS : rows, RUN_ROWS);
  const [start, end] = whole ? [0, rows.length] : [win.start, win.end];
  const cols = 7 + (selectable ? 1 : 0) + (byColumn ? 1 : 0) + (onMark ? 1 : 0);
  // j and k walk the rows, windowed or not; x picks one where rows have a checkbox.
  const inFocus = useListKeys({
    rows,
    keyOf: rowKey,
    root: table,
    open: (r) => navigate(href.run(r.runId)),
    pick: selectable ? (r) => onPick(r, !picked.has(r.runId)) : null,
    actions: rowActions ?? null,
    show: whole ? null : win.show,
  });
  return (
    <table className="t runst" ref={table} aria-label="Runs" aria-rowcount={rows.length + 1}>
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
          <th className="orgcol hide-sm">Calls by origin</th>
          <SortTh by="calls" sort={sort} onSort={onSort} className="num hide-sm">
            Calls
          </SortTh>
          <SortTh by="spent" sort={sort} onSort={onSort} className="num hide-sm">
            Spent
          </SortTh>
          <th className="hide-sm">Status</th>
          <SortTh by="when" sort={sort} onSort={onSort} className="num">
            When
          </SortTh>
          {onMark ? (
            // Said, not only read out: the marks under it label a run good or bad, and each word lists the runs that are.
            <th className="keycell hide-sm">
              <span className="kh">
                <a href={href.runs({ q: 'label:good' })} title="List the runs labelled good">
                  good
                </a>
                <span aria-hidden="true">·</span>
                <a href={href.runs({ q: 'label:bad' })} title="List the runs labelled bad">
                  bad
                </a>
              </span>
            </th>
          ) : null}
        </tr>
      </thead>
      <tbody ref={win.listRef}>
        {!whole && win.before ? <Spacer height={win.before} cols={cols} /> : null}
        {rows.slice(start, end).map((r, j) => (
          <Row key={r.runId} at={start + j} run={r} on={picked.has(r.runId)} focused={inFocus === rowKey(r)} selectable={selectable} byColumn={byColumn} you={!!you && r.author === you} onPick={onPick} now={now} onMark={onMark} markOff={markOff} />
        ))}
        {!whole && win.after ? <Spacer height={win.after} cols={cols} /> : null}
      </tbody>
    </table>
  );
}

/** A row's Status on hover: what judged it and each check, as the run's first fact has it (outcome-tip.ts). */
function statusTip(r: RunLike, out: RunOutcomeWords & { of: OutcomeOf }): string {
  const tip = outcomeTip(r, out);
  return tipCard(tip.title, tip.rows.map(([label, value, color]) => ({ label, value, color })), tip.sub);
}

/**
 * A row's Status, in one line (outcomeOf): a dot and its words, what judged it on hover, the card the
 * run's first fact has, and judged by checks its family's goldens added after it was recorded, said
 * to a screen reader too. A run no check judges says a dash, no dot, named for a screen reader; an
 * interrupted one says so, no dot either. A fork no check judges has no card, so its first term
 * (blocked, stubbed, fenced) is the one the glossary defines.
 */
export function RowStatus({ r }: { r: RunLike }) {
  const out = outcomeOf(r);
  if (out.tone === 'n') {
    return (
      <span className="st n" aria-label={out.text === '—' ? 'no checks' : undefined} data-tip={statusTip(r, out)}>
        {afterDots(out.text)}
      </span>
    );
  }
  return (
    <Status tone={out.tone} tip={out.of === 'fork' ? undefined : statusTip(r, out)}>
      {glossed(afterDots(out.text))}
      {out.today ? <span className="sr"> {TODAY}</span> : null}
    </Status>
  );
}

/**
 * What the table says in place of its rows: why they could not be read, with Retry; that they are
 * being read, as rows of quiet bars (`RunsLoading`); or why none show, as a line from the left
 * (`No runs match.`, `No runs on the days picked.`). A project with no runs draws its own page
 * (pages/Runs.tsx `NoRuns`), so `No runs yet.` shows only for the moment the shell's run list and the
 * table disagree.
 */
export function RunsTableEmpty({ error, loaded, shown, counts, days, retry }: { error: Error | null; loaded: boolean; shown: number; counts: ChipCounts | null; days: unknown; retry?: (() => void) | undefined }) {
  if (error && !shown) return <ErrorState retry={retry}>{failedRead(error)}</ErrorState>;
  if (!loaded) return <RunsLoading />;
  if (shown) return null;
  if (counts?.all) return <EmptyLine>No runs match.</EmptyLine>;
  if (days) return <EmptyLine>No runs on the days picked.</EmptyLine>;
  return <EmptyLine>No runs yet.</EmptyLine>;
}

/** What the runs' rows are drawn as while they load: what a run was about, as long as an about line runs. */
const SKEL_RUNS = ['A refund for an order that never came', 'A change of address, then a new card', 'Why the invoice was charged twice', 'Cancel the plan at the end of the month', 'A refund for an order that never came', 'Book the earlier flight and keep the seat', 'Which orders shipped late last week', 'A change of address, then a new card'];

/**
 * The runs while they load: rows in the table's columns as quiet bars, under its head. They are no
 * table rows, which the tests read as the runs drawn (`table.runst tbody tr`).
 */
export function RunsLoading() {
  return (
    <Skeleton what="the runs">
      {SKEL_RUNS.map((about, i) => (
        <div className="rskrun" key={i}>
          <code>run_8f3a2c</code>
          <span>{about}</span>
          <span>model 4 · tool 9</span>
          <span>failed</span>
        </div>
      ))}
    </Skeleton>
  );
}

/** The height of the rows not drawn, above or below those that are. */
function Spacer({ height, cols }: { height: number; cols: number }) {
  return (
    <tr className="wspace" aria-hidden="true" style={{ height }}>
      <td colSpan={cols} />
    </tr>
  );
}

/** What knows a row to the list keys: where it leads. */
const rowKey = (r: { runId: string }) => href.run(r.runId);

/** A key a row hears from a control in it: not one typed into a field (a checkbox is no field). */
const typedIn = (t: EventTarget | null) => {
  const el = t as { tagName?: string; type?: string; isContentEditable?: boolean; getAttribute?: (name: string) => string | null } | null;
  if (!el) return false;
  const type = el.type ?? el.getAttribute?.('type') ?? null;
  return (el.tagName === 'INPUT' && type !== 'checkbox') || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || !!el.isContentEditable;
};

const Row = memo(function Row({ at, run: r, on, focused, selectable, byColumn, you, onPick, now, onMark = null, markOff = null }: { at: number; run: TableRun; on: boolean; focused: boolean; selectable: boolean; byColumn: boolean; you: boolean; onPick: (run: TableRun, on: boolean) => void; now: number; onMark?: ((run: TableRun, m: RunMark, from?: HTMLElement) => void) | null; markOff?: string | null }) {
  const spent = runSpent(r);
  const origins = runOrigins(r);
  // What the run was about: the server's line, else (an older server) its command, its last resort.
  const about = r.about ?? { text: runSource(r), from: 'command' as const };
  // What needs a look, after the about line where it goes under the id (a phone, where Status gives way).
  const st = sideStatus(r);
  // Good and bad are the key's where it shows: no chip says them again.
  const chips = onMark ? r.labels.filter((l) => !(MARKS as readonly string[]).includes(l)) : r.labels;
  return (
    <tr
      className={[on ? 'picked' : '', focused ? 'krow' : ''].join(' ').trim() || undefined}
      data-rowkey={rowKey(r)}
      data-wi={at}
      aria-rowindex={at + 2}
      {...rowOpen(() => navigate(href.run(r.runId)))}
      onKeyDown={
        onMark
          ? (e) => {
              const m = markKey(e.key);
              if (!m || markOff || typedIn(e.target) || e.metaKey || e.ctrlKey || e.altKey || !singleKeysOn()) return;
              e.preventDefault();
              e.stopPropagation();
              onMark(r, m, e.currentTarget);
            }
          : undefined
      }
    >
      {selectable ? (
        <td className="selcell">
          {/* The whole cell picks the row (a 44px target on a touch screen), and never opens the run. */}
          <label className="selhit">
            <input type="checkbox" aria-label={`Select ${shortId(r.runId)}`} checked={on} onChange={(e) => onPick(r, e.target.checked)} />
          </label>
        </td>
      ) : null}
      <td className="runcell">
        <span className="rid">
          <RunIcon run={r} />
          {/* The id's hover has the run's kind, parent and command. */}
          <a className="rowa" href={href.run(r.runId)} title={`${kindWord(r)}${r.parentRunId ? ` of ${shortId(r.parentRunId)}` : ''} · ${r.source ? `from ${r.source}` : r.command}`}>
            <Id id={shortId(r.runId)} list />
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
            <span className="rso" data-gives="">
              <span className="dot">·</span>
              {st.tone ? <em className={st.tone === 'warn' ? 'inc' : undefined}>{glossed(st.text)}</em> : glossed(st.text)}
            </span>
          ) : null}
        </span>
      </td>
      <td className="abcell">
        <span className="abw">
          <AboutLine about={about} />
          {chips.length ? (
            <span className="labs">
              {chips.map((l) => (
                <a className="chip" key={l} href={href.runs({ q: labelTerm(l) })} title={`List the runs labelled ${l}`}>
                  {l}
                </a>
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
      <td className="orgcell hide-sm">{origins ? <MiniStrip origins={origins} /> : null}</td>
      <td className="num hide-sm">{num(r.calls)}</td>
      <td className="num hide-sm">
        {spent.text}
        {spent.captured ? <span className="nil"> as captured</span> : null}
      </td>
      <td className="stcell hide-sm">
        <RowStatus r={r} />
      </td>
      <td className="num">{whenShort(r.startedAt, now)}</td>
      {onMark ? (
        <td className="keycell hide-sm">
          <RunKey runId={r.runId} labels={r.labels} onMark={(m, from) => onMark(r, m, from)} off={markOff} compact />
        </td>
      ) : null}
    </tr>
  );
});
