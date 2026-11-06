import { act } from 'react';
import { vi } from 'vitest';
import type { AppState } from '../ui/state.js';

/** What the tests of the keys and of the focus manager share: the app's state, the address bar, and the page's changes. */

export function app(over: Partial<AppState> = {}): AppState {
  const base = {
    client: { search: async () => ({ hits: [] }), runsPage: async () => ({ runs: [], total: 0, next: null, chipCounts: {} }) },
    conn: 'ok',
    exported: false,
    meta: null,
    runs: [],
    runCommands: [],
    actionsOff: null,
    hasKind: () => false,
    jobs: [],
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: () => undefined,
    palette: false,
    setPalette: () => undefined,
    help: false,
    setHelp: () => undefined,
    sideOpen: false,
    setSideOpen: () => undefined,
    runKeys: { current: null },
  };
  return { ...base, ...over } as unknown as AppState;
}

/** An address bar as a browser's: a link followed sets it, and the router hears it. */
export function addressBar(start: string) {
  let hash = start;
  const location = {
    pathname: '/',
    search: '',
    get hash() {
      return hash;
    },
    set hash(to: string) {
      hash = to;
      window.dispatchEvent(new Event('hashchange'));
    },
  };
  vi.stubGlobal('location', location);
  vi.stubGlobal('history', { state: null, replaceState: (_s: unknown, _t: string, url: string) => void (hash = url.slice(url.indexOf('#'))) });
  return location;
}

/** The tests' renderer has no observer of the page, which the focus manager follows it by: called before a render, this one lets a test say when the page changed. */
export function watchThePage(): () => Promise<void> {
  const heard = new Set<() => void>();
  vi.stubGlobal(
    'MutationObserver',
    class {
      private readonly fn: () => void;
      constructor(fn: () => void) {
        this.fn = fn;
      }
      observe() {
        heard.add(this.fn);
      }
      disconnect() {
        heard.delete(this.fn);
      }
    },
  );
  return () => act(async () => void [...heard].forEach((fn) => fn()));
}
