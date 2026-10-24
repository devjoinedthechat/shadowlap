import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallRow, CallsPage, Client, RunDetail } from '../ui/api.js';
import type { Origin7 } from '../ui/origins.js';
import { RunPage } from '../ui/pages/Run.js';
import { firstFailedCall, firstStep, openingCall, type OpenCall } from '../ui/run/open-at.js';
import { PAGE } from '../ui/run/paging.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Where a run's page opens when its link names no call: a fork where it forked, a run blame found
 * lost where it was lost, a recording at its newest call, any other failed run at its first call
 * that failed, else at its first call; never on a clock or random read, which holds a value rather
 * than a step of the agent's.
 */

const RUN = '01M5GRX8K406H4KHQ7DEKYWTSZ';
const T = 1_760_000_000_000;

const oc = (callNo: number, kind: string, outcome: 'ok' | 'error' | null = 'ok', origin = 'live'): OpenCall => ({ callNo, kind, outcome, origin });

describe('where a run opens', () => {
  const run = [oc(1, 'clock'), oc(2, 'random'), oc(3, 'api'), oc(4, 'tool', 'error'), oc(5, 'api', 'error'), oc(6, 'tool')];

  it('opens a failed run at its first call that failed', () => {
    expect(openingCall({ forkAt: null, lostAt: null, live: false, failed: true, calls: run })).toBe(4);
    // A run that didn't fail opens at its first step, though a call in it failed and was retried past.
    expect(openingCall({ forkAt: null, lostAt: null, live: false, failed: false, calls: run })).toBe(3);
  });

  it('keeps the fork, the lost call and a recording’s newest call first', () => {
    expect(openingCall({ forkAt: 6, lostAt: 5, live: false, failed: true, calls: run })).toBe(6);
    expect(openingCall({ forkAt: null, lostAt: 5, live: false, failed: true, calls: run })).toBe(5);
    expect(openingCall({ forkAt: null, lostAt: null, live: true, failed: false, calls: run })).toBe(6);
  });

  it('never opens on a clock or random read, unless the run made only those', () => {
    expect(firstStep(run)).toBe(3);
    expect(firstStep([oc(1, 'clock'), oc(2, 'random')])).toBe(1);
    expect(firstStep([])).toBeNull();
    // A failed clock read is no step either.
    expect(firstFailedCall([oc(1, 'clock', 'error'), oc(2, 'api'), oc(3, 'tool', 'error')])).toBe(3);
    // A failed run whose calls all went well (it failed a check) opens at its first step.
    expect(openingCall({ forkAt: null, lostAt: null, live: false, failed: true, calls: [oc(1, 'clock'), oc(2, 'api'), oc(3, 'tool')] })).toBe(2);
  });

  it('passes over a write fenced after a fork and a failure --fail-at played in: they failed on purpose', () => {
    expect(firstFailedCall([oc(1, 'api'), oc(2, 'tool', 'error', 'blocked'), oc(3, 'tool', 'error', 'stubbed'), oc(4, 'api', 'error', 'injected'), oc(5, 'tool', 'error', 'replayed')])).toBe(5);
    expect(firstFailedCall([oc(1, 'api'), oc(2, 'tool', 'error', 'blocked')])).toBeNull();
  });

  it('finds a failure past the calls read from every call’s origin while a long run’s pages come', () => {
    const origins: Origin7[] = Array.from({ length: 1200 }, (_, i) => (i === 899 ? 'fail' : 'live'));
    const read = Array.from({ length: 200 }, (_, i) => oc(i + 1, i % 2 ? 'tool' : 'api'));
    expect(firstFailedCall(read, origins)).toBe(900);
    expect(openingCall({ forkAt: null, lostAt: null, live: false, failed: true, calls: read, origins })).toBe(900);
    // A clock read already read that failed is still no step.
    const clock = [...read.slice(0, 9), oc(10, 'clock', 'error'), ...read.slice(10)];
    const both: Origin7[] = origins.map((o, i) => (i === 9 ? 'fail' : o));
    expect(firstFailedCall(clock, both)).toBe(900);
  });
});

/** A call of the run: a clock read, then model and tool calls; the tool call `failAt` threw. */
function call(callNo: number, failAt: number | null): CallRow {
  const kind = callNo === 1 ? 'clock' : callNo % 2 === 0 ? 'api' : 'tool';
  const failed = callNo === failAt;
  return {
    callNo,
    kind,
    name: kind === 'api' ? 'POST /v1/messages' : kind === 'clock' ? 'now' : 'lookup_order',
    origin: 'live',
    effect: kind === 'tool' ? 'read' : null,
    outcome: failed ? 'error' : 'ok',
    status: kind === 'api' ? 200 : null,
    latencyMs: 900,
    model: kind === 'api' ? 'claude-opus-5' : null,
    stopReason: kind === 'api' ? 'tool_use' : null,
    usage: kind === 'api' ? { input: 800, output: 40, cacheRead: 0, cacheWrite: 0 } : null,
    cost: null,
    bytes: null,
    detail: kind === 'tool' ? '{"order_id":"A-1042"}' : '',
    attempts: 0,
    replayedFrom: null,
    error: failed ? 'Error: the order service timed out' : null,
    startedAt: T + callNo * 1000,
    endedAt: T + callNo * 1000 + 900,
    ttftMs: null,
    scope: null,
    resultShort: kind === 'tool' && !failed ? 'delivered' : null,
    conversation: 1,
    conversationStart: callNo === 2,
    requestedBy: kind === 'tool' ? callNo - 1 : null,
    toolUseId: null,
    cacheMiss: null,
    recordedMs: null,
    asks: kind === 'api' ? ['lookup_order'] : null,
  } as unknown as CallRow;
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** A run of `total` calls, its page with the first `first` of them, failed or not, a tool call failing at `failAt`. */
function answer(total: number, first: number, o: { failed: boolean; failAt: number | null }): RunDetail {
  const status = o.failed ? 'failed' : 'completed';
  const origins = range(1, total)
    .map((n) => (n === o.failAt ? 'f' : 'l'))
    .join('');
  return {
    run: { runId: RUN, parentRunId: null, mode: 'record', status, divergence: null, command: { argv: ['node', 'agent.mjs'], cwd: '/work' }, codeVersion: null, startedAt: T, endedAt: T + total * 1000, meta: { labels: [] } },
    label: 'recording',
    about: { text: 'Refund order A-1042', from: 'user' },
    source: null,
    summary: { runId: RUN, mode: 'record', status, total, byOrigin: { live: total }, byKind: { api: Math.floor(total / 2), tool: Math.ceil(total / 2) - 1, clock: 1, random: 0 }, upstreamRequests: total, injected: 0, refused: 0, imported: false, tokensNotRespent: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, cost: { spent: 0.5, saved: 0, captured: 0 }, durationMs: total * 1000, notReached: [] },
    calls: range(1, Math.min(first, total)).map((n) => call(n, o.failAt)),
    callsTotal: total,
    callsNext: first < total ? first + 1 : null,
    ...(first < total ? { origins } : {}),
    parent: null,
    children: [],
    attempts: 0,
    actions: [],
    models: {},
    fix: null,
    state: { status, kind: 'recording', outcome: { kind: o.failed ? 'failed' : 'none' }, failed: o.failed, interrupted: false, endedAt: T + total * 1000, label: 'recording' },
  } as unknown as RunDetail;
}

function server(total: number, first: number, o: { failed: boolean; failAt: number | null }) {
  const asked: Array<{ from: number; limit: number }> = [];
  const details: number[] = [];
  const client = {
    exported: false,
    run: () => Promise.resolve(answer(total, first, o)),
    calls: (_id: string, from: number, limit = PAGE): Promise<CallsPage> => {
      asked.push({ from, limit });
      const to = Math.min(total, from + Math.min(limit, PAGE) - 1);
      return Promise.resolve({ runId: RUN, calls: range(from, to).map((n) => call(n, o.failAt)), callsTotal: total, callsNext: to < total ? to + 1 : null });
    },
    call: (_id: string, n: number) => (details.push(n), new Promise(() => undefined)),
    offers: () => Promise.resolve(null),
    runChaos: () => Promise.resolve(null),
    forkDifferences: () => Promise.resolve(null),
    unrecorded: () => Promise.resolve(null),
    lineage: () => Promise.resolve([]),
    // Run blame on a failed run's banner waits for any job that holds the working tree.
    jobs: () => Promise.resolve([]),
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

function addressBar(hash: string) {
  const location = { hash, search: '', pathname: '/' };
  vi.stubGlobal('location', location);
  vi.stubGlobal('history', { state: null, replaceState: (_s: unknown, _t: string, url: string) => void (location.hash = url.slice(url.indexOf('#'))) });
  return location;
}

describe('a run’s page, opened without a call', () => {
  it('opens a failed run at its first call that failed, and asks for that call', async () => {
    const bar = addressBar(`#/run/${RUN}`);
    const { client, details } = server(12, 12, { failed: true, failAt: 7 });
    r = await render(createElement(AppContext.Provider, { value: app(client) }, createElement(RunPage, { id: RUN, call: null, view: null })));
    await r.until('the call’s details', () => details.length > 0);
    expect(bar.hash).toBe(`#/run/${RUN}/7`);
    expect(details).toEqual([7]);
    expect(r.one('table.calls tr[aria-selected="true"] td.n').textContent).toBe('7');
  });

  it('opens a run that went well at its first step, past the clock read it started with', async () => {
    const bar = addressBar(`#/run/${RUN}`);
    const { client, details } = server(12, 12, { failed: false, failAt: null });
    r = await render(createElement(AppContext.Provider, { value: app(client) }, createElement(RunPage, { id: RUN, call: null, view: null })));
    await r.until('the call’s details', () => details.length > 0);
    expect(bar.hash).toBe(`#/run/${RUN}/2`);
  });

  it('opens a long failed run where it failed, far past its first page, and reads that page first', async () => {
    const bar = addressBar(`#/run/${RUN}`);
    const { client, asked, details } = server(1200, 200, { failed: true, failAt: 901 });
    r = await render(createElement(AppContext.Provider, { value: app(client) }, createElement(RunPage, { id: RUN, call: null, view: null })));
    await r.until('call 901’s details', () => details.length > 0);
    expect(bar.hash).toBe(`#/run/${RUN}/901`);
    expect(details).toEqual([901]);
    expect(asked[0]).toEqual({ from: 801, limit: PAGE });
  });

  it('jumps to where the run first failed with n', async () => {
    const bar = addressBar(`#/run/${RUN}/2`);
    const { client } = server(12, 12, { failed: true, failAt: 9 });
    const state = app(client);
    r = await render(createElement(AppContext.Provider, { value: state }, createElement(RunPage, { id: RUN, call: 2, view: null })));
    await r.until('the run’s keys', () => !!(state.runKeys as { current: unknown }).current);
    const keys = (state.runKeys as { current: (e: { key: string }) => boolean }).current;
    expect(keys({ key: 'n' })).toBe(true);
    expect(bar.hash).toBe(`#/run/${RUN}/9`);
  });
});
