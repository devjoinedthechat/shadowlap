/**
 * Recordings for test suites. Wrap a test, and it records its agent's model and tool calls the first
 * time it runs, then replays them offline: no tokens, no network, the same answers every time. A
 * test whose code now sends a different request fails with the diff.
 *
 *   import { recorded } from '@shadowlap/test';
 *
 *   test('triages the inbox', recorded(async () => {
 *     const result = await runAgent('triage the inbox');
 *     expect(result.tickets).toHaveLength(3);
 *     expect(await currentRecording().called('send_email')).toBe(0);
 *   }));
 *
 * Recordings live next to the test file, in `__recordings__/<file>/<test name>`, one per test; commit them.
 * SHADOWLAP_RECORD picks the mode: `missing` (default) replays a recording when there is one and
 * records otherwise, `all` records again, `none` only replays and is the default when CI is set.
 */
export * from './recording.js';
export { pointAtSlot, startHost, useHost, workerSlot, type HostInfo, type RunningHost } from './host.js';
