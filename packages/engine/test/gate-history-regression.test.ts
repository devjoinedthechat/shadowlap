import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loop, pct, table, type Loop } from './history-loop.js';

/**
 * An agent whose goldens are gated against their own history drops after 30 sessions
 * (history-loop.ts): each of the 10 sessions after is caught about as often as by a gate held at the
 * share with max 40 against the same baseline, the review's yardstick. More attempts than that max
 * pass an agent as its record shows it whose baseline came out lucky; one that dropped sits below its
 * record by the drop, and a pass past the max is held to that record (`BaselineGate.widened`). One
 * that drops after 15, while its goldens have too few sessions for an inconclusive to count by
 * default, is caught once the plan reads their last sessions below the sessions before them, as their
 * inconclusives then count; until it does, they only warn.
 */

describe('a regression in goldens gated against their own history', { timeout: 900_000 }, () => {
  const cases: Loop[] = [];
  const dropped = (rate: number, to: number) => cases.find((c) => c.rate === rate && c.to === to)!;
  // Dropped at their 15th session: young goldens, with too few sessions for an inconclusive to count by default.
  const young: Loop[] = [];
  const mean = (l: Loop, f: (a: Loop['after'][number]) => number) => l.after.reduce((t, a) => t + f(a), 0) / l.after.length;

  it('is caught in each of the 10 sessions after it as often as by a gate held at the share with max 40, to a twentieth of a point', () => {
    for (const [rate, to, seed] of [
      [0.95, 0.75, 9575],
      [0.9, 0.7, 9070],
      [0.95, 0.6, 9560],
    ] as const) {
      const l = loop(20, rate, seed, { replicas: 30, sessions: 40, drop: { at: 30, to } });
      cases.push(l);
      for (const [j, a] of l.after.entries()) expect(a.red, `${rate} to ${to}, session ${j + 1} after it`).toBeGreaterThanOrEqual(a.fixed - 5e-4);
      // Once its last sessions sit below its baseline beyond chance, the plan says it is a drop.
      expect(Math.max(...l.after.map((a) => a.drop)), `${rate} to ${to}`).toBeGreaterThan(0.1);
    }
  });

  it('in a golden\u2019s first 30 sessions, counts an inconclusive once the plan reads its last sessions below the ones before them, and catches a drop far more often than failing alone', () => {
    for (const [rate, to, seed] of [
      [0.95, 0.75, 1575],
      [0.9, 0.7, 1570],
      [0.95, 0.6, 1560],
    ] as const) {
      const l = loop(20, rate, seed, { replicas: 30, sessions: 25, drop: { at: 15, to } });
      young.push(l);
      for (const [j, a] of l.after.entries()) {
        const at = `${rate} to ${to}, session ${j + 1} after it`;
        // Red by default no less often than by failing alone, as when every young inconclusive only
        // warned, and no more than with every one counted; what isn't red warns or passes.
        expect(a.red, at).toBeGreaterThanOrEqual(a.failing);
        expect(a.red, at).toBeLessThanOrEqual(a.counted + 1e-12);
        expect(a.red + a.warned + a.passed, at).toBeCloseTo(1, 12);
      }
      // Over the 10 sessions after it, caught well past failing alone, as when every young inconclusive
      // only warned, and what only warns now a part of what did then; by the tenth, nearly none.
      expect(mean(l, (a) => a.red), `${rate} to ${to}`).toBeGreaterThan(1.5 * mean(l, (a) => a.failing));
      expect(mean(l, (a) => a.warned), `${rate} to ${to}`).toBeLessThan(0.75 * mean(l, (a) => a.counted - a.failing));
      expect(l.after[9].warned, `${rate} to ${to}, the tenth session after it`).toBeLessThan(0.25 * (l.after[9].counted - l.after[9].failing));
    }
  });

  it('as docs/gating.md states it', () => {
    const page = readFileSync(fileURLToPath(new URL('../../../docs/gating.md', import.meta.url)), 'utf8');
    const says = (text: string) => expect(page.includes(text), `docs/gating.md says: ${text}`).toBe(true);
    console.log(table(cases));
    for (const [rate, to] of [
      [0.95, 0.75],
      [0.9, 0.7],
      [0.95, 0.6],
    ] as const) {
      const a = dropped(rate, to).after;
      says(`${Math.round(100 * rate)}% to ${Math.round(100 * to)}%: ${pct(a[0].red, 1)} in the first session after it and ${pct(a[9].red, 1)} in the tenth, as against ${pct(a[0].fixed, 1)} and ${pct(a[9].fixed, 1)}`);
    }
    const worst = Math.max(0, ...cases.flatMap((c) => c.after.map((a) => a.fixed - a.red)));
    says(`never more than ${(Math.ceil(100 * 100 * worst) / 100).toFixed(2)} of a point less`);
    // A drop after their 15th session, over these 30 histories; the page's figures for it are over 400, gating-figures.test.ts.
    console.log(table(young));
  });
});
