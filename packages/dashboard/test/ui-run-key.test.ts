import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallRow, Client, RunDetail } from '../ui/api.js';
import { ToastHost } from '../ui/components/Toast.js';
import { RunPage } from '../ui/pages/Run.js';
import { markChange, markKey, markTitle, markToast, undoChange, withChange } from '../ui/runkey.js';
import { RunsTable, type TableRun } from '../ui/runspage/RunsTable.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { ToastAction } from '../ui/toast.js';
import { render, type Rendered } from './ui-render.js';

/**
 * The good/bad key: one press labels a run good or bad (what `repair --keeps label:good` keeps
 * working, and what `--fixes label:bad` names), never both, a press of the one it holds taking it
 * off, on a run's header and on each row of Runs, from + and - too, each change with Undo.
 */

describe('the good/bad key', () => {
  it('labels a run good or bad, never both, and takes off the one it holds', () => {
    expect(markChange([], 'good')).toEqual({ add: ['good'], remove: [] });
    expect(markChange(['refund-bug', 'bad'], 'good')).toEqual({ add: ['good'], remove: ['bad'] });
    expect(markChange(['good', 'refund-bug'], 'good')).toEqual({ add: [], remove: ['good'] });
    expect(markChange(['good'], 'bad')).toEqual({ add: ['bad'], remove: ['good'] });
    // As the server's withLabels makes them: the rest kept in order, what is added after.
    expect(withChange(['bad', 'refund-bug'], markChange(['bad', 'refund-bug'], 'good'))).toEqual(['refund-bug', 'good']);
  });

  it('undoes a press by what it changed', () => {
    const before = ['refund-bug', 'bad'];
    const change = markChange(before, 'good');
    const undo = undoChange(before, change);
    expect(undo).toEqual({ add: ['bad'], remove: ['good'] });
    expect(withChange(withChange(before, change), undo).sort()).toEqual([...before].sort());
    // Taking a label off is undone by putting it back.
    expect(undoChange(['good'], markChange(['good'], 'good'))).toEqual({ add: ['good'], remove: [] });
  });

  it('says what a press did and does, in the words a repair takes it in', () => {
    expect(markToast('01M5GRX8K406H4KHQ7DEKYWTSZ', 'good', true)).toBe('01M5GRX8K4 is good: a repair keeps it working (--keeps label:good)');
    expect(markToast('01M5GRX8K406H4KHQ7DEKYWTSZ', 'bad', true)).toBe('01M5GRX8K4 is bad: one to fix (--fixes label:bad)');
    expect(markToast('01M5GRX8K406H4KHQ7DEKYWTSZ', 'good', false)).toBe('01M5GRX8K4 is no longer marked good');
    expect(markTitle('good', false)).toContain('repair --keeps label:good');
    expect(markTitle('bad', true)).toBe('Labelled bad: press to take the label off');
    expect([markKey('+'), markKey('='), markKey('-'), markKey('g')]).toEqual(['good', 'good', 'bad', null]);
  });
});

const RUN = '01M5GRX8K406H4KHQ7DEKYWTSZ';
const T = 1_760_000_000_000;

function call(callNo: number): CallRow {
  const api = callNo % 2 === 1;
  return { callNo, kind: api ? 'api' : 'tool', name: api ? 'POST /v1/messages' : 'lookup_order', origin: 'live', effect: api ? null : 'read', outcome: 'ok', status: api ? 200 : null, latencyMs: 900, model: api ? 'claude-opus-5' : null, stopReason: api ? 'tool_use' : null, usage: null, cost: null, bytes: null, detail: '', attempts: 0, replayedFrom: null, error: null, startedAt: T + callNo, endedAt: T + callNo + 1, ttftMs: null, scope: null, resultShort: null, conversation: 1, conversationStart: callNo === 1, requestedBy: api ? null : callNo - 1, toolUseId: null, cacheMiss: null, recordedMs: null, asks: api ? ['lookup_order'] : null } as unknown as CallRow;
}

function answer(labels: string[]): RunDetail {
  return {
    run: { runId: RUN, parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: { argv: ['node', 'agent.mjs'], cwd: '/work' }, codeVersion: null, startedAt: T, endedAt: T + 10_000, meta: { labels } },
    label: 'recording',
    about: { text: 'Refund order A-1042', from: 'user' },
    source: null,
    summary: { runId: RUN, mode: 'record', status: 'completed', total: 4, byOrigin: { live: 4 }, byKind: { api: 2, tool: 2, clock: 0, random: 0 }, upstreamRequests: 2, injected: 0, refused: 0, imported: false, tokensNotRespent: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, cost: { spent: 0.01, saved: 0, captured: 0 }, durationMs: 10_000, notReached: [] },
    calls: [1, 2, 3, 4].map(call),
    callsTotal: 4,
    callsNext: null,
    parent: null,
    children: [],
    attempts: 0,
    actions: [],
    models: {},
    fix: null,
    state: { status: 'completed', kind: 'recording', outcome: { kind: 'none' }, failed: false, interrupted: false, endedAt: T + 10_000, label: 'recording' },
  } as unknown as RunDetail;
}

/** A server whose labels change as asked, and what each ask was. */
function server(start: string[]) {
  let labels = [...start];
  const asked: Array<{ runId: string; add: string[]; remove: string[] }> = [];
  const client = {
    exported: false,
    run: () => Promise.resolve(answer(labels)),
    call: () => new Promise(() => undefined),
    offers: () => Promise.resolve(null),
    runChaos: () => Promise.resolve(null),
    forkDifferences: () => Promise.resolve(null),
    unrecorded: () => Promise.resolve(null),
    lineage: () => Promise.resolve([]),
    jobs: () => Promise.resolve([]),
    labels: (runId: string, add: string[], remove: string[] = []) => {
      asked.push({ runId, add, remove });
      labels = [...labels.filter((l) => !remove.includes(l)), ...add.filter((l) => !labels.includes(l))];
      return Promise.resolve({ labels });
    },
  } as unknown as Client;
  return { client, asked };
}

function app(client: Client, toasts: Array<{ text: string; action?: ToastAction }>) {
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
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: (text: string, _kind?: string, action?: ToastAction) => void toasts.push({ text, ...(action ? { action } : {}) }),
    refresh: () => undefined,
    registerLayer: () => () => undefined,
    setRunCommands: () => undefined,
    setPalette: () => undefined,
    runKeys: { current: null },
  } as unknown as AppState;
}

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
}

const keyButton = (label: string) => r!.all('.rhead .runkey button').find((b) => b.textContent === label)!;

describe('the key on a run’s header', () => {
  it('labels the run in one press, says so with Undo, and Undo puts it back', async () => {
    addressBar(`#/run/${RUN}/1`);
    const { client, asked } = server(['refund-bug', 'bad']);
    const toasts: Array<{ text: string; action?: ToastAction }> = [];
    r = await render(createElement(AppContext.Provider, { value: app(client, toasts) }, createElement(RunPage, { id: RUN, call: 1, view: null })));
    await r.until('the header', () => r!.all('.rhead .runkey button').length === 2);
    // Bad is pressed; neither good nor bad is a chip of its own, the other labels are.
    expect(keyButton('bad').getAttribute('aria-pressed')).toBe('true');
    expect(keyButton('good').getAttribute('aria-pressed')).toBe('false');
    expect(r.all('.rhead .labelbar .chip').map((c) => c.childNodes[0]!.textContent)).toEqual(['refund-bug']);
    await r.click(keyButton('good'));
    await r.until('the toast', () => toasts.length > 0);
    expect(asked).toEqual([{ runId: RUN, add: ['good'], remove: ['bad'] }]);
    expect(keyButton('good').getAttribute('aria-pressed')).toBe('true');
    expect(keyButton('bad').getAttribute('aria-pressed')).toBe('false');
    expect(toasts[0]!.text).toBe('01M5GRX8K4 is good: a repair keeps it working (--keeps label:good)');
    expect(toasts[0]!.action?.label).toBe('Undo');
    // Undo: bad back, good off.
    toasts[0]!.action!.run();
    await r.until('put back', () => keyButton('bad').getAttribute('aria-pressed') === 'true');
    expect(asked[1]).toEqual({ runId: RUN, add: ['bad'], remove: ['good'] });
    expect(toasts.at(-1)!.text).toBe('01M5GRX8K4: put back as it was');
  });

  it('labels it from the keyboard: + good, - bad, again to take it off', async () => {
    addressBar(`#/run/${RUN}/1`);
    const { client, asked } = server([]);
    const toasts: Array<{ text: string; action?: ToastAction }> = [];
    const state = app(client, toasts);
    r = await render(createElement(AppContext.Provider, { value: state }, createElement(RunPage, { id: RUN, call: 1, view: null })));
    await r.until('the run’s keys', () => !!(state.runKeys as { current: unknown }).current);
    const keys = (state.runKeys as { current: (e: { key: string }) => boolean }).current;
    expect(keys({ key: '+' })).toBe(true);
    await r.until('good', () => keyButton('good').getAttribute('aria-pressed') === 'true');
    expect(keys({ key: '-' })).toBe(true);
    await r.until('bad', () => keyButton('bad').getAttribute('aria-pressed') === 'true');
    expect(keys({ key: '-' })).toBe(true);
    await r.until('neither', () => keyButton('bad').getAttribute('aria-pressed') === 'false');
    expect(asked.map((a) => [a.add, a.remove])).toEqual([
      [['good'], []],
      [['bad'], ['good']],
      [[], ['bad']],
    ]);
    expect(toasts.at(-1)!.text).toBe('01M5GRX8K4 is no longer marked bad');
  });

  it('is off where nothing can change, saying why, and shows how the run is marked', async () => {
    addressBar(`#/run/${RUN}/1`);
    const { client } = server(['good']);
    const state = { ...app(client, []), actionsOff: 'Read-only: started with --read-only' } as unknown as AppState;
    r = await render(createElement(AppContext.Provider, { value: state }, createElement(RunPage, { id: RUN, call: 1, view: null })));
    await r.until('the header', () => r!.all('.rhead .runkey button').length === 2);
    expect(keyButton('good').getAttribute('aria-pressed')).toBe('true');
    expect(keyButton('good').hasAttribute('disabled')).toBe(true);
    expect(keyButton('good').getAttribute('title')).toBe('Read-only: started with --read-only');
  });
});

const row = (i: number, labels: string[]): TableRun => ({ runId: `01M5MXZ4Q3FWR1ND46Y5PGV${String(i).padStart(3, '0')}`, parentRunId: null, depth: 0, mode: 'record', status: 'completed', label: 'recording', divergence: null, command: 'node agent.mjs', about: { text: `ticket ${i}`, from: 'user' }, codeVersion: null, startedAt: T - i * 60_000, endedAt: T - i * 60_000 + 5000, calls: 12, spent: 0.01, saved: 0, captured: 0, imported: false, covers: null, source: null, labels }) as unknown as TableRun;

describe('the key on a row of Runs', () => {
  it('is at the end of each row, marks that run from its buttons or + and - on the row, and good and bad are no chips there', async () => {
    const marked: Array<[string, string]> = [];
    const rows = [row(1, ['good', 'nightly']), row(2, [])];
    r = await render(createElement(RunsTable, { rows, picked: new Set<string>(), selectable: true, byColumn: false, sort: 'when', onSort: () => undefined, onPick: () => undefined, onPickAll: () => undefined, now: T, onMark: (run: TableRun, m: string) => void marked.push([run.runId, m]) }));
    const groups = r.all('table.runst tbody td.keycell .runkey');
    expect(groups).toHaveLength(2);
    expect(groups[0]!.getAttribute('aria-label')).toBe('Good or bad: 01M5MXZ4Q3');
    // Its words for a screen reader, its marks for the eye.
    expect(r.all('table.runst tbody tr')[0]!.querySelectorAll('.runkey button').map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['good', 'true'],
      ['bad', 'false'],
    ]);
    expect(r.all('table.runst tbody tr')[0]!.querySelectorAll('.labs .chip').map((c) => c.textContent)).toEqual(['nightly']);
    await r.click(r.all('table.runst tbody tr')[1]!.querySelectorAll('.runkey button')[1]!);
    expect(marked).toEqual([[rows[1]!.runId, 'bad']]);
    // + on the row's checkbox: that row, good.
    const box = r.all('table.runst tbody tr')[1]!.querySelector('input[type="checkbox"]')!;
    box.focus();
    const e = await r.press('+');
    expect(e.defaultPrevented).toBe(true);
    expect(marked.at(-1)).toEqual([rows[1]!.runId, 'good']);
  });

  it('is not there in a table that changes nothing, whose labels stay chips', async () => {
    r = await render(createElement(RunsTable, { rows: [row(1, ['good'])], picked: new Set<string>(), selectable: false, byColumn: false, sort: 'when', onSort: () => undefined, onPick: () => undefined, onPickAll: () => undefined, now: T }));
    expect(r.all('.runkey')).toHaveLength(0);
    expect(r.all('.labs .chip').map((c) => c.textContent)).toEqual(['good']);
  });
});

describe('a toast with an action', () => {
  it('has its button, which closes the toast and does it', async () => {
    let ran = 0;
    const state = { toastText: { id: 1, text: 'Labelled good', kind: 'notice', action: { label: 'Undo', run: () => void ran++ } } } as unknown as AppState;
    r = await render(createElement(AppContext.Provider, { value: state }, createElement(ToastHost)));
    await r.until('the toast', () => r!.all('.toast').length === 1);
    const undo = r.byText('.toast button', 'Undo');
    await r.click(undo);
    expect(ran).toBe(1);
    expect(r.all('.toast')).toHaveLength(0);
  });
});
