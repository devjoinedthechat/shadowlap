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

  it('keeps Calibrate and Apply fix listed while a repair holds the working tree, dimmed, saying why, once the server’s jobs have come', async () => {
    const location = { hash: '#/', search: '', pathname: '/' };
    vi.stubGlobal('location', location);
    const startJob = vi.fn(async () => ({}));
    const toast = vi.fn();
    // A repair the terminal started: only the server's list holds it, read as the palette opens, and
    // shared by both rows. The first read waits until the test lets it answer; later ones answer at once.
    const listed: unknown[] = [];
    let answer!: () => void;
    const gate = new Promise<void>((done) => (answer = done));
    const jobs = vi.fn(async () => {
      await gate;
      return [...listed];
    });
    const value = app({
      client: { jobs, startJob } as unknown as Client,
      toast,
      meta: { actions: true, project: { id: 'p1', name: 'support-agent', path: '/work/support-agent' } } as never,
      hasKind: (k: string) => k === JOB_KINDS.calibrate || k === JOB_KINDS.applyFix,
    });
    const open = () => render(createElement(AppContext.Provider, { value }, createElement(Palette, { route: OVERVIEW })));
    const row = (label: string) => r!.all('.palit').find((el) => el.querySelector('.pl')!.textContent === label);
    const seen = (label: string) => {
      const el = row(label)!;
      return [el.querySelector('.ph2')!.textContent, el.getAttribute('aria-disabled') === 'true', el.className.includes('waits')];
    };
    rememberList({ fixes: [{ fixId: 'fx-ready', status: 'verified', title: 'Escalate refunds above the limit', label: 'refund-bug' } as FixRow], counts: { all: 1, open: 0, verified: 1 } });
    try {
      r = await open();
      await r.type(r.one('.palin input'), 'Calibrate');
      // Both rows wait on one read of the list; before it has come, nothing holds the tree that the palette knows of.
      expect(jobs).toHaveBeenCalledTimes(1);
      expect(seen('Calibrate')).toEqual(['propose normalizers', false, false]);
      listed.push({ id: 'r1', kind: 'repair', args: ['repair'], done: false, worktree: { use: 'writes', doing: 'a repair is verifying candidates made from your working tree', folder: '/work/support-agent' } });
      answer();
      // The read lands and the open palette reads its sources again, with nothing pressed.
      await r.until('Calibrate waits', () => seen('Calibrate')[1] === true);
      const calibrating = 'A repair is verifying candidates made from your working tree: calibrate once it is done.';
      expect(seen('Calibrate')).toEqual([calibrating, true, true]);
      await r.click(row('Calibrate')!);
      expect(toast).toHaveBeenLastCalledWith(calibrating);
      await r.type(r.one('.palin input'), 'fix patch');
      const applying = 'A repair is verifying candidates made from your working tree: apply the patch once it is done.';
      expect(seen('Apply fix')).toEqual([applying, true, true]);
      await r.click(row('Apply fix')!);
      expect(toast).toHaveBeenLastCalledWith(applying);
      // Neither started: no job, no fix page asked to open its dialog.
      expect(startJob).not.toHaveBeenCalled();
      expect(location.hash).toBe('#/');
      expect(APPLY_ASK.take('fx-ready')).toBe(false);
      // Once the repair is done, the next opening finds the rows ready again, as the list then says.
      listed.length = 0;
      await r.unmount();
      r = await open();
      await r.type(r.one('.palin input'), 'Calibrate');
      await r.until('Calibrate ready', () => seen('Calibrate')[1] === false);
      expect(seen('Calibrate')).toEqual(['propose normalizers', false, false]);
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
