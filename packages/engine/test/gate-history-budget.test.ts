import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gateOdds, type BaselineGate } from '../src/stats.js';
import { planSuite } from '../src/suite.js';
import { GATE, loop, pct, table, type Loop, type Stage } from './history-loop.js';

/**
 * A healthy agent's goldens gated against their own history, session after session from a golden's
 * first (history-loop.ts): where the plan says a golden keeps within its share, it does, on average
 * over the sessions it says so for; where it says it can't, or has too few sessions yet to, it says
 * about as often as it goes red, or more; and a suite of them says it can't keep within its risk only
 * now and then once its record is full.
 */

describe('a healthy agent’s goldens gated against their own history, from their first session on', { timeout: 900_000 }, () => {
  const cases: Loop[] = [];
  const run = (goldens: number, rate: number, seed: number, o: { replicas: number; sessions: number }) => {
    const l = loop(goldens, rate, seed, o);
    cases.push(l);
    return l;
  };
  const stage = (l: Loop, name: string) => l.stages.find((s) => s.name === name)!;
  const healthy = (goldens: number, rate: number) => cases.find((c) => c.goldens === goldens && c.rate === rate)!;
  const holds = (l: Loop) => {
    // Where it says within, it is: its red rate, exactly, averaged over the sessions it said so for.
    for (const s of l.stages) if (s.within) expect(s.redWithin, `${l.goldens} at ${l.rate}, ${s.name}, said within`).toBeLessThanOrEqual(l.share);
    // Where it says it can't, or has too few sessions yet to, it says at least about as much as it
    // goes red, never a tenth less: over every session it said so for from the second on, and in its first.
    const later = l.stages.filter((s) => s.name !== 'session 1');
    const said = later.reduce((t, s) => t + s.plannedOver * s.over + s.plannedEarly * s.early, 0);
    const went = later.reduce((t, s) => t + s.redOver * s.over + s.redEarly * s.early, 0);
    expect(said, `${l.goldens} at ${l.rate}, said over or too few sessions yet`).toBeGreaterThanOrEqual(0.9 * went);
    const first = stage(l, 'session 1');
    expect(first.plannedEarly, `${l.goldens} at ${l.rate}, its first session`).toBeGreaterThanOrEqual(first.redEarly);
  };

  it('keeps 20 goldens within their share wherever the plan says they do, on average, and says how often they go red where it says they can’t, at 80%, 70% and 50%', () => {
    for (const [rate, seed, sessions, replicas] of [
      [0.8, 80, 40, 40],
      [0.7, 70, 30, 16],
      [0.5, 50, 30, 16],
    ] as const) {
      const l = run(20, rate, seed, { replicas, sessions });
      holds(l);
      // Its first session has no baseline: it says it has none yet, never that it keeps within.
      expect(stage(l, 'session 1').early).toBe(stage(l, 'session 1').sessions);
    }
  });

  it('and at 90%, and a single golden at 80% and at 50% within the whole 5%', () => {
    for (const [goldens, rate, seed, replicas] of [
      [20, 0.9, 90, 16],
      [1, 0.8, 18, 12],
      [1, 0.5, 15, 12],
    ] as const)
      holds(run(goldens, rate, seed, { replicas, sessions: 30 }));
  });

  it('as docs/gating.md states it', () => {
    const page = readFileSync(fileURLToPath(new URL('../../../docs/gating.md', import.meta.url)), 'utf8');
    const says = (text: string) => expect(page.includes(text), `docs/gating.md says: ${text}`).toBe(true);
    console.log(table(cases));
    // Within, on average, at 80% down to 50%, from the second session on, and how many of the sessions
    // it said so for went past the share, at those rates and at 90%. The review's loop, 400 histories a
    // rate, found at most 0.16% in any stage, and 8.6% to 11.2% of them past the share, 4.8% at 90%.
    // Histories share their baseline's luck from session to session, so these 16 to 40 are far fewer
    // than their sessions: the page states a bound they keep to, and shares they fall within.
    const said = [0.8, 0.7, 0.5].flatMap((rate) => healthy(20, rate).stages.filter((s) => s.within && s.name !== 'session 1'));
    for (const s of said) expect(s.redWithin, s.name).toBeLessThanOrEqual(0.002);
    says('where the plan says a golden of 20 keeps within its 0.25% share, it goes red at most 0.2% of the time on average over a stage of its sessions, at 80% down to 50%');
    const share = (stages: readonly Stage[]) => stages.reduce((t, s) => t + s.aboveShare, 0) / stages.reduce((t, s) => t + s.within, 0);
    const above = share(said);
    const ninety = share(healthy(20, 0.9).stages.filter((s) => s.within && s.name !== 'session 1'));
    expect(above).toBeGreaterThan(0.02);
    expect(above).toBeLessThan(0.15);
    expect(ninety).toBeLessThan(0.1);
    says('up to about one in ten of the sessions it says so for, one in twenty at 90%, against a baseline that came out lucky, go red more often than the share');
    const half = healthy(20, 0.5);
    says(`an agent at 50% goes red ${pct(stage(half, 'session 1').redEarly, 0)} of the time in its first session, where the plan says about ${pct(stage(half, 'session 1').plannedEarly, 0)}`);
    // A healthy suite at 80% from its 21st session on: the review's loop found 22% and 7%.
    const later: Stage = stage(healthy(20, 0.8), 'sessions 21-40');
    expect(later.flagged).toBeGreaterThan(0.1);
    expect(later.flagged).toBeLessThan(0.4);
    expect(later.overInFact).toBeLessThan(0.1);
    says('a healthy suite of 20 goldens at 80% states a chance past its 5% in about one session in four from the 21st to the 40th, and goes red for nothing more often than that in fewer than one in ten');
    // The first session's forecast: over the rates its recording leaves open, and what an agent at 95% and at 50% take.
    const first = planSuite(Array.from({ length: 20 }, (_, i) => ({ golden: `goldens/h${i}`, gate: GATE, maxGiven: false })))!.planned[0];
    const g = first.gate as BaselineGate;
    expect(g.max).toBe(GATE.max);
    says(`with none, over those its recording leaves open, about ${Math.round(first.attempts)} attempts where an agent at 95% takes ${Math.round(gateOdds(g, 0.95, null).attempts)} and one at 50% ${Math.round(gateOdds(g, 0.5, null).attempts)}`);
  });
});
