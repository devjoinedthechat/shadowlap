import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallRow, Client, RunDetail } from '../ui/api.js';
import { RunPage } from '../ui/pages/Run.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';
import { forgetPickedCalls } from '../ui/run/open-at.js';

// A call picked on a run's page is remembered for the session: each test opens its runs afresh.
afterEach(forgetPickedCalls);

/**
 * A run's page draws, under its banner, what the run did that Shadowlap did not record (the tools
 * the model called, a preload that never loaded, WebSockets, a replay's extra reads), each call it
 * names opening on a click; Calls tags an extra read; Provenance names the host a call went through
 * and the guard.
 */

const RUN = '01M5GRX8K406H4KHQ7DEKYWTSZ';
const T = 1_760_000_000_000;

function call(callNo: number): CallRow {
  const api = callNo % 2 === 1;
  return { callNo, kind: api ? 'api' : 'tool', name: api ? 'POST /api/v1/chat/completions' : 'lookup_policy', origin: callNo === 4 ? 'live' : 'replayed', effect: api ? null : 'pure', outcome: 'ok', status: api ? 200 : null, latencyMs: 900, model: api ? 'gpt-5' : null, stopReason: api ? 'tool_calls' : null, usage: null, cost: null, bytes: null, detail: '', attempts: 0, replayedFrom: null, error: null, startedAt: T + callNo, endedAt: T + callNo + 1, ttftMs: null, scope: null, resultShort: null, conversation: 1, conversationStart: callNo === 1, requestedBy: api ? null : callNo - 1, toolUseId: null, cacheMiss: null, recordedMs: null, asks: api ? ['lookup_policy'] : null, ...(api ? { via: 'openrouter.ai' } : {}), ...(callNo === 4 ? { extraRead: true } : {}) } as unknown as CallRow;
}

function answer(): RunDetail {
  return {
    run: { runId: RUN, parentRunId: null, mode: 'replay', status: 'completed', divergence: null, command: { argv: ['node', 'agent.mjs'], cwd: '/work' }, codeVersion: null, startedAt: T, endedAt: T + 10_000, meta: { labels: [], preloads: { guard: 'warn', hellos: {}, missing: "No Shadowlap preload loaded in the agent's processes, though the run made 3 model calls: the network guard never watched it." } } },
    label: 'clean replay',
    about: { text: 'clean replay', from: 'change' },
    source: null,
    summary: { runId: RUN, mode: 'replay', status: 'completed', total: 6, byOrigin: { replayed: 5, live: 1 }, byKind: { api: 3, tool: 3, clock: 0, random: 0 }, upstreamRequests: 0, injected: 0, refused: 0, imported: false, tokensNotRespent: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, cost: { spent: 0, saved: 0.01, captured: 0, unknownModels: [] }, durationMs: 10_000, notReached: [], extraReads: [{ callNo: 4, kind: 'tool', name: 'lookup_policy' }] },
    calls: [1, 2, 3, 4, 5, 6].map(call),
    callsTotal: 6,
    callsNext: null,
    parent: null,
    children: [],
    attempts: 0,
    actions: [],
    models: {},
    fix: null,
    websockets: [{ target: 'openai /v1/realtime', count: 1, action: 'tunnelled' }],
    state: { status: 'completed', kind: 'clean', outcome: { kind: 'clean' }, failed: false, interrupted: false, endedAt: T + 10_000, label: 'clean replay' },
  } as unknown as RunDetail;
}

const details: number[] = [];
const client = {
  exported: false,
  run: () => Promise.resolve(answer()),
  call: (_id: string, n: number) => (details.push(n), new Promise(() => undefined)),
  offers: () => Promise.resolve(null),
  runChaos: () => Promise.resolve(null),
  forkDifferences: () => Promise.resolve(null),
  unrecorded: () => Promise.resolve({ runId: RUN, partial: false, tools: [{ name: 'Bash', count: 3, firstCallNo: 5, effect: 'write', why: 'a Claude Code built-in that runs a command', fix: 'fence' }] }),
  lineage: () => Promise.resolve([]),
  jobs: () => Promise.resolve([]),
  provenance: () => Promise.resolve({ providers: [{ provider: 'openai', calls: 3, via: 'openrouter.ai' }], preloads: { guard: 'warn', hellos: {}, missing: 'No Shadowlap preload loaded.' } }),
  showJson: () => new Promise(() => undefined),
} as unknown as Client;

const app = { client, exported: false, meta: null, runs: [], live: [], tick: 0, runsTick: 0, feeds: {}, jobs: [], actionsOff: null, hasKind: () => false, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined, refresh: () => undefined, setRunCommands: () => undefined, setPalette: () => undefined, runKeys: { current: null } } as unknown as AppState;

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

describe('the notes on a run’s page', () => {
  it('says what the run did that Shadowlap did not record, the most pressing first, each call opening on a click', async () => {
    const bar = addressBar(`#/run/${RUN}/1`);
    r = await render(createElement(AppContext.Provider, { value: app }, createElement(RunPage, { id: RUN, call: 1, view: null })));
    // Each note a finding, the most pressing first, the others folded until `4 findings` opens them.
    await r.until('the notes', () => r!.all('.findings .rnote').length === 4);
    expect(r.all('.findings .rnote').map((n) => [n.className, n.querySelector('.bk')!.textContent])).toEqual([
      ['rnote err', 'not recorded'],
      ['rnote warn fx', 'no preload'],
      ['rnote warn fx', 'websocket'],
      ['rnote n fx', 'extra reads'],
    ]);
    // The tool, with the model call that first asked for it, which opens on a click.
    const tool = r.one('.rntools li');
    expect(tool.querySelector('code')!.textContent).toBe('Bash');
    expect(tool.querySelector('.eff')!.textContent).toBe('write');
    await r.click(tool.querySelector('button.bn')!);
    expect(bar.hash).toBe(`#/run/${RUN}/5`);
    // What to declare, to copy.
    expect(r.one('.rnhint code.rncopy').textContent).toBe('"tools": { "unrecorded": { "Bash": "write" } }');
    // The extra read's call opens too, and Calls tags it.
    await r.click(r.all('.rnote.n button.bn')[0]);
    expect(bar.hash).toBe(`#/run/${RUN}/4`);
    expect(r.all('table.calls tbody tr')[3].querySelector('.eff.extra')!.textContent).toBe('extra');
  });

  it('names the host the model calls went through and the guard in Provenance', async () => {
    addressBar(`#/run/${RUN}/1/provenance`);
    r = await render(createElement(AppContext.Provider, { value: app }, createElement(RunPage, { id: RUN, call: 1, view: 'provenance' })));
    await r.until('Provenance', () => r!.all('.prov dt').some((d) => d.textContent === 'Guard'));
    const row = (k: string) => {
      const dt = r!.all('.prov dt').find((d) => d.textContent === k)!;
      const dd = dt.parentNode!.childNodes[dt.parentNode!.childNodes.indexOf(dt) + 1] as unknown as { textContent: string; querySelector(s: string): { getAttribute(a: string): string | null } | null };
      return dd;
    };
    expect(row('Provider').textContent).toBe('openai via openrouter.ai 3 calls');
    expect(row('Guard').textContent).toBe('warn · no preload loaded');
  });
});
