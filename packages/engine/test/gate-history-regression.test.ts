import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loop, pct, table, type Loop } from './history-loop.js';

/**
 * An agent whose goldens are gated against their own history drops after 30 sessions
 * (history-loop.ts): each of the 10 sessions after is caught about as often as by a gate held at the
 * share with max 40 against the same baseline, the review's yardstick. More attempts than that max
 * pass an agent as its record shows it whose baseline came out lucky; one that dropped sits below its
 * record by the drop, and a pass past the max is held to that record (`BaselineGate.widened`).
 */

describe('a regression in goldens gated against their own history', { timeout: 900_000 }, () => {
  const cases: Loop[] = [];
  const dropped = (rate: number, to: number) => cases.find((c) => c.rate === rate && c.to === to)!;

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
  });
});
