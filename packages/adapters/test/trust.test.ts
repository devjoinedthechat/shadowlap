import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { withEffects } from '../src/ai-sdk.js';
import { withEffect as withOpenAIAgentsEffect } from '../src/openai-agents.js';

/**
 * A tool an adapter wraps can be marked untrusted where its effect is declared, as `tool()` takes
 * it: the mark reaches the recording, where shadowlap injection plants payloads in its reads.
 */

let store: Store;
let sidecar: Sidecar;

beforeAll(async () => {
  store = Store.open(':memory:');
  sidecar = await Sidecar.start({ store });
});
afterAll(async () => {
  delete process.env.SHADOWLAP_URL;
  delete process.env.SHADOWLAP_RUN_ID;
  await sidecar.close();
  store.close();
});

describe('trust through an adapter', () => {
  it('records a tool marked untrusted beside its effect, and leaves the others alone', async () => {
    const tools = withEffects(
      {
        fetch_page: { execute: async (input: unknown) => ({ url: (input as { url: string }).url, text: 'a page' }) },
        search_web: { execute: async () => ({ results: [] }) },
      },
      { fetch_page: { effect: 'read', trust: 'untrusted' }, search_web: 'read' },
    );
    const inbox = withOpenAIAgentsEffect({ name: 'read_inbox', execute: async () => ({ mail: ['hello'] }) }, { effect: 'read', trust: 'untrusted' });
    const run = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
    process.env.SHADOWLAP_URL = sidecar.url;
    process.env.SHADOWLAP_RUN_ID = run.runId;
    await tools.fetch_page.execute({ url: 'https://example.com/a' });
    await tools.search_web.execute();
    await inbox.execute();
    sidecar.endRun(run.runId, 'completed');
    expect(store.getCalls(run.runId).map((c) => [c.name, c.meta.trust ?? null])).toEqual([
      ['fetch_page', 'untrusted'],
      ['search_web', null],
      ['read_inbox', 'untrusted'],
    ]);
  });
});
