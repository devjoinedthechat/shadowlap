#!/usr/bin/env node
import { startMockAnthropic, withJudge } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from './scenario.js';

/**
 * Serves the reference scenario as a standalone fake API, for running the CLI by hand:
 *
 *   node testing/reference-agent/dist/mock-server.js &          # prints the URL
 *   SHADOWLAP_UPSTREAM_ANTHROPIC=<url> shadowlap run -- node testing/reference-agent/dist/main.js
 *
 * MOCK_EVENT_DELAY_MS paces the streamed events, for recordings whose playback should be watchable.
 * It answers judge checks too: yes, or no with MOCK_JUDGE=no.
 */
const delay = Number(process.env.MOCK_EVENT_DELAY_MS);
const verdict = process.env.MOCK_JUDGE === 'no' ? 'no' : 'yes';
const script = withJudge(() => ({ verdict, reason: `the mock judge answers ${verdict}${verdict === 'yes' ? ' unless MOCK_JUDGE=no' : ''}` }), referenceScript);
const server = await startMockAnthropic({ script, ...(delay > 0 ? { eventDelayMs: () => delay } : {}) });
process.stdout.write(`${server.url}\n`);
process.stderr.write(`[mock-anthropic] serving the reference scenario at ${server.url} (Ctrl-C to stop)\n`);
await new Promise<void>((resolve) => {
  process.once('SIGINT', () => resolve());
  process.once('SIGTERM', () => resolve());
});
await server.close();
