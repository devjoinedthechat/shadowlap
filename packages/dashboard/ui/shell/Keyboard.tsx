import { useEffect, useRef, type RefObject } from 'react';
import { changesHref } from '../changes-tab.js';
import { hideTip, tipShowing } from '../components/HoverCard.js';
import { isTyping } from '../dom.js';
import { isDetail } from '../focus.js';
import { focusCall, focusQuiet, pageUp, stepBack } from '../focus-manager.js';
import { useLatest } from '../hooks.js';
import { besideKeys, inBesideList, letGoOfRow, listKeys, takeRowScope } from '../list-keys.js';
import { modalOpen, overlayKeys, overlayOpen } from '../overlays/modal-store.js';
import { closeTopPanel } from '../overlays/slots.js';
import { knownParent } from '../parents.js';
import { GO_KEYS, GO_WINDOW_MS, href } from '../route.js';
import { copyCompares } from '../runs.js';
import { currentRoute, navigate } from '../router.js';
import { singleKeysOn, useSingleKeys } from '../single-keys.js';
import { useApp, type AppState } from '../state.js';
import { toastKey, UNDO_KEY } from '../toast.js';
import { crumbParent } from './top.js';

/**
 * The keys that work anywhere, in this order. No shortcut works while the link has expired. ⌘K (Ctrl
 * K) opens the palette, on a row's actions with the focus in that row, or closes it. A menu and a
 * modal have the keys first, in the capture phase (`overlayKeys`), so while one is open the page's
 * never fire. Esc does the first that applies (`escapeKey`). Typing in a field or holding ⌘, Ctrl or
 * Alt stops the rest. With single-key shortcuts off (shortcuts.ts) a one-character key stops here,
 * which leaves Enter and the arrows. Then g and its letter, u for what the toast on screen offers,
 * the sidebar's runs while the focus is on one, a run's keys (its page's `runKeys`), / and ?, and a
 * page's list keys (list-keys.ts).
 */

/** ⌘K: it closes the palette; over a dialog it opens nothing, and a menu has already gone. */
function paletteKey(a: AppState, e: KeyboardEvent): void {
  if (a.exported) return;
  e.preventDefault();
  if (a.palette) return a.setPalette(false);
  if (modalOpen()) return;
  takeRowScope();
  a.setPalette(true);
}

/** Esc in a field leaves it, what is typed staying: the focus goes to the run's selected call, else the row in focus. */
function leaveField(e: KeyboardEvent): void {
  e.preventDefault();
  (e.target as HTMLElement).blur();
  if (focusCall()) return;
  const row = document.querySelector<HTMLElement>('#view .krow');
  if (row) focusQuiet(row);
}

/** Where Esc goes up to from a page opened cold: the crumbs' parent, a fork or a replay's run, else its list. */
function upFrom(a: AppState, id: string): string {
  const listed = a.runs?.find((r) => r.runId === id) ?? null;
  const parent = crumbParent({ listed, loaded: knownParent(id), exported: a.exported, holds: (x) => !!a.runs?.some((r) => r.runId === x) });
  return parent ? href.run(parent) : href.runs();
}

/** Esc with nothing open: a run's panel or Runs' selection (`pageUp`), then back the way you came (opened cold, a fix's and a revision's lists), then the row in focus lets go. */
function goUp(a: AppState): boolean {
  if (inBesideList()) return letGoOfRow();
  if (pageUp.current?.()) return true;
  const route = currentRoute();
  if (!isDetail(route)) return letGoOfRow();
  navigate(stepBack(route.page === 'run' ? upFrom(a, route.id) : route.page === 'changes' ? href.changes() : href.fixes()));
  return true;
}

/** Esc that no menu or modal took: a panel, then the phone's sidebar, then a field, then a hover card, and the next press goes up. */
function escapeKey(a: AppState, e: KeyboardEvent): void {
  if (closeTopPanel()) e.preventDefault();
  else if (a.sideOpen) {
    a.setSideOpen(false);
    e.preventDefault();
  } else if (isTyping(e)) leaveField(e);
  else if (tipShowing()) {
    hideTip();
    e.preventDefault();
  } else if (!overlayOpen() && goUp(a)) e.preventDefault();
}

/**
 * Where g then this key goes: Changes at the tab it last showed in the project (Compare at its pair);
 * an exported copy has Runs, and Compare when it holds two runs or more. Null for none.
 */
export function goTarget(a: Pick<AppState, 'exported' | 'meta'>, key: string): string | null {
  const to = GO_KEYS[key];
  if (!to) return null;
  if (key === 'c') return !a.exported ? changesHref() : copyCompares(a.meta?.runIds) ? href.compare() : null;
  return !a.exported || to === href.runs() ? to : null;
}

/** A pending g takes this key, whatever it is, within its window; a g starts one. True when the key was theirs. */
function goKey(a: AppState, e: KeyboardEvent, gAt: RefObject<number>): boolean {
  if (gAt.current) {
    const fresh = Date.now() - gAt.current <= GO_WINDOW_MS;
    gAt.current = 0;
    const to = fresh ? goTarget(a, e.key) : null;
    if (to) {
      e.preventDefault();
      navigate(to);
    }
    if (fresh) return true;
  }
  if (e.key !== 'g') return false;
  gAt.current = Date.now();
  return true;
}

/** `/`: on a run its calls' filter (the run's keys), on Runs its filter, else the palette, which a copy doesn't have. */
function slashKey(a: AppState, e: KeyboardEvent): void {
  const field = document.querySelector<HTMLElement>('#runsQuery');
  if (field) {
    e.preventDefault();
    field.focus();
  } else if (!a.exported) {
    e.preventDefault();
    a.setPalette(true);
  }
}

/** The keys below the switch and g: each stops at the first that takes it. */
function pageKeys(a: AppState, e: KeyboardEvent): void {
  if (besideKeys(e) || (e.key === UNDO_KEY && toastKey.current?.()) || a.runKeys.current?.(e)) e.preventDefault();
  else if (e.key === '/') slashKey(a, e);
  else if (e.key === '?') {
    e.preventDefault();
    a.setHelp(!a.help);
  } else if (listKeys(e, () => a.setPalette(true))) e.preventDefault();
}

export function Keyboard() {
  const app = useApp();
  const latest = useLatest(app);
  const gAt = useRef(0);
  const singleKeys = useSingleKeys();
  useEffect(() => {
    document.documentElement?.classList.toggle('nosk', !singleKeys);
  }, [singleKeys]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const a = latest.current;
      if (a.conn === 'expired') return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) return paletteKey(a, e);
      if (e.key === 'Escape') return escapeKey(a, e);
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || overlayOpen()) return;
      if (!singleKeysOn() && e.key.length === 1) return;
      if (!goKey(a, e, gAt)) pageKeys(a, e);
    };
    const first = (e: KeyboardEvent) => {
      if (latest.current.conn !== 'expired') overlayKeys(e);
    };
    document.addEventListener('keydown', first, true);
    window.addEventListener('keydown', down);
    return () => {
      document.removeEventListener('keydown', first, true);
      window.removeEventListener('keydown', down);
    };
  }, [latest]);
  return null;
}
