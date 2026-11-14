import { describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { kindFacts, loadRunTree, modelResolver, runLabel, type LabelledRun } from '@shadowlap/tui/data';

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

  it('calls a replay that reproduced its failing recording a clean replay, given the recording', () => {
    const store = Store.open(':memory:');
    try {
      const make = (parent: string | null, calls: number, status: 'completed' | 'failed') => {
        const r = store.createRun({ mode: parent ? 'replay' : 'record', ...(parent ? { parentRunId: parent } : {}), command: { argv: ['node', 'agent.js'], cwd: '/w' }, startedAt: 1 });
        for (let c = 1; c <= calls; c++) store.appendCallStart({ runId: r.runId, callNo: c, kind: 'tool', name: 't', fingerprint: `f${c}`, occurrence: 1, origin: parent ? 'replayed' : 'live', effect: 'read', requestRef: null, meta: {}, at: c });
        store.endRun(r.runId, status, 99);
        return store.getRun(r.runId)!;
      };
      const failing = make(null, 3, 'failed');
      const reproduced = make(failing.runId, 3, 'failed');
      const short = make(failing.runId, 1, 'failed');
      const passing = make(null, 3, 'completed');
      const broke = make(passing.runId, 3, 'failed');
      const label = (r: typeof failing) => runLabel(r, kindFacts(store, r, store.countCalls(r.runId)));
      expect(label(reproduced)).toBe('clean replay');
      expect(label(short)).toBe('replay');
      // The recording passed: this replay failed on its own, it reproduced nothing.
      expect(label(broke)).toBe('replay');
      // Only a replay that failed without leaving its recording needs the recording read.
      expect(kindFacts(store, failing, 3)).toEqual({ calls: 3 });
      expect(kindFacts(store, reproduced, 3)).toEqual({ calls: 3, parent: { calls: 3, status: 'failed' } });
      // The terminal UI's run list says the same.
      const tree = loadRunTree(store, { modelOf: modelResolver(store) });
      expect(tree.find((n) => n.run.runId === reproduced.runId)!.label).toBe('clean replay');
      expect(tree.find((n) => n.run.runId === failing.runId)!.label).toBe('recording');
    } finally {
      store.close();
    }
  });
});

describe('loadRunTree', () => {
  it('lists the recordings however many attempts blame and verify made after them', () => {
    const store = Store.open(':memory:');
    try {
      const make = (startedAt: number, parent: string | null = null, meta?: Record<string, unknown>) => {
        const r = store.createRun({ mode: parent ? 'replay' : 'record', ...(parent ? { parentRunId: parent } : {}), command: { argv: ['node', 'agent.js'], cwd: '/w' }, startedAt, ...(meta ? { meta } : {}) });
        store.endRun(r.runId, 'completed', startedAt + 1);
        return r.runId;
      };
      const older = make(1);
      const failing = make(2);
      // Verify's attempts, newer than both recordings, and more of them than the list takes runs.
      const attempts = Array.from({ length: 9 }, (_, i) => make(10 + i, failing, { verify: { role: 'target', attempt: i + 1 } }));
      // An attempt of a run older than every run listed goes with it.
      const stray = make(30, older, { verify: { role: 'good', attempt: 1 } });
      const tree = loadRunTree(store, { modelOf: modelResolver(store) }, 1);
      expect(tree.map((n) => n.run.runId)).toEqual([failing]);
      expect(tree[0].attempts).not.toBeNull();
      const both = loadRunTree(store, { modelOf: modelResolver(store) }, 2);
      expect(both.map((n) => n.run.runId)).toEqual([older, failing]);
      // With attempts listed, each is under its run.
      const all = loadRunTree(store, { modelOf: modelResolver(store), attempts: true }, 2);
      expect(all.filter((n) => n.depth === 1).map((n) => n.run.runId).sort()).toEqual([...attempts, stray].sort());
    } finally {
      store.close();
    }
  });
});
