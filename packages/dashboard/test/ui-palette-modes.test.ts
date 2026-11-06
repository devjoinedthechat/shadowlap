import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JOB_KINDS, type Client } from '../ui/api.js';
import { rememberList } from '../ui/fixes/data.js';
import { APPLY_ASK } from '../ui/page-ask.js';
import { palettePlaceholder } from '../ui/palette.js';
import { href, type Route } from '../ui/route.js';
import { Palette } from '../ui/shell/Palette.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { FixRow } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Search or jump to, as the dashboard stands. Offline it listed its jobs as if they would run, and
 * read-only its field still promised actions. Its field now says what it searches in each, and,
 * while the server can't be reached, a job's entry stays in its place, dimmed and paused: picked,
 * it says why rather than start anything. Rendered as the shell renders the palette.
 */

function app(over: Partial<AppState> = {}): AppState {
  const base = {
    client: { search: async () => ({ hits: [] }), runsPage: async () => ({ runs: [], total: 0, next: null, chipCounts: {} }) },
    exported: false,
    meta: null,
    conn: 'ok',
    runs: [],
    runCommands: [],
    actionsOff: null,
    hasKind: (k: string) => k === 'test',
    jobs: [],
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: () => undefined,
    palette: true,
    setPalette: () => undefined,
    setSideOpen: () => undefined,
    setHelp: () => undefined,
  };
  return { ...base, ...over } as unknown as AppState;
}

const OVERVIEW: Route = { page: 'overview' };
const placeholder = (r: Rendered) => r.one('.palin input').getAttribute('placeholder');
/** The Actions group's rows: each label, its hint, and whether it waits. */
const actions = (r: Rendered) =>
  r
    .all('.palit')
    .filter((el) => /^(Run tests|Keyboard shortcuts)/.test(el.textContent))
    .map((el) => [el.querySelector('.pl')!.textContent, el.querySelector('.ph2')!.textContent, el.className.includes('waits')]);

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('Search or jump to, as the dashboard stands', () => {
  it('says what its field searches: everything, no actions when read-only, runs and pages in a copy or offline', () => {
    expect(palettePlaceholder({ exported: false, actions: true, offline: false })).toBe('Search runs, pages, actions and what runs recorded');
    expect(palettePlaceholder({ exported: false, actions: false, offline: false })).toBe('Search runs, pages and what runs recorded');
    expect(palettePlaceholder({ exported: false, actions: true, offline: true })).toBe('Search runs and pages');
    expect(palettePlaceholder({ exported: true, actions: false, offline: false })).toBe('Search runs and pages');
  });

  it('runs a job from its entry while the server answers', async () => {
    const startJob = vi.fn(async () => ({}));
    r = await render(createElement(AppContext.Provider, { value: app({ client: { startJob } as unknown as Client }) }, createElement(Palette, { route: OVERVIEW })));
    expect(placeholder(r)).toBe('Search runs, pages, actions and what runs recorded');
    expect(actions(r)).toEqual([
      ['Run tests', 'shadowlap test goldens/*', false],
      ['Keyboard shortcuts', 'every key, by where it works', false],
    ]);
  });

  it('shows a job paused while the server can’t be reached, and says why when it is picked', async () => {
    const startJob = vi.fn(async () => ({}));
    const toast = vi.fn();
    const setPalette = vi.fn();
    r = await render(createElement(AppContext.Provider, { value: app({ conn: 'offline', client: { startJob } as unknown as Client, toast, setPalette }) }, createElement(Palette, { route: OVERVIEW })));
    expect(placeholder(r)).toBe('Search runs and pages');
    // The job waits, dimmed, with its own hint; what isn’t a job stays as it was.
    expect(actions(r)).toEqual([
      ['Run tests', 'shadowlap test goldens/*', true],
      ['Keyboard shortcuts', 'every key, by where it works', false],
    ]);
    const tests = r.all('.palit').find((el) => el.textContent.startsWith('Run tests'))!;
    expect(tests.getAttribute('aria-disabled')).toBe('true');
    // It keeps its hint and says paused at its right; the line under the field says why, once.
    expect(tests.querySelector('.paltag')?.textContent).toBe('paused');
    expect(r.all('.paloff').map((el) => el.textContent)).toEqual(['Offline: actions paused until the dashboard server is back.']);
    expect(r.one('.palin input').getAttribute('aria-describedby')).toBe('palOff');
    await r.click(tests);
    expect(startJob).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('Paused until the dashboard server is back');
    // The palette stays open on it.
    expect(setPalette).not.toHaveBeenCalled();
  });

  it('keeps Run tests listed while a test session runs, dimmed, saying why, and says it again when picked', async () => {
    const startJob = vi.fn(async () => ({}));
    const toast = vi.fn();
    const running = { job: { id: 'j1', kind: 'test', args: ['test'], done: false }, lines: [], open: false };
    r = await render(createElement(AppContext.Provider, { value: app({ client: { startJob } as unknown as Client, toast, jobs: [running] as unknown as AppState['jobs'] }) }, createElement(Palette, { route: OVERVIEW })));
    const why = 'A test session is running: run the tests once it is done.';
    expect(actions(r)).toContainEqual(['Run tests', why, true]);
    await r.click(r.all('.palit').find((el) => el.textContent.startsWith('Run tests'))!);
    expect(startJob).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(why);
  });

  it('offers Apply fix for each verified fix once something is typed, by its label too, and opens its page asking there', async () => {
    const location = { hash: '#/', search: '', pathname: '/' };
    vi.stubGlobal('location', location);
    const fix = (fixId: string, status: FixRow['status'], title: string) => ({ fixId, status, title, label: 'refund-bug' }) as FixRow;
    rememberList({ fixes: [fix('fx-open', 'open', 'Refunds sent twice'), fix('fx-ready', 'verified', 'Escalate refunds above the limit'), fix('fx-done', 'applied', 'Refunds in cents')], counts: { all: 3, open: 1, verified: 2 } });
    try {
      r = await render(createElement(AppContext.Provider, { value: app({ client: { jobs: async () => [] } as unknown as Client, hasKind: (k: string) => k === JOB_KINDS.applyFix }) }, createElement(Palette, { route: OVERVIEW })));
      const applies = () => r!.all('.palit').filter((el) => el.querySelector('.pl')!.textContent === 'Apply fix');
      // Found only once something is typed: never on the open palette.
      expect(applies()).toEqual([]);
      await r.type(r.one('.palin input'), 'patch refund-bug');
      expect(applies().map((el) => el.querySelector('.ph2')!.textContent)).toEqual(['Escalate refunds above the limit']);
      await r.click(applies()[0]);
      expect(location.hash).toBe(href.fixes('fx-ready'));
      expect(APPLY_ASK.take('fx-ready')).toBe(true);
    } finally {
      rememberList({ fixes: [], counts: { all: 0, open: 0, verified: 0 } });
      vi.unstubAllGlobals();
    }
  });

  it('promises no actions on a dashboard that runs none', async () => {
    r = await render(createElement(AppContext.Provider, { value: app({ actionsOff: 'This dashboard is read-only: it was started with --read-only.' }) }, createElement(Palette, { route: OVERVIEW })));
    expect(placeholder(r)).toBe('Search runs, pages and what runs recorded');
    expect(actions(r).map((a) => a[0])).toEqual(['Keyboard shortcuts']);
  });
});
