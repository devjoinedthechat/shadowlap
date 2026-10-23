import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { ForkDifferences } from '../src/fork-differences.js';
import type { StaticPayload } from '../src/static.js';
import { createExportedClient } from '../ui/api.js';
import { DifferencesPanel, ForkDifferences as Panel, SHOWN } from '../ui/run/ForkDifferences.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A fork's page says what it did differently from its parent, most consequential first: a write
 * changed, how it ends, a read, its words; then its writes, and what became of each.
 */

const REC = '01M5GRX4VY5XKQ0MRGD13QZKZN';
const FORK = '01M5GRX8K406H4KHQ7DEKYWTSZ';
const RANKS = { 1: 'a write changed', 2: 'it stops, hands over or is judged differently', 3: 'a read added or removed', 4: 'a read asked differently', 5: 'text only' } as const;

const differences = (over: Partial<ForkDifferences> = {}): ForkDifferences => ({
  runId: FORK,
  parentRunId: REC,
  from: 5,
  rank: 1,
  changes: [
    { rank: 1, kind: 'write-removed', tool: 'issue_refund', effect: 'write', detail: 'issue_refund is no longer called', before: '{"order_id":"A-1042","amount":240}', after: null, parent: { callNo: 6, href: `#/run/${REC}/6` }, fork: null },
    { rank: 1, kind: 'write-added', tool: 'escalate', effect: 'write', detail: 'escalate is called', before: null, after: '{"reason":"above the limit"}', parent: null, fork: { callNo: 6, href: `#/run/${FORK}/6` } },
    { rank: 2, kind: 'ended', tool: null, effect: null, detail: 'it does not fail, where its parent did', before: 'failed: issue_refund called 0 times', after: '1 check passed', parent: null, fork: null },
    { rank: 3, kind: 'read-added', tool: 'lookup_order', effect: 'read', detail: 'lookup_order is called', before: null, after: '{"order_id":"A-1042"}', parent: null, fork: { callNo: 7, href: `#/run/${FORK}/7` } },
    { rank: 5, kind: 'text', tool: null, effect: null, detail: 'it says something else', before: '"Refunded $240."', after: '"Escalated."', parent: null, fork: null },
  ],
  ended: { parent: { status: 'completed', failed: true, words: 'failed: issue_refund called 0 times', tone: 'err' }, fork: { status: 'completed', failed: false, words: '1 check passed', tone: 'ok' } },
  writes: [{ callNo: 6, tool: 'escalate', args: '{"reason":"above the limit"}', fate: 'blocked', href: `#/run/${FORK}/6` }],
  toolCalls: { parent: 1, fork: 2 },
  cut: false,
  ranks: RANKS,
  ...over,
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('what a fork did differently, on its page', () => {
  it('lists the first changes most consequential first, a write’s tool in its own colour, with where each is', () => {
    const html = renderToStaticMarkup(createElement(DifferencesPanel, { d: differences() }));
    expect(html).toContain('<h2 id="fdiffT">What the fork did differently</h2>');
    const rows = [...html.matchAll(/<li class="r(\d)">([\s\S]*?)<\/li>/g)];
    expect(rows.map((m) => m[1])).toEqual(['1', '1', '2', '3']);
    expect(rows.length).toBe(SHOWN);
    expect(text(rows[0]![2]!)).toBe('a write issue_refund is no longer called {"order_id":"A-1042","amount":240} #6 in the parent');
    expect(rows[0]![2]).toContain('<b class="w">issue_refund</b>');
    expect(text(rows[2]![2]!)).toBe('how it ends it does not fail, where its parent did: failed: issue_refund called 0 times → 1 check passed');
    expect(rows[2]![2]).toContain('<em class="err">failed: issue_refund called 0 times</em> → <em class="ok">1 check passed</em>');
    // Its writes and what became of each, then a way to every change.
    expect(text(html)).toContain('its writes #6 escalate {"reason":"above the limit"} blocked');
    expect(html).toContain('<em class="fate blocked">blocked</em>');
    expect(html).toContain('Show all 5');
    expect(html).toContain(`href="#/compare/${REC}/${FORK}"`);
  });

  it('opens every change with a click', async () => {
    r = await render(createElement(DifferencesPanel, { d: differences() }));
    expect(r.all('.fdl li').length).toBe(SHOWN);
    const all = r.byText('button', 'Show all 5');
    expect(all.getAttribute('aria-expanded')).toBe('false');
    await r.click(all);
    expect(r.all('.fdl li').length).toBe(5);
    expect(r.all('.fdl li').at(-1)!.textContent).toContain('its words');
  });

  it('says so when the fork did as its parent did, and when it made no write', () => {
    const html = renderToStaticMarkup(createElement(DifferencesPanel, { d: differences({ rank: null, changes: [], writes: [], ended: { parent: { status: 'completed', failed: false, words: 'exited 0', tone: 'n' }, fork: { status: 'completed', failed: false, words: 'exited 0', tone: 'n' } } }) }));
    expect(text(html)).toContain('The same tool calls as its parent from #5, and it ended as its parent did: exited 0.');
    expect(text(html)).toContain('no writes from #5 on');
    expect(html).not.toContain('<ol');
  });

  it('asks the server for the run’s differences, and shows nothing for a run that is no fork', async () => {
    const asked: string[] = [];
    const app = (answer: ForkDifferences | null) => ({ exported: false, client: { forkDifferences: async (id: string) => (asked.push(id), answer) } }) as unknown as AppState;
    r = await render(createElement(AppContext.Provider, { value: app(differences()) }, createElement(Panel, { runId: FORK })));
    await r.until('the panel', () => r!.all('.fdiff').length === 1);
    expect(asked).toEqual([FORK]);
    await r.unmount();
    r = await render(createElement(AppContext.Provider, { value: app(null) }, createElement(Panel, { runId: REC })));
    await r.wait(20);
    expect(r.all('.fdiff')).toEqual([]);
  });

  it('shows them in an exported copy that holds them: one that holds the fork’s parent too', async () => {
    const copy = { runIds: [FORK, REC], responses: { [`runs/${FORK}/differences`]: { differences: differences() } } } as unknown as StaticPayload;
    const app = { exported: true, client: createExportedClient(copy) } as unknown as AppState;
    r = await render(createElement(AppContext.Provider, { value: app }, createElement(Panel, { runId: FORK })));
    await r.until('the panel', () => r!.all('.fdiff').length === 1);
    await r.unmount();
    r = await render(createElement(AppContext.Provider, { value: app }, createElement(Panel, { runId: REC })));
    await r.wait(20);
    expect(r.all('.fdiff')).toEqual([]);
  });
});
