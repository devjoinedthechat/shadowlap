import Anthropic from '@anthropic-ai/sdk';
import { APIError } from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { Sidecar } from '../src/index.js';

/**
 * `--fail-at`: answering a model call with a failure Shadowlap produced. Error handling is the part
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
    // The message names Shadowlap, so it can never be mistaken for something the provider said.
    expect(String((error as APIError).message)).toContain('shadowlap --fail-at');
    expect(calls[0]!.end?.meta.status).toBe(429);
    expect(calls[0]!.end?.meta.injected).toBe(true);
    expect(calls[0]!.end?.outcome).toBe('error');
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
    expect(1 + calls[0]!.attempts.length).toBe(3);
    for (const end of [calls[0]!.end!, ...calls[0]!.attempts]) expect(end.meta.injected).toBe(true);
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
    expect(calls[0]!.origin).toBe('replayed');
    expect(calls[0]!.end?.meta.injected).toBeUndefined();
    expect(summary.divergence).toBeNull();
    store.close();
  });
});
