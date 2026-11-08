import { createElement } from 'react';
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
const T = 1_760_000_000_000;

/** Two tickets of a batch: a clock read, then a model call and its tool, then the answer. */
function call(callNo: number): CallRow {
  const ticket = callNo <= 4 ? 1 : 2;
  const at = (callNo - 1) % 4;
  const kind = at === 0 ? 'clock' : at === 2 ? 'tool' : 'api';
  return { callNo, kind, name: kind === 'api' ? 'POST /v1/messages' : kind === 'tool' ? 'lookup_order' : 'now', origin: 'live', effect: kind === 'tool' ? 'read' : null, outcome: 'ok', status: kind === 'api' ? 200 : null, latencyMs: 900, model: kind === 'api' ? 'claude-opus-5' : null, stopReason: kind === 'api' ? (at === 1 ? 'tool_use' : 'end_turn') : null, usage: null, cost: null, bytes: null, detail: '', attempts: 0, replayedFrom: null, error: null, startedAt: T + callNo, endedAt: T + callNo + 1, ttftMs: null, scope: null, resultShort: null, conversation: ticket, conversationStart: at === 1, requestedBy: kind === 'tool' ? callNo - 1 : null, toolUseId: null, cacheMiss: null, recordedMs: null, asks: kind === 'api' ? (at === 1 ? ['lookup_order'] : []) : null } as unknown as CallRow;
}

function answer(): RunDetail {
  return {
    run: { runId: RUN, parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: { argv: ['node', 'agent.mjs', '--batch', 'inbox.jsonl'], cwd: '/work' }, codeVersion: null, startedAt: T, endedAt: T + 10_000, meta: { labels: [] } },
    label: 'recording',
    about: { text: 'inbox 2026-09-30', from: 'input' },
    source: null,
    summary: { runId: RUN, mode: 'record', status: 'completed', total: 8, byOrigin: { live: 8 }, byKind: { api: 4, tool: 2, clock: 2, random: 0 }, upstreamRequests: 4, injected: 0, refused: 0, imported: false, tokensNotRespent: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, cost: { spent: 0.01, saved: 0, captured: 0, unknownModels: [] }, durationMs: 10_000, notReached: [] },
    calls: [1, 2, 3, 4, 5, 6, 7, 8].map(call),
    callsTotal: 8,
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

const client = { exported: false, run: () => Promise.resolve(answer()), call: () => new Promise(() => undefined), offers: () => Promise.resolve(null), runChaos: () => Promise.resolve(null), forkDifferences: () => Promise.resolve(null), unrecorded: () => Promise.resolve(null), lineage: () => Promise.resolve([]), jobs: () => Promise.resolve([]) } as unknown as Client;
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

/** The run's page as the shell routes to it: the call the address names is the one selected. */
function Routed() {
  const route = useRoute();
  return route.page === 'run' ? createElement(RunPage, { id: route.id, call: route.call, view: route.view }) : null;
}

async function open(at = 2) {
  const bar = addressBar(`#/run/${RUN}/${at}`);
  const app = state();
  r = await render(createElement(AppContext.Provider, { value: app }, createElement(Routed)));
  await r.until('the calls', () => rows().length > 0);
  return { bar, keys: () => (app.runKeys as { current: (e: { key: string }) => boolean }).current };
}

describe('Calls, grouped', () => {
  it('draws a batch’s items as rows of their own, a tool call under the model call that asked for it, its caret saying what it does', async () => {
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
    expect(sum.getAttribute('aria-label')).toBe('conversation 1 of 2, 4 calls');
    expect(sum.getAttribute('aria-expanded')).toBe('true');
    expect(caretOf(2)!.getAttribute('aria-label')).toBe('Hide tool call of #2');
    expect(caretOf(6)!.getAttribute('aria-expanded')).toBe('true');
    expect(caretOf(3)).toBeNull();
    // A step in for each group: the item's, then the model call's.
    const depth = (n: number) => (r!.one(`table.calls tbody tr[data-call="${String(n)}"] td.name`).props.style as Record<string, number> | undefined)?.['--d'];
    expect([depth(1), depth(2), depth(3)]).toEqual([1, 1, 2]);
    expect((item(1).querySelector('td.tgc')!.props.style as Record<string, number>)['--d']).toBe(0);
  });

  it('folds a group without moving the selection: the folded row holds it', async () => {
    const { bar } = await open(3);
    await r!.click(caretOf(2)!);
    expect(rows()).toEqual([1, 2, 4, 5, 6, 7, 8]);
    expect(bar.hash).toBe(`#/run/${RUN}/3`);
    expect(r!.one('table.calls tbody tr[data-call="2"]').className).toBe('held');
    expect(caretOf(2)!.getAttribute('aria-label')).toBe('Show tool call of #2');
    // A click anywhere on an item's row folds it, once.
    await r!.click(item(1).querySelector('td.n')!);
    expect(rows()).toEqual([5, 6, 7, 8]);
    expect(item(1).className).toBe('tgr held');
    expect(bar.hash).toBe(`#/run/${RUN}/3`);
    await r!.click(item(1).querySelector('button.tgsum')!);
    expect(rows()).toEqual([1, 2, 4, 5, 6, 7, 8]);
  });

  it('opens the groups a call picked sits in, and a fold of one holds after it', async () => {
    await open(2);
    expect(r!.all('button').some((b) => b.textContent === 'Fold all')).toBe(false);
    await r!.click(item(2));
    expect(rows()).toEqual([1, 2, 3, 4]);
    await r!.wait(0);
    navigate(href.run(RUN, 7), true);
    await r!.until('#7 in view', () => rows().includes(7));
    expect(rows()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Folded again around the selection, it stays folded.
    await r!.click(item(2));
    await r!.wait(10);
    expect(rows()).toEqual([1, 2, 3, 4]);
    expect(item(2).className).toBe('tgr held');
  });

  it('folds and opens with ← and → on the selected call, and goes up and in', async () => {
    const { bar, keys } = await open(3);
    // ← on a tool call goes to the model call it sits under.
    expect(keys()({ key: 'ArrowLeft' })).toBe(true);
    expect(bar.hash).toBe(`#/run/${RUN}/2`);
    await r!.wait(10);
    // ← on an open model call folds its calls, then the item's row that holds it, the selection held.
    expect(keys()({ key: 'ArrowLeft' })).toBe(true);
    await r!.wait(10);
    expect(rows()).toEqual([1, 2, 4, 5, 6, 7, 8]);
    expect(keys()({ key: 'ArrowLeft' })).toBe(true);
    await r!.wait(10);
    expect(rows()).toEqual([5, 6, 7, 8]);
    expect(bar.hash).toBe(`#/run/${RUN}/2`);
    // → opens what holds the selection, then its calls, then goes to the first of them.
    expect(keys()({ key: 'ArrowRight' })).toBe(true);
    await r!.wait(10);
    expect(rows()).toEqual([1, 2, 4, 5, 6, 7, 8]);
    expect(keys()({ key: 'ArrowRight' })).toBe(true);
    await r!.wait(10);
    expect(rows()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(keys()({ key: 'ArrowRight' })).toBe(true);
    expect(bar.hash).toBe(`#/run/${RUN}/3`);
  });

  it('makes the fold buttons one Tab stop, moved with ↑ ↓ Home End, ← folding and → opening, each press once', async () => {
    await open(2);
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
    await r!.press('ArrowLeft');
    expect(rows()).toEqual([5, 6, 7, 8]);
    await r!.press('ArrowLeft');
    expect(rows()).toEqual([5, 6, 7, 8]);
    await r!.press('ArrowRight');
    expect(rows()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('lists a filter’s matches flat', async () => {
    await open();
    await r!.type(r!.one('.strip .filter-in input[type="search"]'), 'lookup');
    // The tool calls, and the model calls that asked for them.
    await r!.until('the matches', () => rows().join() === '2,3,6,7');
    expect(r!.one('table.calls').className).toBe('calls');
    expect(r!.all('table.calls .tgr, table.calls .tcaret')).toHaveLength(0);
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
  });
});
