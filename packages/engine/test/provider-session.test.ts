import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decide, decideUnavailable, SPRT_DEFAULTS, type Gate, type SprtGate } from '../src/stats.js';
import { planSuite } from '../src/suite.js';
import { attemptsInARow, sessionInARow, UNAVAILABLE_RETRY } from '../src/unavailable.js';

/**
 * What a provider that errs now and then does to a session of 100 gated goldens, worked out exactly
 * with the engine's gate (a black box): how often enough errors in a row stop the session, and how
 * often a gate is left inconclusive by attempts the provider cut short. The errors are independent,
 * each attempt's with chance `e`: a flaky provider, not one that is down.
 */

const G = 100;
const GATE: Gate = planSuite(
  Array.from({ length: G }, (_, i) => ({ golden: `goldens/g${i}`, gate: { kind: 'sprt' as const, ...SPRT_DEFAULTS }, maxGiven: false })),
  { risk: 0.05 },
)!.planned[0].gate;

/** The chance a golden's gate decides after exactly n attempts, for an agent at p with no errors. */
function attemptsToDecide(p: number): number[] {
  let walking = new Map<number, number>([[0, 1]]);
  const out: number[] = [];
  for (let n = 1; n <= GATE.max && walking.size; n++) {
    const next = new Map<number, number>();
    out[n] = 0;
    for (const [s, m] of walking)
      for (const [s2, q] of [
        [s + 1, p],
        [s, 1 - p],
      ] as const) {
        if (decide(s2, n, GATE) === 'continue') next.set(s2, (next.get(s2) ?? 0) + m * q);
        else out[n] += m * q;
      }
    walking = next;
  }
  return out;
}

/**
 * Errors before the model answered are run again and never counted, so each counted attempt comes
 * after a run of errors of its own, k or more long with chance e^k: the session stops for nothing
 * unless every one of them is shorter than `inARow`. Over the goldens' counted attempts N, that is
 * E[(1 - e^inARow)^N], their generating function at 1 - e^inARow, to the power of the goldens.
 */
function stoppedEarly(p: number, e: number, inARow: number): number {
  const dist = attemptsToDecide(p);
  const x = 1 - e ** inARow;
  const each = dist.reduce((a, w, n) => a + w * x ** n, 0);
  return 1 - each ** G;
}

/**
 * A golden's gate when the provider cuts a share `e` of its attempts short, whatever they would have
 * done, each counted against either verdict: how often it ends inconclusive, with its max counting
 * every attempt (`counted`: as before) or only those not cut short (now), and stopped by `inARow` of
 * them in a row (the golden's own, as before; null: none here, as the session counts them now).
 */
function cutShort(p: number, e: number, o: { counted: boolean; inARow: number | null }): number {
  // Cut short more often than this in one gate's attempts is a share of the mass below 1e-15 at e = 0.05.
  const C = 64;
  const R = o.inARow ?? 1;
  const last = 2 * GATE.max;
  const at = (s: number, c: number, run: number) => (s * (C + 1) + c) * R + run;
  let walking = new Float64Array(at(1, 0, 0));
  walking[0] = 1;
  let inconclusive = 0;
  for (let n = 1; n <= last; n++) {
    const next = new Float64Array(at(n + 1, 0, 0));
    // The gate's decision for each tally at this many attempts, worked out once.
    const decided = new Int8Array((n + 1) * (C + 1)).fill(-1);
    const decision = (s2: number, c2: number): number => {
      const k = s2 * (C + 1) + c2;
      let d = decided[k];
      if (d < 0) {
        const v = n >= last ? 'inconclusive' : decideUnavailable(s2, n, c2, GATE);
        d = decided[k] = v === 'continue' ? (o.counted && n >= GATE.max ? 2 : 0) : v === 'inconclusive' ? 2 : 1;
      }
      return d;
    };
    for (let s0 = 0; s0 < n; s0++)
      for (let c = 0; c <= Math.min(C, n - 1 - s0); c++)
        for (let run = 0; run < R; run++) {
          const m = walking[at(s0, c, run)];
          if (!m) continue;
          for (const [s2, c2, run2, q] of [
            [s0 + 1, c, 0, (1 - e) * p],
            [s0, c, 0, (1 - e) * (1 - p)],
            // With no stop of its own, how many in a row is no part of the state.
            [s0, c + 1, o.inARow === null ? 0 : run + 1, e],
          ] as const) {
            if (q <= 0 || c2 > C) continue;
            // Too many cut short in a row stop it, inconclusive (the golden's own count, as before).
            if (o.inARow !== null && run2 >= o.inARow) {
              inconclusive += m * q;
              continue;
            }
            const d = decision(s2, c2);
            if (d === 0) next[at(s2, c2, run2)] += m * q;
            else if (d === 2) inconclusive += m * q;
          }
        }
    walking = next;
  }
  return inconclusive;
}

const pct = (x: number, d = 2) => `${(100 * x).toFixed(d)}%`;
const figures: Record<string, number> = {};

describe('a flaky provider and a session of 100 gated goldens', { timeout: 180_000 }, () => {
  it('stops it for nothing far less often, its errors in a row counted across the session at 3 + ⌈log₁₀ goldens⌉', () => {
    expect([1, 2, 10, 11, 100, 101, 1000].map(sessionInARow)).toEqual([3, 4, 4, 5, 5, 6, 6]);
    expect(sessionInARow(1)).toBe(UNAVAILABLE_RETRY.inARow);
    const k = sessionInARow(G);
    for (const p of [0.95, 0.9]) {
      for (const e of [0.02, 0.05, 0.1]) {
        const before = stoppedEarly(p, e, UNAVAILABLE_RETRY.inARow);
        const now = stoppedEarly(p, e, k);
        figures[`stop ${p} ${e} before`] = before;
        figures[`stop ${p} ${e} now`] = now;
        expect(now).toBeLessThan(before / 25);
      }
    }
    // The review's figures for 3 in a row, at 95%.
    expect(figures['stop 0.95 0.02 before']).toBeCloseTo(0.0133, 3);
    expect(figures['stop 0.95 0.05 before']).toBeCloseTo(0.189, 2);
    expect(figures['stop 0.95 0.1 before']).toBeCloseTo(0.812, 2);
    // Errors on 2% or 5% of the attempts no longer stop a large session but rarely.
    expect(figures['stop 0.95 0.05 now']).toBeLessThan(0.001);
  });

  it('leaves its gates inconclusive less often when cut-short attempts use up none of their max and its errors in a row are the session’s', () => {
    const before = cutShort(0.95, 0.05, { counted: true, inARow: UNAVAILABLE_RETRY.inARow });
    const own = cutShort(0.95, 0.05, { counted: false, inARow: null });
    // The session's stop at 5 in a row, bounded by the chance of 5 cut short in a row ending at any of its attempts.
    const attempts = attemptsToDecide(0.95).reduce((a, w, n) => a + w * n, 0) * G;
    const stop = Math.min(1, (attempts / (1 - 0.05)) * 0.05 ** sessionInARow(G));
    figures.cutBefore = before;
    figures.cutBeforeSuite = 1 - (1 - before) ** G;
    figures.cutNow = own;
    figures.cutNowSuite = 1 - (1 - own) ** G + stop;
    expect(figures.cutNowSuite).toBeLessThan(figures.cutBeforeSuite / 10);
  });

  it('as docs/gating.md states it', () => {
    const page = readFileSync(fileURLToPath(new URL('../../../docs/gating.md', import.meta.url)), 'utf8');
    const says = (text: string) => expect(page.includes(text), `docs/gating.md says: ${text}`).toBe(true);
    console.log(Object.entries(figures).map(([k, v]) => `${k}: ${pct(v, 4)}`).join('\n'));
    // A row for each error rate: the sessions a fixed 3 stopped, which exited 3, and those the session's count stops.
    says(
      [
        `A session of 100 stops at ${sessionInARow(G)} in a row. Sessions of 100 goldens at 95% come out like this, worked out exactly in the engine's tests:`,
        '',
        `| Early error rate | A fixed 3: sessions that exited 3 | ${sessionInARow(G)} in a row: sessions stopped |`,
        '|---:|---:|---:|',
        `| 2% | ${pct(figures['stop 0.95 0.02 before'], 1)} | ${pct(Math.ceil(1e6 * figures['stop 0.95 0.02 now']) / 1e6, 4)} |`,
        `| 5% | ${pct(figures['stop 0.95 0.05 before'], 0)} | ${pct(Math.ceil(1e5 * figures['stop 0.95 0.05 now']) / 1e5, 3)} |`,
        `| 10% | ${pct(figures['stop 0.95 0.1 before'], 0)} | ${pct(Math.ceil(1e3 * figures['stop 0.95 0.1 now']) / 1e3, 1)} |`,
      ].join('\n'),
    );
    says(`the provider cuts short 5% of the attempts of a 100-golden suite at 95%. A gate whose \`max\` counted them, stopped by three in a row of its own, was left inconclusive ${pct(figures.cutBefore)} of the time, ${pct(figures.cutBeforeSuite, 0)} of sessions, nearly all of it three in a row. Counted as above, at most ${pct(Math.ceil(1e3 * figures.cutNowSuite) / 1e3, 1)} of sessions are`);
  });
});

/**
 * The chance a run of `calls` provider calls stops on errors in a row, each call an error with chance
 * `e`, independently: by call i, `inARow(i)` of them in a row stop it. Exact, over how many are in a
 * row so far.
 */
function stopsIn(calls: number, e: number, inARow: (call: number) => number): number {
  let walking = new Float64Array(16);
  walking[0] = 1;
  let stopped = 0;
  for (let i = 1; i <= calls; i++) {
    const k = inARow(i);
    const next = new Float64Array(16);
    for (let run = 0; run < 16; run++) {
      const m = walking[run];
      if (!m) continue;
      next[0] += m * (1 - e);
      if (run + 1 >= k) stopped += m * e;
      else next[run + 1] += m * e;
    }
    walking = next;
  }
  return stopped;
}

const runs: Record<string, number> = {};

describe('a flaky provider and the runs outside test: verify, blame, repair, migrate, injection', () => {
  it('takes one more error in a row to stop a run for each tenfold of its attempts past 10', () => {
    expect([1, 10, 11, 100, 101, 1000, 1001].map(attemptsInARow)).toEqual([3, 3, 4, 4, 5, 5, 6]);
    expect(attemptsInARow(0)).toBe(UNAVAILABLE_RETRY.inARow);
  });

  it('stops a long run for nothing far less often than a fixed 3 did', () => {
    for (const calls of [300, 600])
      for (const e of [0.05, 0.1]) {
        runs[`${calls} ${e} before`] = stopsIn(calls, e, () => UNAVAILABLE_RETRY.inARow);
        runs[`${calls} ${e} now`] = stopsIn(calls, e, attemptsInARow);
        expect(runs[`${calls} ${e} now`]).toBeLessThan(runs[`${calls} ${e} before`] / 10);
      }
    // The review's figures for a fixed 3.
    expect(runs['300 0.05 before']).toBeCloseTo(0.035, 3);
    expect(runs['600 0.05 before']).toBeCloseTo(0.069, 3);
    expect(runs['300 0.1 before']).toBeCloseTo(0.24, 2);
    expect(runs['600 0.1 before']).toBeCloseTo(0.42, 2);
    // Each tenfold adds under a point at 10% errors, as each adds one more in a row.
    expect(stopsIn(10_000, 0.1, attemptsInARow) - stopsIn(1000, 0.1, attemptsInARow)).toBeLessThan(0.01);
  });

  it('stops a chaos session for nothing far less often, its errors in a row counted across its presets', () => {
    // 20 attempts a preset, the review's; before, 3 in a row within each preset stopped it.
    for (const presets of [50, 100])
      for (const e of [0.05, 0.1]) {
        runs[`chaos ${presets} ${e} before`] = 1 - (1 - stopsIn(20, e, () => UNAVAILABLE_RETRY.inARow)) ** presets;
        runs[`chaos ${presets} ${e} now`] = stopsIn(20 * presets, e, () => sessionInARow(presets));
        expect(runs[`chaos ${presets} ${e} now`]).toBeLessThan(runs[`chaos ${presets} ${e} before`] / 25);
      }
    expect(runs['chaos 50 0.05 before']).toBeCloseTo(0.1, 2);
    expect(runs['chaos 100 0.05 before']).toBeCloseTo(0.19, 2);
    expect(runs['chaos 50 0.1 before']).toBeCloseTo(0.56, 2);
    expect(Math.abs(runs['chaos 100 0.1 before'] - 0.81)).toBeLessThan(0.006);
    // A session of one preset stops as before, at 3 in a row.
    expect(sessionInARow(1)).toBe(UNAVAILABLE_RETRY.inARow);
  });

  it('as docs/gating.md states it', () => {
    const page = readFileSync(fileURLToPath(new URL('../../../docs/gating.md', import.meta.url)), 'utf8');
    const says = (text: string) => expect(page.includes(text), `docs/gating.md says: ${text}`).toBe(true);
    console.log(Object.entries(runs).map(([k, v]) => `${k}: ${pct(v, 4)}`).join('\n'));
    const up = (x: number, d: number) => pct(Math.ceil(10 ** (d + 2) * x) / 10 ** (d + 2), d);
    // A row for each error rate and run: how often a fixed 3 stopped it, and how often the count that grows with it does.
    says(
      [
        '| Error rate | Attempts in the run | A fixed 3 stopped | This count stops |',
        '|---:|---:|---:|---:|',
        `| 5% | 300 | ${pct(runs['300 0.05 before'], 1)} | ${up(runs['300 0.05 now'], 2)} |`,
        `| 5% | 600 | ${pct(runs['600 0.05 before'], 1)} | ${up(runs['600 0.05 now'], 2)} |`,
        `| 10% | 300 | ${pct(runs['300 0.1 before'], 0)} | ${up(runs['300 0.1 now'], 1)} |`,
        `| 10% | 600 | ${pct(runs['600 0.1 before'], 0)} | ${up(runs['600 0.1 now'], 1)} |`,
      ].join('\n'),
    );
    // And for each chaos session: 3 in a row within each preset of 20 attempts, or counted across the session.
    says(
      [
        '| Error rate | Presets of 20 attempts | 3 in a row within each preset | Counted across the session |',
        '|---:|---:|---:|---:|',
        `| 5% | 50 | ${pct(runs['chaos 50 0.05 before'], 0)} | ${up(runs['chaos 50 0.05 now'], 3)} |`,
        `| 5% | 100 | ${pct(runs['chaos 100 0.05 before'], 0)} | ${up(runs['chaos 100 0.05 now'], 3)} |`,
        `| 10% | 50 | ${pct(runs['chaos 50 0.1 before'], 0)} | ${up(runs['chaos 50 0.1 now'], 2)} |`,
        `| 10% | 100 | ${pct(runs['chaos 100 0.1 before'], 0)} | ${up(runs['chaos 100 0.1 now'], 1)} |`,
      ].join('\n'),
    );
  });
});

// The gate as the engine plans it for 100 goldens.
describe('the gate it is worked out for', () => {
  it('is the default gate at its share of the 5%', () => {
    expect(GATE).toMatchObject({ kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 179 } satisfies Partial<SprtGate>);
  });
});
