import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { Sidecar } from '../src/index.js';

/**
 * Several processes recording through one sidecar at once, as `shadowlap replay --repeat
 * --concurrency` does: each process's model calls must land in its own run. The SDKs send no
 * Shadowlap header, so the run is in the base URL.
 */
let mock: MockServer;
let store: Store;
let sidecar: Sidecar;

beforeAll(async () => {
  mock = await startMockAnthropic({ script: (ctx) => ({ message: message([text(`turn ${ctx.assistantTurns}`)]) }) });
  store = Store.open(':memory:');
  sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
});
afterAll(async () => {
  await sidecar.close();
  await mock.close();
  store.close();
});

describe('concurrent runs on one sidecar', () => {
  it('attributes each model call to the run whose base URL it used', async () => {
    const a = sidecar.startRun({ mode: 'record', command: { argv: ['a'], cwd: '.' } });
    const b = sidecar.startRun({ mode: 'record', command: { argv: ['b'], cwd: '.' } }); // started last: the fallback run
    const client = (runId: string) => new Anthropic({ apiKey: 'k', baseURL: sidecar.envFor(runId).ANTHROPIC_BASE_URL, maxRetries: 0 });
    const ask = (runId: string, content: string) => client(runId).messages.create({ model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content }] });
    await Promise.all([ask(a.runId, 'one'), ask(b.runId, 'two'), ask(a.runId, 'three')]);
    expect(sidecar.endRun(a.runId, 'completed').summary.byKind.api).toBe(2);
    expect(sidecar.endRun(b.runId, 'completed').summary.byKind.api).toBe(1);
  });

  it('refuses a call pinned to a run that is not active instead of recording it elsewhere', async () => {
    const live = sidecar.startRun({ mode: 'record', command: { argv: ['c'], cwd: '.' } });
    const ended = sidecar.startRun({ mode: 'record', command: { argv: ['d'], cwd: '.' } });
    const url = sidecar.envFor(ended.runId).ANTHROPIC_BASE_URL;
    sidecar.endRun(ended.runId, 'completed');
    const res = await fetch(`${url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: 'late' }] }) });
    expect(res.status).toBe(409);
    expect(sidecar.endRun(live.runId, 'completed').summary.total).toBe(0);
  });
});
