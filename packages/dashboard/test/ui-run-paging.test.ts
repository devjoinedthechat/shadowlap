import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallRow, CallsPage, Client, RunDetail } from '../ui/api.js';
import { RunPage } from '../ui/pages/Run.js';
import { CallsTable } from '../ui/run/CallsView.js';
import { PAGES_AFTER_MS, usePagedRun } from '../ui/run/paged-run.js';
import { followPages, listedCalls, nextRead, PAGE, rangeOf, withPage, withRange } from '../ui/run/paging.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A run's calls come a page at a time (contract 8): its page comes with the first of them, how many
 * it has and every call's origin. The page lists every call from the start, each not read yet as its
 * number and origin; it reads the page that holds the call it opens on, or one asked for, before the
 * others, then the rest in order, one page after another. A recording's page reads them all at once:
 * it follows its newest call.
 */

const RUN = '01M5GRX8K406H4KHQ7DEKYWTSZ';
const T = 1_760_000_000_000;

/** The calls a fork replayed before it went on live. */
const REPLAYED = 600;

/** A model call, then the tool call it asked for, over and over: replayed up to REPLAYED, then live. */
function call(callNo: number): CallRow {
  const api = callNo % 2 === 1;
  return {
    callNo,
    kind: api ? 'api' : 'tool',
    name: api ? 'POST /v1/messages' : 'read_file',
    origin: callNo <= REPLAYED ? 'replayed' : 'live',
    effect: api ? null : 'read',
    outcome: 'ok',
    status: api ? 200 : null,
    latencyMs: 900,
    model: api ? 'claude-opus-5' : null,
    stopReason: api ? 'tool_use' : null,
    usage: api ? { input: 800, output: 40, cacheRead: 4000, cacheWrite: 0 } : null,
    cost: null,
    bytes: null,
    detail: api ? '' : `{"path":"notes/${callNo}.md"}`,
    attempts: 0,
    replayedFrom: null,
    error: null,
    startedAt: T + callNo * 1000,
    endedAt: T + callNo * 1000 + 900,
    ttftMs: null,
    scope: null,
    resultShort: api ? null : `note ${callNo}`,
    conversation: 1,
    conversationStart: callNo === 1,
    requestedBy: api ? null : callNo - 1,
    toolUseId: null,
    cacheMiss: null,
    recordedMs: null,
    asks: api ? ['read_file'] : null,
  } as unknown as CallRow;
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** A run of `total` calls as its page answers it: the first `first` of them, and every call's origin. */
function answer(total: number, first: number, status = 'completed'): RunDetail {
  const calls = range(1, Math.min(first, total)).map(call);
  return {
    run: { runId: RUN, parentRunId: null, mode: 'record', status, divergence: null, command: { argv: ['node', 'agent.mjs'], cwd: '/work' }, codeVersion: null, startedAt: T, endedAt: status === 'running' ? null : T + total * 1000, meta: { labels: [] } },
    label: 'recording',
    about: { text: 'Read the notes and write a report', from: 'user' },
    source: null,
    summary: { runId: RUN, mode: 'record', status, total, byOrigin: { live: total }, byKind: { api: Math.ceil(total / 2), tool: Math.floor(total / 2), clock: 0, random: 0 }, upstreamRequests: total, injected: 0, refused: 0, imported: false, tokensNotRespent: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, cost: { spent: 0.5, saved: 0, captured: 0 }, durationMs: total * 1000, notReached: 0 },
    calls,
    callsTotal: total,
    callsNext: first < total ? first + 1 : null,
    ...(first < total ? { origins: 'r'.repeat(Math.min(total, REPLAYED)) + 'l'.repeat(Math.max(0, total - REPLAYED)) } : {}),
    parent: null,
    children: [],
    attempts: 0,
    actions: [],
    models: {},
    fix: null,
    state: { status, kind: 'recording', outcome: { kind: 'none' }, failed: false, interrupted: false, endedAt: T + total * 1000, label: 'recording' },
  } as unknown as RunDetail;
}

/** A server with a run of `total` calls: what the page asked for, a page at a time. */
function server(total: number, first: number, status = 'completed') {
  const asked: Array<{ from: number; limit: number }> = [];
  const details: number[] = [];
  const client = {
    exported: false,
    run: () => Promise.resolve(answer(total, first, status)),
    calls: (_id: string, from: number, limit = PAGE): Promise<CallsPage> => {
      asked.push({ from, limit });
      const to = Math.min(total, from + Math.min(limit, PAGE) - 1);
      return Promise.resolve({ runId: RUN, calls: range(from, to).map(call), callsTotal: total, callsNext: to < total ? to + 1 : null });
    },
    // The inspector's details of the selected call.
    call: (_id: string, n: number) => (details.push(n), new Promise(() => undefined)),
    offers: () => Promise.resolve(null),
    runChaos: () => Promise.resolve(null),
    forkDifferences: () => Promise.resolve(null),
    lineage: () => Promise.resolve([]),
  } as unknown as Client;
  return { client, asked, details };
}

const app = (client: Client) =>
  ({
    client,
    exported: false,
    meta: null,
    runs: [],
    live: [],
    tick: 0,
    runsTick: 0,
    feeds: {},
    jobs: [],
    actionsOff: null,
    hasKind: () => false,
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: () => undefined,
    refresh: () => undefined,
    registerLayer: () => () => undefined,
    setRunCommands: () => undefined,
    setPalette: () => undefined,
    runKeys: { current: null },
  }) as unknown as AppState;

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.unstubAllGlobals();
});

/** The address bar the run page reads and rewrites as the selection moves. */
function addressBar(hash: string) {
  const location = { hash, search: '', pathname: '/' };
  vi.stubGlobal('location', location);
  vi.stubGlobal('history', { state: null, replaceState: (_s: unknown, _t: string, url: string) => void (location.hash = url.slice(url.indexOf('#'))) });
  return location;
}

const rows = () => r!.all('table.calls tbody tr[data-wi]');
const pending = () => r!.all('table.calls tbody tr[aria-busy]');

describe('the pages a run’s calls come in', () => {
  it('reads around a call asked for, within the gap it is in, else from the first call not read', () => {
    const first = withRange([], 1, 200);
    expect(nextRead(first, null)).toEqual({ from: 201, limit: PAGE });
    // Call 1,000 asked for: from a hundred calls before it.
    expect(nextRead(first, 1000)).toEqual({ from: 900, limit: PAGE });
    const around = withRange(first, ...rangeOf(900, { callsNext: null }));
    expect(around).toEqual([
      [1, 200],
      [900, Infinity],
    ]);
    // The gap left: a page, then the rest of it.
    expect(nextRead(around, null)).toEqual({ from: 201, limit: PAGE });
    expect(nextRead(withRange(around, 201, 700), null)).toEqual({ from: 701, limit: 199 });
    expect(nextRead(withRange(withRange(around, 201, 700), 701, 899), null)).toBeNull();
    // A call asked for that is read: the first not read.
    expect(nextRead(around, 950)).toEqual({ from: 201, limit: PAGE });
  });

  it('lists every call, a placeholder with its origin for each not read, and merges pages by call number', () => {
    const have = withPage(range(1, 3).map(call), [call(6), call(5)].sort((a, b) => a.callNo - b.callNo));
    expect(have.map((c) => c.callNo)).toEqual([1, 2, 3, 5, 6]);
    const listed = listedCalls(have, 7, ['live', 'rep', 'rep', 'block', 'live', 'live', 'fail']);
    expect(listed.map((c) => ('pending' in c ? `${c.callNo}?${c.origin}` : c.callNo))).toEqual([1, 2, 3, '4?block', 5, 6, '7?fail']);
  });

  it('follows a recording’s pages to its end', async () => {
    const { client, asked } = server(1200, 500, 'running');
    const whole = await followPages(client, answer(1200, 500, 'running'));
    expect(asked).toEqual([
      { from: 501, limit: PAGE },
      { from: 1001, limit: PAGE },
    ]);
    expect(whole.calls.map((c) => c.callNo)).toEqual(range(1, 1200));
    expect(whole).toMatchObject({ callsTotal: 1200, callsNext: null });
    expect(whole.origins).toBeUndefined();
  });
});

describe('a long run’s page', () => {
  it('lists every call at once, then reads the pages after the first in order', async () => {
    addressBar(`#/run/${RUN}`);
    const { client, asked } = server(1200, 200);
    r = await render(createElement(AppContext.Provider, { value: app(client) }, createElement(RunPage, { id: RUN, call: null, view: null })));
    await r.until('the calls', () => rows().length > 0);
    // Every call is listed from the start; those drawn are read.
    expect(r.one('table.calls').getAttribute('aria-rowcount')).toBe('1201');
    expect(r.one('[role="tablist"] [aria-selected="true"] .count').textContent).toBe('1,200');
    expect(r.byText('.toolbar[role="status"]', '200 of 1,200 calls read so far; the rest are on their way.')).toBeTruthy();
    // The run's numbers count every call's origin, not those of the calls read: 200, all replayed.
    expect(r.all('.metrics .metric').map((m) => m.textContent)).toEqual(expect.arrayContaining(['600replayed', '600live']));
    // The pages after it, after a moment, in order.
    expect(asked).toEqual([]);
    await r.wait(PAGES_AFTER_MS + 50);
    await r.until('every page', () => asked.length === 2 && r!.all('.toolbar[role="status"]').length === 0);
    expect(asked).toEqual([
      { from: 201, limit: PAGE },
      { from: 701, limit: PAGE },
    ]);
    expect(pending()).toHaveLength(0);
  });

  it('reads the page of the call it opens on first, and shows that call once it is read', async () => {
    const bar = addressBar(`#/run/${RUN}/1000`);
    const { client, asked, details } = server(1200, 200);
    r = await render(createElement(AppContext.Provider, { value: app(client) }, createElement(RunPage, { id: RUN, call: 1000, view: null })));
    // The inspector asks for the call's details once its row is read: the call opened on, not the first.
    await r.until('call 1000’s details', () => details.length > 0);
    expect(details).toEqual([1000]);
    expect(asked[0]).toEqual({ from: 900, limit: PAGE });
    expect(bar.hash).toBe(`#/run/${RUN}/1000`);
    // Then the gap before it, a page at a time.
    await r.until('every page', () => r!.all('.toolbar[role="status"]').length === 0);
    expect(asked).toEqual([
      { from: 900, limit: PAGE },
      { from: 201, limit: PAGE },
      { from: 701, limit: 199 },
    ]);
  });

  it('says when a page could not be read, and tries again when a call is asked for', async () => {
    const { client, asked } = server(1200, 200);
    let fail = true;
    const flaky = { ...client, calls: (id: string, from: number, limit?: number) => (fail ? ((fail = false), Promise.reject(new Error('the server stopped'))) : client.calls(id, from, limit)) } as unknown as Client;
    const out: { current: ReturnType<typeof usePagedRun> | null } = { current: null };
    function Host() {
      out.current = usePagedRun(flaky, answer(1200, 200));
      return null;
    }
    r = await render(createElement(Host));
    await r.until('the error', () => out.current?.paging?.error === 'the server stopped');
    expect(out.current!.run.calls).toHaveLength(200);
    // Nothing more is asked for until a call is.
    await r.wait(PAGES_AFTER_MS + 50);
    expect(asked).toEqual([]);
    out.current!.paging!.need(1000);
    await r.until('every page', () => out.current!.paging === null);
    expect(asked[0]).toEqual({ from: 900, limit: PAGE });
    expect(out.current!.run.calls.map((c) => c.callNo)).toEqual(range(1, 1200));
    expect(out.current!.run).toMatchObject({ callsNext: null });
    expect(out.current!.run.origins).toBeUndefined();
  });

  it('asks for the page of a call not read yet when its row is drawn', async () => {
    const needed: number[] = [];
    const listed = listedCalls([], 1200, null);
    r = await render(createElement(CallsTable, { calls: listed, asked: null, selected: null, scoped: false, forkAt: null, lostAt: null, ancestors: [], live: false, canFork: false, onSelect: () => undefined, onFork: () => undefined, onNeed: (n: number) => void needed.push(n) }));
    await r.until('a page asked for', () => needed.length > 0);
    expect(needed[0]).toBe(1);
    expect(pending().length).toBeGreaterThan(0);
    expect(r.all('table.calls tbody tr[aria-busy] td.name')[0]!.textContent).toBe('Reading…');
  });

  it('reads a recording’s pages before it shows it: its page follows the newest call', async () => {
    addressBar(`#/run/${RUN}`);
    const { client, asked } = server(1200, 500, 'running');
    const live = { ...app(client), live: [{ runId: RUN, calls: 1200 }] } as unknown as AppState;
    r = await render(createElement(AppContext.Provider, { value: live }, createElement(RunPage, { id: RUN, call: null, view: null })));
    await r.until('the calls', () => rows().length > 0);
    expect(asked).toEqual([
      { from: 501, limit: PAGE },
      { from: 1001, limit: PAGE },
    ]);
    expect(r.one('table.calls').getAttribute('aria-rowcount')).toBe('1201');
    expect(pending()).toHaveLength(0);
    expect(r.all('.toolbar[role="status"]')).toHaveLength(0);
  });
});
