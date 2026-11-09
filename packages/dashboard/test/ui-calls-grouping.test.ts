import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallRow, Client, RunDetail } from '../ui/api.js';
import { RunPage } from '../ui/pages/Run.js';
import { href } from '../ui/route.js';
import { navigate, useRoute } from '../ui/router.js';
import { AppContext, type AppState } from '../ui/state.js';
import { styleRules } from './css-sheet.js';
import { render, type Rendered } from './ui-render.js';
import { forgetPickedCalls } from '../ui/run/open-at.js';
import { forgetFolds } from '../ui/run/folds.js';

// A call picked on a run's page, and its folds, are remembered for the session: each test opens its runs afresh.
afterEach(() => {
  forgetPickedCalls();
  forgetFolds();
});

/**
 * Calls' trace on the run's page: each tool call under the model call that asked for it, its caret
 * before the kind, a batch's conversations each under a row of its own (and no Fold all), a fold that
 * never moves the selection, the selection's groups opened, ← and → on the selected call, the fold
 * buttons one Tab stop, and a filter's matches flat.
 */

const RUN = '01M5GRX8K406H4KHQ7DEKYWTSZ';
/** A run whose agent starts a sub-agent, and a fork of it at the sub-agent's tool call. */
const SUB = '01M5GRX8K406H4KHQ7DEKYWTT0';
const FORK = '01M5GRX8K406H4KHQ7DEKYWTT1';
const T = 1_760_000_000_000;

/** A live call that went well, named by its kind, with what `extra` says. */
function row(callNo: number, kind: string, extra: Record<string, unknown>): CallRow {
  const api = kind === 'api';
  return { callNo, kind, name: api ? 'POST /v1/messages' : kind === 'tool' ? 'lookup_order' : 'now', origin: 'live', effect: kind === 'tool' ? 'read' : null, outcome: 'ok', status: api ? 200 : null, latencyMs: 900, model: api ? 'claude-opus-5' : null, stopReason: null, usage: null, cost: null, bytes: null, detail: '', attempts: 0, replayedFrom: null, error: null, startedAt: T + callNo, endedAt: T + callNo + 1, ttftMs: null, scope: null, resultShort: null, conversation: null, conversationStart: false, requestedBy: null, toolUseId: null, cacheMiss: null, recordedMs: null, asks: api ? [] : null, ...extra } as unknown as CallRow;
}

/** Two tickets of a batch: a clock read, then a model call and its tool, then the answer. The first says what it was asked; the second's input is not known. */
function call(callNo: number): CallRow {
  const ticket = callNo <= 4 ? 1 : 2;
  const at = (callNo - 1) % 4;
  const kind = at === 0 ? 'clock' : at === 2 ? 'tool' : 'api';
  return row(callNo, kind, { conversation: ticket, conversationStart: at === 1, stopReason: kind === 'api' ? (at === 1 ? 'tool_use' : 'end_turn') : null, requestedBy: kind === 'tool' ? callNo - 1 : null, asks: kind === 'api' ? (at === 1 ? ['lookup_order'] : []) : null, conversationInput: callNo === 2 ? 'New ticket T-9100 (request 41)' : null });
}

/** The agent's model call asks for its policy checker, which asks for an order, reads it and answers; then the agent's tool call and its answer. */
const SUB_CALLS: Array<[string, Record<string, unknown>]> = [
  ['api', { scope: 'agent', conversation: 1, conversationStart: true, stopReason: 'tool_use', asks: ['check_policy'], cost: 0.004 }],
  ['api', { scope: 'agent/policy-checker', conversation: 2, conversationStart: true, stopReason: 'tool_use', asks: ['lookup_order'], cost: 0.002 }],
  ['tool', { scope: 'agent/policy-checker', requestedBy: 2 }],
  ['api', { scope: 'agent/policy-checker', conversation: 2, stopReason: 'end_turn', cost: 0.001, resultShort: 'Refund allowed: under 30 days' }],
  ['tool', { scope: 'agent', name: 'check_policy', requestedBy: 1 }],
  ['api', { scope: 'agent', conversation: 1, stopReason: 'end_turn', cost: 0.003, resultShort: 'Refunded order 4417' }],
];

function answer(runId = RUN, calls: CallRow[] = [1, 2, 3, 4, 5, 6, 7, 8].map(call), extra: Record<string, unknown> = {}): RunDetail {
  const kinds = (k: string) => calls.filter((c) => c.kind === k).length;
  return {
    run: { runId, parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: { argv: ['node', 'agent.mjs', '--batch', 'inbox.jsonl'], cwd: '/work' }, codeVersion: null, startedAt: T, endedAt: T + 10_000, meta: { labels: [] } },
    label: 'recording',
    about: { text: 'inbox 2026-09-30', from: 'input' },
    source: null,
    summary: { runId, mode: 'record', status: 'completed', total: calls.length, byOrigin: { live: calls.length }, byKind: { api: kinds('api'), tool: kinds('tool'), clock: kinds('clock'), random: 0 }, upstreamRequests: kinds('api'), injected: 0, refused: 0, imported: false, tokensNotRespent: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, cost: { spent: 0.01, saved: 0, captured: 0, unknownModels: [] }, durationMs: 10_000, notReached: [] },
    calls,
    callsTotal: calls.length,
    callsNext: null,
    parent: null,
    children: [],
    attempts: 0,
    actions: [],
    models: {},
    fix: null,
    state: { status: 'completed', kind: 'recording', outcome: { kind: 'none' }, failed: false, interrupted: false, endedAt: T + 10_000, label: 'recording' },
    ...extra,
  } as unknown as RunDetail;
}

const subAgent = (id: string) => answer(id, SUB_CALLS.map(([kind, extra], i) => row(i + 1, kind, extra)), id === FORK ? { forkAt: 3 } : {});

/** A recording's batch whose first ticket wrote and then failed at its model call, and a fork of a batch whose first ticket's model call was overridden and its write blocked. */
const WRITES = '01M5GRX8K406H4KHQ7DEKYWTT2';
const FORKED = '01M5GRX8K406H4KHQ7DEKYWTT3';
const WRITE_CALLS: Array<[string, Record<string, unknown>]> = [
  ['clock', { conversation: 1 }],
  ['api', { conversation: 1, conversationStart: true, stopReason: 'tool_use', asks: ['lookup_order', 'issue_refund'], conversationInput: 'New ticket T-9101 (request 42)' }],
  ['tool', { conversation: 1, requestedBy: 2 }],
  ['tool', { conversation: 1, requestedBy: 2, name: 'issue_refund', effect: 'write' }],
  ['clock', { conversation: 1 }],
  ['api', { conversation: 1, outcome: 'error', status: 529 }],
  ['clock', { conversation: 2 }],
  ['api', { conversation: 2, conversationStart: true, stopReason: 'end_turn', resultShort: 'Closed as a duplicate' }],
];
const FORKED_CALLS: Array<[string, Record<string, unknown>]> = [
  ['clock', { conversation: 1, origin: 'replayed' }],
  ['api', { conversation: 1, conversationStart: true, stopReason: 'tool_use', asks: ['issue_refund'], origin: 'overridden', conversationInput: 'New ticket T-9101 (request 42)' }],
  ['tool', { conversation: 1, requestedBy: 2, name: 'issue_refund', effect: 'write', origin: 'blocked', outcome: 'error' }],
  ['api', { conversation: 1, stopReason: 'end_turn', resultShort: 'Refund held for review' }],
  ['clock', { conversation: 2, origin: 'replayed' }],
  ['api', { conversation: 2, conversationStart: true, stopReason: 'end_turn', origin: 'replayed', resultShort: 'Closed as a duplicate' }],
];
function forked(): RunDetail {
  const d = answer(FORKED, FORKED_CALLS.map(([kind, extra], i) => row(i + 1, kind, extra)), { forkAt: 2 });
  return { ...d, run: { ...d.run, mode: 'replay', parentRunId: WRITES }, label: 'fork', state: { ...d.state, kind: 'fork', label: 'fork' } } as unknown as RunDetail;
}

/** Four tickets of a batch, the fourth folded, then a page read before the run's conversations were numbered: a model call, its tool, the answer. */
const DEEP = '01M5GRX8K406H4KHQ7DEKYWTT4';
const deep = (): RunDetail =>
  answer(DEEP, [
    ...Array.from({ length: 16 }, (_, i) => ({ ...call(i + 1), conversation: Math.floor(i / 4) + 1 })),
    row(17, 'api', { stopReason: 'tool_use', asks: ['lookup_order'] }),
    row(18, 'tool', { requestedBy: 17 }),
    row(19, 'api', { stopReason: 'end_turn' }),
  ]);

const RUNS: Record<string, () => RunDetail> = {
  [RUN]: () => answer(),
  [SUB]: () => subAgent(SUB),
  [FORK]: () => subAgent(FORK),
  [WRITES]: () => answer(WRITES, WRITE_CALLS.map(([kind, extra], i) => row(i + 1, kind, extra))),
  [FORKED]: forked,
  [DEEP]: deep,
};

const client = { exported: false, run: (id: string) => Promise.resolve(RUNS[id]()), call: () => new Promise(() => undefined), offers: () => Promise.resolve(null), runChaos: () => Promise.resolve(null), forkDifferences: () => Promise.resolve(null), unrecorded: () => Promise.resolve(null), lineage: () => Promise.resolve([]), jobs: () => Promise.resolve([]) } as unknown as Client;
const state = () => ({ client, exported: false, meta: null, runs: [], live: [], tick: 0, runsTick: 0, feeds: {}, jobs: [], actionsOff: null, hasKind: () => false, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined, refresh: () => undefined, setRunCommands: () => undefined, setPalette: () => undefined, runKeys: { current: null } }) as unknown as AppState;

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

/** The calls drawn, by number; a group's row is no call's. */
const rows = () => r!.all('table.calls tbody tr[data-call]').map((tr) => Number(tr.getAttribute('data-call')));
const caretOf = (callNo: number) => r!.one(`table.calls tbody tr[data-call="${String(callNo)}"]`).querySelector('button.tcaret');
const item = (n: number) => r!.one(`table.calls tbody tr.tgr[data-fold="i${String(n)}"]`);
const subRow = () => r!.one('table.calls tbody tr.tgr[data-fold="s2"]');
/** A call's steps in, as its name cell says them. */
const depth = (n: number) => (r!.one(`table.calls tbody tr[data-call="${String(n)}"] td.name`).props.style as Record<string, number> | undefined)?.['--d'];

/** The run's page as the shell routes to it: the call the address names is the one selected. */
function Routed() {
  const route = useRoute();
  return route.page === 'run' ? createElement(RunPage, { id: route.id, call: route.call, view: route.view }) : null;
}

async function open(at = 2, id = RUN) {
  const bar = addressBar(`#/run/${id}/${at}`);
  const app = state();
  r = await render(createElement(AppContext.Provider, { value: app }, createElement(Routed)));
  await r.until('the calls', () => rows().length > 0);
  const keys = () => (app.runKeys as { current: (e: { key: string }) => boolean }).current;
  /** A key the run's page hears, and whether it took it, the page drawn after it. */
  const key = async (k: string) => {
    let took = false;
    await act(async () => void (took = keys()({ key: k })));
    return took;
  };
  /** The run's keys hear what reaches the window, as the shell's Keyboard hands them on (ui/shell/Keyboard.tsx). */
  const hearKeys = () => window.addEventListener('keydown', (e) => void (app.runKeys as { current: ((e: KeyboardEvent) => boolean) | null }).current?.(e));
  return { bar, key, hearKeys };
}

describe('Calls, grouped', () => {
  it('draws a batch’s items as rows of their own, each named by what it was asked, a tool call under the model call that asked for it, its caret saying what it does', async () => {
    await open();
    expect(rows()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r!.one('table.calls').className).toBe('calls grouped');
    expect(r!.one('table.calls').getAttribute('aria-rowcount')).toBe('11');
    const items = r!.all('table.calls tbody tr.tgr');
    expect(items.map((tr) => tr.getAttribute('data-fold'))).toEqual(['i1', 'i2']);
    // An item's row is a button over the row, never a call: no number, no selection.
    expect(items[0].hasAttribute('aria-selected')).toBe(false);
    expect(items[0].getAttribute('data-wi')).toBe('0');
    const sum = items[0].querySelector('button.tgsum')!;
    expect(sum.getAttribute('aria-label')).toBe('New ticket T-9100 (request 41), 4 calls');
    expect(sum.getAttribute('aria-expanded')).toBe('true');
    // An item whose input is not known says its place among the batch's conversations.
    expect(items[1].querySelector('button.tgsum')!.getAttribute('aria-label')).toBe('conversation 2 of 2, 4 calls');
    expect(caretOf(2)!.getAttribute('aria-label')).toBe('Hide tool call of #2');
    expect(caretOf(6)!.getAttribute('aria-expanded')).toBe('true');
    expect(caretOf(3)).toBeNull();
    // A step in for each group: the item's, then the model call's.
    expect([depth(1), depth(2), depth(3)]).toEqual([1, 1, 2]);
    expect((item(1).querySelector('td.tgc')!.props.style as Record<string, number>)['--d']).toBe(0);
  });

  it('draws a sub-agent’s calls under a row of its own, in the model call that started it: its name, sub-agent, its calls, what they spent and how it ended', async () => {
    await open(6, SUB);
    expect(rows()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r!.all('table.calls tbody tr.tgr').map((tr) => tr.getAttribute('data-fold'))).toEqual(['s2']);
    expect(r!.one('table.calls').getAttribute('aria-rowcount')).toBe('8');
    const sum = subRow().querySelector('button.tgsum')!;
    expect(sum.getAttribute('aria-label')).toBe('policy-checker, sub-agent, 3 calls');
    expect(sum.querySelector('code')!.textContent).toBe('policy-checker');
    expect(sum.querySelector('.tgk')!.textContent).toBe('sub-agent');
    expect(sum.querySelector('.tgfacts')!.textContent).toBe('3 calls≈$0.0030 spent');
    expect(subRow().querySelector('.tgout')!.textContent).toBe('→ Refund allowed: under 30 days');
    // The agent's model call holds it beside the tool call it asked for; the row names the agent, so its calls' Agent cell is empty.
    expect(caretOf(1)!.getAttribute('aria-label')).toBe('Hide calls of #1');
    expect((subRow().querySelector('td.tgc')!.props.style as Record<string, number>)['--d']).toBe(1);
    expect([depth(2), depth(3), depth(4), depth(5), depth(6)]).toEqual([2, 3, 2, 1, undefined]);
    const agentCell = (n: number) => r!.one(`table.calls tbody tr[data-call="${String(n)}"] td.scopecell`).textContent;
    expect([1, 2, 3, 5].map(agentCell)).toEqual(['agent', '', '', 'agent']);
    // Folded, the row stays, with how many calls it holds; the agent's call folds it with its tool call.
    await r!.click(sum);
    expect(rows()).toEqual([1, 5, 6]);
    await r!.click(caretOf(1)!);
    expect(rows()).toEqual([1, 6]);
    expect(r!.all('table.calls tbody tr.tgr')).toHaveLength(0);
  });

  it('folds a group without moving the selection: the folded row holds it, and the caret keeps the focus', async () => {
    const { bar } = await open(3);
    await r!.click(caretOf(2)!);
    expect(rows()).toEqual([1, 2, 4, 5, 6, 7, 8]);
    expect(bar.hash).toBe(`#/run/${RUN}/3`);
    expect(r!.one('table.calls tbody tr[data-call="2"]').className).toBe('held');
    expect(caretOf(2)!.getAttribute('aria-label')).toBe('Show tool call of #2');
    expect(r!.focused()).toBe(caretOf(2));
    // A click anywhere on an item's row folds it, once.
    await r!.click(item(1).querySelector('td.n')!);
    expect(rows()).toEqual([5, 6, 7, 8]);
    expect(item(1).className).toBe('tgr held');
    expect(bar.hash).toBe(`#/run/${RUN}/3`);
    await r!.click(item(1).querySelector('button.tgsum')!);
    expect(rows()).toEqual([1, 2, 4, 5, 6, 7, 8]);
    expect(r!.focused()).toBe(item(1).querySelector('button.tgsum'));
  });

  it('marks a folded row that holds the fork, and n to the fork opens it', async () => {
    const { bar, key } = await open(6, FORK);
    // Open, the fork's own row carries the mark.
    expect(subRow().querySelector('td.n')!.textContent).toBe('');
    expect(r!.one('table.calls tbody tr[data-call="3"] td.n .fk').textContent).toBe('fork');
    await r!.click(subRow().querySelector('button.tgsum')!);
    expect(rows()).toEqual([1, 5, 6]);
    expect(subRow().querySelector('td.n .fk')!.textContent).toBe('fork');
    expect(await key('n')).toBe(true);
    expect(bar.hash).toBe(`#/run/${FORK}/3`);
    await r!.until('the fork drawn', () => rows().includes(3));
    expect(rows()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(subRow().querySelector('td.n .fk')).toBeNull();
    expect(subRow().querySelector('button.tgsum')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps a run’s folds for the session: another run opened, and this one again, they are as left', async () => {
    await open(2);
    await r!.click(item(2).querySelector('button.tgsum')!);
    expect(rows()).toEqual([1, 2, 3, 4]);
    const subOpen = () => r!.all('table.calls tbody tr[data-call="1"] button.tcaret').length === 1;
    await act(async () => navigate(href.run(SUB, 6), true));
    await r!.until('the sub-agent’s run', subOpen);
    expect(rows()).toEqual([1, 2, 3, 4, 5, 6]);
    await r!.click(caretOf(1)!);
    expect(rows()).toEqual([1, 6]);
    await act(async () => navigate(href.run(RUN, 2), true));
    await r!.until('the batch again', () => r!.all('table.calls tbody tr.tgr[data-fold="i2"]').length === 1);
    expect(rows()).toEqual([1, 2, 3, 4]);
    expect(item(2).querySelector('button.tgsum')!.getAttribute('aria-expanded')).toBe('false');
    await act(async () => navigate(href.run(SUB, 6), true));
    await r!.until('the sub-agent’s run again', subOpen);
    expect(rows()).toEqual([1, 6]);
  });

  it('opens the groups a call picked sits in, and a fold of one holds after it', async () => {
    await open(2);
    expect(r!.all('button').some((b) => b.textContent === 'Fold all')).toBe(false);
    await r!.click(item(2));
    expect(rows()).toEqual([1, 2, 3, 4]);
    await r!.wait(0);
    await act(async () => navigate(href.run(RUN, 7), true));
    await r!.until('#7 in view', () => rows().includes(7));
    expect(rows()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Folded again around the selection, it stays folded.
    await r!.click(item(2));
    await r!.wait(10);
    expect(rows()).toEqual([1, 2, 3, 4]);
    expect(item(2).className).toBe('tgr held');
  });

  it('folds and opens with ← and → on the selected call, and goes up and in', async () => {
    const { bar, key } = await open(3);
    // ← on a tool call goes to the model call it sits under.
    expect(await key('ArrowLeft')).toBe(true);
    expect(bar.hash).toBe(`#/run/${RUN}/2`);
    await r!.wait(10);
    // ← on an open model call folds its calls, then the item's row that holds it, the selection held.
    expect(await key('ArrowLeft')).toBe(true);
    await r!.wait(10);
    expect(rows()).toEqual([1, 2, 4, 5, 6, 7, 8]);
    expect(await key('ArrowLeft')).toBe(true);
    await r!.wait(10);
    expect(rows()).toEqual([5, 6, 7, 8]);
    expect(bar.hash).toBe(`#/run/${RUN}/2`);
    // → opens what holds the selection, then its calls, then goes to the first of them.
    expect(await key('ArrowRight')).toBe(true);
    await r!.wait(10);
    expect(rows()).toEqual([1, 2, 4, 5, 6, 7, 8]);
    expect(await key('ArrowRight')).toBe(true);
    await r!.wait(10);
    expect(rows()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await key('ArrowRight')).toBe(true);
    expect(bar.hash).toBe(`#/run/${RUN}/3`);
  });

  it('heads a sub-agent’s row with its first call for ← and →: ← goes to it, folds its calls, then the row, then goes on to the model call that started it', async () => {
    const { bar, key } = await open(4, SUB);
    // ← on the sub-agent's answer goes to its first call.
    expect(await key('ArrowLeft')).toBe(true);
    expect(bar.hash).toBe(`#/run/${SUB}/2`);
    await r!.wait(10);
    // Then folds that call's tool call, then the row, the selection held.
    expect(await key('ArrowLeft')).toBe(true);
    await r!.wait(10);
    expect(rows()).toEqual([1, 2, 4, 5, 6]);
    expect(await key('ArrowLeft')).toBe(true);
    await r!.wait(10);
    expect(rows()).toEqual([1, 5, 6]);
    expect(subRow().className).toBe('tgr held');
    expect(bar.hash).toBe(`#/run/${SUB}/2`);
    // From the folded row, on to the model call whose tool started it.
    expect(await key('ArrowLeft')).toBe(true);
    expect(bar.hash).toBe(`#/run/${SUB}/1`);
    await r!.wait(10);
    // → goes to the first call under it, which opens the row; then opens its calls, then goes to the first.
    expect(await key('ArrowRight')).toBe(true);
    expect(bar.hash).toBe(`#/run/${SUB}/2`);
    await r!.until('the sub-agent’s row open', () => rows().includes(2));
    expect(rows()).toEqual([1, 2, 4, 5, 6]);
    expect(await key('ArrowRight')).toBe(true);
    await r!.wait(10);
    expect(rows()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await key('ArrowRight')).toBe(true);
    expect(bar.hash).toBe(`#/run/${SUB}/3`);
  });

  it('steps with j and k through every call, a folded one too, opening what j reaches', async () => {
    const { bar, key } = await open(3);
    await r!.click(caretOf(2)!);
    expect(rows()).toEqual([1, 2, 4, 5, 6, 7, 8]);
    // From #3, held under #2: k selects #2, and its calls stay folded.
    expect(await key('k')).toBe(true);
    expect(bar.hash).toBe(`#/run/${RUN}/2`);
    await r!.wait(10);
    expect(rows()).toEqual([1, 2, 4, 5, 6, 7, 8]);
    // j selects #3 and opens #2.
    expect(await key('j')).toBe(true);
    expect(bar.hash).toBe(`#/run/${RUN}/3`);
    await r!.until('#3 drawn again', () => rows().includes(3));
    expect(caretOf(2)!.getAttribute('aria-expanded')).toBe('true');
  });

  it('makes the fold buttons one Tab stop, moved with ↑ ↓ Home End, ← folding and → opening, each press the button’s alone', async () => {
    const { bar, hearKeys } = await open(2);
    hearKeys();
    const stops = () => r!.all('table.calls [data-fold][tabindex="0"]');
    expect(stops()).toHaveLength(1);
    expect(stops()[0]).toBe(caretOf(2));
    await r!.focus(caretOf(2)!);
    await r!.press('ArrowDown');
    expect(r!.focused()).toBe(item(2).querySelector('button.tgsum'));
    expect(stops()).toEqual([item(2).querySelector('button.tgsum')]);
    await r!.press('End');
    expect(r!.focused()).toBe(caretOf(6));
    await r!.press('Home');
    expect(r!.focused()).toBe(item(1).querySelector('button.tgsum'));
    // The run's own ↓ ↑ never heard them: the selection stays.
    expect(bar.hash).toBe(`#/run/${RUN}/2`);
    // ← and → on the second item's row fold and open it alone: the selected model call's own ← and → never hear them.
    await r!.focus(item(2).querySelector('button.tgsum')!);
    await r!.press('ArrowLeft');
    expect(rows()).toEqual([1, 2, 3, 4]);
    expect(caretOf(2)!.getAttribute('aria-expanded')).toBe('true');
    await r!.press('ArrowLeft');
    expect(rows()).toEqual([1, 2, 3, 4]);
    expect(caretOf(2)!.getAttribute('aria-expanded')).toBe('true');
    await r!.press('ArrowRight');
    expect(rows()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(bar.hash).toBe(`#/run/${RUN}/2`);
    // On the first item's row, which holds the selection, ← folds it once.
    await r!.focus(item(1).querySelector('button.tgsum')!);
    await r!.press('ArrowLeft');
    expect(rows()).toEqual([5, 6, 7, 8]);
    await r!.press('ArrowLeft');
    expect(rows()).toEqual([5, 6, 7, 8]);
    await r!.press('ArrowRight');
    expect(rows()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('gives the Tab stop back to the selection’s group once the selection moves on after a fold elsewhere', async () => {
    await open(2);
    const stops = () => r!.all('table.calls [data-fold][tabindex="0"]');
    await r!.focus(item(2).querySelector('button.tgsum')!);
    await r!.press('ArrowLeft');
    expect(rows()).toEqual([1, 2, 3, 4]);
    expect(stops()).toEqual([item(2).querySelector('button.tgsum')]);
    // A tool call picked: the caret of the model call it sits under.
    await r!.click(r!.one('table.calls tbody tr[data-call="3"]'));
    expect(stops()).toEqual([caretOf(2)]);
    // A call with no caret over it: its item's row.
    await r!.click(r!.one('table.calls tbody tr[data-call="4"]'));
    expect(stops()).toEqual([item(1).querySelector('button.tgsum')]);
  });

  it('says on an item’s row what its calls were, in the key’s words after its swatches: a recording’s writes and errors, a fork’s overridden and blocked calls', async () => {
    await open(2, WRITES);
    const facts = () => item(1).querySelector('.tgfacts')!;
    const swatches = () => facts().children.filter((s) => s.children[0]?.className.startsWith('lg ')).map((s) => `${s.children[0].className}:${s.textContent}`);
    expect(item(1).querySelector('button.tgsum')!.getAttribute('aria-label')).toBe('New ticket T-9101 (request 42), 6 calls, 1 write, 1 error');
    expect(facts().textContent).toBe('6 calls1 write1 error');
    expect(swatches()).toEqual(['lg k-write:1 write', 'lg k-err:1 error']);
    expect(item(1).querySelector('.tgout.err')!.textContent).toBe('→ HTTP 529 at #6');
    expect(item(2).querySelector('.tgfacts')!.textContent).toBe('2 calls');
    await act(async () => navigate(href.run(FORKED, 2), true));
    await r!.until('the fork', () => r!.all('table.calls tbody tr.tgr .tgfacts i.lg.over').length === 1);
    expect(item(1).querySelector('button.tgsum')!.getAttribute('aria-label')).toBe('New ticket T-9101 (request 42), 4 calls, 1 overridden, 1 blocked');
    expect(swatches()).toEqual(['lg over:1 overridden', 'lg block:1 blocked']);
    expect(item(2).querySelector('.tgfacts')!.textContent).toBe('2 calls');
  });

  it('draws calls read before their conversation is known at the top, in view under a folded ticket, never in it', async () => {
    await open(2, DEEP);
    const shut = item(4).querySelector('button.tgsum')!;
    expect(shut.getAttribute('aria-expanded')).toBe('false');
    expect(shut.getAttribute('aria-label')).toBe('conversation 4 of 4, 4 calls');
    expect(rows()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 17, 18, 19]);
    // At the run's own level: the model calls no step in, the tool call one under its model call.
    expect([depth(17), depth(18), depth(19)]).toEqual([undefined, 1, undefined]);
  });

  it('lists a filter’s matches flat, a folded group’s too, and groups them again with their folds once it is cleared', async () => {
    await open();
    await r!.click(item(2).querySelector('button.tgsum')!);
    expect(rows()).toEqual([1, 2, 3, 4]);
    const search = () => r!.one('.strip .filter-in input[type="search"]');
    await r!.type(search(), 'lookup');
    // The tool calls, and the model calls that asked for them.
    await r!.until('the matches', () => rows().join() === '2,3,6,7');
    expect(r!.one('table.calls').className).toBe('calls');
    expect(r!.all('table.calls .tgr, table.calls .tcaret')).toHaveLength(0);
    expect(depth(3)).toBeUndefined();
    await r!.type(search(), '');
    await r!.until('the trace again', () => r!.one('table.calls').className === 'calls grouped');
    expect(rows()).toEqual([1, 2, 3, 4]);
    expect(item(2).querySelector('button.tgsum')!.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the trace’s rules', () => {
  it('steps 16px a level, gives a caret a 24px tap on a touch screen, and the held row the selection’s ground under the pointer too', () => {
    const rules = styleRules();
    const decl = (selector: string, prop: string, condition?: string) =>
      rules
        .filter((x) => x.selectors.includes(selector) && (condition ? x.conditions.some((c) => c.includes(condition)) : !x.conditions.length))
        .flatMap((x) => x.decls.filter(([p]) => p === prop).map(([, v]) => v))
        .at(-1);
    expect(decl('table.calls.grouped td.name', 'padding-left')).toBe('calc(26px + var(--d, 0) * 16px)');
    expect(decl('table.calls td.tgc', 'padding-left', 'max-width: 640px')).toBe('calc(24px + var(--d, 0) * 12px)');
    expect(decl('table.calls .tcaret::before', 'inset', 'pointer: coarse')).toBe('-3px -5px');
    expect(decl('table.calls tbody tr.held td', 'background')).toBe('var(--sel)');
    expect(decl('table.calls tbody tr.held td:first-child', 'box-shadow')).toBe('inset 3px 0 0 var(--ink)');
    // Folded, a fold button's caret turns; a row's fork button, aria-expanded for its menu, keeps its icon upright.
    const turned = rules.filter((x) => x.decls.some(([p, v]) => p === 'transform' && v.startsWith('rotate'))).flatMap((x) => x.selectors.filter((s) => s.startsWith('table.calls')));
    expect(turned).toEqual(['table.calls :is(.tcaret, .tgsum)[aria-expanded="false"] > svg']);
  });
});
