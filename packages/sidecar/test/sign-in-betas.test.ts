import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { PLACEHOLDER_KEY, Sidecar } from '../src/index.js';

/**
 * A golden recorded signed in with an Anthropic profile carries the beta its sign-in adds
 * (`anthropic-beta: oauth-2025-04-20`), which a key in CI never sends. That beta says how the call
 * signed in, not what it asks: matching leaves it out, so the golden replays with a key or a
 * placeholder, while every other beta still counts, and the recording keeps the header as sent.
 */
let mock: MockServer;
beforeAll(async () => {
  mock = await startMockAnthropic({ script: ({ request: r }) => ({ message: message([text(`echo: ${JSON.stringify(r.messages.at(-1)?.content)}`)]) }) });
});
afterAll(() => mock.close());

const command = { argv: ['agent'], cwd: '/' };
const ask = (client: Anthropic, prompt: string) => client.messages.create({ model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: prompt }] });
/** Signed in with a profile, as the SDKs send it: a bearer token and the sign-in beta, beside `others`. */
const signedIn = (baseURL: string, others: string[] = []) => new Anthropic({ apiKey: null, authToken: 'oauth-token-of-the-developer', baseURL, maxRetries: 0, defaultHeaders: { 'anthropic-beta': [...others, 'oauth-2025-04-20'].join(',') } });
const keyed = (baseURL: string, key: string, betas: string[] = []) => new Anthropic({ apiKey: key, authToken: null, baseURL, maxRetries: 0, ...(betas.length ? { defaultHeaders: { 'anthropic-beta': betas.join(',') } } : {}) });

async function recordWith(store: Store, client: (base: string) => Anthropic, clock: 'auto' | 'exact' = 'auto'): Promise<string> {
  const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url }, clock });
  const run = sidecar.startRun({ mode: 'record', command });
  await ask(client(sidecar.envFor(run.runId).ANTHROPIC_BASE_URL), 'hello');
  sidecar.endRun(run.runId, 'completed');
  await sidecar.close();
  return run.runId;
}

async function replayWith(store: Store, parentRunId: string, client: (base: string) => Anthropic, prompt = 'hello', clock: 'auto' | 'exact' = 'auto') {
  const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url }, clock });
  const run = sidecar.startRun({ mode: 'replay', parentRunId, command, replay: { writes: 'block', reads: 'live', liveTools: new Set() }, offline: true });
  let error: unknown;
  try {
    await ask(client(sidecar.envFor(run.runId).ANTHROPIC_BASE_URL), prompt);
  } catch (err) {
    error = err;
  }
  const { summary } = sidecar.endRun(run.runId, 'completed');
  await sidecar.close();
  return { summary, error };
}

describe("a recording made signed in with a profile", () => {
  it('replays clean with a key or a placeholder, which send no sign-in beta, and keeps the header as it was sent', async () => {
    const store = Store.open(':memory:');
    // Under the exact clock a replay takes the fingerprints the recording stored; under auto it computes them again.
    const parent = await recordWith(store, (base) => signedIn(base), 'exact');
    expect(store.getCalls(parent)[0].meta.fingerprintHeaders).toMatchObject({ 'anthropic-beta': 'oauth-2025-04-20' });
    const before = mock.requests.length;
    for (const clock of ['exact', 'auto'] as const) {
      for (const key of ['sk-ant-of-ci', PLACEHOLDER_KEY]) {
        const r = await replayWith(store, parent, (base) => keyed(base, key), 'hello', clock);
        expect(r.error, `${key} ${clock}`).toBeUndefined();
        expect(r.summary.divergence, `${key} ${clock}`).toBeNull();
      }
    }
    // And signed in again, as on the developer's machine.
    expect((await replayWith(store, parent, (base) => signedIn(base))).summary.divergence).toBeNull();
    expect(mock.requests.length).toBe(before);
    store.close();
  });

  it('still forks on any other beta, and never names the sign-in beta as a change', async () => {
    const store = Store.open(':memory:');
    const parent = await recordWith(store, (base) => signedIn(base, ['files-api-2025-04-14']));
    expect((await replayWith(store, parent, (base) => keyed(base, PLACEHOLDER_KEY, ['files-api-2025-04-14']))).summary.divergence).toBeNull();
    const other = await replayWith(store, parent, (base) => keyed(base, PLACEHOLDER_KEY, ['context-1m-2025-08-07']));
    expect(other.summary.divergence).toMatchObject({ type: 'request_changed', callNo: 1 });
    expect(JSON.stringify(other.summary.divergence?.diff)).toContain('context-1m-2025-08-07');
    // A change to the prompt: the report shows that, and no beta.
    const prompt = await replayWith(store, parent, (base) => keyed(base, PLACEHOLDER_KEY, ['files-api-2025-04-14']), 'goodbye');
    expect(prompt.summary.divergence).toMatchObject({ type: 'request_changed', callNo: 1 });
    expect(JSON.stringify(prompt.summary.divergence?.diff)).not.toContain('anthropic-beta');
    store.close();
  });
});
