import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, type Client } from '../ui/api.js';
import { oneRunPair, replayCommand } from '../ui/compare/model.js';
import { ComparePage } from '../ui/pages/Compare.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { CompareView, RunDetail, RunListItem } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Every address Compare takes says what it holds: one run is paired with its newest fork, else its
 * newest replay, else its parent, else there is nothing to compare yet; the same run on both sides,
 * a run the store doesn't hold, and an id that starts several runs' ids, say so.
 */

const REC = '01M5GRVTKSJ12EE2SE9YZ5W4J3';
const FORK = '01M5GRXFM1Y2E2VBPFX0TV2TGA';
const ALONE = '01M5GRYHR0BT1ATQFZP3EQR1MZ';
const GONE = '01ZZZZZZZZZZZZZZZZZZZZZZZZ';

let page: Rendered | null = null;
const g = globalThis as Record<string, unknown>;
const saved = { location: g.location, history: g.history };
afterEach(async () => {
  await page?.unmount();
  page = null;
  Object.assign(g, saved);
});

/** The address bar, as the router reads and rewrites it. */
function addressBar(hash: string): { hash: string } {
  const location = { hash, pathname: '/', search: '' };
  Object.assign(g, { location, history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => (location.hash = url.slice(url.indexOf('#'))) } });
  return location;
}

function app(client: Partial<Client>, runs: RunListItem[] = []): AppState {
  return {
    client: { jobs: () => Promise.resolve([]), ...client } as unknown as Client,
    exported: false,
    meta: null,
    tick: 0,
    runsTick: 0,
    feeds: {},
    jobs: [],
    live: [],
    runs,
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: () => undefined,
    registerLayer: () => () => undefined,
  } as unknown as AppState;
}

/** A run's page as the server sends it, with only what Compare reads. */
const detail = (runId: string, o: { parent?: string | null; children?: RunDetail['children']; source?: string | null } = {}) =>
  ({ run: { runId, parentRunId: o.parent ?? null, mode: o.parent ? 'replay' : 'record', status: 'completed', divergence: null, command: { argv: ['node', 'refund_agent.mjs'], cwd: '.' }, codeVersion: null, startedAt: 1, endedAt: 2 }, parent: o.parent ? { runId: o.parent, label: 'recording' } : null, children: o.children ?? [], source: o.source ?? null, calls: [], summary: {} }) as unknown as RunDetail;

const listed = (runId: string): RunListItem => ({ runId, parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: 'node refund_agent.mjs', codeVersion: null, startedAt: 1, calls: 3, spent: 0, saved: 0, captured: 0, imported: false, covers: null, source: null, labels: [] }) as unknown as RunListItem;

const missing = () => Promise.reject(new ApiError(404, 'no run'));
/** A prefix of several runs' ids, as the server answers it. */
const SEVERAL = '01M5GR';
const several = () => Promise.reject(new ApiError(409, `run id prefix ${SEVERAL} matches several runs: use more of the id`));

describe('one run named', () => {
  const kid = (runId: string, kind: string, startedAt: number, attempt = false) => ({ runId, label: kind, kind, startedAt, ...(attempt ? { attempt: true as const } : {}) }) as RunDetail['children'][number];

  it('pairs it with its newest fork, else its newest replay, else its newest test, else its parent; never an attempt or a run still recording', () => {
    const kids = [kid('CLEAN', 'clean', 1), kid('FORK1', 'fork', 2), kid('FORK2', 'fork', 3), kid('PROBE', 'fork', 9, true), kid('TEST', 'test', 8)];
    expect(oneRunPair(detail(REC, { children: kids }))).toEqual([REC, 'FORK2']);
    expect(oneRunPair(detail(REC, { children: kids }), (id) => id !== 'FORK2')).toEqual([REC, 'FORK1']);
    expect(oneRunPair(detail(REC, { children: [kid('TEST', 'test', 8), kid('CLEAN', 'clean', 1)] }))).toEqual([REC, 'CLEAN']);
    expect(oneRunPair(detail(REC, { children: [kid('TEST', 'test', 8)] }))).toEqual([REC, 'TEST']);
    expect(oneRunPair(detail(FORK, { parent: REC, children: [kid('PROBE', 'fork', 9, true)] }))).toEqual([REC, FORK]);
    expect(oneRunPair(detail(ALONE))).toBeNull();
    // What makes something to compare with: a replay, with the agent's command for a capture, which has none.
    expect(replayCommand(detail(ALONE))).toBe('shadowlap replay 01M5GRYHR0');
    expect(replayCommand(detail(ALONE, { source: 'traffic.har' }))).toBe('shadowlap replay 01M5GRYHR0 -- <your command>');
  });

  it('opens the pair it makes, in place of the address that named one run', async () => {
    const bar = addressBar(`#/compare/${REC}`);
    const client = { run: (id: string) => Promise.resolve(id === REC ? detail(REC, { children: [kid(FORK, 'fork', 5)] }) : detail(id)) };
    page = await render(createElement(AppContext.Provider, { value: app(client) }, createElement(ComparePage, { a: REC, b: null })));
    await page.until('the pair to open', () => bar.hash !== `#/compare/${REC}`);
    expect(bar.hash).toBe(`#/compare/${REC}/${FORK}`);
  });

  it('says there is nothing to compare yet, with the command that makes something', async () => {
    addressBar(`#/compare/${ALONE}`);
    page = await render(createElement(AppContext.Provider, { value: app({ run: () => Promise.resolve(detail(ALONE)) }) }, createElement(ComparePage, { a: ALONE, b: null })));
    await page.until('the run to load', () => page!.all('.stepempty h3').length > 0);
    expect(page.one('.stepempty h3').textContent).toBe('Nothing to compare yet');
    expect(page.one('.stepempty p').textContent).toBe('01M5GRYHR0 has no replay or fork, and no parent. Replay it, or fork it at a call, and the two compare call by call.');
    expect(page.one('.stepempty .cmdline').textContent).toContain('shadowlap replay 01M5GRYHR0');
    expect(page.all('.stepempty .actions a').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Open the run', `#/run/${ALONE}`],
      ['Compare other runs', '#/compare'],
    ]);
  });

  it('names a run the store doesn’t hold', async () => {
    addressBar(`#/compare/${GONE}`);
    page = await render(createElement(AppContext.Provider, { value: app({ run: missing }) }, createElement(ComparePage, { a: GONE, b: null })));
    await page.until('the answer', () => page!.all('.stepempty h3').length > 0);
    expect(page.one('.stepempty h3').textContent).toBe('Not in this store');
    expect(page.one('.stepempty p').textContent).toBe(`No run ${GONE} in this store. Pick two runs to compare, or open Runs to find the one you meant.`);
  });

  it('says an id that starts several runs’ ids matches several runs, not that there is no such run', async () => {
    addressBar(`#/compare/${SEVERAL}`);
    page = await render(createElement(AppContext.Provider, { value: app({ run: several }) }, createElement(ComparePage, { a: SEVERAL, b: null })));
    await page.until('the answer', () => page!.all('.stepempty h3').length > 0);
    expect(page.one('.stepempty h3').textContent).toBe('More than one run');
    expect(page.one('.stepempty p').textContent).toBe(`${SEVERAL} matches several runs; use more of the id. Pick two runs to compare, or open Runs to find the one you meant.`);
  });
});

describe('two runs named', () => {
  const runs = [listed(REC), listed(FORK)];

  it('says the same run on both sides is identical, rather than comparing it with itself', async () => {
    addressBar(`#/compare/${REC}/${REC}`);
    let compared = 0;
    // The server takes a unique prefix of an id for the run.
    const client = { run: (id: string) => Promise.resolve(detail(REC.startsWith(id.toUpperCase()) ? REC : id)), compare: () => (compared++, Promise.resolve({} as CompareView)) };
    page = await render(createElement(AppContext.Provider, { value: app(client, runs) }, createElement(ComparePage, { a: REC, b: REC })));
    await page.until('the panel', () => page!.all('.stepempty h3').length > 0);
    expect(page.one('.stepempty h3').textContent).toBe('The same run on both sides');
    expect(page.one('.stepempty p').textContent).toBe('01M5GRVTKS against itself is identical. Pick another run for A or B.');
    expect(compared).toBe(0);
    // A whole id and a prefix of it name one run too.
    await page.unmount();
    page = await render(createElement(AppContext.Provider, { value: app(client, runs) }, createElement(ComparePage, { a: REC, b: REC.slice(0, 10).toLowerCase() })));
    await page.until('the panel', () => page!.all('.stepempty h3').length > 0);
    expect(page.one('.stepempty h3').textContent).toBe('The same run on both sides');
    expect(compared).toBe(0);
  });

  it('names the run the store doesn’t hold, and the side to pick again', async () => {
    addressBar(`#/compare/${REC}/${GONE}`);
    const client = { run: (id: string) => (id === GONE ? missing() : Promise.resolve(detail(id))), compare: () => Promise.reject(new ApiError(404, 'one of the runs does not exist')) };
    page = await render(createElement(AppContext.Provider, { value: app(client, runs) }, createElement(ComparePage, { a: REC, b: GONE })));
    await page.until('the answer', () => page!.all('.stepempty h3').length > 0);
    expect(page.one('.stepempty h3').textContent).toBe('Not in this store');
    expect(page.one('.stepempty p').textContent).toBe(`No run ${GONE} in this store. Pick another run for B.`);
    // The run pickers stay, to pick it.
    expect(page.all('.rpick').length).toBe(2);
  });

  it('says an id that starts several runs’ ids matches several runs, with the side to name in full', async () => {
    addressBar(`#/compare/${SEVERAL}/${FORK}`);
    const client = { run: (id: string) => (id === SEVERAL ? several() : id === GONE ? missing() : Promise.resolve(detail(id))), compare: () => Promise.reject(new ApiError(409, `run id prefix ${SEVERAL} matches several runs: use more of the id`)) };
    page = await render(createElement(AppContext.Provider, { value: app(client, runs) }, createElement(ComparePage, { a: SEVERAL, b: FORK })));
    await page.until('the answer', () => page!.all('.stepempty h3').length > 0);
    expect(page.one('.stepempty h3').textContent).toBe('More than one run');
    expect(page.one('.stepempty p').textContent).toBe(`${SEVERAL} matches several runs; use more of the id, or pick another run for A.`);
    // With a run the store doesn't hold on the other side, both are said.
    await page.unmount();
    addressBar(`#/compare/${SEVERAL}/${GONE}`);
    page = await render(createElement(AppContext.Provider, { value: app(client, runs) }, createElement(ComparePage, { a: SEVERAL, b: GONE })));
    await page.until('the answer', () => page!.all('.stepempty h3').length > 0);
    expect(page.one('.stepempty h3').textContent).toBe('Not in this store');
    expect(page.one('.stepempty p').textContent).toBe(`No run ${GONE} in this store; ${SEVERAL} matches several runs; use more of the id, or pick another run for A and for B.`);
    // The same prefix on both sides names no run to compare with itself.
    await page.unmount();
    addressBar(`#/compare/${SEVERAL}/${SEVERAL}`);
    page = await render(createElement(AppContext.Provider, { value: app(client, runs) }, createElement(ComparePage, { a: SEVERAL, b: SEVERAL })));
    await page.until('the answer', () => page!.all('.stepempty h3').some((h) => h.textContent === 'More than one run'));
    expect(page.one('.stepempty p').textContent).toBe(`${SEVERAL} matches several runs; use more of the id, or pick another run for A and for B.`);
  });
});
