import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { bannerFor, beforeFork, failedCheckText, failureText, fencedWords, type BannerInput } from '../ui/run/banner.js';
import { keyItems } from '../ui/run/call-filter.js';
import { CallsTable } from '../ui/run/CallsView.js';
import { StripKey } from '../ui/run/StripKey.js';
import { ContextView } from '../ui/run/ContextView.js';
import { Inspector } from '../ui/run/Inspector.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { CallDetail, CallRow, RunDetail } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * The run page in the CLI's words: a failed check as `test` prints it, its arguments kept and a
 * tool's fenced calls counted exactly; what came before a fork, never counting a call an override
 * answered as replayed; and the strip's key, which names blocked and stubbed calls apart, as the design does.
 */

let page: Rendered | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe('a failed check, in the CLI’s words', () => {
  // The planted fork's own check: send_email called twice after the fork, both blocked.
  const planted = [
    { callNo: 6, kind: 'tool', name: 'lookup_order', detail: '{"order_id":"A-1042"}', origin: 'overridden' },
    { callNo: 26, kind: 'tool', name: 'send_email', detail: '{"to":"c-311@example.com"}', origin: 'blocked' },
    { callNo: 31, kind: 'tool', name: 'send_email', detail: '{"to":"audit@northwind-billing.example"}', origin: 'blocked' },
  ];
  const check = { label: 'send_email called 1 time', ok: false, status: 'failed', detail: 'called 2 times (2 blocked or stubbed)' };

  it('says what was expected and what happened, with the fenced calls counted exactly', () => {
    expect(failureText({ status: 'completed', checks: [check], blame: null, calls: planted })).toBe('check failed: send_email called 1 time, but called 2 times (2 blocked)');
    const mixed = [{ ...planted[1], origin: 'stubbed' }, planted[2]];
    expect(failedCheckText(check, mixed)).toBe('check failed: send_email called 1 time, but called 2 times (1 blocked, 1 stubbed)');
    // Without the run's calls, or when they count otherwise, the check as kept.
    expect(failedCheckText(check)).toBe('check failed: send_email called 1 time, but called 2 times (2 blocked or stubbed)');
    expect(failedCheckText(check, [planted[1]])).toBe('check failed: send_email called 1 time, but called 2 times (2 blocked or stubbed)');
    // A check kept since the CLI says it exactly is shown as it is.
    expect(failedCheckText({ label: 'send_email called 1 time', detail: 'called 2 times (2 blocked)' }, planted)).toBe('check failed: send_email called 1 time, but called 2 times (2 blocked)');
  });

  it('keeps the arguments a check names, and counts only the calls that had them', () => {
    const c = { label: 'issue_refund with {"amount":240} called 0 times', ok: false, detail: 'called 1 time (1 blocked or stubbed); 1 call with other arguments' };
    const calls = [
      { kind: 'tool', name: 'issue_refund', detail: '{"order_id":"A-1042","amount":240}', origin: 'stubbed' },
      { kind: 'tool', name: 'issue_refund', detail: '{"order_id":"A-1077","amount":80}', origin: 'stubbed' },
    ];
    expect(failureText({ status: 'completed', checks: [c], blame: null, calls })).toBe('check failed: issue_refund with {"amount":240} called 0 times, but called 1 time (1 stubbed); 1 call with other arguments');
  });

  it('heads the failed banner of a run with it, the fenced count exact', () => {
    const base: BannerInput = { status: 'completed', type: 'recording', divergence: null, intervention: null, rescued: null, blame: null, notRecorded: null, checks: [check], fix: null, upstreamRequests: 4, calls: planted };
    expect(bannerFor(base)).toMatchObject({ kind: 'failed', lead: 'send_email called 1 time, but called 2 times (2 blocked)', why: 'not blamed yet' });
  });

  it('says a tool’s fenced calls exactly', () => {
    expect(fencedWords([{ origin: 'blocked' }, { origin: 'blocked' }, { origin: 'live' }])).toBe('2 blocked');
    expect(fencedWords([{ origin: 'stubbed' }])).toBe('1 stubbed');
    expect(fencedWords([{ origin: 'blocked' }, { origin: 'stubbed' }])).toBe('1 blocked, 1 stubbed');
    expect(fencedWords([{ origin: 'live' }])).toBeNull();
  });
});

describe('what came before a fork', () => {
  const fork = { callNo: 17, type: 'request_changed', name: 'POST /v1/messages', replayedBefore: 16, diff: [{ path: '$.messages[14].content[0].content' }] };
  // The override fork: #16's result was overridden, #1 to #15 replayed.
  const calls = [...Array.from({ length: 15 }, (_, i) => ({ callNo: i + 1, kind: i % 2 ? 'tool' : 'api', name: 'x', origin: 'replayed' })), { callNo: 16, kind: 'tool', name: 'lookup_policy', origin: 'overridden' }, { callNo: 17, kind: 'api', name: 'POST /v1/messages', origin: 'live' }];

  it('never counts a call an override answered as replayed, and names it apart unless the flag has', () => {
    expect(beforeFork(fork, calls)).toBe('15 replayed and #16 overridden before it');
    expect(beforeFork(fork, calls, 16)).toBe('15 calls replayed before it');
    expect(beforeFork(fork, [])).toBe('16 calls replayed before it');
    expect(beforeFork({ callNo: 7, replayedBefore: 6 }, [{ callNo: 2, origin: 'overridden' }, { callNo: 6, origin: 'overridden' }], 6)).toBe('4 replayed and #2 overridden before it');
    expect(beforeFork({ callNo: 7, replayedBefore: 6 }, [{ callNo: 2, origin: 'overridden' }, { callNo: 6, origin: 'overridden' }])).toBe('4 replayed and #2 and #6 overridden before it');
    // The override fork, as the design words it: the flag names #16, and 15 calls were replayed before it, not 16.
    const iv = { flag: '--override', value: '16=@policy.json', callNo: 16 };
    const banner = bannerFor({ status: 'completed', type: 'fork', divergence: fork, intervention: iv, interventions: [iv], rescued: null, blame: null, notRecorded: null, checks: [], fix: null, upstreamRequests: 8, calls });
    expect(banner).toMatchObject({ kind: 'fork', why: 'tool #16 overridden with --override 16=@policy.json · 15 calls replayed before it' });
    // A fork whose flag names another call says the override apart.
    const model = { flag: '--model', value: '17:claude-haiku-4-5', callNo: 17 };
    expect(bannerFor({ status: 'completed', type: 'fork', divergence: fork, intervention: model, interventions: [model], rescued: null, blame: null, notRecorded: null, checks: [], fix: null, upstreamRequests: 8, calls })).toMatchObject({ why: 'claude-haiku-4-5 answers from here with --model 17:claude-haiku-4-5 · 15 replayed and #16 overridden before it' });
  });
});

describe('the strip’s key, which filters the calls', () => {
  it('names blocked and stubbed calls apart, each with the swatch of its cells, as the design does', async () => {
    const items = keyItems({ total: 34, counts: { live: 14, rep: 15, over: 1, block: 2, stub: 2 } }, false);
    expect(items.map((i) => i.word)).toEqual(['all', 'replayed', 'live', 'overridden', 'blocked', 'stubbed']);
    page = await render(createElement(StripKey, { items, byKind: false, filter: 'all', onFilter: () => undefined }));
    expect(page.all('.lfilter button').map((b) => b.textContent)).toEqual(['all 34', 'replayed 15', 'live 14', 'overridden 1', 'blocked 2', 'stubbed 2']);
    expect(page.all('.lfilter button i.lg').map((i) => i.className)).toEqual(['lg rep', 'lg live', 'lg over', 'lg block', 'lg stub']);
    expect(page.all('.lfilter .lk')).toHaveLength(0);
  });

  it('says first that every call of a recording is live, then counts each kind', async () => {
    const items = keyItems({ total: 21, counts: { 'k-model': 10, 'k-read': 10, 'k-write': 1 } }, true);
    page = await render(createElement(StripKey, { items, byKind: true, filter: 'k-write', onFilter: () => undefined }));
    expect(page.one('.lfilter .lk').textContent).toBe('every call live');
    expect(page.all('.lfilter button').map((b) => b.textContent)).toEqual(['all 21', 'model calls 10', 'reads 10', 'write 1']);
    expect(page.all('.lfilter button[aria-pressed="true"]').map((b) => b.textContent)).toEqual(['write 1']);
  });
});

describe('a blocked tool’s result in Calls', () => {
  it('says blocked in the blocked grey’s class, keeping the failure red for a call that failed', () => {
    const tool = { kind: 'tool', name: 'issue_refund', effect: 'write', status: null, latencyMs: 2, model: null, stopReason: null, usage: null, cost: null, bytes: null, detail: '{"order":"A-1042"}', attempts: 0, replayedFrom: null, startedAt: 0, endedAt: 2, ttftMs: null, scope: null, resultShort: null, conversation: 1, conversationStart: false, requestedBy: null, toolUseId: null, cacheMiss: null, recordedMs: null, asks: null };
    const blocked = { ...tool, callNo: 1, origin: 'blocked', outcome: 'error', error: 'blocked by the fence' } as unknown as CallRow;
    const failed = { ...tool, callNo: 2, origin: 'live', outcome: 'error', error: 'refund API returned 500' } as unknown as CallRow;
    const app = { actionsOff: null, conn: 'ok', toast: () => undefined } as unknown as AppState;
    const table = createElement(CallsTable, { calls: [blocked, failed], asked: null, selected: 1, scoped: false, forkAt: null, lostAt: null, ancestors: [], live: false, canFork: false, onSelect: () => undefined, onFork: () => undefined });
    const html = renderToStaticMarkup(createElement(AppContext.Provider, { value: app }, table));
    expect(html).toContain('<span class="res blk">→ blocked</span>');
    expect(html).toContain('<span class="res err">→ refund API returned 500</span>');
  });
});

describe('a call’s input, split as the recording keeps it', () => {
  // 4,600 input tokens: 4,000 read from the prompt cache, 400 cache creation (cacheCreationInputTokens), 200 uncached.
  const call = { callNo: 3, kind: 'api', name: 'POST /v1/messages', origin: 'live', effect: null, outcome: 'ok', status: 200, model: 'claude-opus-5', stopReason: 'end_turn', latencyMs: 812, ttftMs: null, usage: { input: 200, output: 56, cacheRead: 4000, cacheWrite: 400 }, cost: null, bytes: null, attempts: 0, replayedFrom: null, error: null, fingerprint: 'f'.repeat(64), occurrence: 1, startedAt: 1, headers: {} } as unknown as CallRow;

  it('names its parts cache read, cache creation and uncached, in the Context view, its hover cards and the call’s details', () => {
    const run = { run: { divergence: null }, cache: { misses: [] } } as unknown as RunDetail;
    const chart = renderToStaticMarkup(createElement(ContextView, { run, calls: [call], selected: 3, onSelect: () => undefined }));
    const legend = chart.slice(chart.indexOf('<div class="legend">'), chart.indexOf('</div>', chart.indexOf('<div class="legend">')));
    expect(legend.split(/<[^>]*>/).filter((t) => t.trim())).toEqual(['cache read', 'cache creation', 'uncached', 'output, on its own axis']);
    expect(chart).toContain('[&quot;cache read&quot;,&quot;4,000&quot;,&quot;var(--c-read)&quot;],[&quot;cache creation&quot;,&quot;400&quot;,&quot;var(--c-write)&quot;],[&quot;uncached&quot;,&quot;200&quot;,&quot;var(--c-unc)&quot;]');
    const app = { client: {}, exported: true, actionsOff: null, toast: () => undefined, guard: (fn: () => void) => fn() } as unknown as AppState;
    const detail = { call, notes: [], actions: [] } as unknown as CallDetail;
    const details = renderToStaticMarkup(createElement(AppContext.Provider, { value: app }, createElement(Inspector, { runId: 'R', call, calls: [call], detail, error: null, tab: 'details', onTab: () => undefined, onStep: () => undefined, change: null, live: false })));
    expect(details).toContain('<dt>Input tokens</dt><dd>4,600 <small>4,000 cache read · 400 cache creation · 200 uncached</small></dd>');
    // A write is only ever a tool that changes something.
    for (const html of [chart, details]) expect(html).not.toMatch(/cache write/i);
  });
});
