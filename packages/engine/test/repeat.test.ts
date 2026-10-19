import { describe, expect, it } from 'vitest';
import { formatRepeats, summarizeRepeats, type RepeatAttemptInput } from '../src/repeat.js';
import { summarizeRun } from '../src/report.js';
import type { CallRecord, DivergenceReport, Origin, RunRecord } from '../src/types.js';

let seq = 0;
const runId = () => `01K5CQ4N7G${String(++seq).padStart(16, '0')}`;

function call(run: string, callNo: number, kind: CallRecord['kind'], name: string, origin: Origin, opts: { outcome?: 'ok' | 'error'; response?: string } = {}): CallRecord {
  return {
    runId: run,
    callNo,
    kind,
    name,
    fingerprint: 'f'.repeat(64),
    occurrence: 1,
    origin,
    effect: kind === 'tool' ? 'write' : null,
    requestRef: null,
    meta: {},
    at: callNo,
    end: { runId: run, callNo, attempt: 0, responseRef: opts.response ?? null, outcome: opts.outcome ?? 'ok', meta: {}, at: callNo + 1 },
    attempts: [],
  };
}

/** An attempt that replays calls 1-2, forks at 3, and then makes the given tool calls and a final answer. */
function attempt(tools: Array<[string, Origin, ('ok' | 'error')?]>, answer: string, exitCode = 0, forkAt = 3): RepeatAttemptInput {
  const id = runId();
  const calls = [call(id, 1, 'api', 'POST /v1/messages', 'replayed'), call(id, 2, 'tool', 'read_logs', 'replayed'), call(id, forkAt, 'api', 'POST /v1/messages', 'live')];
  tools.forEach(([name, origin, outcome], i) => calls.push(call(id, forkAt + 1 + i, 'tool', name, origin, outcome ? { outcome } : {})));
  calls.push(call(id, forkAt + 1 + tools.length, 'api', 'POST /v1/messages', 'live', { response: answer }));
  const divergence: DivergenceReport = { type: 'request_changed', callNo: forkAt, kind: 'api', name: 'POST /v1/messages', replayedBefore: forkAt - 1 };
  const run: RunRecord = { runId: id, parentRunId: '01K5CQ4N7G0000000000000000', mode: 'replay', status: exitCode === 0 ? 'completed' : 'failed', divergence, command: { argv: ['node', 'agent.js'], cwd: '/' }, codeVersion: null, startedAt: 0, endedAt: 1 };
  return { runId: id, exitCode, summary: summarizeRun(run, calls), calls };
}

describe('repeated forks', () => {
  it('treats the tools of one model turn as a set, since they often run at once', () => {
    const inputs = [
      attempt([['search_web', 'live'], ['read_file', 'live']], 'answer'),
      attempt([['read_file', 'live'], ['search_web', 'live']], 'answer'),
    ];
    // The same tools over two model turns, search first: a different path.
    const split = attempt([['search_web', 'live']], 'answer');
    const id = split.runId;
    split.calls = [...split.calls.slice(0, 4), call(id, 5, 'api', 'POST /v1/messages', 'live'), call(id, 6, 'tool', 'read_file', 'live'), call(id, 7, 'api', 'POST /v1/messages', 'live', { response: 'answer' })];
    const r = summarizeRepeats('01K5CQ4N7G0000000000000000', [...inputs, split]);
    expect(r.paths.map((g) => [g.runIds.length, g.path])).toEqual([
      [2, ['read_file', 'search_web']],
      [1, ['search_web', 'read_file']],
    ]);
  });

  it('groups attempts by what they did after the fork', () => {
    const inputs = [
      attempt([['open_ticket', 'stubbed'], ['open_ticket', 'stubbed']], 'answer-a'),
      attempt([['open_ticket', 'stubbed']], 'answer-b'),
      attempt([['open_ticket', 'stubbed'], ['open_ticket', 'stubbed']], 'answer-a'),
      attempt([['page_oncall', 'live', 'error']], 'answer-c', 1),
    ];
    const r = summarizeRepeats('01K5CQ4N7G0000000000000000', inputs);
    expect(r.forkedAt).toEqual([3]);
    expect(r.paths.map((g) => [g.runIds.length, g.path])).toEqual([
      [2, ['open_ticket (stubbed)', 'open_ticket (stubbed)']],
      [1, ['open_ticket (stubbed)']],
      [1, ['page_oncall (error)']],
    ]);
    expect(r.tools).toEqual([
      { name: 'open_ticket', attempts: 3, calls: 5, blocked: 0, stubbed: 5, errors: 0 },
      { name: 'page_oncall', attempts: 1, calls: 1, blocked: 0, stubbed: 0, errors: 1 },
    ]);
    expect(r.succeeded).toBe(3);
    expect(r.distinctFinalResponses).toBe(3);

    const text = formatRepeats(r);
    expect(text).toContain('⑂ 4 attempts from 01K5CQ4N7G, each forked at call 3');
    expect(text).toContain('3 of 4 exited 0');
    expect(text).toContain('2×  open_ticket (stubbed) → open_ticket (stubbed)');
    expect(text).toContain("3 different paths: the change doesn't settle the behavior on its own");
    expect(text).toMatch(/open_ticket\s+3 of 4\s+5 \(5 stubbed\)/);
    expect(text).toMatch(/page_oncall\s+1 of 4\s+1 \(1 errors\)/);
    expect(text).toContain('Final model responses: 3 different');
    expect(text).toContain(`compare the two most common paths: shadowlap diff ${r.paths[0]!.runIds[0]!.slice(0, 10)} ${r.paths[1]!.runIds[0]!.slice(0, 10)}`);
  });

  it('says so when every attempt agrees, comparing answers by content when told how', () => {
    const inputs = [attempt([['open_ticket', 'stubbed']], 'bytes-1'), attempt([['open_ticket', 'stubbed']], 'bytes-2')];
    const r = summarizeRepeats('01K5CQ4N7G0000000000000000', inputs, { responseContent: () => 'the same text' });
    expect(r.paths).toHaveLength(1);
    const text = formatRepeats(r);
    expect(text).toContain('every attempt took the same path');
    expect(text).toContain('Final model responses: the same in every attempt');
    expect(text).not.toContain('shadowlap diff');
  });

  it('flags a prefix that forks at different calls', () => {
    const r = summarizeRepeats('01K5CQ4N7G0000000000000000', [attempt([], 'a', 0, 3), attempt([], 'a', 0, 5)]);
    expect(r.forkedAt).toEqual([3, 5]);
    expect(formatRepeats(r)).toContain('forked at calls 3, 5: the prefix is not deterministic');
    expect(formatRepeats(r)).toContain('No tool was called after the fork in any attempt.');
  });

  it('says which attempts ended early, apart from the forks, without calling them clean', () => {
    const id = runId();
    const calls = [call(id, 1, 'api', 'POST /v1/messages', 'replayed'), call(id, 2, 'tool', 'read_logs', 'replayed')];
    const divergence: DivergenceReport = { type: 'ended_early', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2, recorded: 5 };
    const run: RunRecord = { runId: id, parentRunId: '01K5CQ4N7G0000000000000000', mode: 'replay', status: 'completed', divergence, command: { argv: ['node', 'agent.js'], cwd: '/' }, codeVersion: null, startedAt: 0, endedAt: 1 };
    const early = { runId: id, exitCode: 0, summary: summarizeRun(run, calls), calls };
    const r = summarizeRepeats('01K5CQ4N7G0000000000000000', [attempt([], 'a', 0, 3), early]);
    expect(r.attempts.map((a) => [a.forkedAt, a.endedEarly])).toEqual([
      [3, null],
      [null, 3],
    ]);
    expect(formatRepeats(r).split('\n')[0]).toBe('⑂ 2 attempts from 01K5CQ4N7G, forked at calls none, 3: the prefix is not deterministic · 1 of 2 ended early, at call 3');
  });
});
