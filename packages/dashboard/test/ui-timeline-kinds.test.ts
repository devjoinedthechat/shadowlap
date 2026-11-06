import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallRow } from '../ui/api.js';
import { TimelineView } from '../ui/run/TimelineView.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A recording's Timeline bars say what each call was, in the strip's key and its card's words, as
 * the mock draws them; a replay's and a fork's say where each answer came from.
 */

const T = 1_790_200_000_000;

function call(callNo: number, origin: 'live' | 'replayed', ttftMs: number | null): CallRow {
  return { callNo, kind: 'api', name: 'POST /v1/messages', origin, effect: null, outcome: 'ok', status: 200, latencyMs: origin === 'live' ? 900 : 0, model: 'claude-opus-5', stopReason: 'end_turn', usage: { input: 800, output: 40, cacheRead: 0, cacheWrite: 0 }, cost: null, bytes: null, detail: '', attempts: 0, replayedFrom: null, error: null, startedAt: T + callNo * 1000, endedAt: T + callNo * 1000 + (origin === 'live' ? 900 : 0), ttftMs, scope: null, resultShort: null, conversation: 1, conversationStart: callNo === 1, requestedBy: null, toolUseId: null, cacheMiss: null, recordedMs: null, asks: [] } as unknown as CallRow;
}

/** A tool call: a write, a read, or one that threw. */
function tool(callNo: number, effect: 'write' | 'read', failed = false): CallRow {
  return { ...call(callNo, 'live', null), kind: 'tool', name: effect === 'write' ? 'issue_refund' : 'lookup_order', effect, outcome: failed ? 'error' : 'ok', status: null, error: failed ? 'Timed out' : null, usage: null };
}

let page: Rendered | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
});

const RUN = [call(1, 'live', null), tool(2, 'read'), tool(3, 'write'), tool(4, 'read', true)];
const timeline = (calls: CallRow[], byKind = false) => render(createElement(TimelineView, { calls, selected: null, scoped: false, byKind, onSelect: () => {} }));
const bars = (p: Rendered) => p.all('.tl-row .bar').map((b) => b.getAttribute('class'));
const card = (p: Rendered, i: number) => JSON.parse(p.all('.tl-row .bar')[i].getAttribute('data-tip')!) as { rows: [string, string, string][] };

describe('a recording’s Timeline by kind', () => {
  it('draws each bar in its kind’s colour and names the kind in its card', async () => {
    page = await timeline(RUN, true);
    expect(bars(page)).toEqual(['bar k-model', 'bar k-read', 'bar k-write', 'bar k-err']);
    expect(card(page, 2).rows[0]).toEqual(['write', '900 ms', 'var(--k-write)']);
    expect(card(page, 3).rows[0][0]).toBe('error');
  });

  it('draws a replay’s or a fork’s bars by origin, as it did', async () => {
    page = await timeline([call(1, 'replayed', null), call(2, 'live', null)]);
    expect(bars(page)).toEqual(['bar rep', 'bar live']);
    expect(card(page, 0).rows[0][0]).toBe('replayed');
  });
});
