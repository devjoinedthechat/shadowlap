import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '../ui/api.js';
import { FixesPage } from '../ui/pages/Fixes.js';
import { TestsPage } from '../ui/pages/Tests.js';
import { useRoute } from '../ui/router.js';
import { AppContext, type AppState } from '../ui/state.js';
import { addressBar, watchThePage } from './ui-route-helpers.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A page you open takes the focus to its heading once it has drawn what it opened for, so Tab goes on
 * from there into the page. While its list still loads the page has nothing for Tab to stop at, and
 * Tab from the heading went back to the skip link (browser/keys.spec.ts, "a new page starts Tab from
 * its heading", under load).
 */

let r: Rendered | null = null;
beforeEach(() => {
  addressBar('#/runs');
});
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.unstubAllGlobals();
});

/** The shell's page slot, Runs first, with a client whose read for `page` answers when the test says. */
function opened(page: 'fixes' | 'tests') {
  let answer!: (v: unknown) => void;
  const read = () => new Promise((res) => (answer = res));
  const client = { fixes: read, tests: read, jobs: async () => [], coverage: async () => null } as unknown as Client;
  const value = { client, exported: false, meta: null, tick: 0, feeds: {}, jobs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => (fn(), true), toast: () => undefined, watchJob: () => undefined } as unknown as AppState;
  function Slot() {
    const route = useRoute();
    const shown = route.page !== page ? createElement('h1', {}, 'Runs') : page === 'fixes' ? createElement(FixesPage, { id: null, step: null, sub: null }) : createElement(TestsPage);
    return createElement('main', { id: 'view', tabIndex: -1 }, shown);
  }
  return { tree: createElement(AppContext.Provider, { value }, createElement(Slot)), answer: (v: unknown) => answer(v) };
}

describe('a page opened', () => {
  for (const [page, title, empty] of [
    ['fixes', 'Fixes', { counts: { all: 0, open: 0, verified: 0 }, fixes: [] }],
    ['tests', 'Tests', { empty: true, rows: [], diverged: [], commands: { pack: 'shadowlap pack <run> goldens/<name>' } }],
  ] as const) {
    it(`gives ${title}’ heading the focus once what it loads has come, not while it still loads`, async () => {
      const changed = watchThePage();
      const { tree, answer } = opened(page);
      r = await render(tree);
      await act(async () => void (location.hash = `#/${page}`));
      await changed();
      expect(r.one('main h1').textContent).toBe(title);
      expect(r.focused()).not.toBe(r.one('main h1'));
      expect(r.one('main .page').getAttribute('aria-busy')).toBe('true');
      await act(async () => answer(empty));
      await changed();
      expect(r.all('main .page[aria-busy]')).toHaveLength(0);
      expect(r.focused()).toBe(r.one('main h1'));
    });
  }
});
