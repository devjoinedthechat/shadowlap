import Anthropic from '@anthropic-ai/sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { Sidecar } from '../src/index.js';

/**
 * A recording made on one day, replayed on another: "today" in the prompt differs, and must still
 * match. Only Date is faked, so the network keeps working.
 */
let mock: MockServer;
beforeAll(async () => {
  mock = await startMockAnthropic({ script: (ctx) => ({ message: message([text(`turn ${ctx.assistantTurns}`)]) }) });
});
afterAll(() => mock.close());
afterEach(() => vi.useRealTimers());

const day = (iso: string) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
};

async function run(sidecar: Sidecar, runId: string, system: string) {
  const client = new Anthropic({ apiKey: 'k', baseURL: sidecar.envFor(runId).ANTHROPIC_BASE_URL, maxRetries: 0 });
  await client.messages.create({ model: 'claude-opus-5', max_tokens: 16, system, messages: [{ role: 'user', content: `triage, requested at ${Date.now()}` }] }).catch(() => undefined);
  return sidecar.endRun(runId, 'completed').summary;
}

describe('dates near a run start match across days', () => {
  it('replays a recording from June in September, and still forks on a date that really changed', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
    day('2026-06-01T09:00:00Z');
    const recorded = sidecar.startRun({ mode: 'record', command: { argv: ['a'], cwd: '.' } });
    await run(sidecar, recorded.runId, 'Today is Monday, June 1, 2026 (2026-06-01). Report on sales since 2026-05-01.');

    day('2026-09-17T15:00:00Z');
    const hits = mock.requests.length;
    const same = sidecar.startRun({ mode: 'replay', parentRunId: recorded.runId, command: { argv: ['a'], cwd: '.' } });
    const clean = await run(sidecar, same.runId, 'Today is Thursday, September 17, 2026 (2026-09-17). Report on sales since 2026-05-01.');
    expect(clean.divergence).toBeNull();
    expect(mock.requests.length).toBe(hits);

    const changed = sidecar.startRun({ mode: 'replay', parentRunId: recorded.runId, command: { argv: ['a'], cwd: '.' } });
    const forked = await run(sidecar, changed.runId, 'Today is Thursday, September 17, 2026 (2026-09-17). Report on sales since 2026-08-01.');
    expect(forked.divergence).toMatchObject({ type: 'request_changed', callNo: 1 });
    // Only the change that matters is reported: the dates that are "today" in each run are not.
    expect(forked.divergence!.diff).toEqual([{ path: '$.system', op: 'changed', before: 'Today is <date> (<date>). Report on sales since 2026-05-01.', after: 'Today is <date> (<date>). Report on sales since 2026-08-01.' }]);
    await sidecar.close();
    store.close();
  });

  it('matches dates exactly with clock "exact", and re-fingerprints recordings made under the other mode', async () => {
    const store = Store.open(':memory:');
    const exact = await Sidecar.start({ store, upstreams: { anthropic: mock.url }, clock: 'exact' });
    day('2026-06-01T09:00:00Z');
    const recorded = exact.startRun({ mode: 'record', command: { argv: ['a'], cwd: '.' } });
    await run(exact, recorded.runId, 'Today is 2026-06-01.');
    day('2026-06-02T09:00:00Z');
    const replay = exact.startRun({ mode: 'replay', parentRunId: recorded.runId, command: { argv: ['a'], cwd: '.' } });
    const forked = await run(exact, replay.runId, 'Today is 2026-06-02.');
    expect(forked.divergence?.hints?.[0]?.normalizer).toMatchObject({ pattern: 'iso-date' });
    await exact.close();

    // The same recording, replayed by a sidecar in the default mode: its stored fingerprints were
    // computed exactly, so they are recomputed against the recording's own start.
    const auto = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
    const again = auto.startRun({ mode: 'replay', parentRunId: recorded.runId, command: { argv: ['a'], cwd: '.' } });
    expect((await run(auto, again.runId, 'Today is 2026-06-02.')).divergence).toBeNull();
    await auto.close();
    store.close();
  });
});
