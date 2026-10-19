#!/usr/bin/env node
import { obeyPlanted, startMockAnthropic } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from './scenario.js';

/**
 * Serves the reference scenario as a standalone fake API, for running the CLI by hand:
 *
 *   node testing/reference-agent/dist/mock-server.js &          # prints the URL
 *   SHADOWLAP_UPSTREAM_ANTHROPIC=<url> shadowlap run -- node testing/reference-agent/dist/main.js
 *
 * MOCK_EVENT_DELAY_MS paces the streamed events, for recordings whose playback should be watchable.
 * MOCK_PLANTED=obey makes it a model that obeys instructions planted in tool results (quote and
 * divert: one influenced by them), for trying shadowlap injection by hand.
 */
const delay = Number(process.env.MOCK_EVENT_DELAY_MS);
const planted = process.env.MOCK_PLANTED;
const script = planted === 'obey' || planted === 'quote' || planted === 'divert' ? obeyPlanted(referenceScript, { as: planted }) : referenceScript;
const server = await startMockAnthropic({ script, ...(delay > 0 ? { eventDelayMs: () => delay } : {}) });
process.stdout.write(`${server.url}\n`);
process.stderr.write(`[mock-anthropic] serving the reference scenario at ${server.url} (Ctrl-C to stop)\n`);
await new Promise<void>((resolve) => {
  process.once('SIGINT', () => resolve());
  process.once('SIGTERM', () => resolve());
});
await server.close();
