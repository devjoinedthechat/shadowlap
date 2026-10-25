import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { bannerFor, beforeFork, failedCheckText, failureText, fencedWords, type BannerInput } from '../ui/run/banner.js';
import { CallsToolbar, originFilters } from '../ui/run/CallsView.js';
import { render, type Rendered } from './ui-render.js';

/**
 * The run page in the CLI's words: a failed check as `test` prints it, its arguments kept and a
 * tool's fenced calls counted exactly; what came before a fork, never counting a call an override
 * answered as replayed; and the filter of blocked and stubbed calls named Fenced, as the design does.
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
    expect(bannerFor(base)).toMatchObject({ kind: 'failed', why: 'check failed: send_email called 1 time, but called 2 times (2 blocked) · not blamed yet' });
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

describe('the Calls view', () => {
  it('names the filter of blocked and stubbed calls Fenced, as the design does', async () => {
    expect(originFilters({ over: 1, inject: 0, fail: 0 }).map(([, label]) => label)).toEqual(['All', 'Live', 'Replayed', 'Overridden', 'Fenced']);
    const counts = { all: 32, live: 14, rep: 15, over: 1, inject: 0, fail: 0, block: 2 };
    page = await render(createElement(CallsToolbar, { counts, filter: 'all', onFilter: () => undefined, text: '', onText: () => undefined, inputRef: { current: null } }));
    expect(page.all('.ofilter button').map((b) => b.textContent)).toEqual(['All32', 'Live14', 'Replayed15', 'Overridden1', 'Fenced2']);
  });
});
