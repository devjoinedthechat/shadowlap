import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { Sidecar } from '../src/index.js';

/**
 * Slots, for test workers: a worker creates its model client once, from `envForSlot`, and each test's
 * run takes the slot over in turn. Two workers run at once on two slots.
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

const clientFor = (slot: string) => new Anthropic({ apiKey: 'k', baseURL: sidecar.envForSlot(slot).ANTHROPIC_BASE_URL, maxRetries: 0 });
const ask = (client: Anthropic, content: string) => client.messages.create({ model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content }] });

describe('slots', () => {
  it('sends a long-lived client to whichever run holds its slot, per slot', async () => {
    const [w1, w2] = [clientFor('worker-1'), clientFor('worker-2')];
    const first = sidecar.startRun({ mode: 'record', command: { argv: ['t1'], cwd: '.' }, slot: 'worker-1' });
    const other = sidecar.startRun({ mode: 'record', command: { argv: ['t2'], cwd: '.' }, slot: 'worker-2' });
    await Promise.all([ask(w1, 'a'), ask(w2, 'b'), ask(w1, 'c')]);
    expect(sidecar.endRun(first.runId, 'completed').summary.byKind.api).toBe(2);
    const second = sidecar.startRun({ mode: 'record', command: { argv: ['t3'], cwd: '.' }, slot: 'worker-1' });
    await ask(w1, 'd');
    expect(sidecar.endRun(second.runId, 'completed').summary.byKind.api).toBe(1);
    expect(sidecar.endRun(other.runId, 'completed').summary.byKind.api).toBe(1);
  });

  it('refuses a call on a slot no run holds', async () => {
    await expect(ask(clientFor('worker-9'), 'late')).rejects.toMatchObject({ status: 409 });
    expect(() => sidecar.envForSlot('../x')).toThrow(/a slot is/);
  });

  it('keeps an offline run off the network: a call the recording lacks fails', async () => {
    const recorded = sidecar.startRun({ mode: 'record', command: { argv: ['r'], cwd: '.' }, slot: 'w' });
    await ask(clientFor('w'), 'known');
    sidecar.endRun(recorded.runId, 'completed');
    const hits = mock.requests.length;
    const replay = sidecar.startRun({ mode: 'replay', parentRunId: recorded.runId, command: { argv: ['r'], cwd: '.' }, slot: 'w', offline: true });
    expect((await ask(clientFor('w'), 'known')).content[0]).toMatchObject({ text: 'turn 0' });
    await expect(ask(clientFor('w'), 'unknown')).rejects.toMatchObject({ status: 503 });
    expect(mock.requests.length).toBe(hits);
    expect(sidecar.endRun(replay.runId, 'completed').summary.divergence).toMatchObject({ callNo: 2 });
  });
});
