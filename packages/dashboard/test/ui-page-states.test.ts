/**
 * Each page's quiet states, as the setup-states port draws them: while its data loads, the page's
 * header over its final layout in quiet bars (inert, one status, the page busy, none of the classes
 * the tests and the browser suite read as the page drawn); a read that failed, the header kept over
 * the error line with Retry, which reads again; and a link that names nothing, one page per kind.
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { fixesView } from '../src/fixes-view.js';
import { ApiError, type Client } from '../ui/api.js';
import { FixPage } from '../ui/fixes/FixPage.js';
import type { NotFoundKind } from '../ui/not-found-words.js';
import { FixesPage } from '../ui/pages/Fixes.js';
import { NotFoundPage } from '../ui/pages/NotFound.js';
import { RunPage } from '../ui/pages/Run.js';
import { RunsPage } from '../ui/pages/Runs.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

let r: Rendered | null = null;

afterEach(async () => {
  await r?.unmount();
  r = null;
});

const text = (el: FakeElement) => el.textContent.replace(/\u00a0/g, ' ');
const META = { project: { name: 'support-agent', path: '/work/support-agent' } };
/** A read the dashboard server answered 500 to, with no words of its own. */
const failed = () => Promise.reject(new ApiError(500, 'HTTP 500'));

/** The app as the shell gives it, its server answering as `client` says; a copy when `exported`. */
function app(client: Partial<Record<'run' | 'fix', (id: string) => Promise<unknown>>>, o: { exported?: boolean } = {}): AppState {
  return {
    client: { jobs: () => Promise.resolve([]), exported: !!o.exported, ...client } as unknown as Client,
    exported: !!o.exported,
    meta: META,
    tick: 0,
    runsTick: 0,
    live: [],
    feeds: {},
    jobs: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: () => undefined,
  } as unknown as AppState;
}

/** What a page waiting for its data must be: busy, saying so once, its bars inert and hidden. */
function waiting(page: Rendered, what: string): void {
  expect(page.one('.page').getAttribute('aria-busy')).toBe('true');
  expect(page.all('[role="status"]').map(text)).toEqual([`Loading ${what}…`]);
  const skin = page.one('.skel .skin');
  expect(skin.getAttribute('aria-hidden')).toBe('true');
  expect(skin.hasAttribute('inert')).toBe(true);
}

describe('a run page whose run hasn’t come', () => {
  const RUN = 'run_8f3a2c1d9e7b6a5f';

  it('draws its header, the project then the id, over the strip and the first calls in quiet bars of their own', async () => {
    r = await render(createElement(AppContext.Provider, { value: app({ run: () => new Promise(() => undefined) }) }, createElement(RunPage, { id: RUN, call: null, view: null })));
    waiting(r, 'the run');
    expect(text(r.one('.ph.rerr .eyebrow'))).toBe('support-agent · run');
    expect(text(r.one('.ph.rerr h1'))).toBe('run_8f3a2c');
    expect(r.all('.skin .rskstrip')).toHaveLength(1);
    expect(r.all('.skin .rskcall')).toHaveLength(8);
    // None of what the tests and the browser suite read as the run drawn.
    for (const drawn of ['.rhead', '.rnm', 'table', '[data-wi]', '.strip']) expect(r.all(drawn), drawn).toEqual([]);
  });

  it('keeps that header when the read fails, over the error line, and Retry reads the run again', async () => {
    const asked: string[] = [];
    let answer = failed;
    r = await render(createElement(AppContext.Provider, { value: app({ run: (id) => (asked.push(id), answer()) }) }, createElement(RunPage, { id: RUN, call: null, view: null })));
    await r.until('the failure', () => r!.all('.loaderr').length === 1);
    expect(r.one('.page').hasAttribute('aria-busy')).toBe(false);
    expect(text(r.one('.ph.rerr h1'))).toBe('run_8f3a2c');
    expect(r.all('.loaderr p > span').map(text)).toEqual(['couldn’t load', 'The dashboard server answered 500 for this page’s data.']);
    expect(r.all('.skel')).toEqual([]);
    answer = () => new Promise(() => undefined);
    await r.click(r.byText('.loaderr button', 'Retry'));
    await r.until('the run read again', () => asked.length === 2);
    expect(asked).toEqual([RUN, RUN]);
  });
});

describe('a fix page whose fix hasn’t come', () => {
  it('draws fix and its id over the three steps in the stepper’s look as quiet bars, never the fix’s own classes', async () => {
    r = await render(createElement(AppContext.Provider, { value: app({ fix: () => new Promise(() => undefined) }) }, createElement(FixPage, { id: 'fx-0123456789abcdef', step: null, sub: null })));
    waiting(r, 'the fix');
    expect(text(r.one('.ph .eyebrow'))).toBe('fix · fx-0123456789');
    expect(text(r.one('.ph h1'))).toBe('fx-0123456789');
    expect(r.all('.skin .fxsks > div').map((d) => text(d.querySelector('.k')!))).toEqual(['Blame', 'Repair', 'Verify']);
    // The fix's tests wait for `.ph.fxh h1`, and the browser suite for `.stepper`.
    for (const drawn of ['.fxh', '.stepper']) expect(r.all(drawn), drawn).toEqual([]);
  });

  it('keeps that header when the read fails, over the error line, and Retry reads the fix again', async () => {
    const asked: string[] = [];
    let answer = failed;
    r = await render(createElement(AppContext.Provider, { value: app({ fix: (id) => (asked.push(id), answer()) }) }, createElement(FixPage, { id: 'fx-fedcba9876543210', step: null, sub: null })));
    await r.until('the failure', () => r!.all('.loaderr').length === 1);
    expect(r.one('.page').hasAttribute('aria-busy')).toBe(false);
    expect(text(r.one('.ph h1'))).toBe('fx-fedcba9876');
    expect(r.all('.loaderr p > span').map(text)).toEqual(['couldn’t load', 'The dashboard server answered 500 for this page’s data.']);
    answer = () => new Promise(() => undefined);
    await r.click(r.byText('.loaderr button', 'Retry'));
    await r.until('the fix read again', () => asked.length === 2);
  });
});

describe('Runs while its runs haven’t come', () => {
  const EMPTY = { runs: [], total: 0, next: null, chipCounts: { all: 0, recording: 0, fork: 0, clean: 0, test: 0, capture: 0, failed: 0, local: 0 } };
  const runs = (runsPage: () => Promise<unknown>) => {
    const client = { exported: false, runsPage, runsByDay: () => new Promise(() => undefined), teamStore: () => Promise.resolve(null), knownRuns: (ids: string[]) => Promise.resolve(ids) } as unknown as Client;
    const state = { ...app({}), client, hasKind: () => false, refresh: () => undefined } as unknown as AppState;
    return createElement(AppContext.Provider, { value: state }, createElement(RunsPage, {}));
  };

  it('draws the rows as quiet bars in the table’s place, under its head, with no table row', async () => {
    r = await render(runs(() => new Promise(() => undefined)));
    expect(r.all('.runsec [role="status"]').map(text)).toEqual(['Loading the runs…']);
    expect(r.all('.runsec .skin .rskrun')).toHaveLength(8);
    expect(r.all('table.runst tbody tr')).toEqual([]);
    expect(text(r.one('.ph h1'))).toBe('Runs');
  });

  it('says why the runs couldn’t be read in the table’s place, and Retry reads the first page again', async () => {
    let asked = 0;
    let answer: () => Promise<unknown> = failed;
    r = await render(runs(() => (asked++, answer())));
    await r.until('the failure', () => r!.all('.runsec .loaderr').length === 1);
    expect(r.all('.loaderr p > span').map(text)).toEqual(['couldn’t load', 'The dashboard server answered 500 for this page’s data.']);
    expect(text(r.one('.ph h1'))).toBe('Runs');
    answer = () => Promise.resolve(EMPTY);
    const before = asked;
    await r.click(r.byText('.loaderr button', 'Retry'));
    await r.until('the runs read again', () => r!.all('.loaderr').length === 0);
    expect(asked).toBe(before + 1);
    expect(text(r.one('.runsec .emptyline'))).toBe('No runs yet.');
  });
});

describe('a page of a project with no runs', () => {
  const step = (page: Rendered) => page.all('.stepempty a.btn.lime').map((a) => [text(a), a.getAttribute('href')]);

  it('says on Runs what it will hold, with Set up <project> to the Overview, where the setup is', async () => {
    const state = { ...app({}), runs: [], client: { exported: false, teamStore: () => Promise.resolve(null) } } as unknown as AppState;
    r = await render(createElement(AppContext.Provider, { value: state }, createElement(RunsPage, {})));
    expect(text(r.one('.stepempty h2'))).toBe('No runs yet');
    expect(step(r)).toEqual([['Set up support-agent', '#/']]);
    expect(r.all('ol.setup')).toEqual([]);
  });

  it('says on Fixes what it will hold, with Set up <project>, and no blame command, which needs a run', async () => {
    const store = Store.open(':memory:');
    try {
      const state = { ...app({}), runs: [], client: { exported: false, fixes: () => Promise.resolve(fixesView(store)), jobs: () => Promise.resolve([]) } } as unknown as AppState;
      r = await render(createElement(AppContext.Provider, { value: state }, createElement(FixesPage, { id: null, step: null, sub: null })));
      await r.until('the empty list', () => r!.all('.stepempty').length === 1);
      expect(text(r.one('.stepempty h2'))).toBe('No fixes yet');
      expect(step(r)).toEqual([['Set up support-agent', '#/']]);
      expect(text(r.document.body)).not.toContain('shadowlap blame');
    } finally {
      await r?.unmount();
      r = null;
      store.close();
    }
  });
});

describe('a link that names nothing', () => {
  const page = async (kind: NotFoundKind, id: string, o: { exported?: boolean } = {}) => {
    r = await render(createElement(AppContext.Provider, { value: app({}, o) }, createElement(NotFoundPage, { kind, id })));
    const link = r.one('.ph p a.more');
    const out = { eyebrow: text(r.one('.ph .eyebrow')), title: text(r.one('.ph h1')), line: text(r.one('.ph p')), back: [link.getAttribute('href'), text(link)] };
    await r.unmount();
    r = null;
    return out;
  };

  it('says so under the page’s header, the project in its eyebrow, with the way back to the list that holds its kind', async () => {
    expect(await page('page', '#/nowhere')).toEqual({ eyebrow: 'support-agent · not found', title: 'Nothing here', line: 'No page at #/nowhere. Back to Overview', back: ['#/', 'Back to Overview'] });
    expect(await page('run', '01ZZZZZZZZ')).toEqual({ eyebrow: 'support-agent · not found', title: 'Nothing here', line: 'No run 01ZZZZZZZZ. Open Runs', back: ['#/runs', 'Open Runs'] });
    expect((await page('runs', '01M5')).line).toBe('01M5 matches several runs; use more of the id. Open Runs');
    expect(await page('fix', 'fx-nope')).toEqual({ eyebrow: 'support-agent · not found', title: 'Nothing here', line: 'No fix fx-nope. Open Fixes', back: ['#/fixes', 'Open Fixes'] });
    expect(await page('setup', '')).toMatchObject({ line: 'Nothing to set up here. Back to Overview', back: ['#/', 'Back to Overview'] });
    // A copy names no project.
    expect((await page('run', '01ZZZZZZZZ', { exported: true })).eyebrow).toBe('not found');
  });

  it('sets a page’s address in the code face', async () => {
    r = await render(createElement(AppContext.Provider, { value: app({}) }, createElement(NotFoundPage, { kind: 'page', id: '#/nowhere' })));
    expect(r.all('.ph p code').map(text)).toEqual(['#/nowhere']);
  });
});
