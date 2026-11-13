import { describe, expect, it } from 'vitest';
import type { CallLike } from '../ui/run/calls.js';
import { ticksFor, timelineOf, turnsOf } from '../ui/run/view-model.js';

/**
 * What only the run's other views read (ui/run/view-model.ts): Turns' tool calls under the model call
 * that asked for them, and Timeline's calls on one clock.
 */
describe('a run’s calls in Turns and Timeline', () => {
  const call = (callNo: number, kind: string, extra: Partial<CallLike> = {}): CallLike => ({
    callNo,
    kind,
    name: kind === 'api' ? 'POST /v1/messages' : 'lookup_order',
    origin: 'live',
    effect: kind === 'tool' ? 'read' : null,
    outcome: 'ok',
    status: kind === 'api' ? 200 : null,
    latencyMs: 100,
    model: kind === 'api' ? 'sonnet-5' : null,
    stopReason: kind === 'api' ? 'tool_use' : null,
    usage: kind === 'api' ? { input: 200, output: 80, cacheRead: 2400, cacheWrite: 400 } : null,
    detail: kind === 'tool' ? '{"order_id":"A-1042"}' : '',
    attempts: 0,
    replayedFrom: null,
    error: null,
    startedAt: 1000 + callNo * 100,
    endedAt: 1000 + callNo * 100 + 90,
    ttftMs: null,
    scope: null,
    ...extra,
  });

  it('groups tool calls under the model call that asked for them, within a scope when there are scopes', () => {
    const calls = [call(1, 'api', { scope: 'agent' }), call(2, 'api', { scope: 'customer' }), call(3, 'tool', { scope: 'agent' }), call(4, 'clock'), call(5, 'tool', { scope: 'customer' })];
    expect(turnsOf(calls, true).map((t) => [t.model.callNo, t.tools.map((c) => c.callNo)])).toEqual([
      [1, [3]],
      [2, [5]],
    ]);
    expect(turnsOf(calls, false).map((t) => [t.model.callNo, t.tools.map((c) => c.callNo)])).toEqual([
      [1, []],
      [2, [3, 5]],
    ]);
  });

  it('places calls on one clock and finds the ones that ran at once, under a long call too', () => {
    const calls = [call(1, 'api', { startedAt: 1000, endedAt: 3000 }), call(2, 'tool', { startedAt: 1100, endedAt: 1200 }), call(3, 'tool', { startedAt: 1500, endedAt: 1600 }), call(4, 'api', { startedAt: 3100, endedAt: 3500, ttftMs: 40 })];
    const t = timelineOf(calls);
    expect(t.end).toBe(2500);
    expect(t.rows.map((r) => [r.call.callNo, r.start, r.end, r.firstToken])).toEqual([
      [1, 0, 2000, null],
      [2, 100, 200, null],
      [3, 500, 600, null],
      [4, 2100, 2500, 40],
    ]);
    expect(t.parallel).toEqual([
      [1, 2],
      [1, 3],
    ]);
    expect(ticksFor(2500).map((x) => x.label)).toEqual(['0s', '0.5s', '1s', '1.5s', '2s', '2.5s']);
  });
});
