import { describe, expect, it, vi } from 'vitest';
import { notWaited, recordedDurations, Store } from '../src/index.js';
import { RunBuilder, text, toolUse, user } from './run-fixtures.js';

/** A recording of `n` model and tool calls with distinct durations, and replays of it. */
function family(store: Store, n = 30) {
  const rec = RunBuilder.start(store, { startedAt: 1_000 });
  const ms: number[] = [];
  for (let i = 1; i <= n; i++) {
    const latency = 100 * i;
    ms.push(latency);
    if (i % 2) rec.model({ messages: [user(`step ${i}`)] }, [toolUse('t', { i }, `toolu_${i}`)], { latencyMs: latency });
    else rec.tool('t', { i }, { ok: i }, { latencyMs: latency });
  }
  rec.end();
  /** A replay of `parent`: calls up to `forkAt` replayed from it, the rest live with their own durations. */
  const replay = (parent: string, forkAt = n + 1, startedAt = 2_000) => {
    const r = RunBuilder.start(store, { parent, startedAt });
    for (let i = 1; i <= n; i++) {
      const replayed = i < forkAt;
      const o = replayed ? { origin: 'replayed' as const, replayedFrom: i } : { latencyMs: 7 * i };
      if (i % 2) r.model({ messages: [user(`step ${i}`)] }, [text('x')], o);
      else r.tool('t', { i }, { ok: i }, o);
    }
    return r.end();
  };
  return { rec: rec.runId, ms, replay };
}

describe('time not waited', () => {
  it("is each replayed call's recorded duration, followed back through a replay of a replay", () => {
    const store = Store.open(':memory:');
    const f = family(store);
    const clean = f.replay(f.rec);
    const again = f.replay(clean);
    const run = store.getRun(again)!;
    const getCalls = vi.spyOn(store, 'getCalls');
    const d = recordedDurations(store, run);
    // The run's own calls, then one read per ancestor, not one per call.
    expect(getCalls.mock.calls.map((c) => c[0])).toEqual([again, clean, f.rec]);
    expect([...d.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)).toEqual(f.ms);
    store.close();
  });

  it('takes a fork’s live calls from the fork, and skips calls that were not replayed', () => {
    const store = Store.open(':memory:');
    const f = family(store, 10);
    const fork = f.replay(f.rec, 6);
    // A replay of the fork: calls 1–5 came from the recording, 6–10 were live in the fork.
    const replay = f.replay(fork);
    const d = recordedDurations(store, store.getRun(replay)!);
    expect([...d.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(d.get(3)).toBe(300);
    expect(d.get(8)).toBe(56);
    // The fork itself waited for its live calls: only the replayed ones are not waited.
    expect([...recordedDurations(store, store.getRun(fork)!).keys()]).toEqual([1, 2, 3, 4, 5]);
    store.close();
  });

  it('has nothing to follow when the recording is gone', () => {
    const store = Store.open(':memory:');
    const f = family(store, 4);
    const replay = f.replay(f.rec);
    store.deleteRun(f.rec);
    expect(recordedDurations(store, store.getRun(replay)!).size).toBe(0);
    store.close();
  });

  it('sums the replays among runs named or started in a window, reading shared ancestors once', () => {
    const store = Store.open(':memory:');
    const f = family(store, 6);
    const total = f.ms.reduce((s, v) => s + v, 0);
    const a = f.replay(f.rec, 7, 5_000);
    const b = f.replay(f.rec, 4, 6_000);
    const c = f.replay(a, 7, 9_000);
    const getCalls = vi.spyOn(store, 'getCalls');
    const all = notWaited(store, { since: 0 });
    expect(getCalls.mock.calls.filter((x) => x[0] === f.rec)).toHaveLength(1);
    expect(all.ms).toBe(total + (100 + 200 + 300) + total);
    expect(all.calls).toBe(6 + 3 + 6);
    expect(all.runs.map((r) => r.runId).sort()).toEqual([a, b, c].sort());
    expect(notWaited(store, [b]).ms).toBe(600);
    expect(notWaited(store, { since: 5_500, until: 9_000 }).runs.map((r) => r.runId)).toEqual([b]);
    expect(notWaited(store, 8_000).ms).toBe(total);
    store.close();
  });

  it('reads a finished replay once however often the Overview asks, and one still running each time', () => {
    const store = Store.open(':memory:');
    const f = family(store, 6);
    const total = f.ms.reduce((s, v) => s + v, 0);
    const done = [f.replay(f.rec, 7, 5_000), f.replay(f.rec, 4, 6_000)];
    // A replay still running: three calls replayed so far.
    const running = RunBuilder.start(store, { parent: f.rec, startedAt: 7_000 });
    for (let i = 1; i <= 3; i++) {
      if (i % 2) running.model({ messages: [user(`step ${i}`)] }, [text('x')], { origin: 'replayed', replayedFrom: i });
      else running.tool('t', { i }, { ok: i }, { origin: 'replayed', replayedFrom: i });
    }
    const first = notWaited(store, { since: 0 });
    expect(first.ms).toBe(total + 600 + 600);
    const getCalls = vi.spyOn(store, 'getCalls');
    expect(notWaited(store, { since: 0 })).toEqual(first);
    // Only the running replay and the recording it follows are read again.
    expect(getCalls.mock.calls.map((c) => c[0]).sort()).toEqual([f.rec, running.runId].sort());
    expect(getCalls.mock.calls.some((c) => done.includes(c[0]))).toBe(false);
    // Its next replayed call counts at once.
    running.tool('t', { i: 4 }, { ok: 4 }, { origin: 'replayed', replayedFrom: 4 });
    expect(notWaited(store, { since: 0 }).ms).toBe(total + 600 + 1000);
    // Once it ends, it is read once more and then kept.
    running.end();
    expect(notWaited(store, [running.runId]).ms).toBe(1000);
    getCalls.mockClear();
    expect(notWaited(store, [running.runId]).ms).toBe(1000);
    expect(getCalls).not.toHaveBeenCalled();
    // A replay of a replay, kept; then its recording is deleted (the replay in between stays). What
    // was kept for it goes with the recording, as on its own page.
    const again = f.replay(done[0]!, 7, 8_000);
    expect(notWaited(store, [again]).ms).toBe(total);
    store.deleteRun(f.rec);
    expect(recordedDurations(store, store.getRun(again)!).size).toBe(0);
    expect(notWaited(store, [again])).toEqual({ ms: 0, calls: 0, runs: [] });
    store.close();
  });
});
