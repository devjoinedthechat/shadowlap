import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { sameRun, shortId } from '../format.js';
import { claimCallFocus, focusQuiet, pageUp, stepsSideways, wantCallFocus } from '../focus-manager.js';
import { useLatest } from '../hooks.js';
import { shownRuns } from '../list-keys.js';
import { href, nextView, type View } from '../route.js';
import { navigate } from '../router.js';
import { markKey, type RunMark } from '../runkey.js';
import { recentRunIds, type RunLike } from '../runs.js';
import { pressShortcut, useSingleKeys, type ShortcutId } from '../shortcuts.js';
import type { CallTree } from './groups.js';

/**
 * A run's keys, while its page is open, as `shell/Keyboard.tsx` hands them on: j and k from anywhere
 * on the page, ↓ and ↑ in the views, the selected call taking the focus so they go on from it; 1 to
 * 4, v, n, p; [ and ] through the list you came from; +, - and ← → as they are; and r, c, b and f,
 * which press the header's buttons, so a key does what its button does and waits as it waits. A run
 * without the button has no key. Esc closes the diff panel before it leaves the page.
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
  tree: CallTree | null;
  folded: ReadonlySet<number>;
  listed: readonly C[];
  fold: (callNo: number) => void;
  showDiff: boolean;
  setShowDiff: (on: boolean) => void;
  runs: readonly RunLike[] | null;
  toast: (text: string) => void;
}

/** The keys that press a button in the run's header. */
const PRESSES: Readonly<Record<string, ShortcutId>> = { r: 'replay', c: 'compare', b: 'blame', f: 'fork' };

/** ← and → on the selected call in Calls, as in a tree: ← folds its group, or goes to the call it sits under; → opens it, or goes to its first call. False when there is nothing to do. */
function foldKey<C extends { callNo: number }>(k: RunKeyState<C>, open: boolean): boolean {
  const { tree, selected, folded, listed } = k;
  if (!tree || selected === null) return false;
  const i = tree.index.get(selected);
  if (i === undefined) return false;
  const isHead = tree.kids[i]! > 0;
  if (!open) {
    if (isHead && !folded.has(selected)) return k.fold(selected), true;
    const up = tree.parent.get(selected);
    return up !== undefined ? (k.select(up), true) : false;
  }
  if (isHead && folded.has(selected)) return k.fold(selected), true;
  const next = isHead ? listed[i + 1] : undefined;
  return next ? (k.select(next.callNo), true) : false;
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
  }
  const to = i < 0 ? undefined : ids[i + d];
  if (!to) return toast(`No run ${d > 0 ? 'after' : 'before'} ${shortId(runId)} in the list`);
  stepsSideways();
  navigate(href.run(to));
}

/** Esc on a run: the diff panel closes first, its toggle taking the focus if the focus was inside. */
function closeDiff(k: { showDiff: boolean; setShowDiff: (on: boolean) => void }): boolean {
  if (!k.showDiff || !document.querySelector('.diffpanel')) return false;
  const a = document.activeElement;
  const lost = !a || a === document.body || !!a.closest('.diffpanel');
  k.setShowDiff(false);
  const toggle = lost ? document.querySelector<HTMLElement>('#view [data-act="diff"]') : null;
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
      if (/^[1-4]$/.test(e.key)) return k.setTab(Number(e.key) - 1), true;
      const jumpTo = k.forkAt ?? k.lostAt ?? k.failedAt;
      if (e.key === 'n' && jumpTo !== null) return k.select(jumpTo), true;
      if (e.key === 'p' && k.parentId) return navigate(href.run(k.parentId)), true;
      if (e.key === 'v') return k.setView(nextView(k.v)), true;
      if (e.key === '[' || e.key === ']') return void stepRun(k.runId, e.key === ']' ? 1 : -1, k.runs, k.toast), true;
      const m = markKey(e.key);
      if (m && k.canMark) return k.mark(m), true;
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && k.v === 'calls' && k.tree) return foldKey(k, e.key === 'ArrowRight');
      const button = PRESSES[e.key];
      if (button) return press.current(button);
      if (e.key === '/') {
        if (k.v !== 'calls') k.setView('calls');
        k.setFilterWanted(true);
        return true;
      }
      return false;
    };
    pageUp.current = () => closeDiff(now.current);
    return () => {
      runKeys.current = null;
      pageUp.current = null;
    };
  }, [runKeys, now]);
}
