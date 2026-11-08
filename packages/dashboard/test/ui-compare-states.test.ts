import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompareHead } from '../src/compare.js';
import { ApiError, type Client } from '../ui/api.js';
import { oneRunPair, replayCommand } from '../ui/compare/model.js';
import { ComparePage } from '../ui/pages/Compare.js';
import { useRoute } from '../ui/router.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { CallDetail, CompareView, RunDetail, RunListItem } from '../ui/types.js';
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
    client: { jobs: () => Promise.resolve([]), compareHead: () => Promise.resolve(null), ...client } as unknown as Client,
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
    await page.until('the run to load', () => page!.all('.stepempty h2').length > 0);
    expect(page.one('.stepempty h2').textContent).toBe('Nothing to compare yet');
    expect(page.one('.stepempty p').textContent).toBe('01M5GRYHR0 has no replay or fork, and no parent. Replay it, or fork it at a call, and the two compare call by call.');
    expect(page.one('.stepempty .cmdline').textContent).toContain('shadowlap replay 01M5GRYHR0');
    expect(page.all('.stepempty .actions a').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Open run', `#/run/${ALONE}`],
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
    await page.until('the panel', () => page!.all('.stepempty h2').length > 0);
    expect(page.one('.stepempty h2').textContent).toBe('The same run on both sides');
    expect(page.one('.stepempty p').textContent).toBe('01M5GRVTKS against itself is identical. Pick another run for A or B.');
    expect(compared).toBe(0);
    // A whole id and a prefix of it name one run too.
    await page.unmount();
    page = await render(createElement(AppContext.Provider, { value: app(client, runs) }, createElement(ComparePage, { a: REC, b: REC.slice(0, 10).toLowerCase() })));
    await page.until('the panel', () => page!.all('.stepempty h2').length > 0);
    expect(page.one('.stepempty h2').textContent).toBe('The same run on both sides');
    expect(compared).toBe(0);
  });

  it('shows the identical prefix and the first request that differs while the rest is compared', async () => {
    addressBar(`#/compare/${REC}/${FORK}`);
    let whole: (c: CompareView) => void = () => undefined;
    const head: CompareHead = { a: { runId: REC, calls: 20_000 }, b: { runId: FORK, calls: 20_000 }, identicalPrefix: 19_976, firstRequestDifference: { callNo: 19_977, kind: 'api', name: 'POST /v1/messages', diff: [{ path: '$.system', op: 'changed', before: 'Be thorough.', after: 'Be brief.', what: 'system prompt' }] }, onlyInA: 0, onlyInB: 0, answersDiffer: 0 };
    const client = { run: (id: string) => Promise.resolve(detail(id)), compareHead: () => Promise.resolve(head), compare: () => new Promise<CompareView>((resolve) => (whole = resolve)) };
    page = await render(createElement(AppContext.Provider, { value: app(client, runs) }, createElement(ComparePage, { a: REC, b: FORK })));
    await page.until('the head', () => page!.all('.prefix').length > 0);
    expect(page.one('.prefix').textContent).toBe('#1–#19,976 identical. The first request that differs is #19977.');
    // Each head's sign is drawn for the eye alone, as the structural diff's are.
    expect(page.all('.diffpanel h4').map((h) => h.textContent)).toEqual(['−#19977 in 01M5GRVTKS', '+#19977 in 01M5GRXFM1']);
    expect(page.all('.diffpanel h4 .js').every((s) => s.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(page.one('.cmpwait[role="status"]').textContent).toBe('Comparing the rest: what changed between the two runs and where each went from #19977…');
    // The whole comparison takes its place once it comes.
    whole({ ...head, prefix: [], responseDifferences: [], after: null, changes: { systemPrompt: true, systems: { a: ['x'], b: ['y'] }, tools: { added: [], removed: [], redefined: false }, models: { a: [], b: [] }, code: { a: null, b: null } }, intervention: null, code: null });
    await page.until('the whole comparison', () => page!.all('.cmpwait').length === 0 && page!.all('.cmpfacts').length > 0);
    expect(page.all('.cmpfacts p').map((p) => p.textContent)).toEqual(['System prompt changed', 'Code, tools and model unchanged']);
  });

  it('keeps the head when the rest can’t be worked out in the time a request has, and says how to work it out', async () => {
    addressBar(`#/compare/${REC}/${FORK}`);
    const head: CompareHead = { a: { runId: REC, calls: 100_000 }, b: { runId: FORK, calls: 100_000 }, identicalPrefix: 99_976, firstRequestDifference: { callNo: 99_977, kind: 'api', name: 'POST /v1/messages', diff: [{ path: '$.system', op: 'changed', before: 'Be thorough.', after: 'Be brief.', what: 'system prompt' }] }, onlyInA: 0, onlyInB: 0, answersDiffer: 0 };
    const client = { run: (id: string) => Promise.resolve(detail(id)), compareHead: () => Promise.resolve(head), compare: () => Promise.reject(new ApiError(503, 'a compare job took more than 2 minutes, so it was stopped')) };
    page = await render(createElement(AppContext.Provider, { value: app(client, runs) }, createElement(ComparePage, { a: REC, b: FORK })));
    await page.until('the answer', () => page!.all('.cmpwait').some((w) => w.textContent.includes('could not')));
    expect(page.one('.prefix').textContent).toBe('#1–#99,976 identical. The first request that differs is #99977.');
    expect(page.all('.diffpanel h4').map((h) => h.textContent)).toEqual(['−#99977 in 01M5GRVTKS', '+#99977 in 01M5GRXFM1']);
    expect(page.one('.cmpwait[role="status"] p').textContent).toBe(
      'The rest, what changed between the two runs and where each went from #99977, could not be worked out here: a compare job took more than 2 minutes, so it was stopped. What shows above is whole. A terminal compares the two runs with no time limit:',
    );
    expect(page.one('.cmpwait .cmdline').textContent).toBe('$shadowlap diff 01M5GRVTKS 01M5GRXFM1');
    expect(page.all('.empty')).toEqual([]);
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

describe('picking another run', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the focus on the picker used, as the page compares the new pair', async () => {
    // The address bar as a browser has it: set, it tells the page (hashchange) in a task of its own, after what set it has drawn, and the router follows.
    let hash = `#/compare/${REC}/${FORK}`;
    const location = {
      pathname: '/',
      search: '',
      get hash() {
        return hash;
      },
      set hash(to: string) {
        hash = to;
        setTimeout(() => window.dispatchEvent(new Event('hashchange')));
      },
    };
    Object.assign(g, { location, history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => (hash = url.slice(url.indexOf('#'))) } });
    // What the list of runs reads to place itself under its button.
    vi.stubGlobal('innerWidth', 1440);
    vi.stubGlobal('innerHeight', 900);
    vi.stubGlobal('addEventListener', () => undefined);
    vi.stubGlobal('removeEventListener', () => undefined);
    const client = { run: (id: string) => Promise.resolve(detail(id)), compare: () => new Promise<CompareView>(() => undefined) };
    function Routed() {
      const route = useRoute();
      return createElement('main', { id: 'view', tabIndex: -1 }, route.page === 'compare' ? createElement(ComparePage, { a: route.a, b: route.b }) : null);
    }
    page = await render(createElement(AppContext.Provider, { value: app(client, [listed(REC), listed(FORK), listed(ALONE)]) }, createElement(Routed)));
    const pickerA = () => page!.all('.rpick').find((b) => b.getAttribute('aria-label')?.startsWith('Run A:'))!;
    await page.click(pickerA());
    await page.until('the list of runs', () => page!.all('[role="listbox"] [role="option"]').length > 0);
    await page.click(page.all('[role="listbox"] [role="option"]').find((o) => o.textContent.includes(ALONE.slice(0, 10)))!);
    await page.until('the new pair', () => pickerA().getAttribute('aria-label')!.startsWith(`Run A: ${ALONE.slice(0, 10)}`));
    expect(hash).toBe(`#/compare/${ALONE}/${FORK}`);
    // The button picked with keeps the focus, where the next Tab or Enter goes on from.
    expect(page.focused()).toBe(pickerA());
  });
});

describe('the whole comparison', () => {
  // The --fail-at 19=529 fork of the recording: the recording refunded and answered; the fork got HTTP 529 at #19 and stopped.
  const failAt = { run: 'b' as const, kind: 'fail' as const, flag: '--fail-at 19=529', callNo: 19, name: 'POST /v1/messages', before: 'an answer', after: 'HTTP 529', words: '#19 got HTTP 529 instead of an answer' };
  const call = (callNo: number, o: Record<string, unknown> = {}) => ({ callNo, kind: 'api', name: 'POST /v1/messages', effect: null, origin: 'replayed', input: false, failure: null, decision: null, args: null, ...o });
  const refund = { stop: 'tools', stopReason: 'tool_use', tools: [{ name: 'issue_refund', args: { order: 'A-1', amount: 240 }, effect: 'write' }], text: '', stops: 'calls tools' };
  const pair = {
    from: { a: 19, b: 19 },
    verdict: { words: 'Different endings', where: 'after #18', tone: 'warn' },
    endings: {
      a: { failures: null, writes: [{ fate: null, tools: [{ tool: 'issue_refund', count: 1 }] }], end: { kind: 'answered', callNo: 21 }, quit: false },
      b: { failures: null, writes: [], end: { kind: 'stopped', callNo: 19, status: 529 }, quit: true },
    },
    rows: [
      { n: 19, a: call(19, { decision: refund }), b: call(19, { origin: 'injected', failure: { status: 529, by: 'injected' } }), alike: false, similar: false },
      { n: 20, a: call(20, { kind: 'tool', name: 'issue_refund', effect: 'write', args: '{"order":"A-1","amount":240}' }), b: null, alike: false, similar: false },
    ],
    more: 0,
  };
  const view = { a: { runId: REC, calls: 21 }, b: { runId: FORK, calls: 19 }, identicalPrefix: 18, firstRequestDifference: null, onlyInA: 2, onlyInB: 0, prefix: [], after: null, code: null, intervention: failAt, responseDifferences: [{ callNo: 19, kind: 'api', name: 'POST /v1/messages', detail: 'got HTTP 529 instead of an answer', by: '--fail-at 19=529' }], changes: { systemPrompt: false, systems: { a: ['x'], b: ['x'] }, tools: { added: [], removed: [], redefined: false }, models: { a: ['claude-sonnet-5'], b: ['claude-sonnet-5'] }, code: { a: 'a7b3c2e', b: 'a7b3c2e' } }, pair } as unknown as CompareView;
  const run = (id: string, parent: string | null) => ({ ...detail(id, { parent }), summary: { total: 21, byKind: { api: 11, tool: 10 }, cost: { spent: 0.051, captured: 0, unknownModels: [] } }, callsTotal: id === REC ? 21 : 19, checks: [] }) as unknown as RunDetail;
  const detailOf = (id: string, n: number) => ({ call: { callNo: n, kind: n === 20 ? 'tool' : 'api', name: 'x', origin: id === FORK ? 'injected' : 'replayed', outcome: id === FORK ? 'error' : 'ok', status: id === FORK ? 529 : null, attempts: 2, latencyMs: 1200, usage: null, cost: null, error: null }, request: { args: { order: 'A-1', amount: 240 } }, result: { result: { refunded: true } } }) as unknown as CallDetail;
  const client = { run: (id: string) => Promise.resolve(run(id, id === FORK ? REC : null)), compare: () => Promise.resolve(view), call: (id: string, n: number) => Promise.resolve(detailOf(id, n)) };
  function Routed() {
    const route = useRoute();
    return createElement('main', { id: 'view', tabIndex: -1 }, route.page === 'compare' ? createElement(ComparePage, { a: route.a, b: route.b, call: route.call }) : null);
  }

  it('leads with the verdict and a line a run, then both paths in one list, a row a call', async () => {
    addressBar(`#/compare/${REC}/${FORK}`);
    page = await render(createElement(AppContext.Provider, { value: app(client, [listed(REC), listed(FORK)]) }, createElement(Routed)));
    await page.until('the comparison', () => page!.all('.cprow').length > 0);
    // Its word is in the heading for a screen reader, drawn apart in its colour.
    // Its words glued, so `#18` never starts a line of its own.
    expect(page.one('.verdict.cmpv h2').textContent.replace(/\s/g, ' ')).toBe('Different endings after #18');
    expect(page.one('.verdict.cmpv .vw.warn').textContent).toBe('Different endings');
    const line = (i: number) => page!.all('.cmpends > span')[i].textContent;
    expect(page.all('.cmpends > code').map((c) => c.textContent)).toEqual(['01M5GRVTKS', '01M5GRXFM1']);
    expect(line(0)).toBe('issue_refund · answered at #21 · ≈$0.051 spent');
    expect(line(1)).toBe('no write · stopped at #19 on HTTP 529 · ≈$0.051 spent');
    expect(page.all('.cmpfacts p').map((p) => p.textContent)).toEqual(['Code, system prompt, tools and model unchanged']);
    // What made the fork carries its card.
    expect(page.one('.prefix .lead').textContent).toBe('#19 got HTTP 529 instead of an answer');
    expect(page.one('.prefix .lead').getAttribute('data-tip')).toContain('--fail-at 19=529');
    expect(page.one('.paths2').getAttribute('role')).toBe('group');
    expect(page.one('.paths2').getAttribute('aria-label')).toBe('Both runs after the identical prefix, a row a call');
    expect(page.all('.cph .pk').map((p) => p.textContent)).toEqual(['recording · 3 calls after #18', 'replay · 1 call after #18']);
    const rows = page.all('button.cprow');
    expect(rows.map((r) => r.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
    // Each side says whose call it is, and the heard space between a call, its effect and its origin.
    expect(rows[0].textContent).toBe('#19 01M5GRVTKS: →\u00a0issue_refund {"order":"A-1","amount":240} replayed 01M5GRXFM1: HTTP 529 injected');
    expect(rows[1].textContent).toBe('#20 01M5GRVTKS: issue_refund write replayed 01M5GRXFM1: no call');
    expect(page.all('.pside.none')).toHaveLength(1);
  });

  it('opens both calls under a row as its address says, and closes them from the row or its ×', async () => {
    const bar = addressBar(`#/compare/${REC}/${FORK}`);
    page = await render(createElement(AppContext.Provider, { value: app(client, [listed(REC), listed(FORK)]) }, createElement(Routed)));
    await page.until('the comparison', () => page!.all('button.cprow').length > 0);
    const row = () => page!.all('button.cprow')[0];
    await page.click(row());
    expect(bar.hash).toBe(`#/compare/${REC}/${FORK}/19`);
    await page.until('the row opened', () => page!.all('#cmpd').length > 0 && page!.all('.cmpnote').length > 0);
    expect(row().getAttribute('aria-expanded')).toBe('true');
    expect(row().getAttribute('aria-controls')).toBe('cmpd');
    // The row keeps the focus.
    expect(page.focused()).toBe(row());
    expect(page.one('#cmpd').getAttribute('aria-label')).toBe('#19 in both runs');
    expect(page.one('#cmpd .cmpx').getAttribute('aria-label')).toBe('Close #19');
    expect(page.one('#cmpd .dtool b').textContent).toBe('issue_refund');
    expect(page.one('#cmpd .dstop').textContent).toBe('calls tools');
    expect(page.one('#cmpd .cmpnote').textContent).toBe('Never sent. Shadowlap answered with HTTP 529 (--fail-at 19=529), 3 attempts.');
    expect(page.all('#cmpd a.more').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Open run at #19, 01M5GRVTKS', `#/run/${REC}/19`],
      ['Open run at #19, 01M5GRXFM1', `#/run/${FORK}/19`],
    ]);
    // Pressed again, it closes; so does its ×, the focus back on the row.
    await page.click(row());
    expect(bar.hash).toBe(`#/compare/${REC}/${FORK}`);
    await page.until('the row closed', () => page!.all('#cmpd').length === 0);
    await page.click(page.all('button.cprow')[1]);
    await page.until('the second row opened', () => page!.all('#cmpd').length > 0);
    expect(page.one('#cmpd .cmpnone').textContent).toBe('No call: the run had ended.');
    await page.click(page.one('#cmpd .cmpx'));
    expect(bar.hash).toBe(`#/compare/${REC}/${FORK}`);
    await page.until('the row closed', () => page!.all('#cmpd').length === 0);
    expect(page.focused()).toBe(page.all('button.cprow')[1]);
  });

  it('opens the row its address names when the page loads, and none for a call past the rows', async () => {
    addressBar(`#/compare/${REC}/${FORK}/20`);
    page = await render(createElement(AppContext.Provider, { value: app(client, [listed(REC), listed(FORK)]) }, createElement(Routed)));
    await page.until('the row opened', () => page!.all('#cmpd').length > 0);
    expect(page.one('#cmpd').getAttribute('aria-label')).toBe('#20 in both runs');
    await page.unmount();
    addressBar(`#/compare/${REC}/${FORK}/4`);
    page = await render(createElement(AppContext.Provider, { value: app(client, [listed(REC), listed(FORK)]) }, createElement(Routed)));
    await page.until('the comparison', () => page!.all('button.cprow').length > 0);
    expect(page.all('#cmpd')).toHaveLength(0);
  });

  const shown = async (c: Partial<Client>, hash: string, what: () => boolean) => {
    addressBar(hash);
    page = await render(createElement(AppContext.Provider, { value: app(c, [listed(REC), listed(FORK)]) }, createElement(Routed)));
    await page.until('the comparison', what);
  };

  it('reads both calls before it draws the opened row, saying it loads, and why with Retry where one can’t be read', async () => {
    let fail = true;
    let release = (): void => undefined;
    const held = new Promise<void>((r) => (release = r));
    const asked: string[] = [];
    const call = async (id: string, n: number) => {
      asked.push(`${id}:${n}`);
      await held;
      if (id === FORK && fail) throw new ApiError(500, 'the store could not be read');
      return detailOf(id, n);
    };
    await shown({ ...client, call }, `#/compare/${REC}/${FORK}/19`, () => page!.all('#cmpd .skel').length > 0);
    expect(page.one('#cmpd .skel [role="status"]').textContent).toBe('Loading #19 in both runs…');
    // Neither side is drawn against nothing meanwhile.
    expect(page.all('#cmpd .cmpdx, #cmpd .cmpk')).toHaveLength(0);
    release();
    await page.until('the failure said', () => page!.all('#cmpd .loaderr').length > 0);
    expect(page.one('#cmpd .loaderr').textContent).toBe('couldn’t loadThe store could not be readRetry');
    expect(page.all('#cmpd .cmpdx, #cmpd .skel')).toHaveLength(0);
    fail = false;
    await page.click(page.one('#cmpd .loaderr button'));
    await page.until('both calls', () => page!.all('#cmpd .cmpnote').length > 0);
    // Only the call that failed is asked for again.
    expect(asked.sort()).toEqual([`${FORK}:19`, `${FORK}:19`, `${REC}:19`].sort());
  });

  it('numbers a row by its place, once, where a judge’s call sits between one run’s calls, each side opening its own call', async () => {
    const judged = {
      ...pair,
      rows: [
        { n: 19, a: call(20, { decision: refund }), b: call(19, { failure: { status: null, by: 'provider' } }), alike: false, similar: false },
        { n: 20, a: null, b: call(20, { kind: 'tool', name: 'issue_refund', effect: 'write', args: '{"order":"A-1","amount":240}' }), alike: false, similar: false },
      ],
    };
    const asked: string[] = [];
    const hungUp = (id: string, n: number) => {
      asked.push(`${id}:${n}`);
      const d = detailOf(id, n);
      return Promise.resolve(id === FORK ? { ...d, call: { ...d.call, origin: 'live', status: null, error: 'socket hang up' } } : d);
    };
    await shown({ ...client, compare: () => Promise.resolve({ ...view, pair: judged }), call: hungUp }, `#/compare/${REC}/${FORK}/19`, () => page!.all('#cmpd .cmpnote').length > 0);
    expect(page.all('button.cprow').map((r) => [r.getAttribute('data-n'), r.querySelector('.cpn')!.textContent])).toEqual([
      ['19', '#19'],
      ['20', '#20'],
    ]);
    expect(page.all('#cmpd')).toHaveLength(1);
    expect(asked.sort()).toEqual([`${REC}:20`, `${FORK}:19`]);
    expect(page.all('#cmpd a.more').map((a) => a.getAttribute('href'))).toEqual([`#/run/${REC}/20`, `#/run/${FORK}/19`]);
    // A failure with no status heads its side as its row says it, not with a status it never got.
    expect(page.one('#cmpd .cmperr').textContent).toBe('failed');
    expect(page.one('#cmpd .cmpnote').textContent).toBe('Failed. socket hang up.');
  });

  it('draws a row both made alike on one dimmed line, nothing in it marked', async () => {
    const send = { ...refund, tools: [{ name: 'send_email', args: { to: 'customer@example.com', body: 'Your refund of $240 is on its way. '.repeat(6) }, effect: 'write' }] };
    const alike = { ...pair, rows: [{ n: 19, a: call(19, { decision: send }), b: call(19, { decision: send }), alike: true, similar: false }] };
    await shown({ ...client, compare: () => Promise.resolve({ ...view, pair: alike }) }, `#/compare/${REC}/${FORK}`, () => page!.all('button.cprow').length > 0);
    expect(page.all('.pside.same')).toHaveLength(2);
    expect(page.all('.pdec.wrap, .cprow mark, .cprow wbr')).toHaveLength(0);
  });

  it('names the other run where a decision calls a tool it doesn’t, for a screen reader, and heads a tool’s values with its cost and time', async () => {
    const escalate = { ...refund, tools: [{ name: 'escalate', args: { team: 'billing' }, effect: 'write' }] };
    const decided = { ...pair, rows: [{ n: 19, a: call(19, { decision: refund }), b: call(19, { decision: escalate }), alike: false, similar: false }, pair.rows[1]] };
    await shown({ ...client, compare: () => Promise.resolve({ ...view, pair: decided }) }, `#/compare/${REC}/${FORK}/19`, () => page!.all('#cmpd .dtool').length === 2);
    expect(page.all('#cmpd .dtool .sr').map((s) => s.textContent)).toEqual([', not called in 01M5GRXFM1', ', not called in 01M5GRVTKS']);
    await page.click(page.all('button.cprow')[1]);
    await page.until('the tool’s row', () => page!.all('#cmpd .cmptool').length > 0);
    // Its run, its call, what it cost and took, then its arguments and result, then the way to its run.
    const order = [...page.all('#cmpd .cmpdc')[0].children].filter((e) => e.tagName === 'P' || e.tagName === 'A').map((e) => e.className);
    expect(order).toEqual(['cmpwho', 'cmptool', 'cmpmeta', 'cmpk', 'cmpk', 'more']);
  });

  it('says a side still records under the lines it draws with no verdict, and counts the calls past the rows', async () => {
    const recording = { ...pair, verdict: null, endings: { ...pair.endings, b: { failures: null, writes: [], end: { kind: 'running', callNo: 19 }, quit: false } }, more: 3 };
    const live = (id: string) => {
      const r = run(id, id === FORK ? REC : null);
      return Promise.resolve(id === FORK ? { ...r, run: { ...r.run, status: 'running' } } : r);
    };
    await shown({ ...client, run: live, compare: () => Promise.resolve({ ...view, pair: recording }) }, `#/compare/${REC}/${FORK}`, () => page!.all('button.cprow').length > 0);
    expect(page.all('.verdict')).toHaveLength(0);
    expect(page.all('p.cmpv.cmplive .cmpends > span').map((l) => l.textContent)).toEqual(['issue_refund · answered at #21 · ≈$0.051 spent', 'no write · still running · ≈$0.051 spent']);
    expect(page.all('.cmpmore').map((p) => p.textContent)).toEqual(['… 3 more calls', 'recording · more calls as they arrive']);
  });

  it('names each side by its run’s own id where the address names it otherwise, which a row’s address keeps', async () => {
    const [a, b] = [REC.slice(0, 10).toLowerCase(), FORK.slice(0, 10).toLowerCase()];
    const bar = addressBar(`#/compare/${a}/${b}`);
    page = await render(createElement(AppContext.Provider, { value: app({ ...client, run: (id: string) => Promise.resolve(id === a ? run(REC, null) : run(FORK, REC)) }, [listed(REC), listed(FORK)]) }, createElement(Routed)));
    await page.until('the comparison', () => page!.all('button.cprow').length > 0);
    expect(page.all('.cph > code').map((c) => c.textContent)).toEqual(['01M5GRVTKS', '01M5GRXFM1']);
    expect(page.all('button.cprow')[0].textContent).toContain('01M5GRVTKS: ');
    await page.click(page.all('button.cprow')[0]);
    expect(bar.hash).toBe(`#/compare/${a}/${b}/19`);
    await page.until('the row opened', () => page!.all('#cmpd .cmpnote').length > 0);
    expect(page.all('#cmpd .cmpwho').map((w) => w.textContent)).toEqual(['01M5GRVTKS', '01M5GRXFM1']);
  });
});
