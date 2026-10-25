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
      shuffled.add(i + 2, outcomes[i + 1]);
      shuffled.add(i + 1, outcomes[i]);
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

/** How an attempt ends: passed or failed, null when it could not be judged, or unread, as Ctrl-C ends one. */
type Ending = boolean | null | 'unread';

/**
 * A probe whose attempts the test ends one by one: `end(n, passed)` ends attempt n as blame does (the
 * tally reads it, null for one that could not be judged), `end(n, 'unread')` unread, as Ctrl-C does.
 * `stop()` stands for whatever stops new attempts: an interrupt, a prefix that broke, the budget spent.
 */
function probe(concurrency: number) {
  const tally = gated();
  const started: number[] = [];
  /** How many attempts the gate had read as each started. */
  const readAtStart: number[] = [];
  const running = new Map<number, (ending: Ending) => void>();
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
        running.set(n, (ending) => {
          running.delete(n);
          if (ending !== 'unread') tally.add(n, ending);
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
    end: async (n: number, ending: Ending) => {
      running.get(n)!(ending);
      await settle();
    },
  };
}

/** Ends each attempt of the probe `steps[n - 1]` steps after it started, as `outcomes[n - 1]`, until the probe has ended. */
async function runOut(x: ReturnType<typeof probe>, outcomes: ReadonlyArray<boolean | null>, steps: readonly number[]): Promise<void> {
  const left = new Map<number, number>();
  for (let step = 0; !x.ended(); step++) {
    await settle();
    for (const n of x.started) if (!left.has(n)) left.set(n, steps[n - 1]);
    for (const [n, l] of left) {
      if (l === 0) continue;
      left.set(n, l - 1);
      if (l === 1) await x.end(n, outcomes[n - 1]);
    }
    expect(step).toBeLessThan(10_000);
  }
}

/**
 * The verdict one attempt after another reaches on the same outcomes in the same order, and the
 * attempt that reached it: the gate's, or inconclusive on the attempts before the first that could
 * not be judged.
 */
function oneAfterAnother(outcomes: ReadonlyArray<boolean | null>): { decided: { decision: GateDecision; at: number }; by: number } {
  let passes = 0;
  for (let i = 1; i <= outcomes.length; i++) {
    const o = outcomes[i - 1];
    if (o === null) return { decided: { decision: 'inconclusive', at: i - 1 }, by: i };
    if (o) passes++;
    const d = decide(passes, i, GATE);
    if (d !== 'continue') return { decided: { decision: d, at: i }, by: i };
  }
  throw new Error(`the gate decides by attempt ${GATE.max}`);
}

/** A seeded generator: the same attempts, outcomes and endings every run. */
function seeded(seed: number): () => number {
  return () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
}

/** How long each attempt runs, in steps: now and then one runs far longer than the rest. */
const durations = (random: () => number) => Array.from({ length: GATE.max }, () => (random() < 0.2 ? 20 + Math.floor(random() * 40) : 1 + Math.floor(random() * 4)));

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
    const random = seeded(7);
    for (let round = 0; round < 120; round++) {
      const concurrency = 1 + (round % 4);
      const rate = [0.05, 0.5, 0.9][round % 3];
      const outcomes = Array.from({ length: GATE.max }, () => random() < rate);
      const steps = durations(random);
      const x = probe(concurrency);
      await runOut(x, outcomes, steps);
      const one = oneAfterAnother(outcomes);
      expect(x.tally.decided, `round ${round}`).toEqual(one.decided);
      expect(x.started.length, `round ${round}`).toBeLessThanOrEqual(one.by + concurrency - 1);
      // None started while concurrency attempts had started that the gate had not read.
      x.started.forEach((n, i) => expect(n - 1 - x.readAtStart[i], `round ${round}, attempt ${n}`).toBeLessThan(concurrency));
    }
  });

  it('starts none once an attempt that could not be judged is read, and wakes the worker that waited to read it', async () => {
    const x = probe(2);
    await settle();
    // The second could not be judged and ends while the first still runs: the gate can't read it yet, so nothing starts.
    await x.end(2, null);
    expect(x.started).toEqual([1, 2]);
    expect(x.tally.decided).toBeNull();
    // The first passes: the gate reads it, then the second, which stops the probe inconclusive on the first alone.
    await x.end(1, true);
    expect(x.tally.decided).toEqual({ decision: 'inconclusive', at: 1 });
    expect(x.ended()).toBe(true);
    await x.done;
    expect(x.started).toEqual([1, 2]);
  });

  it('stops where one after another would at an attempt that could not be judged, at most concurrency - 1 past it, whatever order they end in', async () => {
    const random = seeded(11);
    let stoppedUnjudged = 0;
    for (let round = 0; round < 120; round++) {
      const concurrency = 1 + (round % 4);
      const rate = [0.05, 0.5, 0.9][round % 3];
      // Now and then an attempt can't be judged, such as one whose judge's call failed.
      const outcomes = Array.from({ length: GATE.max }, () => (random() < 0.12 ? null : random() < rate));
      const steps = durations(random);
      const x = probe(concurrency);
      await runOut(x, outcomes, steps);
      const one = oneAfterAnother(outcomes);
      expect(x.tally.decided, `round ${round}`).toEqual(one.decided);
      expect(x.tally.decidedOn(), `round ${round}`).toEqual(outcomes.slice(0, one.decided.at));
      expect(x.started.length, `round ${round}`).toBeLessThanOrEqual(one.by + concurrency - 1);
      x.started.forEach((n, i) => expect(n - 1 - x.readAtStart[i], `round ${round}, attempt ${n}`).toBeLessThan(concurrency));
      if (outcomes[one.by - 1] === null) stoppedUnjudged++;
    }
    // The rounds hold both kinds of ending: a gate's verdict and an attempt that could not be judged.
    expect(stoppedUnjudged).toBeGreaterThan(10);
    expect(stoppedUnjudged).toBeLessThan(110);
  });

  it('wakes an attempt waiting on a slow one when Ctrl-C, a broken prefix or the budget stops the probe, so none waits forever', async () => {
    // Ctrl-C ends the slow attempt unread; a broken prefix and the budget let the gate read it.
    for (const ending of ['unread', false] as const) {
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
