import { describe, expect, it } from 'vitest';
import { inputTicks, outputTop, tickLabel } from '../ui/run/context-axis.js';

/** Context's axes: the input's ticks by a round step, and the output's own scale, as the mock draws them. */
describe('Context’s axes', () => {
  it('ticks the input by the first round step that gives at most four above 0', () => {
    expect(inputTicks(300)).toEqual([0, 100, 200, 300]);
    expect(inputTicks(400)).toEqual([0, 100, 200, 300, 400]);
    expect(inputTicks(401)).toEqual([0, 200, 400]);
    expect(inputTicks(1_800)).toEqual([0, 500, 1000, 1500]);
    expect(inputTicks(38_000)).toEqual([0, 10000, 20000, 30000]);
    // Past 200,000 tokens, by 100,000.
    expect(inputTicks(350_000)).toEqual([0, 100000, 200000, 300000]);
    expect(inputTicks(0)).toEqual([0]);
  });

  it('reads a thousand as 1k', () => {
    expect([0, 500, 1000, 1500, 20000].map(tickLabel)).toEqual(['0', '500', '1k', '1.5k', '20k']);
  });

  it('tops the output’s axis at the next 50 up, at least 50', () => {
    expect(outputTop(0)).toBe(50);
    expect(outputTop(40)).toBe(50);
    expect(outputTop(50)).toBe(50);
    expect(outputTop(51)).toBe(100);
    expect(outputTop(1_234)).toBe(1250);
  });
});
