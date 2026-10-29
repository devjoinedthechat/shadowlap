import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decide, planSuite, SPRT_DEFAULTS, type Gate } from '@shadowlap/engine';
import { describe, expect, it } from 'vitest';
import { Turns } from '../src/turns.js';

/**
 * A gate takes its attempts to be independent. Failures that come in bursts break that: here the
 * attempts of a whole session draw from one two-state chain in the order they run, where after a
 * failure the next attempt fails with chance `burst`, and the chain fails `1 - rate` of all attempts.
 * A session of goldens each gated at its share of the suite's 5% (`planSuite`, `decide`: the engine's,
 * as black boxes) runs its goldens one after another, as `shadowlap test` did, or in turns (turns.ts),
 * as it does now. Seeded: every run sees the same coin flips.
 */

/** mulberry32: a small, seeded generator with a period of 2^32. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SESSIONS = 1000;

interface Suite {
  goldens: number;
  rate: number;
  burst: number;
  /** How often a session of these goldens went red, one golden after another and in turns. */
  oneByOne: number;
  inTurns: number;
}

async function suite(goldens: number, rate: number, burst: number, seed: number): Promise<Suite> {
  const gate: Gate = planSuite(Array.from({ length: goldens }, (_, i) => ({ golden: `goldens/g${i}`, gate: { kind: 'sprt', ...SPRT_DEFAULTS }, maxGiven: false })), { risk: 0.05 })!.planned[0].gate;
  const fail = 1 - rate;
  // After a pass, the chance a failure follows that keeps `fail` of all attempts failing.
  const after = (fail * (1 - burst)) / (1 - fail);
  const red = async (order: 'one-by-one' | 'in-turns'): Promise<number> => {
    const random = seeded(seed);
    let reds = 0;
    for (let s = 0; s < SESSIONS; s++) {
      let failed = random() < fail;
      // The session's next attempt, wherever it runs.
      const next = () => (failed = random() < (failed ? burst : after));
      const verdicts: string[] = [];
      const golden = async (turns: Turns | null) => {
        let passes = 0;
        let n = 0;
        let d = decide(0, 0, gate);
        while (d === 'continue') {
          const give = turns ? await turns.take() : null;
          const passed = !next();
          give?.();
          if (passed) passes++;
          d = decide(passes, ++n, gate);
        }
        verdicts.push(d);
      };
      if (order === 'one-by-one') for (let g = 0; g < goldens; g++) await golden(null);
      else {
        const turns = new Turns();
        await Promise.all(Array.from({ length: goldens }, () => golden(turns)));
      }
      if (verdicts.some((v) => v !== 'pass')) reds++;
    }
    return reds / SESSIONS;
  };
  return { goldens, rate, burst, oneByOne: await red('one-by-one'), inTurns: await red('in-turns') };
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

describe('turns', () => {
  it('runs one attempt at a time, the goldens still open in the order they first asked', async () => {
    const turns = new Turns();
    const ran: string[] = [];
    let running = 0;
    const golden = async (name: string, attempts: number) => {
      for (let i = 1; i <= attempts; i++) {
        const give = await turns.take();
        running++;
        expect(running).toBe(1);
        ran.push(`${name}${i}`);
        await new Promise((r) => setTimeout(r, 1));
        running--;
        give();
      }
    };
    await Promise.all([golden('a', 3), golden('b', 1), golden('c', 2)]);
    expect(ran).toEqual(['a1', 'b1', 'c1', 'a2', 'c2', 'a3']);
  });

  it('lets every golden waiting go once it is closed, as a session that stops does', async () => {
    const turns = new Turns();
    const held = await turns.take();
    const waiting = [turns.take(), turns.take()];
    turns.close();
    expect(await Promise.all(waiting)).toHaveLength(2);
    held();
    // A turn given back twice gives nothing more.
    expect(held).not.toThrow();
  });
});

describe('goldens whose failures come in bursts', { timeout: 120_000 }, () => {
  const cases: Suite[] = [];

  it('turn a healthy suite red far past its 5% when their attempts run one golden after another, and stay near it in turns', async () => {
    // Independent attempts: within the 5% either way (at 90%, the gate's own good rate, about at it).
    for (const [rate, seed] of [
      [0.95, 95],
      [0.9, 90],
    ] as const) {
      const c = await suite(100, rate, 1 - rate, seed);
      cases.push(c);
      expect(c.oneByOne, `independent at ${rate}`).toBeLessThan(0.05 + 3 * Math.sqrt(0.05 / SESSIONS));
      expect(c.inTurns, `independent at ${rate}`).toBeLessThan(0.05 + 3 * Math.sqrt(0.05 / SESSIONS));
    }
    const at95 = await suite(100, 0.95, 0.5, 9505);
    const at90 = await suite(100, 0.9, 0.3, 9003);
    cases.push(at95, at90);
    expect(at95.oneByOne).toBeGreaterThan(0.3);
    expect(at95.inTurns).toBeLessThan(0.01);
    expect(at90.oneByOne).toBeGreaterThan(0.4);
    expect(at90.inTurns).toBeLessThan(0.08);
  });

  it('as docs/gating.md states it', () => {
    const page = readFileSync(fileURLToPath(new URL('../../../docs/gating.md', import.meta.url)), 'utf8');
    const at95 = cases.find((c) => c.rate === 0.95 && c.burst === 0.5)!;
    const at90 = cases.find((c) => c.rate === 0.9 && c.burst === 0.3)!;
    const text = `100 goldens of an agent that passes 95% of its attempts, where after a failure the next attempt fails half the time, go red ${pct(at95.oneByOne)} of the time when their attempts run one golden after another, and ${pct(at95.inTurns)} in turns; at 90%, where it fails again 30% of the time, ${pct(at90.oneByOne)} and ${pct(at90.inTurns)}`;
    expect(page.includes(text), `docs/gating.md says: ${text}`).toBe(true);
    console.log(cases.map((c) => `${c.goldens} goldens at ${c.rate}, P(fail | fail before) ${c.burst}: red ${pct(c.oneByOne)} one by one, ${pct(c.inTurns)} in turns`).join('\n'));
  });
});
