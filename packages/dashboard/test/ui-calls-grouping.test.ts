import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallRow, Client, RunDetail } from '../ui/api.js';
import { RunPage } from '../ui/pages/Run.js';
import { href } from '../ui/route.js';
import { navigate, useRoute } from '../ui/router.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Calls grouped on the run's page: each tool call under the model call that asked for it, a batch's
 * conversations each under its first call, a fold mark on every call with calls under it, Fold all,
 * ← and → as in a tree, the selected call never folded away, and a filter's matches flat.
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
const state = () => ({ client, exported: false, meta: null, runs: [], live: [], tick: 0, runsTick: 0, feeds: {}, jobs: [], actionsOff: null, hasKind: () => false, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined, refresh: () => undefined, registerLayer: () => () => undefined, setRunCommands: () => undefined, setPalette: () => undefined, runKeys: { current: null } }) as unknown as AppState;

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

const rows = () => r!.all('table.calls tbody tr[data-wi]').map((tr) => Number(tr.querySelector('td.n')!.childNodes.at(-1)!.textContent));
const foldOf = (callNo: number) => r!.all('table.calls tbody tr[data-wi]').find((tr) => tr.querySelector('td.n')!.childNodes.at(-1)!.textContent === String(callNo))!.querySelector('button.tw');

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
  it('puts each ticket of a batch under its first call, a tool call under the model call that asked for it, each fold mark saying what it does', async () => {
    await open();
    expect(r!.one('table.calls').className).toBe('calls grouped');
    expect(foldOf(1)!.getAttribute('aria-label')).toBe('Hide the 3 calls under #1');
    expect(foldOf(1)!.getAttribute('aria-expanded')).toBe('true');
    expect(foldOf(2)!.getAttribute('aria-label')).toBe('Hide the call under #2');
    expect(foldOf(3)).toBeNull();
    // Each ticket names its conversation beside its first call.
    expect(r!.all('table.calls .gitem').map((e) => e.textContent)).toEqual(['conversation 1 of 2', 'conversation 2 of 2']);
  });

  it('folds a group away and opens it again, a folded one saying how many calls it holds', async () => {
    await open(6);
    await r!.click(foldOf(1)!);
    expect(rows()).toEqual([1, 5, 6, 7, 8]);
    expect(foldOf(1)!.getAttribute('aria-expanded')).toBe('false');
    expect(r!.all('table.calls .gfold').map((e) => e.textContent)).toEqual(['3 calls']);
    await r!.click(foldOf(1)!);
    expect(rows()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('folds every group with Fold all, and opens what the selection goes into', async () => {
    await open(2);
    await r!.click(r!.byText('.toolbar button', 'Fold all'));
    // The selected call stays in view: the group it sits in opens again, its siblings with it.
    expect(rows()).toEqual([1, 2, 4, 5]);
    // Something is folded: the button opens it all again.
    expect(r!.byText('.toolbar button', 'Unfold all')).toBeTruthy();
    // Going to a call in a folded group opens the groups it sits in.
    await r!.wait(0);
    navigate(href.run(RUN, 7), true);
    await r!.until('#7 in view', () => rows().includes(7));
    expect(rows()).toEqual([1, 2, 4, 5, 6, 7, 8]);
    await r!.click(r!.byText('.toolbar button', 'Unfold all'));
    await r!.click(r!.byText('.toolbar button', 'Fold all'));
    // Folded again, the other ticket goes, and #7's stays open around it.
    expect(rows()).toEqual([1, 5, 6, 7, 8]);
    await r!.click(r!.byText('.toolbar button', 'Unfold all'));
    expect(rows()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('folds and opens with ← and →, and goes up and in, as a tree does', async () => {
    const { bar, keys } = await open(3);
    // ← on a call with nothing under it goes to the call it sits under.
    expect(keys()({ key: 'ArrowLeft' })).toBe(true);
    expect(bar.hash).toBe(`#/run/${RUN}/2`);
    await r!.wait(10);
    // ← on an open group folds it, then goes up again.
    expect(keys()({ key: 'ArrowLeft' })).toBe(true);
    await r!.wait(10);
    expect(rows()).toEqual([1, 2, 4, 5, 6, 7, 8]);
    expect(keys()({ key: 'ArrowRight' })).toBe(true);
    await r!.wait(10);
    expect(rows()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // → on an open group goes to its first call.
    expect(keys()({ key: 'ArrowRight' })).toBe(true);
    expect(bar.hash).toBe(`#/run/${RUN}/3`);
  });

  it('lists a filter’s matches flat', async () => {
    await open();
    await r!.type(r!.one('.toolbar input[type="search"]'), 'lookup');
    // The tool calls, and the model calls that asked for them.
    await r!.until('the matches', () => rows().join() === '2,3,6,7');
    expect(r!.one('table.calls').className).toBe('calls');
    expect(r!.all('table.calls .lead')).toHaveLength(0);
    expect(r!.all('.toolbar button').some((b) => b.textContent === 'Fold all')).toBe(false);
  });
});
