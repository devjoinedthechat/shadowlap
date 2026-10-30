import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gateOdds, type BaselineGate } from '../src/stats.js';
import { planSuite } from '../src/suite.js';
import { GATE, loop, pct, table, type Loop, type Stage } from './history-loop.js';

/**
 * A healthy agent's goldens gated against their own history, session after session from a golden's
 * first (history-loop.ts), both ways a session counts an inconclusive: every one, as under
 * `--inconclusive fail`, and as `shadowlap test` does with none given, where a golden with fewer than
 * 30 sessions runs the same attempts but goes red only by failing. Where the plan says a golden keeps
 * within its share, it does, on average over the sessions it says so for; where it says it can't, or
 * has too few sessions yet to, it says about as often as it goes red, or more; and a suite of them says
 * it can't keep within its risk only now and then once its record is full.
 */

/** Each loop's seed, histories and sessions: a suite of 20 at 80% for 40 sessions, the rest for 30. */
const SIZES = new Map<string, { seed: number; replicas: number; sessions: number }>([
  ['20 0.8', { seed: 80, replicas: 40, sessions: 40 }],
  ['20 0.7', { seed: 70, replicas: 16, sessions: 30 }],
  ['20 0.5', { seed: 50, replicas: 16, sessions: 30 }],
  ['20 0.9', { seed: 90, replicas: 16, sessions: 30 }],
  ['1 0.8', { seed: 18, replicas: 12, sessions: 30 }],
  ['1 0.5', { seed: 15, replicas: 12, sessions: 30 }],
]);

describe('a healthy agent’s goldens gated against their own history, from their first session on', { timeout: 900_000 }, () => {
  // Each loop runs once, when a test first asks for it: with every inconclusive counted, or by default.
  const cases = new Map<string, Loop>();
  const healthy = (goldens: number, rate: number, counted = false): Loop => {
    const key = `${goldens} ${rate} ${counted}`;
    let l = cases.get(key);
    if (!l) {
      const { seed, ...size } = SIZES.get(`${goldens} ${rate}`)!;
      l = loop(goldens, rate, seed, { ...size, ...(counted ? { inconclusive: 'fail' as const } : {}) });
      cases.set(key, l);
    }
    return l;
  };
  const stage = (l: Loop, name: string) => l.stages.find((s) => s.name === name)!;
  // Stages taken together, each suite of them once.
  const merged = (l: Loop, names: readonly string[]) => {
    const xs = names.map((name) => stage(l, name));
    const suites = xs.reduce((t, s) => t + s.suites, 0);
    const of = (f: (s: Stage) => number) => xs.reduce((t, s) => t + f(s) * s.suites, 0) / suites;
    return { flagged: of((s) => s.flagged), overInFact: of((s) => s.overInFact), suiteRed: of((s) => s.suiteRed) };
  };
  const holds = (l: Loop) => {
    const which = `${l.goldens} at ${l.rate}${l.counted ? ', every inconclusive counted' : ''}`;
    // Where it says within, it is: its red rate, exactly, averaged over the sessions it said so for.
    for (const s of l.stages) if (s.within) expect(s.redWithin, `${which}, ${s.name}, said within`).toBeLessThanOrEqual(l.share);
    // Where it says it can't, or has too few sessions yet to, it says at least about as much as it
    // goes red, never a tenth less: over every session it said so for from the second on, and in its first.
    const later = l.stages.filter((s) => s.name !== 'session 1');
    const said = later.reduce((t, s) => t + s.plannedOver * s.over + s.plannedEarly * s.early, 0);
    const went = later.reduce((t, s) => t + s.redOver * s.over + s.redEarly * s.early, 0);
    expect(said, `${which}, said over or too few sessions yet`).toBeGreaterThanOrEqual(0.9 * went);
    const first = stage(l, 'session 1');
    expect(first.plannedEarly, `${which}, its first session`).toBeGreaterThanOrEqual(first.redEarly);
  };

  it('with every inconclusive counted, keeps 20 goldens within their share wherever the plan says they do, on average, and says how often they go red where it says they can’t, at 80%, 70% and 50%', () => {
    for (const rate of [0.8, 0.7, 0.5]) {
      const l = healthy(20, rate, true);
      holds(l);
      // Its first session has no baseline: it says it has none yet, never that it keeps within.
      expect(stage(l, 'session 1').early).toBe(stage(l, 'session 1').sessions);
    }
  });

  it('and at 90%, and a single golden at 80% and at 50% within the whole 5%', () => {
    for (const [goldens, rate] of [
      [20, 0.9],
      [1, 0.8],
      [1, 0.5],
    ] as const)
      holds(healthy(goldens, rate, true));
  });

  it('by default, runs the attempts --inconclusive fail runs, and a golden with fewer than 30 sessions goes red only by failing, within its share where the plan says so, and a healthy suite far less often in its first 20 sessions', () => {
    for (const [goldens, rate] of [
      [20, 0.8],
      [20, 0.5],
      [1, 0.8],
      [1, 0.5],
    ] as const) {
      const l = healthy(goldens, rate);
      // The same gates as with every inconclusive counted, so the same attempts: counted against them, exactly what --inconclusive fail goes red for.
      const counted = healthy(goldens, rate, true);
      for (const s of l.stages) expect(s.redCounted, `${goldens} at ${rate}, ${s.name}`).toBe(stage(counted, s.name).red);
      holds(l);
      // Its first session has no baseline, and its inconclusive only warns: it goes red only by failing, well within its share.
      expect(stage(l, 'session 1').red, `${goldens} at ${rate}, its first session`).toBeLessThanOrEqual(l.share / 10);
    }
    const byDefault = healthy(20, 0.8);
    const counted = healthy(20, 0.8, true);
    expect(stage(byDefault, 'sessions 2-10').suiteRed).toBeLessThan(stage(counted, 'sessions 2-10').suiteRed / 10);
    expect(stage(byDefault, 'sessions 11-20').suiteRed).toBeLessThan(stage(counted, 'sessions 11-20').suiteRed / 2);
    // From its 31st session on, every inconclusive counts, and it goes red exactly as under --inconclusive fail.
    expect(stage(byDefault, 'sessions 31-40').suiteRed).toBe(stage(counted, 'sessions 31-40').suiteRed);
  });

  it('as docs/gating.md states it', () => {
    const page = readFileSync(fileURLToPath(new URL('../../../docs/gating.md', import.meta.url)), 'utf8');
    const says = (text: string) => expect(page.includes(text), `docs/gating.md says: ${text}`).toBe(true);
    // The loops it reads, as the log shows them.
    for (const rate of [0.8, 0.7, 0.5, 0.9]) healthy(20, rate, true);
    for (const rate of [0.8, 0.5]) healthy(20, rate);
    console.log(table([...cases.values()]));
    // Within, on average, at 80% down to 50%, from the second session on, either way; and how many of
    // the sessions it said so for went past the share, at those rates and at 90%, every inconclusive
    // counted. The review's loop, 400 histories a rate, found at most 0.16% in any stage, and 8.6% to
    // 11.2% of them past the share, 4.8% at 90%. Histories share their baseline's luck from session to
    // session, so these 16 to 40 are far fewer than their sessions: the page states a bound they keep
    // to, and shares they fall within.
    const within = (l: Loop) => l.stages.filter((s) => s.within && s.name !== 'session 1');
    for (const l of [...[0.8, 0.7, 0.5].map((rate) => healthy(20, rate, true)), healthy(20, 0.8), healthy(20, 0.5)]) for (const s of within(l)) expect(s.redWithin, `${l.rate}, ${s.name}`).toBeLessThanOrEqual(0.002);
    says('where the plan says a golden of 20 keeps within its 0.25% share, it goes red at most 0.2% of the time on average over a stage of its sessions, at 80% down to 50%');
    const share = (stages: readonly Stage[]) => stages.reduce((t, s) => t + s.aboveShare, 0) / stages.reduce((t, s) => t + s.within, 0);
    const above = share([0.8, 0.7, 0.5].flatMap((rate) => within(healthy(20, rate, true))));
    const ninety = share(within(healthy(20, 0.9, true)));
    expect(above).toBeGreaterThan(0.02);
    expect(above).toBeLessThan(0.15);
    expect(ninety).toBeLessThan(0.1);
    says('with every inconclusive counted, up to about one in ten of the sessions it says so for, one in twenty at 90%, against a baseline that came out lucky, go red more often than the share');
    // The first session, every inconclusive counted: nearly all of it inconclusive, which by default only warns.
    const half = healthy(20, 0.5, true);
    expect(stage(healthy(20, 0.5), 'session 1').red).toBeLessThan(stage(half, 'session 1').redEarly / 100);
    says(`with every inconclusive counted, an agent at 50% goes red ${pct(stage(half, 'session 1').redEarly, 0)} of the time in its first session, where the plan says about ${pct(stage(half, 'session 1').plannedEarly, 0)}, nearly all of it inconclusive`);
    // Its first 20 sessions by default and with every inconclusive counted: over 400 histories, gating-figures.test.ts.
    const counted = healthy(20, 0.8, true);
    // A healthy suite at 80% from its 21st session on, every inconclusive counted: the review's loop found 22% and 7%.
    const later = merged(counted, ['sessions 21-30', 'sessions 31-40']);
    expect(later.flagged).toBeGreaterThan(0.1);
    expect(later.flagged).toBeLessThan(0.4);
    expect(later.overInFact).toBeLessThan(0.1);
    says('with every inconclusive counted, a healthy suite of 20 goldens at 80% states a chance past its 5% in about one session in four from the 21st to the 40th, and goes red for nothing more often than that in fewer than one in ten');
    // The first session's forecast: over the rates its recording leaves open, and what an agent at 95% and at 50% take.
    const first = planSuite(Array.from({ length: 20 }, (_, i) => ({ golden: `goldens/h${i}`, gate: GATE, maxGiven: false })))!.planned[0];
    const g = first.gate as BaselineGate;
    expect(g.max).toBe(GATE.max);
    says(`with none, over those its recording leaves open, about ${Math.round(first.attempts)} attempts where an agent at 95% takes ${Math.round(gateOdds(g, 0.95, null).attempts)} and one at 50% ${Math.round(gateOdds(g, 0.5, null).attempts)}`);
  });
});
