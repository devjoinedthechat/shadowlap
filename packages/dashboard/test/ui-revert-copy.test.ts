import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordEvent, Store } from '@shadowlap/engine';
import { copyNextStep, nextStepOf, type NextStepWork } from '../src/next-step.js';
import { createExportedClient } from '../ui/api.js';
import { addRun } from './read-model-store.js';

/**
 * What keeps Revert's dialog and the first bad commit's change box undrawn in an exported copy, whose
 * script holds neither (ui/served-parts.ts): a copy's run has no revert step to lead with, and no
 * offers, so no first bad commit to show or change to open.
 */

const T0 = 1_790_000_000_000;
const MIN = 60_000;
const GOLDEN = 'goldens/refund-in-limit';

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => store.close());

const work: NextStepWork = { goldens: [{ path: GOLDEN, runId: null, packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks: [] }], tests: undefined, normalize: undefined, dir: '/work/project' };

/** A test replay of the golden that crashed, and the commit Find breaking commit named for it. */
function crashed(parent: string): string {
  const at = T0 + 2 * MIN;
  const session = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: at, revision: 'bbbbbbb' }).sessionId;
  const run = addRun(store, { parent, startedAt: at, status: 'failed', calls: 'rl', meta: { test: { golden: GOLDEN, session } } });
  store.addTestResult({ sessionId: session, golden: GOLDEN, ok: false, failure: 'exit', reason: 'the agent exited with code 1', runId: run, goldenRunId: parent, revision: 'bbbbbbb', at });
  recordEvent(store, { kind: 'bisect.found', ref: GOLDEN, at: at + 30_000, data: { commit: 'ccccccc', first: { rev: 'ccccccc', subject: 'Log the total', author: 'Ravi', date: '2026-09-30T10:00:00Z' }, why: 'the agent exited with code 1', untested: [], replays: 3, tokens: 0, answered: { at, ok: false } } });
  return run;
}

describe('an exported copy of a crash whose first bad commit is named', () => {
  it('leads with no Revert, though the dashboard would', () => {
    const rec = addRun(store, { startedAt: T0, calls: 'lll' });
    const crash = crashed(rec);
    work.goldens[0].runId = rec;
    expect(nextStepOf(store, crash, work)).toMatchObject({ key: 'revert' });
    expect(copyNextStep(store, crash, [rec, crash])?.key ?? null).not.toBe('revert');
  });

  it('offers nothing, so it shows no first bad commit and no change', async () => {
    const client = createExportedClient({ responses: {}, runIds: [] } as never);
    await expect(client.offers('01M5JEQWA2QMJ3NYD1C687WP08')).resolves.toBeNull();
  });
});
