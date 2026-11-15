import Anthropic from '@anthropic-ai/sdk';
import { APIError } from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type ReplayOptions } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { Sidecar } from '../src/index.js';

/**
 * `--fail-at`: answering a model call with a failure shadowlap produced. Error handling is the part
 * of an agent a replay exercises for free and the part no recording of a healthy run contains, so
 * this is the only way into it. The mock stays reachable throughout: nothing here should ever ask
 * it anything, which is the point.
 */
let mock: MockServer;
beforeAll(async () => {
  mock = await startMockAnthropic({ script: () => ({ message: message([text('ok')]) }) });
});
afterAll(() => mock.close());

const params = { model: 'claude-opus-5' as const, max_tokens: 16, messages: [{ role: 'user' as const, content: 'hello' }] };

async function record(store: Store) {
  const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
  const run = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
  const client = new Anthropic({ apiKey: 'k', baseURL: sidecar.envFor(run.runId).ANTHROPIC_BASE_URL, maxRetries: 0 });
  await client.messages.create(params);
  sidecar.endRun(run.runId, 'completed');
  await sidecar.close();
  return run;
}

async function replay(store: Store, parentRunId: string, failAt: Map<number, number>, maxRetries = 0) {
  const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
  const run = sidecar.startRun({
    mode: 'replay',
    parentRunId,
    command: { argv: ['agent'], cwd: '/' },
    replay: { writes: 'block', reads: 'live', liveTools: new Set(), failAt },
  });
  const client = new Anthropic({ apiKey: 'k', baseURL: sidecar.envFor(run.runId).ANTHROPIC_BASE_URL, maxRetries });
  let error: unknown;
  try {
    await client.messages.create(params);
  } catch (err) {
    error = err;
  }
  const { summary } = sidecar.endRun(run.runId, 'completed');
  await sidecar.close();
  return { run, summary, error, calls: store.getCalls(run.runId) };
}

describe('injected failures', () => {
  it('answers the call with the status, and the agent sees a real provider error', async () => {
    const store = Store.open(':memory:');
    const parent = await record(store);
    const { error, calls } = await replay(store, parent.runId, new Map([[1, 429]]));

    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).status).toBe(429);
    // The message names shadowlap, so it can never be mistaken for something the provider said.
    expect(String((error as APIError).message)).toContain('shadowlap --fail-at');
    expect(calls[0].end?.meta.status).toBe(429);
    expect(calls[0].end?.meta.injected).toBe(true);
    expect(calls[0].end?.outcome).toBe('error');
    store.close();
  });

  it('counts as no upstream request, because nothing left the machine', async () => {
    const store = Store.open(':memory:');
    const parent = await record(store);
    const { summary } = await replay(store, parent.runId, new Map([[1, 500]]));
    expect(summary.upstreamRequests).toBe(0);
    store.close();
  });

  it('fails every attempt, so the retry policy runs and then gives up', async () => {
    const store = Store.open(':memory:');
    const parent = await record(store);
    // "the retry worked" is what an ordinary replay shows; the interesting path is the give-up.
    const { error, calls } = await replay(store, parent.runId, new Map([[1, 429]]), 2);
    expect((error as APIError).status).toBe(429);
    expect(1 + calls[0].attempts.length).toBe(3);
    for (const end of [calls[0].end!, ...calls[0].attempts]) expect(end.meta.injected).toBe(true);
    store.close();
  });

  it('explains itself in the divergence report instead of blaming another flag', async () => {
    const store = Store.open(':memory:');
    const parent = await record(store);
    const { run } = await replay(store, parent.runId, new Map([[1, 529]]));
    const divergence = store.getRun(run.runId)?.divergence;
    expect(divergence?.type).toBe('forced');
    expect(divergence?.reason).toContain('--fail-at 1=529');
    expect(divergence?.reason).not.toContain('--live-tool');
    store.close();
  });

  it('leaves calls it was not asked about served from the recording', async () => {
    const store = Store.open(':memory:');
    const parent = await record(store);
    const { calls, summary } = await replay(store, parent.runId, new Map([[99, 500]]));
    expect(calls[0].origin).toBe('replayed');
    expect(calls[0].end?.meta.injected).toBeUndefined();
    expect(summary.divergence).toBeNull();
    store.close();
  });
});

describe('injected failures on Bedrock', () => {
  it('answer in AWS\'s error shape, so the AWS SDK raises the exception a real failure raises', async () => {
    // A Converse endpoint that answers every request.
    const { createServer } = await import('node:http');
    const upstream = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 1 } }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
    const address = upstream.address() as { port: number };
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { bedrock: `http://127.0.0.1:${address.port}` } });
    const converse = (runId: string) =>
      fetch(`${sidecar.url}/r/${runId}/bedrock/model/anthropic.claude-sonnet-5/converse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: [{ text: 'hello' }] }] }) });
    try {
      const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
      expect((await converse(rec.runId)).status).toBe(200);
      sidecar.endRun(rec.runId, 'completed');
      for (const [status, type] of [
        [429, 'ThrottlingException'],
        [503, 'ServiceUnavailableException'],
        [500, 'InternalServerException'],
        [400, 'ValidationException'],
      ] as const) {
        const run = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '/' }, replay: { failAt: new Map([[1, status]]) } });
        const res = await converse(run.runId);
        expect(res.status).toBe(status);
        expect(res.headers.get('x-amzn-errortype')).toBe(type);
        const body = (await res.json()) as { message?: string };
        expect(body.message).toMatch(new RegExp(`shadowlap --fail-at 1=${status}`));
        sidecar.endRun(run.runId, 'completed');
      }
    } finally {
      await sidecar.close();
      store.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});

describe('flags that name a model call, in a recording made with scopes', () => {
  it('reach the call they named when sub-agents send their requests in another order', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
    const step = async (runId: string, scope: string, n: number) => {
      const client = new Anthropic({ apiKey: 'k', baseURL: sidecar.envFor(runId).ANTHROPIC_BASE_URL, maxRetries: 0, defaultHeaders: { 'x-shadowlap-scope': scope } });
      try {
        await client.messages.create({ ...params, messages: [{ role: 'user', content: `${scope}: step ${n}` }] });
        return 'ok';
      } catch (err) {
        return err instanceof APIError ? err.status : 'error';
      }
    };
    try {
      // Recorded: #1 and #2 are alpha's, #3 and #4 beta's.
      const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
      for (const scope of ['alpha', 'beta']) for (const n of [1, 2]) await step(rec.runId, scope, n);
      sidecar.endRun(rec.runId, 'completed');

      // The replay runs beta first: alpha's second request is the replay's call #4.
      const reversed = async (replay: Partial<ReplayOptions>) => {
        const run = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '/' }, replay });
        const got: Record<string, unknown> = {};
        for (const scope of ['beta', 'alpha']) for (const n of [1, 2]) got[`${scope} ${n}`] = await step(run.runId, scope, n);
        const { summary } = sidecar.endRun(run.runId, 'completed');
        return { got, summary };
      };
      const failed = await reversed({ failAt: new Map([[2, 400]]) });
      expect(failed.got).toEqual({ 'beta 1': 'ok', 'beta 2': 'ok', 'alpha 1': 'ok', 'alpha 2': 400 });
      expect(failed.summary.divergence).toMatchObject({ type: 'forced', callNo: 4, counterpart: { callNo: 2 } });
      expect(failed.summary.divergence!.reason).toMatch(/--fail-at 2=400/);
      expect(failed.summary.warnings.join('\n')).not.toMatch(/changed nothing/);

      const diverged = await reversed({ divergeAt: 2 });
      expect(diverged.summary.divergence).toMatchObject({ type: 'forced', callNo: 4, reason: 'forced live by --diverge-at 2', counterpart: { callNo: 2 } });

      const prompt = await reversed({ promptFrom: 4 });
      expect(prompt.summary.divergence).toMatchObject({ type: 'forced', callNo: 2, counterpart: { callNo: 4 } });

      // A place the replay never reaches says so.
      const short = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '/' }, replay: { failAt: new Map([[4, 503]]) } });
      await step(short.runId, 'alpha', 1);
      expect(sidecar.endRun(short.runId, 'completed').summary.warnings.join('\n')).toMatch(/--fail-at 4=503 changed nothing: call #4 is the recording's model call 2 of scope beta, and the replay made none there/);
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});
