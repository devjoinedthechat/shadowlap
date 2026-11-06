import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { listRuns } from '../src/api.js';
import { nextStepRows, replayStepOf, stepRow, type NextStepWork } from '../src/next-step.js';
import { judgedRows } from '../src/run-outcome.js';
import { addRun } from './read-model-store.js';

/**
 * A list's rows carry each run's Replay beside its next step, for ⌘K on the row, as the run's page
 * keeps it beside its lime button: on a clean or a test replay, the recording it came from.
 */

const T0 = 1_790_000_000_000;
const MIN = 60_000;
const work: NextStepWork = { goldens: [], tests: undefined, normalize: undefined, dir: '/work/project' };

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => store.close());

describe('a list’s rows', () => {
  it('carry each run’s Replay where its step is another, a replay’s on the recording it came from, and none where Replay leads', () => {
    const rec = addRun(store, { startedAt: T0, status: 'failed', calls: 'lll' });
    const replayed = addRun(store, { parent: rec, startedAt: T0 + MIN, calls: 'rrr' });
    addRun(store, { startedAt: T0 + 2 * MIN, calls: 'lll' });
    const rows = nextStepRows(store, judgedRows(store, listRuns(store), null, Infinity), work);
    const by = new Map(rows.map((r) => [r.runId, r]));
    expect(by.get(rec)?.next?.key).toBe('blame');
    expect(by.get(rec)?.replay).toEqual({ key: 'replay', label: 'Replay', runId: rec, command: `shadowlap replay ${rec.slice(0, 10)}` });
    for (const row of rows) {
      if (row.next?.key === 'replay') expect(row).not.toHaveProperty('replay');
      else expect(row.replay).toEqual(stepRow(replayStepOf(store, row.runId)!));
    }
    const ofReplay = by.get(replayed);
    expect(ofReplay?.next?.key === 'replay' ? ofReplay.next : ofReplay?.replay).toMatchObject({ label: 'Replay recording', runId: rec });
  });
});
