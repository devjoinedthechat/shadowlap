import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { sameRun, shortId } from '../format.js';
import { claimCallFocus, focusQuiet, pageUp, stepsSideways, wantCallFocus } from '../focus-manager.js';
import { useLatest } from '../hooks.js';
import { shownRuns } from '../list-keys.js';
import { href, nextView, type View } from '../route.js';
import { currentRoute, navigate } from '../router.js';
import { markKey, type RunMark } from '../runkey.js';
import { recentRunIds, type RunLike } from '../runs.js';
import { pressShortcut, useSingleKeys, type ShortcutId } from '../shortcuts.js';
import { errorText, type ToastKind } from '../toast.js';
import { pathOf, type Trace, type TraceGroup } from './groups.js';
import { panelToggle } from './InspectorPanel.js';
import { closePanelOn, panelOn } from './panel-state.js';

/**
 * A run's keys, while its page is open, as `shell/Keyboard.tsx` hands them on: j and k from anywhere
 * on the page, ↓ and ↑ in the views, the selected call taking the focus so they go on from it; 1 to
 * 4, v, n, p; [ and ] through the list you came from; +, - and ← → as they are; and r, c, b and f,
 * which press the header's buttons, so a key does what its button does and waits as it waits. A run
 * without the button has no key. Esc closes a finding's panel (its diff, its change, its results)
 * before it leaves the page.
 */

export interface RunKeyState<C extends { callNo: number }> {
  runId: string;
  v: View;
  selected: number | null;
  /** Moves the selection, and says which call it landed on. */
  step: (delta: number) => number | null;
  setTab: (n: number) => void;
  select: (n: number) => void;
  setView: (v: View) => void;
  setFilterWanted: (on: boolean) => void;
  /** The call that needs a look (`n`): where it forked, where blame found it lost, else where it first failed. */
  forkAt: number | null;
  lostAt: number | null;
  failedAt: number | null;
  parentId: string | null | undefined;
  canMark: boolean;
  mark: (m: RunMark) => void;
  /** Calls' trace, or null while it lists its calls flat; whether a group is open, and its fold. */
  trace: Trace<C> | null;
  shown: (g: TraceGroup) => boolean;
  listed: readonly C[];
  fold: (g: TraceGroup) => void;
  runs: readonly RunLike[] | null;
  toast: (text: string, kind?: ToastKind) => void;
}

/** The keys that press a button in the run's header. */
const PRESSES: Readonly<Record<string, ShortcutId>> = { r: 'replay', c: 'compare', b: 'blame', f: 'fork' };

/**
 * ← and → on the selected call in Calls, on the trace as a tree: a group's head is its model call,
 * or a sub-agent's stretch's first call; a batch's item has its row alone. ← folds the group the
 * selected call heads (its tool calls, then its stretch), else goes to the head of the group it sits
 * in, else folds the item's row that holds it, the selection held; on a held selection it goes on
 * from the folded row that holds it. → opens the folded group that holds it, else the group it
 * heads, else goes to the first call under it. False when there is nothing to do.
 */
function foldKey<C extends { callNo: number }>(k: RunKeyState<C>, open: boolean): boolean {
  const { trace, selected, shown } = k;
  if (!trace || selected === null) return false;
  const own = trace.heads.get(selected) ?? null;
  const path = pathOf(trace, selected);
  const held = path.find((g) => !shown(g));
  const inner = path.at(-1);
  const stretch = inner?.kind === 'sub' && inner.first === selected ? inner : null;
  if (open) {
    if (held) return k.fold(held), true;
    if (own && !shown(own)) return k.fold(own), true;
    const i = own || (stretch && stretch.last > selected) ? k.listed.findIndex((c) => c.callNo === selected) : -1;
    const next = i < 0 ? undefined : k.listed[i + 1];
    return next ? (k.select(next.callNo), true) : false;
  }
  const mine = held ? null : own && shown(own) ? own : stretch;
  if (mine) return k.fold(mine), true;
  // On from what shows the selection: a folded model call's row selects that call; else the group above.
  if (held?.kind === 'model') return held.head !== null && (k.select(held.head), true);
  const up = held ? path[path.indexOf(held) - 1] : inner;
  if (!up) return false;
  if (up.kind === 'model') return up.head !== null && (k.select(up.head), true);
  if (up.kind === 'sub' && up.first !== selected) return k.select(up.first), true;
  return k.fold(up), true;
}

/** The run before or after this one in the list you came from: Runs as it was last shown, else the sidebar's. */
async function stepRun(runId: string, d: 1 | -1, runs: readonly RunLike[] | null, toast: (text: string) => void): Promise<void> {
  const noted = shownRuns.current;
  const holds = !!noted?.ids.some((id) => sameRun(runId, id));
  let ids = holds ? noted!.ids : recentRunIds(runs ?? []);
  let i = ids.findIndex((id) => sameRun(runId, id));
  // Only a list that truly ends says so: the next page of Runs is read first.
  if (holds && d > 0 && i === ids.length - 1 && noted!.more) {
    ids = await noted!.more();
    i = ids.findIndex((id) => sameRun(runId, id));
    // You went elsewhere while it read: the step is no longer asked for.
    const here = currentRoute();
    if (here.page !== 'run' || !sameRun(here.id, runId)) return;
  }
  const to = i < 0 ? undefined : ids[i + d];
  if (!to) return toast(`No run ${d > 0 ? 'after' : 'before'} ${shortId(runId)} in the list`);
  stepsSideways();
  navigate(href.run(to));
}

/**
 * Esc on a run: the diff, the change or the results in the inspector's place close first, the
 * finding's toggle taking the focus if the focus was inside them (InspectorPanel.tsx). The panel is
 * open once its frame shows, whether what it holds has come, is on its way or failed to come (it loads
 * the first time it opens).
 */
export function closePanel(runId: string): boolean {
  const panel = panelOn(runId);
  if (!panel || !document.querySelector('#insp.fpanel')) return false;
  const a = document.activeElement;
  const lost = !a || a === document.body || !!a.closest('.fpanel');
  const toggle = lost ? panelToggle(panel) : null;
  closePanelOn(runId);
  if (toggle) focusQuiet(toggle);
  return true;
}

export function useRunKeys<C extends { callNo: number }>(runKeys: RefObject<((e: KeyboardEvent) => boolean) | null>, state: RunKeyState<C>): void {
  // What the keys read as they fire; the switch is read so the page's marks draw again as it moves.
  useSingleKeys();
  const now = useLatest(state);
  const press = useRef((id: ShortcutId) => pressShortcut(id, (words) => now.current.toast(words)));
  useLayoutEffect(claimCallFocus);
  useEffect(() => {
    runKeys.current = (e) => {
      const k = now.current;
      const inViews = !!(e.target as Partial<Element> | null)?.closest?.('.vbody');
      if (e.key === 'j' || (e.key === 'ArrowDown' && inViews)) return wantCallFocus(k.step(1)), true;
      if (e.key === 'k' || (e.key === 'ArrowUp' && inViews)) return wantCallFocus(k.step(-1)), true;
      // The inspector's tabs, which give it back from a panel in its place.
      if (/^[1-4]$/.test(e.key)) return closePanelOn(k.runId), k.setTab(Number(e.key) - 1), true;
      const jumpTo = k.forkAt ?? k.lostAt ?? k.failedAt;
      if (e.key === 'n' && jumpTo !== null) return k.select(jumpTo), true;
      if (e.key === 'p' && k.parentId) return navigate(href.run(k.parentId)), true;
      if (e.key === 'v') return k.setView(nextView(k.v)), true;
      if (e.key === '[' || e.key === ']') return void stepRun(k.runId, e.key === ']' ? 1 : -1, k.runs, k.toast).catch((err: unknown) => k.toast(errorText(err), 'error')), true;
      const m = markKey(e.key);
      if (m && k.canMark) return k.mark(m), true;
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && k.v === 'calls' && k.trace) return foldKey(k, e.key === 'ArrowRight');
      const button = PRESSES[e.key];
      if (button) return press.current(button);
      if (e.key === '/') {
        if (k.v !== 'calls') k.setView('calls');
        k.setFilterWanted(true);
        return true;
      }
      return false;
    };
    pageUp.current = () => closePanel(now.current.runId);
    return () => {
      runKeys.current = null;
      pageUp.current = null;
    };
  }, [runKeys, now]);
}
