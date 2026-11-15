import { describe, expect, it } from 'vitest';
import { divergenceLine, formatDivergence, formatSummary, summarizeRun } from '../src/report.js';
import type { CallRecord, DivergenceReport, Origin, RunRecord } from '../src/types.js';

const run = (divergence: DivergenceReport | null): RunRecord => ({
  runId: '01K5CQ4N7G0000000000000001',
  parentRunId: '01K5CQ4N7G0000000000000000',
  mode: 'replay',
  status: 'completed',
  divergence,
  command: { argv: ['node', 'agent.js'], cwd: '/' },
  codeVersion: null,
  startedAt: 0,
  endedAt: 1,
});

const call = (callNo: number, kind: CallRecord['kind'], name: string, origin: Origin): CallRecord => ({
  runId: '01K5CQ4N7G0000000000000001',
  callNo,
  kind,
  name,
  fingerprint: 'f'.repeat(64),
  occurrence: 1,
  origin,
  effect: kind === 'tool' ? 'write' : null,
  requestRef: null,
  meta: {},
  at: 0,
  end: { runId: '01K5CQ4N7G0000000000000001', callNo, attempt: 0, responseRef: null, outcome: 'ok', meta: {}, at: 1 },
  attempts: [],
});

describe('formatSummary after a fork', () => {
  const divergence: DivergenceReport = { type: 'request_changed', callNo: 2, kind: 'api', name: 'POST /v1/messages', replayedBefore: 1, counterpart: { runId: '01K5CQ4N7G0000000000000000', callNo: 2 } };
  const notReached = [
    { callNo: 2, kind: 'api' as const, name: 'POST /v1/messages' },
    { callNo: 3, kind: 'tool' as const, name: 'open_ticket' },
  ];

  it('leaves the call the divergence was compared with out of the unused calls', () => {
    const calls = [call(1, 'api', 'POST /v1/messages', 'replayed'), call(2, 'api', 'POST /v1/messages', 'live'), call(3, 'tool', 'open_ticket', 'stubbed')];
    const text = formatSummary(summarizeRun(run(divergence), calls, notReached));
    expect(text).toContain('1 recorded call left unused after the fork: #3 open_ticket');
    expect(text).not.toContain('#2 POST');
    expect(text).not.toContain('not reached');
  });

  it('counts blocked and stubbed writes by what happened to them', () => {
    const one = (origins: Origin[]) => formatSummary(summarizeRun(run(divergence), [call(1, 'api', 'POST /v1/messages', 'replayed'), call(2, 'api', 'POST /v1/messages', 'live'), ...origins.map((o, i) => call(3 + i, 'tool', 'open_ticket', o))]));
    expect(one(['stubbed', 'stubbed'])).toContain('then 1 live, 2 writes stubbed;');
    expect(one(['blocked'])).toContain('then 1 live, 1 write blocked;');
    expect(one(['blocked', 'stubbed', 'stubbed'])).toContain('3 writes (1 blocked, 2 stubbed);');
  });

  it('still says "not reached" when a replay without a fork stops early', () => {
    const text = formatSummary(summarizeRun(run(null), [call(1, 'api', 'POST /v1/messages', 'replayed')], notReached));
    expect(text).toContain('2 recorded calls not reached: #2 POST /v1/messages, #3 open_ticket');
  });
});

describe('a replay that stops before its recording ends', () => {
  const notReached = [
    { callNo: 3, kind: 'api' as const, name: 'POST /v1/messages' },
    { callNo: 4, kind: 'tool' as const, name: 'write_report' },
    { callNo: 5, kind: 'clock' as const, name: 'Date.now' },
  ];
  const replayed = [call(1, 'api', 'POST /v1/messages', 'replayed'), call(2, 'tool', 'search', 'replayed')];
  // As the session ends it, and the store keeps it on the run.
  const early: DivergenceReport = { type: 'ended_early', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2, recorded: 5, reason: 'the agent stopped after 2 of the 5 recorded calls, before making #3', counterpart: { runId: '01K5CQ4N7G0000000000000000', callNo: 3 } };

  it('ended early, not clean: it names the first recorded call it never made, how much of the recording it replayed, and every call it never made', () => {
    const text = formatSummary(summarizeRun(run(early), replayed, notReached));
    expect(text).toContain('✗ Ended early at call 3: 2 of 5 recorded calls replayed (1 api, 1 tool)');
    expect(text).not.toContain('Replay clean');
    expect(text).not.toContain('Forked');
    expect(text).toContain('3 recorded calls not reached: #3 POST /v1/messages, #4 write_report, #5 Date.now');
  });

  it('says so from the stored run alone, as show and the dashboard read it', () => {
    expect(formatSummary(summarizeRun(run(early), replayed))).toContain('✗ Ended early at call 3: 2 of 5 recorded calls replayed');
    expect(formatDivergence(early)).toBe('✗ Ended early at call 3 (api POST /v1/messages): 2 of 5 recorded calls replayed\n  every request the agent sent matched, but it stopped before its recording did, without making #3');
    expect(divergenceLine(early)).toBe('ended early at call 3 (api POST /v1/messages): 2 of 5 recorded calls replayed');
    expect(divergenceLine({ ...early, type: 'new_call' })).toBe('diverged at call 3 (api POST /v1/messages)');
  });

  it('is clean when only clock and random reads are left over', () => {
    const s = summarizeRun(run(null), replayed, [{ callNo: 3, kind: 'clock', name: 'Date.now' }, { callNo: 4, kind: 'random', name: 'Math.random' }]);
    expect(formatSummary(s)).toContain('✓ Replay clean: 2/2 calls replayed');
  });
});

describe('summarizeRun: where the calls were answered and paid for', () => {
  const priced = (c: CallRecord, extra: Record<string, unknown> = {}): CallRecord => ({ ...c, meta: { model: 'claude-sonnet-4-5' }, end: { ...c.end!, meta: { usage: { inputTokens: 1_000_000, outputTokens: 0 }, ...extra } } });
  const prices = { 'claude-sonnet-4-5': { input: 3, output: 15 } };

  it('prices each call at the card its own prompt picks, spent and saved alike', () => {
    const haiku = (c: CallRecord, inputTokens: number): CallRecord => ({ ...c, meta: { model: 'claude-haiku-5-5' }, end: { ...c.end!, meta: { usage: { inputTokens, outputTokens: 1000 } } } });
    const calls = [haiku(call(1, 'api', 'POST /v1/messages', 'live'), 100_000), haiku(call(2, 'api', 'POST /v1/messages', 'live'), 100_001), haiku(call(3, 'api', 'POST /v1/messages', 'replayed'), 100_001)];
    const s = summarizeRun({ ...run(null), mode: 'record', parentRunId: null }, calls);
    expect(s.cost.spent).toBeCloseTo((100_000 * 0.1 + 1000 * 0.5 + 100_001 * 0.5 + 1000 * 2.5) / 1e6, 12);
    expect(s.cost.saved).toBeCloseTo((100_001 * 0.5 + 1000 * 2.5) / 1e6, 12);
  });

  it('counts an imported recording as captured, not spent here, and sends nothing upstream', () => {
    const imported: RunRecord = { ...run(null), mode: 'record', parentRunId: null, meta: { imported: { at: 1, from: 'session.har' } } };
    const s = summarizeRun(imported, [priced(call(1, 'api', 'POST /v1/messages', 'live'))], [], [], { prices });
    expect(s.imported).toBe(true);
    expect(s.cost).toMatchObject({ spent: 0, captured: 3 });
    expect(s.upstreamRequests).toBe(0);
    // Recorded here, the same call is spend.
    const local = summarizeRun({ ...imported, meta: {} }, [priced(call(1, 'api', 'POST /v1/messages', 'live'))], [], [], { prices });
    expect(local.cost).toMatchObject({ spent: 3, captured: 0 });
    expect(local.upstreamRequests).toBe(1);
  });

  it('counts a teammate’s recording pulled from the team store as spent, with its upstream requests', () => {
    const pulled: RunRecord = { ...run(null), mode: 'record', parentRunId: null, meta: { imported: { at: 1, from: 's3://northwind-agent-runs/support-agent' }, author: 'maya@example.com' } };
    const s = summarizeRun(pulled, [priced(call(1, 'api', 'POST /v1/messages', 'live'))], [], [], { prices });
    expect(s.imported).toBe(false);
    expect(s.cost).toMatchObject({ spent: 3, captured: 0 });
    expect(s.upstreamRequests).toBe(1);
    // The same run unpacked from a pack someone sent: captured, as before.
    const packed = summarizeRun({ ...pulled, meta: { imported: { at: 1, from: 'chat-from-maya' } } }, [priced(call(1, 'api', 'POST /v1/messages', 'live'))], [], [], { prices });
    expect(packed.cost).toMatchObject({ spent: 0, captured: 3 });
    expect(packed.upstreamRequests).toBe(0);
    // And a capture a teammate pushed: its traffic was paid for where it ran.
    const capture = summarizeRun({ ...pulled, meta: { ...pulled.meta, covers: ['api'] } }, [priced(call(1, 'api', 'POST /v1/messages', 'live'))], [], [], { prices });
    expect(capture.imported).toBe(true);
    expect(capture.cost).toMatchObject({ spent: 0, captured: 3 });
  });

  it('keeps a replay of an imported recording as spend: that replay ran here', () => {
    const replay: RunRecord = { ...run(null), meta: { imported: { at: 1, from: 'pack' } } };
    const s = summarizeRun(replay, [priced(call(1, 'api', 'POST /v1/messages', 'live'))], [], [], { prices });
    expect(s.imported).toBe(false);
    expect(s.cost.spent).toBe(3);
  });

  it('names an injected failure apart from live calls and does not count it upstream', () => {
    const divergence: DivergenceReport = { type: 'forced', callNo: 2, kind: 'api', name: 'POST /v1/messages', replayedBefore: 1 };
    const failed = call(2, 'api', 'POST /v1/messages', 'live');
    const injectedCall: CallRecord = { ...failed, end: { ...failed.end!, outcome: 'error', meta: { status: 429, injected: true } } };
    const s = summarizeRun(run(divergence), [call(1, 'api', 'POST /v1/messages', 'replayed'), injectedCall, call(3, 'api', 'POST /v1/messages', 'live')]);
    expect(s.injected).toBe(1);
    expect(s.upstreamRequests).toBe(1);
    expect(formatSummary(s)).toContain('then 1 live, 1 injected;');
  });

  it('names a call an intervention could not be applied to apart, and does not count it upstream', () => {
    const divergence: DivergenceReport = { type: 'forced', callNo: 2, kind: 'api', name: 'POST /v1/messages', replayedBefore: 1 };
    const answered = call(2, 'api', 'POST /v1/messages', 'live');
    const refused: CallRecord = { ...answered, end: { ...answered.end!, outcome: 'error', meta: { status: 400, refused: true } } };
    const s = summarizeRun(run(divergence), [call(1, 'api', 'POST /v1/messages', 'replayed'), refused]);
    expect([s.refused, s.injected, s.upstreamRequests, s.byOrigin.live]).toEqual([1, 0, 0, 1]);
    expect(formatSummary(s)).toContain('then 0 live, 1 refused; 0 upstream requests');
  });
});

describe('formatDivergence: what came before a fork', () => {
  const fork: DivergenceReport = { type: 'request_changed', callNo: 17, kind: 'api', name: 'POST /v1/messages', replayedBefore: 16 };
  const calls = [...Array.from({ length: 15 }, (_, i) => call(i + 1, i % 2 ? 'tool' : 'api', 'x', 'replayed')), call(16, 'tool', 'lookup_policy', 'overridden'), call(17, 'api', 'POST /v1/messages', 'live')];

  it('names the calls an override answered apart from those replayed, as the run page does, given the run’s calls', () => {
    expect(formatDivergence(fork, undefined, 12, calls).split('\n')[0]).toBe('✗ Diverged at call 17 (api POST /v1/messages): 15 calls replayed and #16 overridden before divergence');
    // Without them, the count the divergence kept.
    expect(formatDivergence(fork).split('\n')[0]).toBe('✗ Diverged at call 17 (api POST /v1/messages): 16 calls replayed before divergence');
    // An override after the fork is none of what came before it.
    expect(formatDivergence(fork, undefined, 12, [...calls.slice(0, 15), call(16, 'tool', 'lookup_policy', 'replayed'), call(18, 'tool', 'escalate', 'overridden')]).split('\n')[0]).toContain(': 16 calls replayed before divergence');
  });

  it('counts one call replayed as one call', () => {
    expect(formatDivergence({ ...fork, callNo: 2, replayedBefore: 1 }).split('\n')[0]).toBe('✗ Diverged at call 2 (api POST /v1/messages): 1 call replayed before divergence');
    expect(formatDivergence({ ...fork, callNo: 3, replayedBefore: 2 }, undefined, 12, [call(1, 'api', 'x', 'replayed'), call(2, 'tool', 'lookup_policy', 'overridden')]).split('\n')[0]).toContain(': 1 call replayed and #2 overridden before divergence');
  });
});
