import { describe, expect, it } from 'vitest';
import { BLAME_DEFAULTS, decide, decideCount, type SprtGate } from '@shadowlap/engine';
import { ProbeTally } from '../src/blame.js';

/**
 * A blame probe's attempts as its gate reads them when several run at once (`--concurrency`): in
 * the order they started, each once those before it ended, and decided once.
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
    // It fails: read in order, a failure then two passes, which is not yet a rescue.
    t.add(1, false);
    expect(t.decided).toBeNull();
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

  it('decides a fixed count the same way, and nothing before an answer', () => {
    const t = new ProbeTally((passes, attempts) => decideCount(passes, attempts, 5, 2));
    expect(t.decidedOn()).toEqual([]);
    t.add(1, false);
    t.add(2, true);
    t.add(3, true);
    expect(t.decided).toEqual({ decision: 'pass', at: 3 });
  });
});
