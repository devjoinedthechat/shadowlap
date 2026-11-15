import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallRow, CallsPage, Client, RunDetail } from '../ui/api.js';
import type { Origin7 } from '../ui/origins.js';
import type { Kind } from '../ui/run/kinds.js';
import { RunPage } from '../ui/pages/Run.js';
import { forgetPickedCalls, firstFailedCall, firstStep, openingCall, type OpenCall } from '../ui/run/open-at.js';
import { PAGE } from '../ui/run/paging.js';
import { useRoute } from '../ui/router.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

// A call picked on a run's page is remembered for the session: each test opens its runs afresh.
afterEach(forgetPickedCalls);

/**
 * Where a run's page opens when its link names no call: a fork where it forked, a run blame found
 * lost where it was lost, a recording at its newest call, any other failed run at its first call
 * that failed, else at its first call; never on a clock or random read, which holds a value rather
 * than a step of the agent's.
 */

const RUN = '01M5GRX8K406H4KHQ7DEKYWTSZ';
const T = 1_760_000_000_000;

const oc = (callNo: number, kind: string, outcome: 'ok' | 'error' | null = 'ok', origin = 'live', effect: string | null = null): OpenCall => ({ callNo, kind, outcome, origin, effect });
const JUDGE = 'shadowlap:judge';
/** A model call shadowlap's judge made, after the agent's. */
const judgeOc = (callNo: number, outcome: 'ok' | 'error' = 'ok'): OpenCall => ({ ...oc(callNo, 'api', outcome), scope: JUDGE, agent: JUDGE });

describe('where a run opens', () => {
  const run = [oc(1, 'clock'), oc(2, 'random'), oc(3, 'api'), oc(4, 'tool', 'error'), oc(5, 'api', 'error'), oc(6, 'tool')];

  it('opens a run at its first call that failed, whether or not the run failed for it', () => {
    expect(openingCall({ forkAt: null, lostAt: null, live: false, calls: run })).toBe(4);
  });

  it('keeps a recording’s newest call, the lost call, the fork and the outcome’s call first, in that order', () => {
    expect(openingCall({ forkAt: null, lostAt: 5, live: true, calls: run })).toBe(6);
    expect(openingCall({ forkAt: 6, lostAt: 5, live: false, calls: run })).toBe(5);
    expect(openingCall({ forkAt: 6, lostAt: null, outcomeAt: 3, live: false, calls: run })).toBe(6);
    expect(openingCall({ forkAt: null, lostAt: null, outcomeAt: 3, live: false, calls: run })).toBe(3);
    // A call that isn't one of the run's steps is passed over: a clock read the outcome named.
    expect(openingCall({ forkAt: null, lostAt: null, outcomeAt: 1, live: false, calls: run })).toBe(4);
  });

  it('opens a run that went well at its first write, else at its last model call', () => {
    const calls = [oc(1, 'clock'), oc(2, 'api'), oc(3, 'tool', 'ok', 'live', 'read'), oc(4, 'tool', 'ok', 'live', 'write'), oc(5, 'api'), oc(6, 'tool', 'ok', 'live', 'read')];
    expect(openingCall({ forkAt: null, lostAt: null, live: false, calls })).toBe(4);
    expect(openingCall({ forkAt: null, lostAt: null, live: false, calls: calls.filter((c) => c.callNo !== 4) })).toBe(5);
  });

  it('opens a long recording at its count while its pages come, not at the last call read', () => {
    const read = Array.from({ length: 500 }, (_, i) => oc(i + 1, i % 2 ? 'tool' : 'api'));
    expect(openingCall({ forkAt: null, lostAt: null, live: true, calls: read, total: 3000 })).toBe(3000);
    // Its pages all read, the count and the last call agree.
    expect(openingCall({ forkAt: null, lostAt: null, live: true, calls: read, total: null })).toBe(500);
    expect(openingCall({ forkAt: null, lostAt: null, live: true, calls: [], total: 0 })).toBeNull();
  });

  it('never opens on a clock or random read, unless the run made only those', () => {
    expect(firstStep(run)).toBe(3);
    expect(firstStep([oc(1, 'clock'), oc(2, 'random')])).toBe(1);
    expect(firstStep([])).toBeNull();
    // A failed clock read is no step either.
    expect(firstFailedCall([oc(1, 'clock', 'error'), oc(2, 'api'), oc(3, 'tool', 'error')])).toBe(3);
    // A run of reads alone opens at its first.
    expect(openingCall({ forkAt: null, lostAt: null, live: false, calls: [oc(1, 'clock'), oc(2, 'random')] })).toBe(1);
  });

  it('passes over a write fenced after a fork and a failure --fail-at played in: they failed on purpose', () => {
    expect(firstFailedCall([oc(1, 'api'), oc(2, 'tool', 'error', 'blocked'), oc(3, 'tool', 'error', 'stubbed'), oc(4, 'api', 'error', 'injected'), oc(5, 'tool', 'error', 'replayed')])).toBe(5);
    expect(firstFailedCall([oc(1, 'api'), oc(2, 'tool', 'error', 'blocked')])).toBeNull();
  });

  it('finds a failure past the calls read from every call’s origin while a long run’s pages come', () => {
    const origins: Origin7[] = Array.from({ length: 1200 }, (_, i) => (i === 899 ? 'fail' : 'live'));
    const read = Array.from({ length: 200 }, (_, i) => oc(i + 1, i % 2 ? 'tool' : 'api'));
    expect(firstFailedCall(read, origins)).toBe(900);
    expect(openingCall({ forkAt: null, lostAt: null, live: false, calls: read, origins })).toBe(900);
    // A clock read already read that failed is still no step.
    const clock = [...read.slice(0, 9), oc(10, 'clock', 'error'), ...read.slice(10)];
    const both: Origin7[] = origins.map((o, i) => (i === 9 ? 'fail' : o));
    expect(firstFailedCall(clock, both)).toBe(900);
  });

  it('finds a long run’s first write and last model call past the calls read from every call’s kind', () => {
    const read = Array.from({ length: 200 }, (_, i) => oc(i + 1, i % 2 ? 'tool' : 'api', 'ok', 'live', 'read'));
    const kinds: Kind[] = Array.from({ length: 1200 }, (_, i) => (i === 699 ? 'k-write' : i === 1099 ? 'k-model' : 'k-read'));
    expect(openingCall({ forkAt: null, lostAt: null, live: false, calls: read, kinds })).toBe(700);
    // With no write, its last model call, far past the calls read.
    expect(openingCall({ forkAt: null, lostAt: null, live: false, calls: read, kinds: kinds.map((k) => (k === 'k-write' ? 'k-read' : k)) })).toBe(1100);
    // A failure still comes first, and every page read the kinds go unused.
    const origins: Origin7[] = Array.from({ length: 1200 }, (_, i) => (i === 899 ? 'fail' : 'live'));
    expect(openingCall({ forkAt: null, lostAt: null, live: false, calls: read, origins, kinds })).toBe(900);
    expect(openingCall({ forkAt: null, lostAt: null, live: false, calls: read.slice(0, 2), kinds: kinds.slice(0, 2) })).toBe(1);
  });

  it('never opens on a judge’s call: a judged run’s last model call is the agent’s, a judge’s call that errored is none that failed, and none named is passed over', () => {
    const judged = [oc(1, 'api'), oc(2, 'tool', 'ok', 'live', 'read'), oc(3, 'api'), judgeOc(4)];
    expect(openingCall({ forkAt: null, lostAt: null, live: false, calls: judged })).toBe(3);
    const erred = [...judged.slice(0, 3), judgeOc(4, 'error')];
    expect(firstFailedCall(erred)).toBeNull();
    expect(openingCall({ forkAt: null, lostAt: null, live: false, calls: erred })).toBe(3);
    // The agent's own failure still comes first.
    expect(firstFailedCall([oc(1, 'api'), oc(2, 'tool', 'error'), judgeOc(3, 'error')])).toBe(2);
    // A call the outcome names that is the judge's is passed over too.
    expect(openingCall({ forkAt: null, lostAt: null, outcomeAt: 4, live: false, calls: judged })).toBe(3);
    // A run of a judge's calls alone has none of the agent's to open on.
    expect(firstStep([judgeOc(1)])).toBeNull();
  });

  it('leaves out a long run’s judge’s calls by the server’s numbers before their pages come: its last model call and its failures', () => {
    const read = Array.from({ length: 200 }, (_, i) => oc(i + 1, i % 2 ? 'tool' : 'api', 'ok', 'live', 'read'));
    const kinds: Kind[] = Array.from({ length: 1200 }, (_, i) => (i === 1099 || i >= 1198 ? 'k-model' : 'k-read'));
    // Its two judge's calls, the last two, are model calls: it opens on the agent's last.
    expect(openingCall({ forkAt: null, lostAt: null, live: false, calls: read, kinds, judge: [1199, 1200] })).toBe(1100);
    expect(openingCall({ forkAt: null, lostAt: null, live: false, calls: read, kinds })).toBe(1200);
    // A judge's call that failed, past the calls read: none of the agent's failed.
    const origins: Origin7[] = Array.from({ length: 1200 }, (_, i) => (i === 1199 ? 'fail' : 'live'));
    expect(firstFailedCall(read, origins, [1199, 1200])).toBeNull();
    expect(firstFailedCall(read, origins)).toBe(1200);
    expect(openingCall({ forkAt: null, lostAt: null, live: false, calls: read, origins, kinds, judge: [1199, 1200] })).toBe(1100);
  });

  it('never opens on a call the run doesn’t have, which a fork, a loss or an outcome names', () => {
    const calls = [oc(1, 'api'), oc(2, 'tool', 'ok', 'live', 'read'), oc(3, 'api')];
    expect(openingCall({ forkAt: 9, lostAt: null, live: false, calls })).toBe(3);
    expect(openingCall({ forkAt: null, lostAt: 9, outcomeAt: 2, live: false, calls })).toBe(2);
    // While a long run's pages come, a call up to its count is one of its own, read yet or not.
    expect(openingCall({ forkAt: 900, lostAt: null, live: false, calls, total: 1200 })).toBe(900);
    expect(openingCall({ forkAt: 1300, lostAt: null, live: false, calls, total: 1200 })).not.toBe(1300);
  });

  it('opens a replay that ended early where it stopped: its last call, never the judge’s after it', () => {
    // It stopped before its recording did: its divergence names the recording's call it never made, #8, which no call of its own is.
    const calls = [oc(1, 'api', 'ok', 'replayed'), oc(2, 'tool', 'ok', 'replayed', 'read'), oc(3, 'api', 'ok', 'replayed'), oc(4, 'clock', 'ok', 'replayed'), judgeOc(5)];
    expect(openingCall({ forkAt: null, endedEarly: true, lostAt: null, live: false, calls })).toBe(3);
    // While its pages come, its last call is its count, past the calls read, the judge's left out.
    expect(openingCall({ forkAt: null, endedEarly: true, lostAt: null, live: false, calls: calls.slice(0, 2), total: 1200, judge: [1200] })).toBe(1199);
    // One that made no call has none to open on.
    expect(openingCall({ forkAt: null, endedEarly: true, lostAt: null, live: false, calls: [] })).toBeNull();
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
    injectionRun: () => Promise.resolve({ untrusted: [], results: [], attempt: null }), injectionResults: () => Promise.resolve({ results: [] }), unrecorded: () => Promise.resolve(null),
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

  it('opens a run that went well, with no write in it, at its last model call', async () => {
    const bar = addressBar(`#/run/${RUN}`);
    const { client, details } = server(12, 12, { failed: false, failAt: null });
    r = await render(createElement(AppContext.Provider, { value: app(client) }, createElement(RunPage, { id: RUN, call: null, view: null })));
    await r.until('the call’s details', () => details.length > 0);
    expect(bar.hash).toBe(`#/run/${RUN}/12`);
  });

  it('opens a run again on the call picked on its page earlier in the session', async () => {
    const bar = addressBar(`#/run/${RUN}/7`);
    const { client, details } = server(12, 12, { failed: false, failAt: null });
    r = await render(createElement(AppContext.Provider, { value: app(client) }, createElement(RunPage, { id: RUN, call: 7, view: null })));
    await r.until('the call’s details', () => details.length > 0);
    await r.unmount();
    bar.hash = `#/run/${RUN}`;
    r = await render(createElement(AppContext.Provider, { value: app(client) }, createElement(RunPage, { id: RUN, call: null, view: null })));
    await r.until('the address', () => bar.hash !== `#/run/${RUN}`);
    expect(bar.hash).toBe(`#/run/${RUN}/7`);
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

describe('a long replay’s header while its pages come', () => {
  const RECORDING = '01M5GRVTKSJ12EE2SE9YZ5W4J3';
  /** A clean replay of 1,200 calls, each served from its recording, which took a second there: its page with its first 200, as a long run's first answer comes. */
  const replayed = (n: number): CallRow => ({ ...call(n, null), origin: 'replayed', replayedFrom: n, recordedMs: 1000, latencyMs: 0 }) as unknown as CallRow;
  function longReplay(notWaitedMs: number | null): { client: Client; details: number[] } {
    const a = answer(1200, 200, { failed: false, failAt: null });
    const run = { ...a, run: { ...a.run, parentRunId: RECORDING, mode: 'replay' }, calls: a.calls.map((c) => replayed(c.callNo)), origins: 'r'.repeat(1200), parent: { runId: RECORDING, label: 'recording' }, warming: { done: 300, total: 1200 }, notWaitedMs, state: { ...a.state!, kind: 'clean' } } as unknown as RunDetail;
    const { client, details } = server(1200, 200, { failed: false, failAt: null });
    const calls = (_id: string, from: number, limit = PAGE): Promise<CallsPage> => {
      const to = Math.min(1200, from + Math.min(limit, PAGE) - 1);
      return Promise.resolve({ runId: RUN, calls: range(from, to).map(replayed), callsTotal: 1200, callsNext: to < 1200 ? to + 1 : null });
    };
    // Its verdict by checks and its next step, which a warming answer leaves to their own reads.
    const outcome = () => Promise.resolve({ judged: null });
    const nextStep = () => Promise.resolve({ next: null });
    return { client: { ...client, run: () => Promise.resolve(run), calls, outcome, nextStep }, details };
  }
  const notWaited = () => r!.all('.rhead .metrics .metric').map((m) => `${m.querySelector('b')?.textContent ?? ''} ${m.querySelector('span')?.textContent ?? ''}`).find((t) => t.endsWith(' not waited')) ?? null;

  it('says no time not waited of its first calls as the run’s, and the whole run’s once every page is read', async () => {
    addressBar(`#/run/${RUN}`);
    const { client } = longReplay(null);
    r = await render(createElement(AppContext.Provider, { value: app(client) }, createElement(RunPage, { id: RUN, call: null, view: null })));
    await r.until('the run’s header', () => r!.all('.rhead .metrics').length === 1);
    expect(notWaited()).toBeNull();
    // Every page read: the time every replayed call took where it was recorded, 1,200 seconds.
    await r.until('every page', () => notWaited() !== null);
    expect(notWaited()).toBe('20m not waited');
  });

  it('says the server’s time not waited where it has the whole run’s', async () => {
    addressBar(`#/run/${RUN}`);
    const { client } = longReplay(1_200_000);
    r = await render(createElement(AppContext.Provider, { value: app(client) }, createElement(RunPage, { id: RUN, call: null, view: null })));
    await r.until('the run’s header', () => r!.all('.rhead .metrics').length === 1);
    expect(notWaited()).toBe('20m not waited');
  });
});

describe('a replay that ended early, on its page', () => {
  const RECORDING = '01M5GRVTKSJ12EE2SE9YZ5W4J3';
  /**
   * A replay of a recording of 20 calls that stopped after its first 12, as the engine keeps it: its
   * divergence at the recording's #13, which it never made, and its page as the server sent it before
   * (`forkAt` that call) or since (none).
   */
  function endedEarly(forkAt: number | null): RunDetail {
    const a = answer(12, 12, { failed: false, failAt: null });
    const divergence = { type: 'ended_early', callNo: 13, kind: 'api', name: 'POST /v1/messages', replayedBefore: 12, recorded: 20, reason: 'the agent stopped after 12 of the 20 recorded calls, before making #13', counterpart: { runId: RECORDING, callNo: 13 } };
    return {
      ...a,
      run: { ...a.run, parentRunId: RECORDING, mode: 'replay', divergence },
      label: 'ended early @13',
      calls: a.calls.map((c) => ({ ...c, origin: 'replayed' })),
      parent: { runId: RECORDING, label: 'recording' },
      forkAt,
      state: { ...a.state!, kind: 'fork' },
    } as unknown as RunDetail;
  }

  async function open(forkAt: number | null) {
    const bar = addressBar(`#/run/${RUN}`);
    const { client, details } = server(12, 12, { failed: false, failAt: null });
    const early = { ...client, run: () => Promise.resolve(endedEarly(forkAt)) } as unknown as Client;
    r = await render(createElement(AppContext.Provider, { value: app(early) }, createElement(RunPage, { id: RUN, call: null, view: null })));
    await r.until('the call’s details', () => details.length > 0);
    return { bar, details };
  }

  it('opens where it stopped, its last call, never on the recording’s call it never made', async () => {
    for (const forkAt of [13, null]) {
      const { bar, details } = await open(forkAt);
      expect(bar.hash).toBe(`#/run/${RUN}/12`);
      expect(details).toEqual([12]);
      expect(r!.one('table.calls tr[aria-selected="true"] td.n').textContent).toBe('12');
      await r!.unmount();
      r = null;
      forgetPickedCalls();
    }
  });

  it('says it ended early, as Runs and the sidebar do, at the recording’s call, which its #13 opens there', async () => {
    await open(13);
    expect(r!.one('.rhead .ek .ebk').textContent).toBe('ended early @13');
    const finding = r!.one('.findings .banner.fork');
    expect(finding.querySelector('.bk')!.textContent).toBe('ended early at');
    const at = finding.querySelector('a.bn')!;
    expect([at.textContent, at.getAttribute('href')]).toEqual(['#13', `#/run/${RECORDING}/13`]);
    expect(finding.textContent).not.toContain('forked at');
    // No FORK flag on a call of its own: it forked at none it made.
    expect(r!.all('table.calls .fk').length).toBe(0);
  });
});

describe('a judged run’s page', () => {
  /** A run that went well, read alone, with no write: its judge's call, #13, after the agent's twelve, and the verdict it gave. */
  function judgedRun(): RunDetail {
    const a = answer(12, 12, { failed: false, failAt: null });
    const judge = { ...call(12, null), callNo: 13, startedAt: T + 13_000, endedAt: T + 13_900, stopReason: 'end_turn', scope: JUDGE, agent: JUDGE, reserved: true, judge: { check: 'explains-refund', verdict: 'yes' }, conversation: 2, conversationStart: true, asks: null } as unknown as CallRow;
    const verdict = { name: 'explains-refund', model: 'claude-haiku-4-5', of: 'answer', verdict: 'yes', source: 'live', cost: 0.0004, redactions: 0, cut: 0, callNo: 13 };
    return { ...a, calls: [...a.calls, judge], callsTotal: 13, checks: [{ label: 'judge "explains-refund" answers yes', ok: true, status: 'passed', reason: 'The reply says why', source: 'live', judge: verdict }] } as unknown as RunDetail;
  }

  /** The run's page as the shell routes to it: the call the address names is the one selected. */
  function Routed() {
    const route = useRoute();
    return route.page === 'run' ? createElement(RunPage, { id: route.id, call: route.call, view: route.view }) : null;
  }

  /** ⌘K's commands for this run, as the page last gave them. */
  let commands: Array<{ label: string }> = [];
  async function open() {
    const bar = addressBar(`#/run/${RUN}`);
    const { client, details } = server(12, 12, { failed: false, failAt: null });
    const judged = { ...client, run: () => Promise.resolve(judgedRun()) } as unknown as Client;
    const state = { ...app(judged), setRunCommands: (items: typeof commands) => void (items.length && (commands = items)) } as unknown as AppState;
    r = await render(createElement(AppContext.Provider, { value: state }, createElement(Routed)));
    await r.until('the call’s details', () => details.length > 0);
    return bar;
  }
  const chips = () => r!.all('.scopebar .chips button');
  const pressed = () => chips().map((b) => [b.textContent, b.getAttribute('aria-pressed')]);
  const listed = () => r!.all('table.calls tbody tr[data-call]').map((tr) => Number(tr.getAttribute('data-call')));
  /** The judge verdict's call in the findings bar. */
  const verdictCall = () => r!.all('.findings button').find((b) => b.textContent === '#13')!;

  it('opens under All on the agent’s last model call, never the judge’s that came after it', async () => {
    const bar = await open();
    expect(bar.hash).toBe(`#/run/${RUN}/12`);
    expect(r!.one('table.calls tr[aria-selected="true"] td.n').textContent).toBe('12');
    expect(pressed()).toEqual([
      ['Agent 12', 'true'],
      ['judge 1', 'false'],
    ]);
    expect(listed()).not.toContain(13);
  });

  it('picks the judge’s chip at each press of its verdict’s call, though the call is selected already and All was picked since', async () => {
    const bar = await open();
    await r!.click(verdictCall());
    await r!.until('the judge’s chip', () => pressed()[1]?.[1] === 'true');
    expect([bar.hash, listed()]).toEqual([`#/run/${RUN}/13`, [13]]);
    // All picked: the judge's call stays selected, out of its list.
    await r!.click(chips()[0]);
    await r!.until('All', () => pressed()[0]?.[1] === 'true');
    expect(bar.hash).toBe(`#/run/${RUN}/13`);
    expect(listed()).not.toContain(13);
    // Its call pressed again goes nowhere new, and picks the judge's chip again.
    await r!.click(verdictCall());
    await r!.until('the judge’s chip again', () => pressed()[1]?.[1] === 'true');
    expect([bar.hash, listed()]).toEqual([`#/run/${RUN}/13`, [13]]);
  });

  it('offers no Fork at #n… in ⌘K at a judge’s call, as it does at the agent’s', async () => {
    await open();
    await r!.until('the run’s commands', () => commands.some((c) => c.label === 'Fork at #12…'));
    await r!.click(verdictCall());
    await r!.until('the judge’s call’s commands', () => pressed()[1]?.[1] === 'true' && !commands.some((c) => c.label === 'Fork at #12…'));
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.map((c) => c.label).filter((l) => l.startsWith('Fork'))).toEqual([]);
  });
});
