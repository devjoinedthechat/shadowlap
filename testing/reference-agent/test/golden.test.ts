import Anthropic from '@anthropic-ai/sdk';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Store, unpackRun } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { EXPECTED_TOTAL_CALLS, runAgent } from '../src/index.js';

/**
 * The committed golden recording must replay clean with the network unreachable. Any live call
 * would hit a closed port and fail loudly, so a pass proves zero upstream requests.
 * Regenerate with `npm run golden` when the scenario changes on purpose.
 */
const GOLDEN = fileURLToPath(new URL('../../golden/reference-agent/', import.meta.url));

describe('golden recording', () => {
  it.skipIf(!existsSync(GOLDEN))('replays clean with no network', async () => {
    const store = Store.open(':memory:');
    const { imported } = unpackRun(store, GOLDEN);
    expect(imported).toHaveLength(1);
    const parent = imported[0]!;

    // Port 9 (discard) is closed on every CI runner; a connection there is an immediate failure.
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: 'http://127.0.0.1:9' } });
    const run = sidecar.startRun({ mode: 'replay', parentRunId: parent, command: { argv: ['test'], cwd: '.' } });
    process.env.SHADOWLAP_URL = sidecar.url;
    process.env.SHADOWLAP_RUN_ID = run.runId;
    try {
      const client = new Anthropic({ apiKey: 'no-key', baseURL: `${sidecar.url}/anthropic`, maxRetries: 0 });
      const result = await runAgent({ client });
      const { summary } = sidecar.endRun(run.runId, 'completed');
      expect(summary.divergence).toBeNull();
      expect(summary.byOrigin.replayed).toBe(EXPECTED_TOTAL_CALLS);
      expect(summary.upstreamRequests).toBe(0);
      expect(summary.notReached).toEqual([]);
      expect(result.finalText).toContain('Done.');
    } finally {
      delete process.env.SHADOWLAP_URL;
      delete process.env.SHADOWLAP_RUN_ID;
      await sidecar.close();
      store.close();
    }
  });
});
