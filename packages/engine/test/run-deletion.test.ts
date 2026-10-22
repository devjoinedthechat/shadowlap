import { describe, expect, it } from 'vitest';
import { attemptBundles, deletionPlan, filedTestAttempt, Store, withAttempts, type RunMeta } from '../src/index.js';

/**
 * Which runs are attempts bundled under another, by one rule for every list and every delete, and
 * what deleting a run takes with it: `shadowlap rm`, the terminal UI's `x` and the dashboard's Delete
 * all delete a run with the attempts bundled under it, so none is left behind as a run of its own.
 */

const cmd = { argv: ['node', 'agent.js'], cwd: '/tmp' };
let clock = Date.parse('2026-10-01T09:00:00Z');

function run(store: Store, o: { parent?: string; meta?: RunMeta; running?: boolean } = {}): string {
  const r = store.createRun({ mode: o.parent ? 'replay' : 'record', parentRunId: o.parent ?? null, command: cmd, startedAt: (clock += 1000), ...(o.meta ? { meta: o.meta } : {}) });
  if (!o.running) store.endRun(r.runId, 'completed', clock + 500);
  return r.runId;
}

const probe = (of: string, n: number): RunMeta => ({ probe: { of, callNo: 3, passed: n % 2 === 0 }, repeat: { group: `p-${of}`, attempt: n, of: 4 } });

/** A failed recording blamed (two probes, the rescued fork, a repeat of a probe), verified and given an error-path preset, and a golden replayed three times in one session. */
function story(store: Store) {
  const rec = run(store);
  const probeA = run(store, { parent: rec, meta: probe(rec, 1) });
  const probeB = run(store, { parent: rec, meta: probe(rec, 2) });
  const rescued = run(store, { parent: rec, meta: probe(rec, 4) });
  store.updateRunMeta(rec, { blame: { at: clock, outcome: 'blamed', callNo: 3, confidence: 'high', rescuedRunId: rescued, fields: {}, oracle: ['the agent exits 0'], probes: [], spent: 0 } });
  // A --repeat of one of the probes: an attempt of an attempt.
  const again = run(store, { parent: probeA, meta: { repeat: { group: 'again', attempt: 1, of: 1 } } });
  const verify = run(store, { parent: rec, meta: { verify: { role: 'target', passed: true } } });
  const chaos = run(store, { parent: rec, meta: { chaos: { preset: 'tool-timeout', callNo: 2, session: 's1', attempt: 1 } } });
  // A fork of the recording, made on purpose: no attempt.
  const fork = run(store, { parent: rec });
  const golden = run(store);
  const test = (attempt: number, of?: string, name = 'goldens/refund'): RunMeta => ({ test: { golden: name, session: 's1', attempt, ...(of ? { of } : {}) } });
  const shown = run(store, { parent: golden, meta: test(3) });
  const t1 = run(store, { parent: golden, meta: test(1, shown) });
  const t2 = run(store, { parent: golden, meta: test(2, shown) });
  // One that names the test run but is of another golden (a pack can carry anything): a run of its own.
  const odd = run(store, { parent: golden, meta: test(2, shown, 'goldens/other') });
  return { rec, probeA, probeB, rescued, again, verify, chaos, fork, golden, shown, t1, t2, odd };
}

describe('attempt bundles', () => {
  it("files each attempt under the run it came from, an attempt's attempts under it, and leaves the rescued fork and a misfiled test run out", () => {
    const store = Store.open(':memory:');
    const s = story(store);
    const bundles = attemptBundles(store.allRuns());
    expect(new Set(bundles.get(s.rec))).toEqual(new Set([s.probeA, s.probeB, s.verify, s.chaos]));
    expect(bundles.get(s.probeA)).toEqual([s.again]);
    expect(new Set(bundles.get(s.shown))).toEqual(new Set([s.t1, s.t2]));
    const filed = new Set([...bundles.values()].flat());
    for (const id of [s.rescued, s.fork, s.odd, s.golden, s.shown, s.rec]) expect(filed.has(id), id).toBe(false);
    // What goes with the recording: its attempts and theirs, never the run itself.
    expect(new Set(withAttempts(bundles, s.rec))).toEqual(new Set([s.probeA, s.probeB, s.verify, s.chaos, s.again]));
    expect(withAttempts(bundles, s.fork)).toEqual([]);
    store.close();
  });

  it('files a test run only under a test run of the same golden, session and recording that is no attempt itself', () => {
    const head = { parentRunId: 'G', meta: { test: { golden: 'g', session: 's' } } };
    const attempt = { parentRunId: 'G', meta: { test: { golden: 'g', session: 's', of: 'H' } } };
    expect(filedTestAttempt(attempt, head)).toBe(true);
    expect(filedTestAttempt(attempt, { ...head, parentRunId: 'OTHER' })).toBe(false);
    expect(filedTestAttempt(attempt, { ...head, meta: { test: { golden: 'g', session: 's2' } } })).toBe(false);
    expect(filedTestAttempt(attempt, { ...head, meta: { test: { golden: 'g', session: 's', of: 'X' } } })).toBe(false);
    expect(filedTestAttempt(attempt, { parentRunId: 'G', meta: {} })).toBe(false);
  });
});

describe('what deleting a run takes with it', () => {
  it('takes the attempts bundled under it, at any depth, and leaves its forks and other runs', () => {
    const store = Store.open(':memory:');
    const s = story(store);
    const plan = deletionPlan(store, [s.rec, s.shown]);
    expect(plan.runs).toEqual([s.rec, s.shown]);
    expect(new Set(plan.attempts)).toEqual(new Set([s.probeA, s.probeB, s.verify, s.chaos, s.again, s.t1, s.t2]));
    expect(plan.held).toEqual([]);
    // With --forks, the runs made from it go too: the rescued fork and the fork made on purpose
    // are runs; the attempts are still attempts, however they were reached.
    const forks = deletionPlan(store, [s.rec], { forks: true });
    expect(new Set(forks.runs)).toEqual(new Set([s.rec, s.rescued, s.fork]));
    expect(new Set(forks.attempts)).toEqual(new Set([s.probeA, s.probeB, s.verify, s.chaos, s.again]));
    // An attempt asked for alone is a run like any other, with its own attempts.
    expect(deletionPlan(store, [s.probeA])).toEqual({ runs: [s.probeA], attempts: [s.again], held: [] });
    store.close();
  });

  it('leaves a run alone while it records, while a replay reads from it, or while an attempt of it still runs', () => {
    const store = Store.open(':memory:');
    const live = run(store, { running: true });
    const rec = run(store);
    // Blame is probing it right now: one probe still running.
    run(store, { parent: rec, meta: probe(rec, 1), running: true });
    const other = run(store);
    const probe2 = run(store, { parent: other, meta: probe(other, 1) });
    // A replay of one of its attempts is running: the attempt serves its answers.
    run(store, { parent: probe2, running: true });
    const done = run(store);
    expect(deletionPlan(store, [live, rec, other, done])).toEqual({
      runs: [done],
      attempts: [],
      held: [
        { runId: live, why: 'still recording' },
        { runId: rec, why: 'an attempt of it is still running' },
        { runId: other, why: 'a replay of it is still running' },
      ],
    });
    // A caller that asked which runs are in progress already (gc, as of its own now) passes them.
    expect(deletionPlan(store, [live, rec, other, done], { live: [] }).held).toEqual([]);
    expect(deletionPlan(store, [rec, done], { live: store.recordingRuns().live.map((r) => r.run) }).held).toEqual([{ runId: rec, why: 'an attempt of it is still running' }]);
    store.close();
  });
});
