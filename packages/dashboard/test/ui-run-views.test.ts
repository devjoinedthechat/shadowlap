import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallRow, Client, RunDetail } from '../ui/api.js';
import { VIEWS } from '../ui/route.js';
import type { AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';
import { forgetPickedCalls } from '../ui/run/open-at.js';

// A call picked on a run's page is remembered for the session: each test opens its runs afresh.
afterEach(forgetPickedCalls);

/**
 * A run's views but Calls, each in a script of its own (`VIEW_PARTS`, ui/pages/Run.tsx). Opening a
 * run asks for none of them, so what it loads is the page's own code, as the bundle size test counts
 * it. The pointer or the focus reaching the Views tabs loads every one, and so does the first switch
 * of view, so a switch to any draws it at once, its first frame the view. A view whose code didn't
 * come says so in the view, with Retry, and the page around it stays whole. Each test opens the page
 * from its modules loaded anew, so no script an earlier test loaded is in already.
 */

const RUN = '01M5GRX8K406H4KHQ7DEKYWTSZ';
/** Another recording with the same calls, and one with no model call. */
const OTHER = '01M6B2C3D4E5F6G7H8J9KAMBNC';
const NO_MODEL = '01M7Q2R3S4T5V6W7X8Y9Z0A1B2';
const T = 1_760_000_000_000;

/** A clock read, then a model call that asks for a tool, the tool, and the model's answer. */
function call(callNo: number): CallRow {
  const kind = callNo === 1 ? 'clock' : callNo === 3 ? 'tool' : 'api';
  const api = kind === 'api';
  return { callNo, kind, name: api ? 'POST /v1/messages' : kind === 'tool' ? 'lookup_order' : 'now', origin: 'live', effect: kind === 'tool' ? 'read' : null, outcome: 'ok', status: api ? 200 : null, latencyMs: 900, model: api ? 'claude-opus-5' : null, stopReason: api ? (callNo === 2 ? 'tool_use' : 'end_turn') : null, usage: api ? { input: 800, output: 40, cacheRead: 0, cacheWrite: 0 } : null, cost: null, bytes: null, detail: '', attempts: 0, replayedFrom: null, error: null, startedAt: T + callNo * 1000, endedAt: T + callNo * 1000 + 900, ttftMs: null, scope: null, resultShort: kind === 'tool' ? 'delivered' : null, conversation: 1, conversationStart: callNo === 2, requestedBy: kind === 'tool' ? 2 : null, toolUseId: null, cacheMiss: null, recordedMs: null, asks: api ? (callNo === 2 ? ['lookup_order'] : []) : null } as unknown as CallRow;
}

function answer(runId = RUN): RunDetail {
  const calls = (runId === NO_MODEL ? [1, 3] : [1, 2, 3, 4]).map(call);
  return {
    run: { runId, parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: { argv: ['node', 'agent.mjs', 'A-1042'], cwd: '/work' }, codeVersion: null, startedAt: T, endedAt: T + 5000, meta: { labels: [] } },
    label: 'recording',
    about: { text: 'Refund order A-1042', from: 'user' },
    source: null,
    summary: { runId, mode: 'record', status: 'completed', total: calls.length, byOrigin: { live: calls.length }, byKind: { api: 2, tool: 1, clock: 1, random: 0 }, upstreamRequests: 2, injected: 0, refused: 0, imported: false, tokensNotRespent: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, cost: { spent: 0.02, saved: 0, captured: 0, unknownModels: [] }, durationMs: 5000, notReached: [] },
    calls,
    callsTotal: calls.length,
    callsNext: null,
    parent: null,
    children: [],
    attempts: 0,
    actions: [],
    models: {},
    fix: null,
    state: { status: 'completed', kind: 'recording', outcome: { kind: 'none' }, failed: false, interrupted: false, endedAt: T + 5000, label: 'recording' },
  } as unknown as RunDetail;
}

const client = {
  exported: false,
  run: (runId: string) => Promise.resolve(answer(runId)),
  call: () => new Promise(() => undefined),
  offers: () => Promise.resolve(null),
  runChaos: () => Promise.resolve(null),
  forkDifferences: () => Promise.resolve(null),
  injectionRun: () => Promise.resolve({ untrusted: [], results: [], attempt: null }), injectionResults: () => Promise.resolve({ results: [] }), unrecorded: () => Promise.resolve(null),
  lineage: () => Promise.resolve([]),
  fixBundles: () => Promise.resolve([]),
  provenance: () => Promise.resolve(null),
  // The Decisions view draws its loading line until the previews come, which here they never do.
  runDecisions: () => new Promise(() => undefined),
  showJson: () => new Promise(() => undefined),
  jobs: () => Promise.resolve([]),
} as unknown as Client;

function app(o: { paused?: string[] } = {}): AppState {
  return {
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
    // Offline, an action says it waits rather than run.
    guard: (fn: () => void) => (o.paused ? void o.paused.push('Paused until the dashboard server is back') : fn()),
    watchJob: () => undefined,
    toast: () => undefined,
    refresh: () => undefined,
    setRunCommands: () => undefined,
    setPalette: () => undefined,
    runKeys: { current: null },
  } as unknown as AppState;
}

let r: Rendered | null = null;
/** Forgets the kind or origin picked in the strip's key, kept from run to run in the modules the page was opened from. */
let forgetPick: () => void = () => undefined;
afterEach(async () => {
  await r?.unmount();
  r = null;
  forgetPick();
  vi.unstubAllGlobals();
  vi.doUnmock('../ui/run/TimelineView.js');
});

/** The run page's modules loaded anew, none of the views' scripts asked for yet. */
async function fresh() {
  vi.resetModules();
  const [{ RunPage, VIEW_PARTS }, { useRoute }, { AppContext }, { resetCallFilter }] = await Promise.all([import('../ui/pages/Run.js'), import('../ui/router.js'), import('../ui/state.js'), import('../ui/run/call-filter.js')]);
  forgetPick = resetCallFilter;
  return { RunPage, VIEW_PARTS, useRoute, AppContext };
}

type Fresh = Awaited<ReturnType<typeof fresh>>;

/** The run's page as the shell routes to it, opened on Calls; the address bar it reads and rewrites. */
async function open(m: Fresh, state = app()) {
  const bar = { hash: `#/run/${RUN}/2`, search: '', pathname: '/', reload: vi.fn() };
  vi.stubGlobal('location', bar);
  vi.stubGlobal('history', { state: null, replaceState: (_s: unknown, _t: string, url: string) => void (bar.hash = url.slice(url.indexOf('#'))) });
  function Routed() {
    const route = m.useRoute();
    return route.page === 'run' ? createElement(m.RunPage, { id: route.id, call: route.call, view: route.view }) : null;
  }
  r = await render(createElement(m.AppContext.Provider, { value: state }, createElement(Routed)));
  await r.until('the calls', () => r!.all('table.calls tbody tr[data-wi]').length > 0);
  return bar;
}

/** Where each view's script is, by view. */
const scripts = (m: Fresh) => Object.fromEntries(Object.entries(m.VIEW_PARTS).map(([view, part]) => [view, part.script]));
const every = (script: string) => Object.fromEntries(VIEWS.filter((v) => v !== 'calls').map((v) => [v, script]));
const tablist = () => r!.one('[role="tablist"][aria-label="Views"]');
/** Every view's tab but Calls', the first. */
const viewTabs = () => tablist().querySelectorAll('[role="tab"]').slice(1);

/** Switches to each view in turn: each draws in the switch itself, never an empty view for its script to come. */
async function drawsEachAtOnce(bar: { hash: string }) {
  expect(viewTabs()).toHaveLength(VIEWS.length - 1);
  for (let i = 0; i < VIEWS.length - 1; i++) {
    await r!.click(viewTabs()[i]);
    const view = /\/([a-z]+)$/.exec(bar.hash)?.[1];
    expect(view).toBe(VIEWS[i + 1]);
    expect(r!.one('.vbody').childNodes.length, `${view} draws at once`).toBeGreaterThan(0);
  }
}

describe('a run’s views but Calls', () => {
  it('ask for none of their scripts as the page opens, and load every one once the pointer reaches the Views tabs, each then drawn at once', async () => {
    const m = await fresh();
    const bar = await open(m);
    // Every view but Calls is a part of its own, and opening the run asked for none of them.
    expect(scripts(m)).toEqual(every('idle'));
    await r!.hover(tablist());
    expect(Object.values(scripts(m))).not.toContain('idle');
    await r!.until('every view’s script', () => Object.values(m.VIEW_PARTS).every((p) => p.script === 'loaded'));
    await drawsEachAtOnce(bar);
  });

  it('load every one once the focus reaches the Views tabs, as Tab or a screen reader moves it', async () => {
    const m = await fresh();
    const bar = await open(m);
    expect(scripts(m)).toEqual(every('idle'));
    await r!.focus(viewTabs()[0]);
    await r!.until('every view’s script', () => Object.values(m.VIEW_PARTS).every((p) => p.script === 'loaded'));
    await drawsEachAtOnce(bar);
  });

  it('load every one with the first switch of view, as v makes it, so the next switch draws at once', async () => {
    const m = await fresh();
    const state = app();
    const bar = await open(m, state);
    const v = () => act(async () => void (state.runKeys as { current: (e: { key: string }) => boolean }).current({ key: 'v' }));
    await v();
    expect(bar.hash).toBe(`#/run/${RUN}/2/turns`);
    await r!.until('every view’s script', () => Object.values(m.VIEW_PARTS).every((p) => p.script === 'loaded'));
    await v();
    expect(bar.hash).toBe(`#/run/${RUN}/2/context`);
    expect(r!.one('.vbody').childNodes.length, 'context draws at once').toBeGreaterThan(0);
  });

  it('say so in the view when one’s code didn’t come, with Retry, which loads the page again once the server is back', async () => {
    vi.doMock('../ui/run/TimelineView.js', () => {
      throw new TypeError('Failed to fetch dynamically imported module');
    });
    const m = await fresh();
    const paused: string[] = [];
    const state = app({ paused });
    const bar = await open(m, state);
    await r!.hover(tablist());
    await r!.until('every view’s script', () => Object.values(m.VIEW_PARTS).every((p) => p.script === 'loaded' || p.script === 'failed'));
    expect(scripts(m)).toEqual({ ...every('loaded'), timeline: 'failed' });
    await r!.click(viewTabs()[VIEWS.indexOf('timeline') - 1]);
    expect(bar.hash).toBe(`#/run/${RUN}/2/timeline`);
    const line = r!.one('.vbody .loaderr');
    expect(line.getAttribute('role')).toBe('alert');
    expect(line.querySelector('.st.err')!.textContent).toBe('couldn’t load');
    expect(line.querySelector('p')!.textContent).toContain('This view’s code didn’t come from the dashboard server.');
    // The page around it stays: its header, its calls' tabs, and the other views.
    expect(r!.all('.rhead')).toHaveLength(1);
    // Offline, Retry waits for the server rather than leave the browser's own error in the page's place.
    await r!.click(r!.byText('.vbody .loaderr button', 'Retry'));
    expect(bar.reload).not.toHaveBeenCalled();
    expect(paused).toEqual(['Paused until the dashboard server is back']);
    paused.length = 0;
    // Back, it loads the page again: a browser never asks for a script it failed to load a second time.
    (state as unknown as { guard: (fn: () => void) => void }).guard = (fn) => fn();
    await r!.click(viewTabs()[0]);
    await r!.click(viewTabs()[VIEWS.indexOf('timeline') - 1]);
    await r!.click(r!.byText('.vbody .loaderr button', 'Retry'));
    expect(bar.reload).toHaveBeenCalledTimes(1);
    await r!.click(viewTabs()[0]);
    expect(r!.one('.vbody').childNodes.length, 'turns draws').toBeGreaterThan(0);
  });
});

describe('the strip’s key and Filter calls, from another view', () => {
  const callsShown = () => tablist().querySelectorAll('[role="tab"]')[0].getAttribute('aria-selected') === 'true';
  const rows = () => r!.all('table.calls tbody tr[data-wi]').map((tr) => Number(tr.querySelector('td.n')!.childNodes.at(-1)!.textContent));

  it('show Calls, where the calls they keep are listed: a kind picked in the key, or a word typed', async () => {
    const m = await fresh();
    const bar = await open(m);
    const timeline = async () => {
      await r!.click(viewTabs()[VIEWS.indexOf('timeline') - 1]);
      expect(bar.hash).toBe(`#/run/${RUN}/2/timeline`);
      expect(callsShown()).toBe(false);
    };
    await timeline();
    // all keeps the view: it filters nothing.
    await r!.click(r!.byText('.lfilter button', 'all 4'));
    expect(bar.hash).toBe(`#/run/${RUN}/2/timeline`);
    const model = r!.one('.lfilter button[data-of="k-model"]');
    expect(model.textContent).toBe('model calls 2');
    await r!.click(model);
    expect(bar.hash).toBe(`#/run/${RUN}/2`);
    expect(callsShown()).toBe(true);
    expect(model.getAttribute('aria-pressed')).toBe('true');
    await r!.until('the model calls alone', () => rows().join() === '2,4');
    await r!.click(r!.byText('.lfilter button', 'all 4'));
    await timeline();
    const field = r!.one('.strip .filter-in input[type="search"]');
    await r!.type(field, 'lookup');
    expect(callsShown()).toBe(true);
    expect(field.value).toBe('lookup');
    await r!.until('the calls that name it', () => rows().includes(3) && !rows().includes(1));
  });

  it('keep a kind picked in the key from run to run, all where the next run has none of it', async () => {
    const m = await fresh();
    const bar = await open(m);
    const pressed = () => r!.all('.lfilter button[aria-pressed="true"]').map((b) => b.getAttribute('data-of'));
    await r!.click(r!.one('.lfilter button[data-of="k-model"]'));
    await r!.until('the model calls alone', () => rows().join() === '2,4');
    // Another run, as a link or [ and ] open it: the page starts empty there, then draws it.
    const go = async (runId: string) => {
      bar.hash = `#/run/${runId}`;
      await act(async () => void window.dispatchEvent(new Event('hashchange')));
      await r!.until(`${runId}’s calls`, () => r!.all(`.rnm[data-run="${runId}"]`).length === 1 && rows().length > 0);
    };
    await go(OTHER);
    expect(pressed()).toEqual(['k-model']);
    expect(rows().join()).toBe('2,4');
    await go(NO_MODEL);
    expect(pressed()).toEqual(['all']);
    expect(rows().join()).toBe('1,3');
    await go(RUN);
    expect(pressed()).toEqual(['k-model']);
    expect(rows().join()).toBe('2,4');
  });
});
