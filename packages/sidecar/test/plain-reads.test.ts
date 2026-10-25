import { afterEach, describe, expect, it } from 'vitest';
import { canonicalize, sha256, Store, type ClockMode } from '@shadowlap/engine';
import { now, random, uuid } from '@shadowlap/sdk';
import { Sidecar } from '../src/index.js';

/**
 * Clock and random reads are matched by their names as well as their kind and label. The SDKs label
 * none by default, so `random()` and `uuid()` share a kind and an empty label: an agent that now asks
 * for a random number before its uuid must get a number, live, and still get the recording's uuid.
 */

const command = { argv: ['agent'], cwd: '/' };
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

/** A sidecar whose run the SDK's reads go to, as an agent's would. */
async function started(clock?: ClockMode) {
  const store = Store.open(':memory:');
  const sidecar = await Sidecar.start({ store, ...(clock ? { clock } : {}) });
  Object.assign(process.env, sidecar.envFor());
  const as = (runId: string) => {
    process.env.SHADOWLAP_RUN_ID = runId;
  };
  return { store, sidecar, as };
}

describe('clock and random reads', () => {
  it("serves an unlabelled random() the agent now makes first live, and its uuid() from the recording", async () => {
    const { store, sidecar, as } = await started();
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      as(rec.runId);
      const recorded = await uuid();
      sidecar.endRun(rec.runId, 'completed');

      const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command });
      as(rep.runId);
      const inserted = await random();
      const id = await uuid();
      const { summary } = sidecar.endRun(rep.runId, 'completed');
      // A number for random(), not the recorded uuid; the recorded uuid for uuid().
      expect(typeof inserted).toBe('number');
      expect(id).toBe(recorded);
      expect(summary.divergence).toBeNull();
      const [first, second] = store.getCalls(rep.runId);
      expect(first).toMatchObject({ name: 'random', origin: 'live', meta: { extraRead: true } });
      expect(second).toMatchObject({ name: 'uuid', origin: 'replayed' });
      expect(second.end!.meta.replayedFrom).toBe(1);
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('serves repeated reads in the order each name recorded them, however the names interleave now', async () => {
    const { store, sidecar, as } = await started();
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      as(rec.runId);
      const r1 = await random();
      const u1 = await uuid();
      const t1 = await now();
      const r2 = await random();
      const u2 = await uuid();
      const t2 = await now();
      sidecar.endRun(rec.runId, 'completed');

      const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command });
      as(rep.runId);
      const got = { uuids: [await uuid(), await uuid()], randoms: [await random(), await random()], times: [await now(), await now()] };
      const { summary } = sidecar.endRun(rep.runId, 'completed');
      expect(got).toEqual({ uuids: [u1, u2], randoms: [r1, r2], times: [t1, t2] });
      expect(summary.byOrigin).toMatchObject({ replayed: 6, live: 0 });
      expect(summary.divergence).toBeNull();
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  for (const clock of ['auto', 'exact'] as const) {
    it(`replays a recording made before reads were named, each read getting its own (clock ${clock})`, async () => {
      const { store, sidecar, as } = await started(clock);
      try {
        // As a recording made then holds them: fingerprinted by kind and label alone, so uuid() and
        // random() shared one, and counted as its first and second occurrence.
        const before = (kind: 'clock' | 'random', label: string) => sha256(canonicalize({ kind, label }));
        const parent = store.createRun({ mode: 'record', command, meta: { normalizersHash: sha256(canonicalize({ v: 7, normalizers: [] })) } });
        const reads = [
          { kind: 'random' as const, name: 'uuid', occurrence: 1, result: '8d1c7e8e-1f7b-4a5e-9a3e-3f1c0b7a9d21' },
          { kind: 'random' as const, name: 'random', occurrence: 2, result: 0.25 },
          { kind: 'clock' as const, name: 'now', occurrence: 1, result: 1_780_000_000_000 },
        ];
        reads.forEach((r, i) => {
          const identity = { kind: r.kind, name: r.name, fingerprint: before(r.kind, ''), occurrence: r.occurrence };
          store.appendCallStart({ runId: parent.runId, callNo: i + 1, ...identity, origin: 'live', effect: null, requestRef: store.putJson({ label: '' }), meta: {}, at: i });
          store.appendCallEnd(identity, { runId: parent.runId, callNo: i + 1, attempt: 0, responseRef: store.putJson({ result: r.result }), outcome: 'ok', meta: {}, at: i });
        });
        store.endRun(parent.runId, 'completed');

        const rep = sidecar.startRun({ mode: 'replay', parentRunId: parent.runId, command });
        as(rep.runId);
        const got = [await random(), await uuid(), await now()];
        const { summary } = sidecar.endRun(rep.runId, 'completed');
        expect(got).toEqual([0.25, '8d1c7e8e-1f7b-4a5e-9a3e-3f1c0b7a9d21', 1_780_000_000_000]);
        expect(summary.byOrigin).toMatchObject({ replayed: 3, live: 0 });
        expect(summary.divergence).toBeNull();
      } finally {
        await sidecar.close();
        store.close();
      }
    });
  }
});
