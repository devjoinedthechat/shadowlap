import { describe, expect, it } from 'vitest';
import { maskedChange, normalizeAddArgs, normalizeAddCommand, Store, volatileValues, type DivergenceReport } from '../src/index.js';

describe('test history in the store', () => {
  it('keeps sessions and per-golden results, newest first, with what the Tests screen needs', () => {
    const store = Store.open(':memory:');
    const s1 = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'c91d0f4', actor: 'ci', startedAt: 1000 });
    store.addTestResult({ sessionId: s1.sessionId, golden: 'goldens/refund-flow', ok: true, revision: 'c91d0f4', runId: 'R1', goldenRunId: 'G1', at: 1100, data: { mode: 'replay', calls: { total: 8, replayed: 8, live: 0, blocked: 0, stubbed: 0 } } });
    store.addTestResult({ sessionId: s1.sessionId, golden: 'goldens/refund-in-limit', ok: false, failure: 'diverged', reason: 'diverged at call 1 (api POST /v1/messages)', revision: 'c91d0f4', runId: 'R2', at: 1200 });
    store.finishTestSession(s1.sessionId, { passed: 1, failed: 1, upstreamRequests: 0, endedAt: 1300 });
    const s2 = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/refund-flow'], revision: 'd2e8a1f+dirty', startedAt: 2000 });

    expect(store.getTestSession(s1.sessionId)).toEqual({ sessionId: s1.sessionId, startedAt: 1000, endedAt: 1300, command: ['shadowlap', 'test', 'goldens/*'], revision: 'c91d0f4', passed: 1, failed: 1, upstreamRequests: 0, actor: 'ci' });
    expect(store.listTestSessions().map((s) => s.sessionId)).toEqual([s2.sessionId, s1.sessionId]);
    expect(store.listTestSessions({ finished: true }).map((s) => s.sessionId)).toEqual([s1.sessionId]);
    expect(store.listTestSessions({ before: 2000 }).map((s) => s.sessionId)).toEqual([s1.sessionId]);

    const results = store.listTestResults({ sessionId: s1.sessionId });
    expect(results.map((r) => r.golden)).toEqual(['goldens/refund-in-limit', 'goldens/refund-flow']);
    expect(results[0]).toMatchObject({ ok: false, failure: 'diverged', reason: 'diverged at call 1 (api POST /v1/messages)', runId: 'R2', goldenRunId: null, data: null });
    expect(results[1]).toMatchObject({ ok: true, failure: null, data: { mode: 'replay', calls: { total: 8 } } });
    expect(store.listTestResults({ golden: 'goldens/refund-flow' })).toHaveLength(1);
    expect(store.listTestResults({ since: 1150 })).toHaveLength(1);
    store.close();
  });

  it('replaces a golden\'s result within one session, as an update does, and never fails a result for lack of a reason', () => {
    const store = Store.open(':memory:');
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/x', '--update'] });
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/x', ok: false, failure: 'diverged', at: 1 });
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/x', ok: true, at: 2, data: { updated: { from: 'A', to: 'B', calls: 4 } } });
    const [only] = store.listTestResults({ sessionId: s.sessionId });
    expect(only).toMatchObject({ ok: true, failure: null, data: { updated: { from: 'A', to: 'B', calls: 4 } } });
    // A failed result without a reason still says it failed.
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/y', ok: false });
    expect(store.listTestResults({ golden: 'goldens/y' })[0]!.failure).toBe('error');
    store.close();
  });

  it('finds each golden\'s newest result, and the runs test made for a golden', () => {
    const store = Store.open(':memory:');
    const a = store.startTestSession({ command: ['shadowlap', 'test'], startedAt: 1 });
    store.addTestResult({ sessionId: a.sessionId, golden: 'g1', ok: true, at: 10 });
    store.addTestResult({ sessionId: a.sessionId, golden: 'g2', ok: false, failure: 'check', at: 11 });
    const b = store.startTestSession({ command: ['shadowlap', 'test'], startedAt: 20 });
    store.addTestResult({ sessionId: b.sessionId, golden: 'g1', ok: false, failure: 'diverged', at: 30 });
    expect(store.latestTestResults().map((r) => [r.golden, r.ok])).toEqual([['g1', false], ['g2', false]]);
    expect(store.latestTestResults({ until: 15 }).map((r) => [r.golden, r.ok])).toEqual([['g2', false], ['g1', true]]);
    expect(store.listTestResults({ sessionIds: [a.sessionId] }).map((r) => r.golden)).toEqual(['g2', 'g1']);
    expect(store.listTestResults({ sessionIds: [] })).toEqual([]);

    const replay = store.createRun({ mode: 'replay', command: { argv: ['node'], cwd: '/' }, meta: { test: { golden: 'g1', session: b.sessionId } } });
    store.createRun({ mode: 'replay', command: { argv: ['node'], cwd: '/' }, meta: { test: { golden: 'g2', session: b.sessionId } } });
    store.createRun({ mode: 'record', command: { argv: ['node'], cwd: '/' } });
    expect(store.testReplays(['g1']).map((r) => r.runId)).toEqual([replay.runId]);
    expect(store.testReplays([])).toEqual([]);
    store.close();
  });

  it('counts the runs at each revision and how many failed, newest first, for one command', () => {
    const store = Store.open(':memory:');
    const agent = ['node', 'agent.mjs'];
    const run = (argv: string[], codeVersion: string | null, startedAt: number, status: 'completed' | 'failed' | 'crashed', meta?: Parameters<Store['createRun']>[0]['meta']) => {
      const r = store.createRun({ mode: 'record', command: { argv, cwd: '/p' }, codeVersion, startedAt, ...(meta ? { meta } : {}) });
      store.endRun(r.runId, status, startedAt + 1);
    };
    run(agent, 'aaa1111', 100, 'completed');
    run(agent, 'aaa1111', 110, 'failed');
    run(agent, 'bbb2222', 200, 'completed', { checks: [{ ok: false, label: 'send_email called 0 times', detail: 'called 1 time' }] });
    run(agent, 'bbb2222', 210, 'completed', { checks: [{ ok: true, label: 'send_email called 0 times', detail: null }] });
    run(agent, 'ccc3333', 300, 'crashed');
    run(agent, 'ccc3333', 310, 'completed', { probe: { of: 'X', callNo: 2, passed: false } });
    run(['python', 'other.py'], 'ddd4444', 400, 'completed');
    run(agent, null, 500, 'completed');
    store.createRun({ mode: 'record', command: { argv: agent, cwd: '/p' }, codeVersion: 'eee5555', startedAt: 600 });
    expect(store.runRevisions({ argv: agent })).toEqual([
      { revision: 'ccc3333', lastAt: 300, runs: 1, failed: 1 },
      { revision: 'bbb2222', lastAt: 210, runs: 2, failed: 1 },
      { revision: 'aaa1111', lastAt: 110, runs: 2, failed: 1 },
    ]);
    expect(store.runRevisions({ argv: agent, before: 300, limit: 1 })).toEqual([{ revision: 'bbb2222', lastAt: 210, runs: 2, failed: 1 }]);
    expect(store.runRevisions().map((r) => r.revision)).toEqual(['ddd4444', 'ccc3333', 'bbb2222', 'aaa1111']);
    store.close();
  });

  it('keeps history when the runs it names are deleted', () => {
    const store = Store.open(':memory:');
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/' } });
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'g'] });
    store.addTestResult({ sessionId: s.sessionId, golden: 'g', ok: true, runId: run.runId });
    store.deleteRun(run.runId);
    expect(store.listTestResults()[0]!.runId).toBe(run.runId);
    store.close();
  });
});

describe('values that change every run', () => {
  const divergence = (diff: NonNullable<DivergenceReport['diff']>, kind: DivergenceReport['kind'] = 'api', name = 'POST /v1/messages'): DivergenceReport => ({ type: 'request_changed', callNo: 1, kind, name, replayedBefore: 0, diff });

  it('names a changed UUID, date or id with the normalizer that masks it for good', () => {
    const uuid = volatileValues(divergence([{ path: '$.metadata.user_id', op: 'changed', before: '3f2a8c1e-1b2c-4d5e-8f90-0a1b2c3d4e5f', after: '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' }]));
    expect(uuid.explainsAll).toBe(true);
    expect(uuid.values).toEqual([{ path: '$.metadata.user_id', looks: 'a UUID', op: 'changed', normalizer: { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' } }]);
    expect(normalizeAddCommand(uuid.values[0]!.normalizer)).toBe("shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'");
    expect(normalizeAddArgs(uuid.values[0]!.normalizer)).toEqual(['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>']);

    const id = volatileValues(divergence([{ path: '$.args.request_id', op: 'changed', before: 'req_8f3a2c', after: 'req_19bd07' }], 'tool', 'lookup'));
    expect(id.values[0]).toEqual({ path: '$.args.request_id', looks: 'an id', op: 'changed', normalizer: { kind: 'tool', name: 'lookup', path: '$.args.request_id', replace: '<ID>' } });
    expect(normalizeAddCommand(id.values[0]!.normalizer)).toBe("shadowlap normalize add --kind tool --name lookup --path '$.args.request_id' --replace '<ID>'");
  });

  it('looks inside a field the request carries for the first time, but not inside an appended message', () => {
    const added = volatileValues(divergence([{ path: '$.metadata', op: 'added', after: { user_id: '3f2a8c1e-1b2c-4d5e-8f90-0a1b2c3d4e5f', plan: 'pro', trace: { request_id: 'req_8f3a2c' }, tags: ['req_1a2b3c'] } }]));
    expect(added.values.map((v) => [v.path, v.looks, v.op])).toEqual([
      ['$.metadata.trace.request_id', 'an id', 'added'],
      ['$.metadata.user_id', 'a UUID', 'added'],
    ]);
    expect(added.values[1]!.normalizer).toEqual({ kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' });
    expect(added.explainsAll).toBe(false);
    // A message appended to the conversation carries ids that were recorded, not made anew.
    const appended = volatileValues(divergence([{ path: '$.messages[3]', op: 'added', after: { role: 'assistant', id: 'msg_01XYZ9', content: [{ type: 'tool_use', id: 'toolu_01ABC' }] } }]));
    expect(appended.values).toEqual([]);
  });

  it('leaves out what the normalizers in force already mask, as matching did', () => {
    const uuid = { path: '$.metadata.user_id', op: 'changed' as const, before: '3f2a8c1e-1b2c-4d5e-8f90-0a1b2c3d4e5f', after: '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' };
    const scratch = { path: '$.system', op: 'changed' as const, before: 'Scratch: /tmp/agent-IibHnC/', after: 'Scratch: /tmp/agent-Ye8IFi/' };
    const masks = [{ kind: 'api' as const, path: '$.system', pattern: '/agent-[A-Za-z0-9]+/', replace: 'agent-X' }];
    // The scratch directory is masked for matching, so only the UUID made the replay diverge.
    expect(volatileValues(divergence([uuid, scratch])).explainsAll).toBe(false);
    expect(volatileValues(divergence([uuid, scratch]), masks)).toMatchObject({ values: [{ path: '$.metadata.user_id' }], explainsAll: true });
    // A UUID already masked is not offered again; what is left is a prompt change.
    const both = [...masks, { kind: 'api' as const, path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' }];
    expect(volatileValues(divergence([uuid, scratch, { path: '$.messages[0].content', op: 'changed', before: 'triage', after: 'triage it' }]), both)).toEqual({ values: [], explainsAll: false });
    // Rules for another kind or tool, or a path elsewhere, mask nothing here.
    expect(maskedChange(scratch, [{ kind: 'tool', path: '$.system', pattern: '/agent-[A-Za-z0-9]+/', replace: 'X' }], { kind: 'api', name: 'POST /v1/messages' })).toBe(false);
    expect(maskedChange(scratch, [{ path: '$.other', replace: 'X' }], { kind: 'api', name: 'POST /v1/messages' })).toBe(false);
    expect(maskedChange({ path: '$.messages[2].content[0].text', op: 'changed', before: 'at agent-ab12', after: 'at agent-cd34' }, [{ pattern: '/agent-[a-z0-9]+/', replace: 'agent-X' }], { kind: 'api', name: 'POST /v1/messages' })).toBe(true);
    expect(maskedChange({ path: '$.messages[0].cache_control', op: 'added', after: { type: 'ephemeral' } }, [], { kind: 'api', name: 'POST /v1/messages' })).toBe(true);
  });

  it('tells a value the request newly carries from a prompt change', () => {
    const added = volatileValues(divergence([{ path: '$.metadata.user_id', op: 'added', after: '3f2a8c1e-1b2c-4d5e-8f90-0a1b2c3d4e5f' }]));
    expect(added.explainsAll).toBe(false);
    expect(added.values[0]).toMatchObject({ looks: 'a UUID', op: 'added', normalizer: { pattern: 'uuid' } });

    const prompt = volatileValues(divergence([{ path: '$.system', op: 'changed', before: 'You are a support agent.', after: 'You are a support agent. Be brief.' }]));
    expect(prompt).toEqual({ values: [], explainsAll: false });
    const both = volatileValues(divergence([
      { path: '$.system', op: 'changed', before: 'Be brief.', after: 'Be concise.' },
      { path: '$.metadata.user_id', op: 'changed', before: '3f2a8c1e-1b2c-4d5e-8f90-0a1b2c3d4e5f', after: '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' },
    ]));
    expect(both.values.map((v) => v.path)).toEqual(['$.metadata.user_id']);
    expect(both.explainsAll).toBe(false);
    // Keys that only end in the letters "id" are not ids; camel-case ids are.
    for (const key of ['paid', 'valid', 'android', 'rapid', 'grid', 'Paid']) {
      expect(volatileValues(divergence([{ path: `$.order.${key}`, op: 'changed', before: 1999, after: 2499 }])).values, key).toEqual([]);
    }
    for (const key of ['userId', 'requestID', 'traceUuid', 'user_id', 'request-id', 'id', 'NONCE']) {
      expect(volatileValues(divergence([{ path: `$.meta.${key}`, op: 'changed', before: 1999, after: 2499 }])).values, key).toHaveLength(1);
    }
    // Words are not ids, even under an id-like key.
    expect(volatileValues(divergence([{ path: '$.args.order_id', op: 'changed', before: 'refund', after: 'escalate' }])).values).toEqual([]);
    expect(volatileValues({ type: 'new_call', callNo: 2, kind: 'tool', name: 'x', replayedBefore: 1 }).values).toEqual([]);
  });
});
