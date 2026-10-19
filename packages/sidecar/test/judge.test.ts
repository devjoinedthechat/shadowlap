import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JUDGE_SCOPE, loadApiRequest, Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, withJudge, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { Sidecar } from '../src/index.js';

/**
 * Judge calls through the sidecar: the reserved scope only this process can use, a judge answered
 * from the recording or not at all, a judge's own upstream, and an ended run opened for its judge.
 */

const command = { argv: ['agent'], cwd: '/' };
let mock: MockServer;
let other: MockServer;

beforeAll(async () => {
  const agent = () => ({ message: message([text('Done.')], { stop_reason: 'end_turn' }) });
  mock = await startMockAnthropic({ script: withJudge(() => ({ verdict: 'yes', reason: 'the reply is there' }), agent), eventDelayMs: () => 0 });
  other = await startMockAnthropic({ script: withJudge(() => ({ verdict: 'no', reason: 'asked the other one' }), agent), eventDelayMs: () => 0 });
});
afterAll(async () => {
  await mock.close();
  await other.close();
});

const judgeBody = (material: string) => ({ model: 'claude-haiku-4-5', max_tokens: 64, temperature: 0, system: 'Reply with the verdict JSON.', messages: [{ role: 'user', content: `Question: Is it done?\n\nThe material is the answer.\n\n<material>\n${material}\n</material>` }] });

function ask(sidecar: Sidecar, runId: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${sidecar.url}/r/${runId}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-shadowlap-scope': JUDGE_SCOPE, 'x-shadowlap-judge': sidecar.judgeToken, 'x-shadowlap-judge-check': 'done', 'x-shadowlap-judge-ask': 'abc123', ...headers },
    body: JSON.stringify(body),
  });
}

async function agentCall(sidecar: Sidecar, runId: string, content = 'Finish up.', headers: Record<string, string> = {}) {
  return fetch(`${sidecar.url}/r/${runId}/anthropic/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 64, messages: [{ role: 'user', content }] }) });
}

describe('the judge scope', () => {
  it('is refused to any call without this process\'s judge token, and to every other scope under shadowlap:', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
    try {
      const run = sidecar.startRun({ mode: 'record', command });
      const forged = await agentCall(sidecar, run.runId, 'x', { 'x-shadowlap-scope': JUDGE_SCOPE });
      expect(forged.status).toBe(400);
      expect(((await forged.json()) as { error: { message: string } }).error.message).toContain('reserved for Shadowlap');
      expect((await ask(sidecar, run.runId, judgeBody('x'), { 'x-shadowlap-judge': 'not-the-token' })).status).toBe(400);
      expect((await ask(sidecar, run.runId, judgeBody('x'), { 'x-shadowlap-scope': 'shadowlap:other' })).status).toBe(400);
      const tool = await fetch(`${sidecar.url}/v1/calls/resolve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shadowlap-run': run.runId, 'x-shadowlap-scope': JUDGE_SCOPE, 'x-shadowlap-judge': sidecar.judgeToken }, body: JSON.stringify({ kind: 'tool', name: 'send_email', effect: 'write', args: {} }) });
      expect(tool.status).toBe(400);
      // No agent's environment holds the token.
      expect(JSON.stringify(sidecar.envFor(run.runId))).not.toContain(sidecar.judgeToken);
      expect(store.getCalls(run.runId)).toEqual([]);
      sidecar.endRun(run.runId, 'completed');
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('records a judge call with its check, answers a clean replay from it, and a fork whose material changed live', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      await (await agentCall(sidecar, rec.runId)).json();
      const judged = await ask(sidecar, rec.runId, judgeBody('Done.'));
      expect(judged.headers.get('x-shadowlap-origin')).toBe('live');
      const recorded = sidecar.endRun(rec.runId, 'completed').summary;
      expect(recorded.total).toBe(1);
      expect(recorded.judge).toMatchObject({ calls: 1, live: 1, upstreamRequests: 1 });
      expect(store.getCalls(rec.runId)[1]!.meta).toMatchObject({ scope: JUDGE_SCOPE, judge: { check: 'done', ask: 'abc123' } });

      const sent = mock.requests.length;
      const clean = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command });
      await (await agentCall(sidecar, clean.runId)).json();
      const again = await ask(sidecar, clean.runId, judgeBody('Done.'));
      expect(again.headers.get('x-shadowlap-origin')).toBe('replayed');
      expect(await again.json()).toMatchObject({ content: [{ text: '{"verdict":"yes","reason":"the reply is there"}' }] });
      const s = sidecar.endRun(clean.runId, 'completed').summary;
      expect(s.divergence).toBeNull();
      expect(s.byOrigin.replayed).toBe(1);
      expect(s.judge).toMatchObject({ calls: 1, replayed: 1, live: 0, upstreamRequests: 0 });
      expect(mock.requests.length).toBe(sent);

      // The material changed: the judge is asked live, and the replay of the agent stays clean.
      const changed = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command });
      await (await agentCall(sidecar, changed.runId)).json();
      expect((await ask(sidecar, changed.runId, judgeBody('Done, differently.'))).headers.get('x-shadowlap-origin')).toBe('live');
      const c = sidecar.endRun(changed.runId, 'completed').summary;
      expect(c.divergence).toBeNull();
      expect(c.judge).toMatchObject({ live: 1, upstreamRequests: 1 });
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('answers a judge that may not be asked live from the recording or not at all, sending nothing upstream', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
    try {
      const run = sidecar.startRun({ mode: 'record', command });
      const sent = mock.requests.length;
      const res = await ask(sidecar, run.runId, judgeBody('x'), { 'x-shadowlap-judge-offline': '1' });
      expect(res.status).toBe(503);
      expect(await res.text()).toContain('shadowlap_offline');
      expect(mock.requests.length).toBe(sent);
      const s = sidecar.endRun(run.runId, 'completed').summary;
      expect(s.judge).toMatchObject({ calls: 1, live: 0, notAsked: 1, upstreamRequests: 0 });
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('asks a judge where it says, whatever this sidecar points its provider at', async () => {
    const store = Store.open(':memory:');
    // The agent's calls go to a model under test; the judge's to its own.
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: other.url } });
    try {
      const run = sidecar.startRun({ mode: 'record', command });
      const res = await ask(sidecar, run.runId, judgeBody('x'), { 'x-shadowlap-judge-upstream': mock.url });
      expect(((await res.json()) as { content: Array<{ text: string }> }).content[0]!.text).toContain('the reply is there');
      expect((await ask(sidecar, run.runId, judgeBody('y'), { 'x-shadowlap-judge-upstream': 'file:///etc/passwd' })).status).toBe(400);
      sidecar.endRun(run.runId, 'completed');
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('is never rewritten by a replay\'s flags, which count only the agent\'s model calls', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      await (await agentCall(sidecar, rec.runId)).json();
      await (await ask(sidecar, rec.runId, judgeBody('Done.'))).json();
      sidecar.endRun(rec.runId, 'completed');
      const fork = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, interventions: { set: { fromCall: 1, fields: { model: 'claude-opus-5', max_tokens: 9 } } } });
      await (await agentCall(sidecar, fork.runId)).json();
      await (await ask(sidecar, fork.runId, judgeBody('Done.'))).json();
      sidecar.endRun(fork.runId, 'completed');
      const [agent, judge] = store.getCalls(fork.runId);
      expect(loadApiRequest(store, agent!.requestRef!)).toMatchObject({ model: 'claude-opus-5', max_tokens: 9 });
      expect(loadApiRequest(store, judge!.requestRef!)).toMatchObject({ model: 'claude-haiku-4-5', max_tokens: 64 });
      // A flag can name no judge call: the recording's second model call is the judge's.
      expect(() => sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, interventions: { set: { fromCall: 2, fields: { max_tokens: 9 } } } })).toThrow(/#2/);
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});

describe('an ended run opened for its judge', () => {
  it('takes judge calls after its own, refuses everything else, and keeps its status and end', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      await (await agentCall(sidecar, rec.runId)).json();
      sidecar.endRun(rec.runId, 'failed');
      const before = store.getRun(rec.runId)!;

      sidecar.openForJudge(rec.runId);
      expect((await agentCall(sidecar, rec.runId)).status).toBe(409);
      expect((await ask(sidecar, rec.runId, judgeBody('Done.'))).status).toBe(200);
      expect(() => sidecar.endRun(rec.runId, 'completed')).toThrow(/open for its judge's calls only/);
      expect(sidecar.closeForJudge(rec.runId)).toMatchObject({ calls: 1, live: 1, upstreamRequests: 1 });
      expect(sidecar.closeForJudge(rec.runId)).toBeNull();
      expect(store.getRun(rec.runId)).toMatchObject({ status: 'failed', endedAt: before.endedAt });
      expect(store.getCalls(rec.runId).map((c) => [c.callNo, c.meta.scope ?? null])).toEqual([
        [1, null],
        [2, JUDGE_SCOPE],
      ]);

      // A replay opened for its judge is answered from its recording's judge calls.
      const replay = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command });
      await (await agentCall(sidecar, replay.runId)).json();
      sidecar.endRun(replay.runId, 'completed');
      sidecar.openForJudge(replay.runId);
      expect((await ask(sidecar, replay.runId, judgeBody('Done.'))).headers.get('x-shadowlap-origin')).toBe('replayed');
      expect(sidecar.closeForJudge(replay.runId)).toMatchObject({ calls: 1, replayed: 1, upstreamRequests: 0 });
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});
