import { describe, expect, it } from 'vitest';
import { countOrigins, type Origin7 } from '../ui/origins.js';
import { metricItems, type MetricInput } from '../ui/run/metrics.js';
import { runDuration } from '../ui/run/model.js';

/**
 * A run imported from a capture says only what its file held: a capture of the model calls alone
 * (a nock or VCR file of the provider's traffic) never saw the tools, and one from a file that keeps
 * no times imported every call at one instant, so it has no duration to show.
 */

describe('a capture', () => {
  const counts = (s: string) => countOrigins([...s].map(() => 'live'));
  const input = (over: Partial<MetricInput> = {}): MetricInput => ({ total: 4, byKind: { api: 4, tool: 0 }, upstreamRequests: 0, cost: { spent: 0, saved: 0, captured: 0.0005, unknownModels: [] }, tokensNotRespent: 0, counts: counts('llll'), capture: true, live: false, notWaitedMs: null, ...over });

  it('says its tool calls were not captured, rather than counting none', () => {
    expect(metricItems(input({ toolsCaptured: false }))).toContainEqual(['—', 'tool calls not captured']);
    expect(metricItems(input({ toolsCaptured: false })).some(([v, l]) => v === 0 && l === 'tool calls')).toBe(false);
    // One that captured its tools, or a recording, counts them.
    expect(metricItems(input({ toolsCaptured: true }))).toContainEqual([0, 'tool calls']);
    expect(metricItems(input({ capture: false }))).toContainEqual([0, 'tool calls']);
  });

  it('has no duration when nothing timed it', () => {
    const row = (latencyMs: number | null) => ({ latencyMs });
    const nock = { summary: { durationMs: 0 }, calls: [row(null), row(null)], run: { meta: { covers: ['api' as const] } } };
    expect(runDuration(nock as unknown as Parameters<typeof runDuration>[0])).toBeNull();
    const har = { summary: { durationMs: 10_403 }, calls: [row(8), row(3)], run: { meta: { covers: ['api' as const] } } };
    expect(runDuration(har as unknown as Parameters<typeof runDuration>[0])).toBe(10_403);
    // A recording that made no call still took the time it took.
    const empty = { summary: { durationMs: 1200 }, calls: [], run: { meta: {} } };
    expect(runDuration(empty as unknown as Parameters<typeof runDuration>[0])).toBe(1200);
  });
});
