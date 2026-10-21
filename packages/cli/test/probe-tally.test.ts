import { describe, expect, it } from 'vitest';
import { BLAME_DEFAULTS, decide, decideCount, type GateDecision, type SprtGate } from '@shadowlap/engine';
import { probeAttempts, ProbeTally } from '../src/blame.js';

/**
 * A blame probe's attempts as its gate reads them when several run at once (`--concurrency`): in
 * the order they started, each once those before it ended, and decided once; and started only
 * while fewer than --concurrency have started that the gate has not read.
 */
const GATE: SprtGate = { kind: 'sprt', ...BLAME_DEFAULTS };
const gated = () => new ProbeTally((passes, attempts) => decide(passes, attempts, GATE));

describe('a probe tally', () => {
  it('keeps its first verdict: an attempt still running when two passes rescued the run does not reopen it', () => {
    const t = gated();
    t.add(1, true);
    expect(t.decided).toBeNull();
    t.add(2, true);
    expect(t.decided).toEqual({ decision: 'pass', at: 2 });
    // The third had started before the second ended, and failed: evidence, but no new verdict.
    t.add(3, false);
    expect(t.decided).toEqual({ decision: 'pass', at: 2 });
    expect(t.decidedOn()).toEqual([true, true]);
    // Read as the whole tally it would be undecided again: 2 of 3 is between the bounds.
    expect(decide(2, 3, GATE)).toBe('continue');
  });

  it('reads attempts in the order they started, waiting for one that ended late', () => {
    const t = gated();
    // The second and third to start end first, both passing; the first is still running.
    t.add(2, true);
    t.add(3, true);
    expect(t.decided).toBeNull();
    expect(t.read).toBe(0);
    // It fails: read in order, a failure then two passes, which is not yet a rescue.
    t.add(1, false);
    expect(t.decided).toBeNull();
    expect(t.read).toBe(3);
    t.add(4, true);
    expect(decide(3, 4, GATE)).toBe('pass');
    expect(t.decided).toEqual({ decision: 'pass', at: 4 });
    expect(t.decidedOn()).toEqual([false, true, true, true]);
  });

  it('reaches what one attempt after another would, whatever order they end in', () => {
    const outcomes = [false, true, false, false, true, false, false, false];
    const inOrder = gated();
    outcomes.forEach((x, i) => inOrder.add(i + 1, x));
    // Ended in reverse pairs: 2, 1, 4, 3, …
    const shuffled = gated();
    for (let i = 0; i < outcomes.length; i += 2) {
      shuffled.add(i + 2, outcomes[i + 1]!);
      shuffled.add(i + 1, outcomes[i]!);
    }
    expect(shuffled.decided).toEqual(inOrder.decided);
    expect(shuffled.decidedOn()).toEqual(inOrder.decidedOn());
  });

  it('decides inconclusive at an attempt that could not be judged, on the attempts before it', () => {
    const t = gated();
    t.add(1, true);
    // The third, started before the second ended, could not be judged; the second is still running.
    t.add(3, null);
    expect(t.decided).toBeNull();
    t.add(2, false);
    expect(t.decided).toEqual({ decision: 'inconclusive', at: 2 });
    expect(t.decidedOn()).toEqual([true, false]);
    // A verdict reached before it stands: one that ends later is only a late attempt.
    const settled = gated();
    settled.add(1, true);
    settled.add(2, true);
    settled.add(3, null);
    expect(settled.decided).toEqual({ decision: 'pass', at: 2 });
    // A fixed count too.
    const counted = new ProbeTally((passes, attempts) => decideCount(passes, attempts, 5, 2));
    counted.add(1, null);
    expect(counted.decided).toEqual({ decision: 'inconclusive', at: 0 });
    expect(counted.decidedOn()).toEqual([]);
  });

  it('decides a fixed count the same way, and nothing before an answer', () => {
    const t = new ProbeTally((passes, attempts) => decideCount(passes, attempts, 5, 2));
    expect(t.decidedOn()).toEqual([]);
    t.add(1, false);
    t.add(2, true);
    t.add(3, true);
    expect(t.decided).toEqual({ decision: 'pass', at: 3 });
  });
});

/** Lets every attempt that can move on do so: what is left waits on an attempt still running. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A probe whose attempts the test ends one by one: `end(n, passed)` ends attempt n as blame does (the
 * tally reads it), `end(n, null)` unread, as Ctrl-C does. `stop()` stands for whatever stops new
 * attempts: an interrupt, a prefix that broke, the budget spent.
 */
function probe(concurrency: number) {
  const tally = gated();
  const started: number[] = [];
  /** How many attempts the gate had read as each started. */
  const readAtStart: number[] = [];
  const running = new Map<number, (passed: boolean | null) => void>();
  let stopped = false;
  let ended = false;
  const done = probeAttempts({
    concurrency,
    limit: GATE.max,
    tally,
    more: () => !stopped && !tally.decided,
    attempt: (n) =>
      new Promise<void>((resolve) => {
        started.push(n);
        readAtStart.push(tally.read);
        running.set(n, (passed) => {
          running.delete(n);
          if (passed !== null) tally.add(n, passed);
          resolve();
        });
      }),
  }).finally(() => (ended = true));
  return {
    tally,
    started,
    readAtStart,
    done,
    ended: () => ended,
    stop: () => (stopped = true),
    end: async (n: number, passed: boolean | null) => {
      running.get(n)!(passed);
      await settle();
    },
  };
}

describe("a probe's attempts at once", () => {
  it('starts none past --concurrency that the gate cannot read: while the first runs slow, the others wait for it', async () => {
    const x = probe(2);
    await settle();
    expect(x.started).toEqual([1, 2]);
    // The second ends, failing; the gate can't read it before the first, so nothing starts.
    await x.end(2, false);
    expect(x.started).toEqual([1, 2]);
    expect(x.tally.read).toBe(0);
    // The first ends: the gate reads both, and two more start.
    await x.end(1, false);
    expect(x.tally.read).toBe(2);
    expect(x.started).toEqual([1, 2, 3, 4]);
    // The third read, a fifth starts; the fourth makes four straight failures, which lose the probe.
    await x.end(3, false);
    expect(x.started).toEqual([1, 2, 3, 4, 5]);
    await x.end(4, false);
    expect(x.tally.decided).toEqual({ decision: 'fail', at: 4 });
    // The fifth was running when it decided: one past it, concurrency - 1, and no more.
    expect(x.ended()).toBe(false);
    await x.end(5, false);
    await x.done;
    expect(x.started).toEqual([1, 2, 3, 4, 5]);
  });

  it('runs at most concurrency - 1 past the attempt that decides, to the verdict one after another reaches, whatever order they end in', async () => {
    // A seeded generator: the same attempts, outcomes and endings every run.
    let seed = 7;
    const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
    for (let round = 0; round < 120; round++) {
      const concurrency = 1 + (round % 4);
      const rate = [0.05, 0.5, 0.9][round % 3]!;
      const outcomes = Array.from({ length: GATE.max }, () => random() < rate);
      // How long each attempt runs, in steps: now and then one runs far longer than the rest.
      const steps = Array.from({ length: GATE.max }, () => (random() < 0.2 ? 20 + Math.floor(random() * 40) : 1 + Math.floor(random() * 4)));
      const x = probe(concurrency);
      const left = new Map<number, number>();
      for (let step = 0; !x.ended(); step++) {
        await settle();
        for (const n of x.started) if (!left.has(n)) left.set(n, steps[n - 1]!);
        for (const [n, l] of left) {
          if (l === 0) continue;
          left.set(n, l - 1);
          if (l === 1) await x.end(n, outcomes[n - 1]!);
        }
        expect(step).toBeLessThan(10_000);
      }
      // The verdict one after another reaches, on the same outcomes in the same order.
      let one: { decision: GateDecision; at: number } | null = null;
      for (let i = 1; !one && i <= GATE.max; i++) {
        const d = decide(outcomes.slice(0, i).filter(Boolean).length, i, GATE);
        if (d !== 'continue') one = { decision: d, at: i };
      }
      expect(x.tally.decided, `round ${round}`).toEqual(one);
      expect(x.started.length, `round ${round}`).toBeLessThanOrEqual(one!.at + concurrency - 1);
      // None started while concurrency attempts had started that the gate had not read.
      x.started.forEach((n, i) => expect(n - 1 - x.readAtStart[i]!, `round ${round}, attempt ${n}`).toBeLessThan(concurrency));
    }
  });

  it('wakes an attempt waiting on a slow one when Ctrl-C, a broken prefix or the budget stops the probe, so none waits forever', async () => {
    // Ctrl-C ends the slow attempt unread; a broken prefix and the budget let the gate read it.
    for (const ending of [null, false] as const) {
      const x = probe(2);
      await settle();
      await x.end(2, false);
      // The second's worker waits for the first, still running.
      expect(x.started).toEqual([1, 2]);
      x.stop();
      await x.end(1, ending);
      expect(x.ended()).toBe(true);
      await x.done;
      expect(x.started).toEqual([1, 2]);
      expect(x.tally.decided).toBeNull();
    }
  });

  it('ends with the error of an attempt that threw, starting none after it', async () => {
    const tally = gated();
    const started: number[] = [];
    let finishFirst = () => {};
    const done = probeAttempts({
      concurrency: 2,
      limit: GATE.max,
      tally,
      more: () => !tally.decided,
      attempt: (n) => {
        started.push(n);
        if (n === 2) return Promise.reject(new Error('the store is gone'));
        return new Promise<void>((resolve) => (finishFirst = resolve));
      },
    });
    await expect(done).rejects.toThrow('the store is gone');
    // The first ends, unread: nothing starts after the error.
    finishFirst();
    await settle();
    expect(started).toEqual([1, 2]);
  });
});
