import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallRow } from '../ui/api.js';
import { TimelineView } from '../ui/run/TimelineView.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Timeline's notch: a streamed call's first token is marked on its bar, and the summary under the
 * bars names the notch at its end, as the mock draws it. A run of replayed calls streamed nothing
 * here, so neither shows.
 */

const T = 1_790_200_000_000;

function call(callNo: number, origin: 'live' | 'replayed', ttftMs: number | null): CallRow {
  return { callNo, kind: 'api', name: 'POST /v1/messages', origin, effect: null, outcome: 'ok', status: 200, latencyMs: origin === 'live' ? 900 : 0, model: 'claude-opus-5', stopReason: 'end_turn', usage: { input: 800, output: 40, cacheRead: 0, cacheWrite: 0 }, cost: null, bytes: null, detail: '', attempts: 0, replayedFrom: null, error: null, startedAt: T + callNo * 1000, endedAt: T + callNo * 1000 + (origin === 'live' ? 900 : 0), ttftMs, scope: null, resultShort: null, conversation: 1, conversationStart: callNo === 1, requestedBy: null, toolUseId: null, cacheMiss: null, recordedMs: null, asks: [] } as unknown as CallRow;
}

let page: Rendered | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
});

const timeline = (calls: CallRow[]) => render(createElement(TimelineView, { calls, selected: null, scoped: false, onSelect: () => {} }));

describe('Timeline’s first-token notch', () => {
  it('marks a streamed call’s first token, and names the notch last in the summary', async () => {
    page = await timeline([call(1, 'live', 300), call(2, 'live', null)]);
    expect(page.all('.ft')).toHaveLength(1);
    expect(page.all('.tl-sum .ftkey')).toHaveLength(1);
    expect(page.all('.tl-sum span').at(-1)!.textContent).toBe('first token');
  });

  it('shows neither for a run of replayed calls', async () => {
    page = await timeline([call(1, 'replayed', 300), call(2, 'replayed', null)]);
    expect(page.all('.ft')).toHaveLength(0);
    expect(page.all('.tl-sum .ftkey')).toHaveLength(0);
  });
});
