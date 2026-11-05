import { useEffect, useRef } from 'react';
import { hideTip, tipShowing } from '../components/HoverCard.js';
import { isTyping } from '../dom.js';
import { useLatest } from '../hooks.js';
import { modalOpen, overlayKeys, overlayOpen } from '../overlays/modal-store.js';
import { closeTopPanel } from '../overlays/slots.js';
import { GO_KEYS, GO_WINDOW_MS } from '../route.js';
import { copyCompares } from '../runs.js';
import { navigate } from '../router.js';
import { useApp, type AppState } from '../state.js';
import { toastKey, UNDO_KEY } from '../toast.js';

/**
 * The keys that work anywhere: ⌘K (Ctrl K) for the palette, / to search (on a run it filters the
 * calls), ? for the shortcuts, g then a letter to go to a page, u for what the toast on screen offers
 * (its Undo), and Esc. A menu and a modal have the keys first, in the capture phase, so while one is
 * open the page's never fire (`overlayKeys`): Esc closes it there, and only reaches this handler to
 * close a panel, then the phone sidebar, then a hover card. A run's own keys are its page's
 * (`runKeys`). No shortcut works while the link has expired.
 */

/** ⌘K: it closes the palette; over a dialog it opens nothing, and a menu has already gone. */
function paletteKey(a: AppState, e: KeyboardEvent): void {
  if (a.exported) return;
  e.preventDefault();
  if (a.palette) a.setPalette(false);
  else if (!modalOpen()) a.setPalette(true);
}

/** Esc that no menu or modal took: a panel, then the phone's sidebar, then a hover card. */
function escapeKey(a: AppState, e: KeyboardEvent): void {
  if (closeTopPanel()) e.preventDefault();
  else if (a.sideOpen) {
    a.setSideOpen(false);
    e.preventDefault();
  } else if (tipShowing()) {
    hideTip();
    e.preventDefault();
  }
}

export function Keyboard() {
  const app = useApp();
  const latest = useLatest(app);
  const gAt = useRef(0);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const a = latest.current;
      if (a.conn === 'expired') return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) return paletteKey(a, e);
      if (e.key === 'Escape') return escapeKey(a, e);
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || overlayOpen()) return;
      if (gAt.current) {
        const fresh = Date.now() - gAt.current <= GO_WINDOW_MS;
        gAt.current = 0;
        const to = GO_KEYS[e.key];
        if (fresh && to) {
          // An exported copy has Runs, and Compare when it holds two runs or more.
          if (a.exported && to !== '#/runs' && !(to === '#/compare' && copyCompares(a.meta?.runIds))) return;
          e.preventDefault();
          navigate(to);
          return;
        }
      }
      if (e.key === 'g') {
        gAt.current = Date.now();
        return;
      }
      // The undo key: what the toast on screen offers (its Undo), before a page's own keys.
      if (e.key === UNDO_KEY && toastKey.current?.()) {
        e.preventDefault();
        return;
      }
      if (a.runKeys.current?.(e)) {
        e.preventDefault();
        return;
      }
      if (e.key === '/') {
        if (a.exported) return;
        e.preventDefault();
        a.setPalette(true);
      } else if (e.key === '?') {
        e.preventDefault();
        a.setHelp(!a.help);
      }
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
