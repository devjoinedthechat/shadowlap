import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareRuns, Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { Sidecar } from '../src/index.js';

/**
 * A trace never keeps the API version its client named (`anthropic-version`), so a call imported from
 * one names none. A replay matches such a recording whatever version the agent's SDK names (one
 * release of the SDKs names 2023-06-01, a later one 2026-10-21), and names none either: it holds the
 * same calls as the recording, as Compare reads them, and replays the same way. A recording that
 * names a version still forks when the agent names another.
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

/** A recording of one call made with the SDK, or with no API version, as a call imported from a trace names none. */
async function record(store: Store, clock: 'auto' | 'exact', withVersion = false): Promise<string> {
  const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url }, clock });
  const run = sidecar.startRun({ mode: 'record', command });
  const base = sidecar.envFor(run.runId).ANTHROPIC_BASE_URL!;
  if (withVersion) await sdk(base).messages.create(REQUEST);
  else await (await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-test' }, body: JSON.stringify(REQUEST) })).arrayBuffer();
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
  it('replays clean whatever version the SDK names, under either clock, and so do the replays it makes', async () => {
    const store = Store.open(':memory:');
    const before = mock.requests.length;
    for (const clock of ['exact', 'auto'] as const) {
      const parent = await record(store, clock);
      expect(store.getCalls(parent)[0]!.meta.fingerprintHeaders).toEqual({});
      for (const version of [undefined, '2026-10-21']) {
        const r = await replayWith(store, parent, clock, version);
        expect(r.error, `${clock} ${version}`).toBeUndefined();
        expect(r.summary.divergence, `${clock} ${version}`).toBeNull();
        // The replay names no version either: it is the recording's call, as the recording holds it.
        const [call] = store.getCalls(r.runId);
        expect(call!.meta.fingerprintHeaders, `${clock} ${version}`).toEqual({});
        expect(call!.fingerprint, `${clock} ${version}`).toBe(store.getCalls(parent)[0]!.fingerprint);
        // And a replay of it matches whatever version too: a golden packed from it replays on either release.
        for (const next of [undefined, '2026-10-21']) expect((await replayWith(store, r.runId, clock, next)).summary.divergence, `${clock} ${version} then ${next}`).toBeNull();
      }
    }
    // The recordings answered every call: one each, made while recording.
    expect(mock.requests.length).toBe(before + 2);
    store.close();
  });

  it('compares with its replay call for call, as the same calls', async () => {
    const store = Store.open(':memory:');
    const parent = await record(store, 'auto');
    const replay = await replayWith(store, parent, 'auto', '2026-10-21');
    const compared = compareRuns(store, store.getRun(parent)!, store.getCalls(parent), store.getRun(replay.runId)!, store.getCalls(replay.runId));
    expect(compared.firstRequestDifference).toBeNull();
    expect(compared.identicalPrefix).toBe(1);
    store.close();
  });

  it('names only what changed when a request differs, never the version', async () => {
    const store = Store.open(':memory:');
    const parent = await record(store, 'auto');
    const r = await replayWith(store, parent, 'auto', '2026-10-21', 'goodbye');
    expect(r.summary.divergence).toMatchObject({ type: 'request_changed', callNo: 1 });
    expect(r.summary.divergence!.diff!.map((e) => e.path)).toEqual(['$.messages[0].content']);
    store.close();
  });
});

describe('a recording that names an API version', () => {
  it('forks when the SDK names another, naming the header that changed', async () => {
    const store = Store.open(':memory:');
    for (const clock of ['exact', 'auto'] as const) {
      const parent = await record(store, clock, true);
      expect(store.getCalls(parent)[0]!.meta.fingerprintHeaders).toEqual({ 'anthropic-version': '2023-06-01' });
      expect((await replayWith(store, parent, clock)).summary.divergence, clock).toBeNull();
      const later = await replayWith(store, parent, clock, '2026-10-21');
      expect(later.summary.divergence, clock).toMatchObject({ type: 'request_changed', callNo: 1 });
      expect(later.summary.divergence!.diff, clock).toEqual([{ path: 'headers.anthropic-version', op: 'changed', before: '2023-06-01', after: '2026-10-21' }]);
    }
    store.close();
  });
});
