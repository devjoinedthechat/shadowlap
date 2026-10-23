import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { Sidecar } from '../src/index.js';

/**
 * A trace never keeps the API version its client named (`anthropic-version`), so a call imported from
 * one names none. A replay matches such a recording whatever version the agent's SDK names: one
 * release of the SDKs names 2023-06-01, a later one 2026-10-21. The replay keeps the version its
 * requests named, and from then on is matched on it like any recording; a recording that names a
 * version still forks when the agent names another.
 */
let mock: MockServer;
beforeAll(async () => {
  mock = await startMockAnthropic({ script: () => ({ message: message([text('ok')]) }) });
});
afterAll(() => mock.close());

const command = { argv: ['agent'], cwd: '/' };
const REQUEST = { model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] };

/** The SDK, naming the API version its release names: 2023-06-01 for this one, or `version` as a later release does. */
const sdk = (baseURL: string, version?: string) => new Anthropic({ apiKey: 'sk-ant-test', baseURL, maxRetries: 0, ...(version ? { defaultHeaders: { 'anthropic-version': version } } : {}) });

/** A recording whose one call names no API version, as a call imported from a trace names none. */
async function recordWithoutVersion(store: Store, clock: 'auto' | 'exact'): Promise<string> {
  const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url }, clock });
  const run = sidecar.startRun({ mode: 'record', command });
  const res = await fetch(`${sidecar.envFor(run.runId).ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-test' }, body: JSON.stringify(REQUEST) });
  await res.arrayBuffer();
  sidecar.endRun(run.runId, 'completed');
  await sidecar.close();
  return run.runId;
}

async function replayWith(store: Store, parentRunId: string, clock: 'auto' | 'exact', version?: string, prompt = 'hello') {
  const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url }, clock });
  const run = sidecar.startRun({ mode: 'replay', parentRunId, command, replay: { writes: 'block', reads: 'live', liveTools: new Set() }, offline: true });
  let error: unknown;
  try {
    await sdk(sidecar.envFor(run.runId).ANTHROPIC_BASE_URL!, version).messages.create({ ...REQUEST, messages: [{ role: 'user', content: prompt }] });
  } catch (err) {
    error = err;
  }
  const { summary } = sidecar.endRun(run.runId, 'completed');
  await sidecar.close();
  return { runId: run.runId, summary, error };
}

describe('a recording that names no API version', () => {
  it('replays clean whatever version the SDK names, under either clock, and the replay keeps the version named', async () => {
    const store = Store.open(':memory:');
    const before = mock.requests.length;
    for (const clock of ['exact', 'auto'] as const) {
      const parent = await recordWithoutVersion(store, clock);
      expect(store.getCalls(parent)[0]!.meta.fingerprintHeaders).toEqual({});
      for (const version of [undefined, '2026-10-21']) {
        const r = await replayWith(store, parent, clock, version);
        expect(r.error, `${clock} ${version}`).toBeUndefined();
        expect(r.summary.divergence, `${clock} ${version}`).toBeNull();
        expect(store.getCalls(r.runId)[0]!.meta.fingerprintHeaders).toEqual({ 'anthropic-version': version ?? '2023-06-01' });
      }
    }
    // The recordings answered every call: one each, made while recording.
    expect(mock.requests.length).toBe(before + 2);
    store.close();
  });

  it('names only what changed when a request differs, never the version', async () => {
    const store = Store.open(':memory:');
    const parent = await recordWithoutVersion(store, 'auto');
    const r = await replayWith(store, parent, 'auto', '2026-10-21', 'goodbye');
    expect(r.summary.divergence).toMatchObject({ type: 'request_changed', callNo: 1 });
    expect(r.summary.divergence!.diff!.map((e) => e.path)).toEqual(['$.messages[0].content']);
    store.close();
  });

  it('makes a replay that is matched on the version it named, as a recording that names one is', async () => {
    const store = Store.open(':memory:');
    for (const clock of ['exact', 'auto'] as const) {
      const parent = await recordWithoutVersion(store, clock);
      const replay = await replayWith(store, parent, clock, '2026-10-21');
      expect(replay.summary.divergence).toBeNull();
      expect((await replayWith(store, replay.runId, clock, '2026-10-21')).summary.divergence, clock).toBeNull();
      const older = await replayWith(store, replay.runId, clock);
      expect(older.summary.divergence, clock).toMatchObject({ type: 'request_changed', callNo: 1 });
      expect(older.summary.divergence!.diff, clock).toEqual([{ path: 'headers.anthropic-version', op: 'changed', before: '2026-10-21', after: '2023-06-01' }]);
    }
    store.close();
  });
});
