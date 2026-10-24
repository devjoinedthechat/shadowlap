import { memo, useEffect, useRef, type CSSProperties } from 'react';
import type { CallRow } from '../api.js';
import { Org } from '../components/bits.js';
import { Icon } from '../components/Icon.js';
import { callName, kindShort } from '../format.js';
import type { CallIndex } from '../recorded.js';
import type { Origin7 } from '../origins.js';
import { callDetail, originOf, resultLine, timeOf, tokensText } from './model.js';
import { foldLabel, itemWords, type CallTree } from './groups.js';
import { isPending, type ListedCall, type PendingCall } from './paging.js';
import { useWindow } from './window-hook.js';

/**
 * Calls: #, call, origin, tokens, time. A tool's result sits on a second line under it. A replayed
 * call's time is its recorded duration, in grey: the replay did not wait for it. Each row has a fork
 * button, shown on hover and on the selected row. Only the rows in view and a screenful either side
 * are drawn (window-hook.ts), so a run of 50,000 calls opens and moves as one of fifty does. A call
 * whose page isn't read yet (paging.ts) is a row with its number and origin, and coming into view
 * asks for its page (`onNeed`).
 *
 * Grouped (`tree`, groups.ts), each call sits under the call it belongs to, indented, and a call with
 * calls under it has a fold mark that hides them and shows them again; a folded one says how many it
 * holds, and a batch's item names its conversation. The list is the same rows either way.
 */

export type OriginFilter = 'all' | 'live' | 'rep' | 'over' | 'inject' | 'fail' | 'block';

/** Whether an origin passes the origin filter: Fenced holds the blocked and the stubbed. */
function originMatches(o: Origin7 | null, f: OriginFilter): boolean {
  if (f === 'all') return true;
  return f === 'block' ? o === 'block' || o === 'stub' : o === f;
}

/** A call not read yet passes on its origin alone, and no text filter: its words aren't there to match. */
export function pendingMatches(c: PendingCall, f: OriginFilter, text: string): boolean {
  return !text && originMatches(c.origin, f);
}

export function matchesFilter(c: CallRow, f: OriginFilter, text: string, asked?: string | null): boolean {
  if (!originMatches(originOf(c), f)) return false;
  if (!text) return true;
  const d = callDetail(c, asked).text;
  const res = resultLine(c)?.text ?? '';
  return `${callName(c.kind, c.name)} ${c.name} ${d} ${res} ${c.model ?? ''} #${c.callNo}`.toLowerCase().includes(text.toLowerCase());
}

/**
 * The origin filters: All, Live and Replayed, then Overridden, Injected and Failed when the run has
 * any, and Fenced, which holds the writes blocked and stubbed after a fork, as the design names it.
 */
export function originFilters(counts: Pick<Record<OriginFilter, number>, 'over' | 'inject' | 'fail'>): Array<[OriginFilter, string]> {
  return [
    ['all', 'All'],
    ['live', 'Live'],
    ['rep', 'Replayed'],
    ...(counts.over ? ([['over', 'Overridden']] as Array<[OriginFilter, string]>) : []),
    ...(counts.inject ? ([['inject', 'Injected']] as Array<[OriginFilter, string]>) : []),
    ...(counts.fail ? ([['fail', 'Failed']] as Array<[OriginFilter, string]>) : []),
    ['block', 'Fenced'],
  ];
}

export function CallsToolbar({
  counts,
  filter,
  onFilter,
  text,
  onText,
  inputRef,
  fold = null,
}: {
  counts: Record<OriginFilter, number>;
  filter: OriginFilter;
  onFilter: (f: OriginFilter) => void;
  text: string;
  onText: (t: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** With the calls grouped: whether any group is folded (Unfold all), and how to fold them all or open them all. */
  fold?: { all: boolean; onAll: (fold: boolean) => void } | null;
}) {
  const items = originFilters(counts);
  return (
    <div className="toolbar">
      <div className="ofilter" role="group" aria-label="Filter by origin">
        {items.map(([f, label]) => (
          <button key={f} type="button" aria-pressed={filter === f} onClick={() => onFilter(f)}>
            {label}
            <b>{counts[f].toLocaleString('en-US')}</b>
          </button>
        ))}
      </div>
      <label className="filter-in">
        <span className="sr">Filter calls</span>
        <input
          ref={inputRef}
          type="search"
          placeholder="Filter calls"
          value={text}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && (e.currentTarget.value || document.activeElement === e.currentTarget)) {
              e.stopPropagation();
              if (e.currentTarget.value) onText('');
              else e.currentTarget.blur();
            }
          }}
        />
        <span className="kbd">/</span>
      </label>
      {fold ? (
        <button className="linkbtn foldall" type="button" onClick={() => fold.onAll(!fold.all)} title={fold.all ? 'Show every call under the call it belongs to' : 'Fold every model call over the calls under it, and every batch item over its calls'}>
          {fold.all ? 'Unfold all' : 'Fold all'}
        </button>
      ) : null}
    </div>
  );
}

/** A call's row is one line, or two with a result under it: the window places rows by these shapes. A call not read yet is one line until it is. */
const callShape = (c: ListedCall) => (!isPending(c) && resultLine(c) ? 'two' : 'one');
const CALL_ROWS = { keyOf: (c: ListedCall) => c.callNo, shapeOf: callShape, estimate: (shape: string) => (shape === 'two' ? 50 : 33) };

export function CallsTable({
  calls,
  asked,
  selected,
  scoped,
  forkAt,
  lostAt,
  ancestors,
  live,
  canFork,
  onSelect,
  onFork,
  onNeed,
  tree = null,
  folded = NONE,
  onFold = null,
}: {
  calls: readonly ListedCall[];
  asked: ReadonlyMap<number, string> | null;
  selected: number | null;
  scoped: boolean;
  forkAt: number | null;
  lostAt: number | null;
  ancestors: readonly CallIndex[];
  live: boolean;
  canFork: boolean;
  onSelect: (n: number) => void;
  onFork: (n: number, el: HTMLElement) => void;
  onNeed?: ((n: number) => void) | null;
  /** The grouping of the calls listed (before any are folded away), or null to list them flat, as a filter does. */
  tree?: CallTree | null;
  /** The heads folded. */
  folded?: ReadonlySet<number>;
  onFold?: ((callNo: number) => void) | null;
}) {
  const head = useRef<HTMLTableSectionElement>(null);
  const placed = useRef(false);
  const win = useWindow(calls, CALL_ROWS);
  const { show } = win;
  const latest = useRef(calls);
  latest.current = calls;
  // A call not read yet in view: its page is asked for.
  useEffect(() => {
    if (!onNeed) return;
    for (let i = win.start; i < win.end; i++) {
      const c = calls[i];
      if (c && isPending(c)) return onNeed(c.callNo);
    }
  }, [calls, win.start, win.end, onNeed]);
  // Keep the selected row in view, scrolling the views pane only: centred when the run opens, by as
  // little as it takes after that.
  useEffect(() => {
    const i = selected === null ? -1 : latest.current.findIndex((c) => c.callNo === selected);
    if (i < 0) return;
    show(i, { centre: !placed.current, head: head.current?.offsetHeight ?? 34 });
    placed.current = true;
  }, [selected, show]);
  if (!calls.length) return <div className="empty">No calls match.</div>;
  const cols = scoped ? 7 : 6;
  const grouped = !!tree?.grouped;
  /** A row's place in the grouping: its depth, the calls under it, folded or not, and the batch item it heads. */
  const groupOf = (callNo: number): Group | null => {
    if (!tree || !grouped) return null;
    const i = tree.index.get(callNo);
    if (i === undefined) return null;
    const it = tree.items.get(callNo);
    return { depth: tree.depth[i]!, kids: tree.kids[i]!, folded: folded.has(callNo), item: it ? itemWords(it) : null };
  };
  return (
    <table className={grouped ? 'calls grouped' : 'calls'} aria-rowcount={calls.length + 1}>
      <thead ref={head}>
        <tr aria-rowindex={1}>
          <th className="n">#</th>
          <th>Call</th>
          {scoped ? <th className="hide-sm">Scope</th> : null}
          <th>Origin</th>
          <th className="num tok">Tokens</th>
          <th className="num">Time</th>
          <th className="rowact">
            <span className="sr">Fork</span>
          </th>
        </tr>
      </thead>
      <tbody ref={win.listRef}>
        {win.before ? <Spacer height={win.before} cols={cols} /> : null}
        {calls.slice(win.start, win.end).map((c, j) =>
          isPending(c) ? (
            <PendingRow key={c.callNo} at={win.start + j} c={c} selected={c.callNo === selected} scoped={scoped} mark={c.callNo === forkAt ? 'fork' : c.callNo === lostAt ? 'lost' : null} onSelect={onSelect} grouped={grouped} />
          ) : (
            <Row key={c.callNo} at={win.start + j} c={c} asked={c.kind === 'api' && asked ? (asked.get(c.callNo) ?? null) : undefined} selected={c.callNo === selected} scoped={scoped} mark={c.callNo === forkAt ? 'fork' : c.callNo === lostAt ? 'lost' : null} ancestors={ancestors} live={live} canFork={canFork} onSelect={onSelect} onFork={onFork} group={groupOf(c.callNo)} onFold={onFold} />
          ),
        )}
        {win.after ? <Spacer height={win.after} cols={cols} /> : null}
      </tbody>
    </table>
  );
}

const NONE: ReadonlySet<number> = new Set();

/** Where a row sits in the grouping, as it draws it. */
interface Group {
  depth: number;
  kids: number;
  folded: boolean;
  /** For a batch's item, `conversation 3 of 40`. */
  item: string | null;
}

/** A row's lead in a grouped list: its depth, then its fold mark when calls sit under it, or the room of one. */
function Lead({ callNo, group, onFold }: { callNo: number; group: Group; onFold: ((callNo: number) => void) | null }) {
  return (
    <span className="lead" style={{ width: `${group.depth * 14 + 18}px` }}>
      {group.kids > 0 && onFold ? (
        <button
          type="button"
          className="tw"
          aria-expanded={!group.folded}
          aria-label={foldLabel(callNo, group.kids, group.folded)}
          title={foldLabel(callNo, group.kids, group.folded)}
          onClick={(e) => {
            e.stopPropagation();
            onFold(callNo);
          }}
        >
          <Icon name="caret" />
        </button>
      ) : null}
    </span>
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

/** A call whose page isn't read yet: its number, its mark and its origin, and a word that it is on its way. */
const PendingRow = memo(function PendingRow({ at, c, selected, scoped, mark, onSelect, grouped = false }: { at: number; c: PendingCall; selected: boolean; scoped: boolean; mark: 'fork' | 'lost' | null; onSelect: (n: number) => void; grouped?: boolean }) {
  return (
    <tr data-wi={at} aria-rowindex={at + 2} aria-selected={selected} aria-busy="true" onClick={() => onSelect(c.callNo)}>
      <td className="n">
        {mark ? <span className={`fk${mark === 'lost' ? ' bl' : ''}`}>{mark === 'fork' ? 'FORK' : 'LOST'}</span> : null}
        {c.callNo}
      </td>
      <td className="name">
        {grouped ? <span className="lead" style={{ width: '18px' }} /> : null}
        <span className="det">Reading…</span>
      </td>
      {scoped ? <td className="hide-sm scopecell" /> : null}
      <td>{c.origin ? <Org origin={c.origin} /> : null}</td>
      <td className="num tok" />
      <td className="num" />
      <td className="rowact" />
    </tr>
  );
});

const Row = memo(function Row({
  at,
  c,
  asked,
  selected,
  scoped,
  mark,
  ancestors,
  live,
  canFork,
  onSelect,
  onFork,
  group = null,
  onFold = null,
}: {
  at: number;
  c: CallRow;
  asked: string | null | undefined;
  selected: boolean;
  scoped: boolean;
  mark: 'fork' | 'lost' | null;
  ancestors: readonly CallIndex[];
  live: boolean;
  canFork: boolean;
  onSelect: (n: number) => void;
  onFork: (n: number, el: HTMLElement) => void;
  group?: Group | null;
  onFold?: ((callNo: number) => void) | null;
}) {
  const d = callDetail(c, asked);
  const res = resultLine(c);
  const t = timeOf(c, ancestors, live);
  return (
    <tr data-wi={at} aria-rowindex={at + 2} aria-selected={selected} onClick={() => onSelect(c.callNo)}>
      <td className="n">
        {mark ? <span className={`fk${mark === 'lost' ? ' bl' : ''}`}>{mark === 'fork' ? 'FORK' : 'LOST'}</span> : null}
        {c.callNo}
      </td>
      <td className="name" title={c.name} style={group ? ({ '--lead': `${group.depth * 14 + 18}px` } as CSSProperties) : undefined}>
        {group ? <Lead callNo={c.callNo} group={group} onFold={onFold} /> : null}
        <small>{kindShort(c.kind)}</small>
        {callName(c.kind, c.name)}
        {c.input ? <span className="eff input">input</span> : c.effect ? <span className={`eff ${c.effect}`}>{c.effect}</span> : null}
        {c.extraRead ? (
          <span className="eff extra" title="An extra read: answered live, as its recording held no counterpart, while the replay went on replaying">
            extra
          </span>
        ) : null}
        {c.attempts ? <span className="det" title={`${c.attempts} ${c.attempts === 1 ? 'retry' : 'retries'} before the final outcome`}>+{c.attempts}</span> : null}
        {group?.item ? <span className="gitem">{group.item}</span> : null}
        {group?.folded && group.kids ? <span className="gfold">{group.kids === 1 ? '1 call' : `${group.kids.toLocaleString('en-US')} calls`}</span> : null}
        {d.text ? <span className={`det${d.err ? ' err' : ''}`}>{d.text}</span> : null}
        {res ? <span className={`res${res.err ? ' err' : ''}`}>→ {res.text}</span> : null}
      </td>
      {scoped ? (
        <td className="hide-sm scopecell">
          <code>{c.scope ?? ''}</code>
        </td>
      ) : null}
      <td>
        <Org origin={originOf(c)} />
      </td>
      <td className="num tok">{tokensText(c)}</td>
      <td className={`num${t.was ? ' was' : ''}`} title={t.was && t.text !== '—' ? 'recorded; not waited in this run' : undefined}>
        {t.text}
      </td>
      <td className="rowact">
        {canFork ? (
          <button
            type="button"
            aria-label={`Fork at #${c.callNo}`}
            title={`Fork at #${c.callNo}`}
            onClick={(e) => {
              e.stopPropagation();
              onFork(c.callNo, e.currentTarget);
            }}
          >
            <Icon name="fork" />
          </button>
        ) : null}
      </td>
    </tr>
  );
});
