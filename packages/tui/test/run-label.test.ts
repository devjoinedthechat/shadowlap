import { describe, expect, it } from 'vitest';
import { runLabel, type LabelledRun } from '@shadowlap/tui/data';

/** The terminal UI names a run's kind as the dashboard does: the engine's classification decides. */

const run = (over: Partial<LabelledRun>): LabelledRun => ({ mode: 'record', status: 'completed', divergence: null, ...over });

describe('runLabel', () => {
  it('names recordings, captures, forks and replays', () => {
    expect(runLabel(run({}), 4)).toBe('recording');
    expect(runLabel(run({ meta: { imported: { at: 1, from: 'goldens/refund' } } }), 4)).toBe('recording');
    expect(runLabel(run({ meta: { imported: { at: 1, from: 'cap.har' }, covers: ['api'] } }), 4)).toBe('capture');
    expect(runLabel(run({ mode: 'replay', divergence: { callNo: 17 } }), 20)).toBe('fork @17');
    expect(runLabel(run({ mode: 'replay' }), 4)).toBe('clean replay');
    expect(runLabel(run({ mode: 'replay' }), 0)).toBe('replay');
    expect(runLabel(run({ mode: 'replay', status: 'running' }), 2)).toBe('replay');
    // Without its recording at hand, a replay that exited with an error is not called clean.
    expect(runLabel(run({ mode: 'replay', status: 'failed' }), 4)).toBe('replay');
  });

  it('names a run shadowlap test made a test', () => {
    expect(runLabel(run({ mode: 'replay', divergence: { callNo: 1 }, meta: { test: { golden: 'goldens/refund', session: 's1' } } }), 1)).toBe('test');
  });
});
