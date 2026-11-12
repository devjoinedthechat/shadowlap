import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { claimCallFocus } from '../focus-manager.js';
import type { CallRow } from '../api.js';
import { AboutLine, useFitAbouts } from '../components/About.js';
import { Org, SrSpace } from '../components/bits.js';
import { Icon } from '../components/Icon.js';
import { approx, callName, kindShort, num, plural } from '../format.js';
import { useLatest } from '../hooks.js';
import { ORIGIN_NAME, type Origin7 } from '../origins.js';
import { agentOf } from '../scopes.js';
import type { CallIndex } from '../recorded.js';
import { cssVars } from '../dom.js';
import { callDetail, originOf, resultLine, timeOf, tokensText } from './model.js';
import { caretWords, groupName, pathOf, type Trace, type TraceEnd, type TraceGroup, type TraceRow } from './groups.js';
import { isKind, kindWords } from './kinds.js';
import { isPending, type ListedCall, type PendingCall } from './paging.js';
import { useWindow, type Windowed } from './window-hook.js';
import { ActionButton } from '../components/ActionButton.js';
import { useServedParts } from '../served-parts.js';
import { UntrustedTag } from '../injection/UntrustedTag.js';
import type { UntrustedView } from '../types.js';

/**
 * Calls: #, call, origin, tokens, time. A tool's result sits on a second line under it. A replayed
 * call's time is its recorded duration, in grey: the replay did not wait for it. Each row has a fork
 * button, shown on hover and on the selected row. Only the rows in view and a screenful either side
 * are drawn (window-hook.ts), so a run of 50,000 calls opens and moves as one of fifty does. A call
 * whose page isn't read yet (paging.ts) is a row with its number and origin, and coming into view
 * asks for its page (`onNeed`).
 *
 * Grouped (`rows`, groups.ts), the trace: a model call's tool calls a step in under it, its caret in
 * the step before its kind; a sub-agent's and a batch item's calls under a row that names them, says
 * what its calls were in the key's words and how it ended. A fold never moves the selection: the
 * folded row that holds it carries its ground (`held`). The fold buttons are one Tab stop between
 * them (`useFoldStop`).
 */

/** A row of Calls: a call's, or a sub-agent's or a batch item's. */
type Line = TraceRow<ListedCall>;

const flatLine = (c: ListedCall): Line => ({ call: c, group: null, depth: 0, head: null, held: false, sub: false });
/** The group a row folds: a group row's own, or a model call's whose calls sit under it. */
const foldOf = (r: Line): TraceGroup | null => r.group ?? r.head;

/** A call's row is one line, or two with a result under it; a group's row two with its end line: the window places rows by these shapes. A call not read yet is one line until it is. */
const callShape = (c: ListedCall) => (!isPending(c) && resultLine(c) ? 'two' : 'one');
const lineShape = (r: Line) => (r.call ? callShape(r.call) : r.group.end ? 'gtwo' : 'gone');
const LINE_ROWS = { keyOf: (r: Line) => (r.call ? r.call.callNo : `g:${r.group.key}`), shapeOf: lineShape, estimate: (shape: string) => (shape === 'two' || shape === 'gtwo' ? 50 : 33) };

const ALL_OPEN = () => true;

export function CallsTable({
  calls,
  rows = null,
  held = null,
  shown = ALL_OPEN,
  trace = null,
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
  onFold = null,
  untrusted = NO_READS,
}: {
  /** The calls, drawn flat when there are no `rows`. */
  calls: readonly ListedCall[];
  /** The trace's rows (call-list.ts), or null to list the calls flat, as a filter does. */
  rows?: readonly Line[] | null;
  /** The folded group that holds the selected call. */
  held?: TraceGroup | null;
  shown?: (g: TraceGroup) => boolean;
  trace?: Trace<ListedCall> | null;
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
  onFold?: ((g: TraceGroup) => void) | null;
  /** The run's untrusted reads a model call reads, by call: each tagged after its effect. */
  untrusted?: ReadonlyMap<number, UntrustedView>;
}) {
  const head = useRef<HTMLTableSectionElement>(null);
  const table = useRef<HTMLTableElement>(null);
  const placed = useRef(false);
  const lines = useMemo(() => rows ?? calls.map(flatLine), [rows, calls]);
  const win = useWindow(lines, LINE_ROWS);
  const { show } = win;
  const latest = useLatest({ lines, held });
  // A call not read yet in view: its page is asked for.
  useEffect(() => {
    if (!onNeed) return;
    for (let i = win.start; i < win.end; i++) {
      const c = lines[i]?.call;
      if (c && isPending(c)) return onNeed(c.callNo);
    }
  }, [lines, win.start, win.end, onNeed]);
  // Keep the selected row in view, or the folded row that holds it, scrolling the views pane only:
  // centred when the run opens, by as little as it takes after that. A fold moves no selection, so
  // it scrolls nothing.
  useEffect(() => {
    const { lines: now, held: h } = latest.current;
    let i = selected === null ? -1 : now.findIndex((r) => r.call?.callNo === selected);
    if (i < 0 && h) i = now.findIndex((r) => foldOf(r) === h);
    if (i < 0) return;
    show(i, { centre: !placed.current, head: head.current?.offsetHeight ?? 34 });
    placed.current = true;
  }, [selected, show, latest]);
  // A call a key moved to takes the focus once the window has drawn it.
  useLayoutEffect(claimCallFocus);
  // An item's input and how a group ended fit their room as an about line does.
  useFitAbouts(table);
  const rove = useFoldStop(lines, win, { held, selected, trace, shown, onFold, head, table });
  // The groups that hold the fork and the lost call: a folded one carries its mark.
  const forkIn = useMemo(() => new Set(trace && forkAt !== null ? pathOf(trace, forkAt) : []), [trace, forkAt]);
  const lostIn = useMemo(() => new Set(trace && lostAt !== null ? pathOf(trace, lostAt) : []), [trace, lostAt]);
  if (!lines.length) return <div className="empty">No calls match.</div>;
  const cols = scoped ? 7 : 6;
  const markOf = (n: number) => (n === forkAt ? 'fork' : n === lostAt ? 'lost' : null);
  return (
    <table className={rows ? 'calls grouped' : 'calls'} aria-rowcount={lines.length + 1} ref={table}>
      <thead ref={head}>
        <tr aria-rowindex={1}>
          <th className="n">#</th>
          <th>Call</th>
          {scoped ? <th className="hide-sm">Agent</th> : null}
          <th className="orgh">
            <span className="orgw">Origin</span>
          </th>
          <th className="num tok">Tokens</th>
          <th className="num">Time</th>
          <th className="rowact">
            <span className="sr">Fork</span>
          </th>
        </tr>
      </thead>
      <tbody ref={win.listRef} onPointerDown={rove.onPointerDown} onFocus={rove.onFocus} onBlur={rove.onBlur}>
        {win.before ? <Spacer height={win.before} cols={cols} /> : null}
        {lines.slice(win.start, win.end).map((r, j) => {
          const at = win.start + j;
          const c = r.call;
          if (!c) {
            const g = r.group;
            return <GroupRow key={`g:${g.key}`} at={at} g={g} depth={r.depth} open={shown(g)} held={g === held} mark={forkIn.has(g) ? 'fork' : lostIn.has(g) ? 'lost' : null} cols={cols} stop={rove.stop === g.key} onToggle={rove.toggle} onKey={rove.onKey} />;
          }
          if (isPending(c)) return <PendingRow key={c.callNo} at={at} c={c} depth={r.depth} selected={c.callNo === selected} scoped={scoped} mark={markOf(c.callNo)} onSelect={onSelect} />;
          const caret = r.head;
          return (
            <Row
              key={c.callNo}
              at={at}
              c={c}
              asked={c.kind === 'api' && asked ? (asked.get(c.callNo) ?? null) : undefined}
              selected={c.callNo === selected}
              scoped={scoped}
              mark={markOf(c.callNo)}
              ancestors={ancestors}
              live={live}
              canFork={canFork}
              onSelect={onSelect}
              onFork={onFork}
              depth={r.depth}
              sub={r.sub}
              held={!!caret && caret === held}
              caret={caret && onFold ? <Caret g={caret} open={shown(caret)} stop={rove.stop === caret.key} onToggle={rove.toggle} onKey={rove.onKey} /> : null}
              untrusted={untrusted.get(c.callNo)}
            />
          );
        })}
        {win.after ? <Spacer height={win.after} cols={cols} /> : null}
      </tbody>
    </table>
  );
}

const NO_READS: ReadonlyMap<number, UntrustedView> = new Map();

/** The keys a fold button takes: to the previous, the next, the first and the last fold, and fold and open. */
const ROVE_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End', 'ArrowLeft', 'ArrowRight']);

/** Where each fold button's row is, and their rows in order. */
interface FoldIndex {
  at: ReadonlyMap<string, number>;
  order: readonly number[];
}

function foldIndex(lines: readonly Line[]): FoldIndex {
  const at = new Map<string, number>();
  const order: number[] = [];
  lines.forEach((r, i) => {
    const g = foldOf(r);
    if (!g) return;
    at.set(g.key, i);
    order.push(i);
  });
  return { at, order };
}

/** The first fold row drawn, from `start`, before `end`. */
function firstDrawn(f: FoldIndex, lines: readonly Line[], start: number, end: number): string | null {
  let lo = 0;
  let hi = f.order.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (f.order[mid]! < start) lo = mid + 1;
    else hi = mid;
  }
  const i = f.order[lo];
  return i !== undefined && i < end ? (foldOf(lines[i]!)?.key ?? null) : null;
}

/** The fold an element is the button of; null for anything else. */
const foldButtonKey = (el: EventTarget | null): string | null => (el instanceof HTMLElement && el.matches('button[data-fold]') ? el.getAttribute('data-fold') : null);

/** Whether a press is on a fold button: its caret, its row's words, or the button itself. */
const onFoldButton = (el: EventTarget | null): boolean => el instanceof Element && el.closest('button[data-fold]') !== null;

/**
 * The fold buttons, every group's row and every model call's caret, as one Tab stop between them:
 * the one with the focus (or moved to with a key), while the selection is the one it had then; else
 * the held row's, else the selected row's caret, else the nearest group around the selection, else
 * the first; the first drawn when that one's row isn't. So a fold elsewhere leaves the stop to the
 * selection's group once the selection or the focus moves on. On a fold button, ↑ and ↓ move to the
 * next or previous, Home and End to the first and the last, ← folds and → opens, and the run's keys
 * never see them. A fold lets go of the row the window was keeping in view, so the list keeps its
 * scroll and the caret stays under the pointer.
 */
function useFoldStop(
  lines: readonly Line[],
  win: Windowed,
  o: { held: TraceGroup | null; selected: number | null; trace: Trace<ListedCall> | null; shown: (g: TraceGroup) => boolean; onFold: ((g: TraceGroup) => void) | null; head: RefObject<HTMLTableSectionElement | null>; table: RefObject<HTMLTableElement | null> },
) {
  const [moved, setMoved] = useState<{ key: string; selected: number | null } | null>(null);
  const want = useRef<string | null>(null);
  const folds = useMemo(() => foldIndex(lines), [lines]);
  const { held, selected, trace } = o;
  const near = selected !== null && trace ? (trace.within.get(selected) ?? null) : null;
  const kept = moved?.selected === selected ? moved.key : null;
  let stop = [kept, held?.key, selected !== null ? trace?.heads.get(selected)?.key : undefined].find((k) => !!k && folds.at.has(k)) ?? null;
  for (let g = near; !stop && g; g = g.parent) if (folds.at.has(g.key)) stop = g.key;
  const i = stop === null ? -1 : folds.at.get(stop)!;
  if (i < win.start || i >= win.end) stop = firstDrawn(folds, lines, win.start, win.end);
  const now = useLatest({ lines, folds, selected, shown: o.shown, onFold: o.onFold, show: win.show, release: win.release, head: o.head });
  // A press focuses its fold button before its click. The stop goes to the button with that click,
  // once the fold has let go of the row the window keeps in view: a redraw mid-press could scroll
  // the button out from under the pointer, and the click would land beside it.
  const pressed = useRef(false);
  const toggle = useCallback(
    (g: TraceGroup) => {
      const n = now.current;
      if (!n.onFold) return;
      n.release();
      if (pressed.current && foldButtonKey(document.activeElement) === g.key) setMoved({ key: g.key, selected: n.selected });
      pressed.current = false;
      n.onFold(g);
    },
    [now],
  );
  const onPointerDown = useCallback((e: PointerEvent<HTMLElement>) => {
    pressed.current = onFoldButton(e.target);
  }, []);
  // The fold button that takes the focus is the stop; once the focus leaves the fold buttons, none is.
  const onFocus = useCallback(
    (e: FocusEvent<HTMLElement>) => {
      const key = foldButtonKey(e.target);
      if (key && !pressed.current) setMoved({ key, selected: now.current.selected });
    },
    [now],
  );
  const onBlur = useCallback((e: FocusEvent<HTMLElement>) => {
    if (foldButtonKey(e.relatedTarget)) return;
    pressed.current = false;
    setMoved(null);
  }, []);
  const onKey = useCallback(
    (e: KeyboardEvent<HTMLElement>, g: TraceGroup) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !ROVE_KEYS.has(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const n = now.current;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (n.shown(g) === (e.key === 'ArrowLeft')) toggle(g);
        return;
      }
      const { at, order } = n.folds;
      const here = order.indexOf(at.get(g.key) ?? -1);
      const to = order[e.key === 'Home' ? 0 : e.key === 'End' ? order.length - 1 : here + (e.key === 'ArrowDown' ? 1 : -1)];
      const next = to === undefined ? null : foldOf(n.lines[to]!);
      if (to === undefined || !next) return;
      setMoved({ key: next.key, selected: n.selected });
      want.current = next.key;
      n.show(to, { head: n.head.current?.offsetHeight ?? 34 });
    },
    [now, toggle],
  );
  // A fold button moved to takes the focus once the window has drawn it.
  useLayoutEffect(() => {
    const key = want.current;
    const b = key ? o.table.current?.querySelector<HTMLElement>(`button[data-fold="${key}"]`) : null;
    if (!b) return;
    b.focus({ preventScroll: true });
    want.current = null;
  });
  return { stop, toggle, onKey, onPointerDown, onFocus, onBlur };
}

/** The height of the rows not drawn, above or below those that are. */
function Spacer({ height, cols }: { height: number; cols: number }) {
  return (
    <tr className="wspace" aria-hidden="true" style={{ height }}>
      <td colSpan={cols} />
    </tr>
  );
}

/** What a group's calls were, as the key draws them loud: by kind its writes and errors, else what a fork changed, in the key's order. */
const LOUD_ORDER: readonly string[] = ['k-write', 'k-err', 'over', 'inject', 'fail', 'block', 'stub'];

function loudFacts(g: TraceGroup): { code: string; words: string }[] {
  return [...g.loud].sort((a, b) => LOUD_ORDER.indexOf(a[0]) - LOUD_ORDER.indexOf(b[0])).map(([code, n]) => ({ code, words: `${num(n)} ${isKind(code) ? kindWords(code, n) : ORIGIN_NAME[code as Origin7]}` }));
}

interface FoldProps {
  onToggle: (g: TraceGroup) => void;
  onKey: (e: KeyboardEvent<HTMLElement>, g: TraceGroup) => void;
}

/**
 * A sub-agent's or a batch item's row: the fork's or the lost call's mark while folded, then a button
 * over the rest of the row with its caret, its name or its input, and what its calls were; how it
 * ended under it. A click anywhere on it folds or opens it; it selects nothing.
 */
const GroupRow = memo(function GroupRow({ at, g, depth, open, held, mark, cols, stop, onToggle, onKey }: FoldProps & { at: number; g: TraceGroup; depth: number; open: boolean; held: boolean; mark: 'fork' | 'lost' | null; cols: number; stop: boolean }) {
  const name = groupName(g);
  const loud = loudFacts(g);
  const calls = plural(g.calls, 'call');
  const label = `${g.kind === 'sub' ? `${name}, sub-agent` : name}, ${[calls, ...loud.map((f) => f.words)].join(', ')}`;
  return (
    <tr className={held ? 'tgr held' : 'tgr'} data-fold={g.key} data-wi={at} data-acts="" aria-rowindex={at + 2} onClick={() => onToggle(g)}>
      <td className="n">{mark && !open ? <span className={mark === 'lost' ? 'fk bl' : 'fk'}>{mark}</span> : null}</td>
      <td className="tgc" colSpan={cols - 1} style={cssVars({ '--d': depth })}>
        <button
          className="tgsum"
          type="button"
          data-fold={g.key}
          aria-expanded={open}
          aria-label={label}
          tabIndex={stop ? 0 : -1}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(g);
          }}
          onKeyDown={(e) => onKey(e, g)}
        >
          <Icon name="caret" className="tcr" />
          {g.kind === 'sub' ? (
            <>
              <code title={g.agent ?? undefined}>{name}</code>
              <span className="tgk">sub-agent</span>
            </>
          ) : (
            <AboutLine about={{ text: name, from: 'user' }} className="tgin" title={name} />
          )}
          <span className="tgfacts legend">
            <span>{calls}</span>
            {loud.map((f) => (
              <span key={f.code}>
                <i className={`lg ${f.code}`} />
                {f.words}
              </span>
            ))}
            {g.kind === 'sub' && g.spent !== null ? <span>{approx(g.spent)} spent</span> : null}
          </span>
        </button>
        {g.end ? <GroupEnd end={g.end} /> : null}
      </td>
    </tr>
  );
});

/** How a group ended, under its name: its last answer, the model call that failed, or that it still records. */
function GroupEnd({ end }: { end: TraceEnd }) {
  return (
    <span className={end.err ? 'tgout err' : 'tgout'}>
      {end.progress ? null : <span className="tga">→ </span>}
      <AboutLine about={{ text: end.text, from: 'user' }} title={end.text} />
    </span>
  );
}

/** A model call's caret, in the step before its kind: it folds the calls under it and opens them again. */
function Caret({ g, open, stop, onToggle, onKey }: FoldProps & { g: TraceGroup; open: boolean; stop: boolean }) {
  const words = caretWords(g, open);
  return (
    <button
      className="tcaret"
      type="button"
      data-fold={g.key}
      aria-expanded={open}
      aria-label={words}
      title={words}
      tabIndex={stop ? 0 : -1}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(g);
      }}
      onKeyDown={(e) => onKey(e, g)}
    >
      <Icon name="caret" />
    </button>
  );
}

/** A call whose page isn't read yet: its number, its mark and its origin, and a word that it is on its way. */
const PendingRow = memo(function PendingRow({ at, c, depth, selected, scoped, mark, onSelect }: { at: number; c: PendingCall; depth: number; selected: boolean; scoped: boolean; mark: 'fork' | 'lost' | null; onSelect: (n: number) => void }) {
  return (
    <tr data-wi={at} data-call={c.callNo} data-acts="" aria-rowindex={at + 2} aria-selected={selected} aria-busy="true" onClick={() => onSelect(c.callNo)}>
      <td className="n">
        {mark ? <Mark mark={mark} /> : null}
        {c.callNo}
      </td>
      <td className="name" style={depth ? cssVars({ '--d': depth }) : undefined}>
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
  depth = 0,
  sub = false,
  held = false,
  caret = null,
  untrusted,
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
  /** Its steps in, in the trace. */
  depth?: number;
  /** Whether it sits in a sub-agent's row, which names the agent: its Agent cell is empty. */
  sub?: boolean;
  /** A folded model call's that holds the selected call: it carries the selection's ground. */
  held?: boolean;
  /** A model call's caret, when calls sit under it. */
  caret?: ReactNode;
  untrusted?: UntrustedView | undefined;
}) {
  const d = callDetail(c, asked);
  const res = resultLine(c);
  const t = timeOf(c, ancestors, live);
  // The fork menu's script loads as the pointer or the focus reaches the row's fork button, so it opens at once.
  const forkPart = useServedParts().ForkMenu;
  const preloadFork = () => forkPart?.preload();
  return (
    <tr className={held ? 'held' : undefined} data-wi={at} data-call={c.callNo} data-acts="" aria-rowindex={at + 2} aria-selected={selected} onClick={() => onSelect(c.callNo)}>
      <td className="n">
        {mark ? <Mark mark={mark} /> : null}
        {c.callNo}
      </td>
      <td className="name" title={c.name} style={depth ? cssVars({ '--d': depth }) : undefined}>
        {caret}
        <small>{kindShort(c.kind)}</small>
        {callName(c.kind, c.name)}
        {c.input ? <span className="eff input">input</span> : c.effect ? <span className={`eff ${c.effect}`}>{c.effect}</span> : null}
        <UntrustedTag read={untrusted} />
        {c.extraRead ? (
          <span className="eff extra" title="An extra read: answered live, as its recording held no counterpart, while the replay went on replaying">
            extra
          </span>
        ) : null}
        {c.attempts ? <span className="det" title={`${c.attempts} ${c.attempts === 1 ? 'retry' : 'retries'} before the final outcome`}>+{c.attempts}</span> : null}
        {d.text ? <span className={`det${d.err ? ' err' : ''}`}>{d.text}</span> : null}
        {res ? <span className={`res${res.err ? ' err' : res.blocked ? ' blk' : ''}`}>→ {res.text}</span> : null}
      </td>
      {scoped ? <td className="hide-sm scopecell">{sub ? null : <code title={agentOf(c) ?? undefined}>{agentOf(c) ?? ''}</code>}</td> : null}
      <td>
        <Org origin={originOf(c)} />
      </td>
      <td className="num tok">{tokensText(c)}</td>
      <td className={`num${t.was ? ' was' : ''}`} title={t.was && t.text !== '—' ? 'recorded; not waited in this run' : undefined}>
        {t.text}
      </td>
      <td className="rowact">
        {canFork ? (
          <ActionButton
            aria-haspopup="menu"
            aria-expanded="false"
            aria-label={`Fork at #${c.callNo}`}
            title={`Fork at #${c.callNo}`}
            onPointerEnter={preloadFork}
            onFocus={preloadFork}
            onClick={(e) => {
              e.stopPropagation();
              onFork(c.callNo, e.currentTarget);
            }}
          >
            <Icon name="fork" />
          </ActionButton>
        ) : null}
      </td>
    </tr>
  );
});

/** The fork's and the lost call's mark before the number, a space a screen reader says after it: "fork 17", not "fork17". */
function Mark({ mark }: { mark: 'fork' | 'lost' }) {
  return (
    <>
      <span className={`fk${mark === 'lost' ? ' bl' : ''}`}>{mark}</span>
      <SrSpace />
    </>
  );
}
