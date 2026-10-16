import { useEffect, useRef } from 'react';
import { isTyping } from '../dom.js';
import { useLatest } from '../hooks.js';
import { GO_KEYS, GO_WINDOW_MS } from '../route.js';
import { copyCompares } from '../runs.js';
import { navigate } from '../router.js';
import { useApp } from '../state.js';

/**
 * The keys that work anywhere: ⌘K (Ctrl K) for the palette, / to search (on a run it filters the
 * calls), ? for the shortcuts, g then a letter to go to a page, and Esc, which closes a menu, then a
 * dialog, then a panel, then the phone sidebar. A run's own keys are its page's (`runKeys`). No
 * shortcut works while the link has expired.
 */
export function Keyboard() {
  const app = useApp();
  const latest = useLatest(app);
  const gAt = useRef(0);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const a = latest.current;
      if (a.conn === 'expired') return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        if (a.exported) return;
        e.preventDefault();
        a.setPalette(!a.palette);
        return;
      }
      if (e.key === 'Escape') {
        if (a.closeTopLayer()) {
          e.preventDefault();
          return;
        }
        if (a.sideOpen) {
          a.setSideOpen(false);
          e.preventDefault();
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || a.blockingLayer()) return;
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
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [latest]);
  return null;
}
