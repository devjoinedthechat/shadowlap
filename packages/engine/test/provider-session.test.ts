import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decide, decideUnavailable, SPRT_DEFAULTS, type Gate, type SprtGate } from '../src/stats.js';
import { planSuite } from '../src/suite.js';
import { sessionInARow, UNAVAILABLE_RETRY } from '../src/unavailable.js';

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
    says(`with early errors on 2%, 5% and 10% of the attempts, ${pct(figures['stop 0.95 0.02 before'], 1)}, ${pct(figures['stop 0.95 0.05 before'], 0)} and ${pct(figures['stop 0.95 0.1 before'], 0)} of 100-golden sessions at 95% exited 3`);
    says(`which a provider erring on 2%, 5% and 10% of the attempts makes ${pct(Math.ceil(1e6 * figures['stop 0.95 0.02 now']) / 1e6, 4)}, ${pct(Math.ceil(1e5 * figures['stop 0.95 0.05 now']) / 1e5, 3)} and ${pct(Math.ceil(1e3 * figures['stop 0.95 0.1 now']) / 1e3, 1)} of such sessions`);
    says(`cut short on 5% of the attempts, a gate of a 100-golden suite at 95% was left inconclusive ${pct(figures.cutBefore)} of the time, ${pct(figures.cutBeforeSuite, 0)} of sessions, nearly all of it three in a row; now at most ${pct(Math.ceil(1e3 * figures.cutNowSuite) / 1e3, 1)} of sessions`);
  });
});

// The gate as the engine plans it for 100 goldens.
describe('the gate it is worked out for', () => {
  it('is the default gate at its share of the 5%', () => {
    expect(GATE).toMatchObject({ kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 179 } satisfies Partial<SprtGate>);
  });
});
