import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COUNTS_AT } from '../src/suite.js';
import { loop, pct, type Loop } from './history-loop.js';

/**
 * What docs/gating.md says of goldens with too few sessions for an inconclusive to count by default,
 * from the seeded loops of history-loop.ts: a healthy suite's first 20 sessions, an agent that drops
 * after its goldens' 15th session, and the same drop after their 30th. Each figure is over 400
 * histories, which take minutes to run, too long for every test run: `node scripts/gating-figures.mjs`
 * runs them and keeps them in gating-figures.json. This test holds the page to that file, and the file
 * to the code: each loop's first 10 histories, run again, come out as the file keeps them only while
 * the planner, the rule that counts a young golden's inconclusive (`COUNTS_AT`) and the loop are as
 * they were when it was written.
 */

const FILE = fileURLToPath(new URL('./gating-figures.json', import.meta.url));
/** Where the script has the figures written, outside the checkout, which a test leaves as it found it. */
const WRITE = process.env.SHADOWLAP_GATING_FIGURES;
/** Histories a figure is over, and those each test run works out again to hold the file to the code. */
const HISTORIES = 400;
const PINNED = 10;

/** The drops the page gives, each with its loop's seed: from 95% to 75% after the 30th session too. */
const YOUNG = [
  { name: '95-75', rate: 0.95, to: 0.75, seed: 1575 },
  { name: '90-70', rate: 0.9, to: 0.7, seed: 1570 },
  { name: '95-60', rate: 0.95, to: 0.6, seed: 1560 },
] as const;
const MATURE = { rate: 0.95, to: 0.75, seed: 9575 } as const;

interface Ended {
  /** Over the 10 sessions after the drop, on average: red by default, red under --inconclusive fail, inconclusive and only warning, passed. */
  red: number;
  counted: number;
  warned: number;
  passed: number;
}

interface Figures {
  /** A healthy suite of 20 goldens at 80%, its sessions from the 2nd to the 10th and from the 11th to the 20th: red by default, and with every inconclusive counted. */
  healthy: { byDefault: [number, number]; counted: [number, number] };
  /** A drop after their 15th session, by its name. */
  young: Record<(typeof YOUNG)[number]['name'], Ended>;
  /** The drop from 95% to 75% after their 30th session. */
  mature: Ended;
}

interface Kept {
  histories: number;
  countsAt: number;
  figures: Figures;
  /** The same over the first `histories` of each loop. */
  pinned: { histories: number; figures: Figures };
}

const ended = (l: Loop): Ended => {
  const mean = (f: (a: Loop['after'][number]) => number) => l.after.reduce((t, a) => t + f(a), 0) / l.after.length;
  return { red: mean((a) => a.red), counted: mean((a) => a.counted), warned: mean((a) => a.warned), passed: mean((a) => a.passed) };
};

/** Every figure, over the first `histories` of each loop. */
function figuresOver(histories: number): Figures {
  const healthy = loop(20, 0.8, 80, { replicas: histories, sessions: 20 });
  const stage = (name: string) => healthy.stages.find((s) => s.name === name)!;
  const young = Object.fromEntries(YOUNG.map((y) => [y.name, ended(loop(20, y.rate, y.seed, { replicas: histories, sessions: 25, drop: { at: 15, to: y.to } }))])) as Figures['young'];
  return {
    healthy: { byDefault: [stage('sessions 2-10').suiteRed, stage('sessions 11-20').suiteRed], counted: [stage('sessions 2-10').suiteRedCounted, stage('sessions 11-20').suiteRedCounted] },
    young,
    mature: ended(loop(20, MATURE.rate, MATURE.seed, { replicas: histories, sessions: 40, drop: { at: 30, to: MATURE.to } })),
  };
}

/** The sentences docs/gating.md carries, from the figures over `histories` each. */
function sentences(f: Figures, histories: number): string[] {
  const percent = (x: number) => `${Math.round(100 * x)}%`;
  const drops = YOUNG.map((y) => {
    const e = f.young[y.name];
    return `from ${Math.round(100 * y.rate)}% to ${Math.round(100 * y.to)}%: red by default in ${percent(e.red)} of them, ${percent(e.counted)} under \`--inconclusive fail\`, warned in ${percent(e.warned)} and passed in ${percent(e.passed)}`;
  });
  const green = f.young['95-75'].passed + f.young['95-75'].warned;
  return [
    `In the same loops, over ${histories} histories each, a healthy suite of 20 goldens at 80% goes red for nothing in ${pct(f.healthy.byDefault[0], 1)} of its sessions from the 2nd to the 10th and ${pct(f.healthy.byDefault[1], 1)} from the 11th to the 20th, against ${pct(f.healthy.counted[0], 1)} and ${pct(f.healthy.counted[1], 1)} with every inconclusive counted, as \`--inconclusive fail\` counts it.`,
    `When the agent behind 20 goldens drops after their 15th session, the 10 sessions after it come out, over ${histories} histories, ${drops.join('; ')}.`,
    `A young golden's green is weaker evidence of no drop than a mature one's: after the drop from 95% to 75%, a golden with 15 sessions stays green in ${percent(green)} of the 10 sessions after it, one with 30 in ${percent(f.mature.passed)}.`,
  ];
}

describe('the figures docs/gating.md gives for goldens with too few sessions for an inconclusive to count', { timeout: WRITE ? 14_400_000 : 900_000 }, () => {
  it.runIf(WRITE)(`works them out over ${HISTORIES} histories each, and over the first ${PINNED} that hold them to the code`, () => {
    const kept: Kept = { histories: HISTORIES, countsAt: COUNTS_AT, figures: figuresOver(HISTORIES), pinned: { histories: PINNED, figures: figuresOver(PINNED) } };
    writeFileSync(WRITE!, `${JSON.stringify(kept, null, 2)}\n`);
    console.log(sentences(kept.figures, kept.histories).join('\n'));
    // A young golden's green says less than a mature one's: after the same drop, it is green more often.
    expect(kept.figures.young['95-75'].passed + kept.figures.young['95-75'].warned).toBeGreaterThan(kept.figures.mature.passed);
  });

  it.skipIf(WRITE)(`keeps figures the code still gives: the first ${PINNED} histories of each loop come out as the file keeps them, at the rule's 99 to 1`, () => {
    const kept = JSON.parse(readFileSync(FILE, 'utf8')) as Kept;
    const again = 'run node scripts/gating-figures.mjs, and put what it prints in docs/gating.md';
    // Worked out under the round-5 rule, which counts a young golden's inconclusive at 99 to 1.
    expect(kept.countsAt, `COUNTS_AT changed: ${again}`).toBe(COUNTS_AT);
    expect(kept.histories).toBeGreaterThanOrEqual(200);
    const now = figuresOver(kept.pinned.histories);
    const flat = (f: Figures) => [...f.healthy.byDefault, ...f.healthy.counted, ...YOUNG.flatMap((y) => Object.values(f.young[y.name])), ...Object.values(f.mature)];
    const was = flat(kept.pinned.figures);
    for (const [i, x] of flat(now).entries()) expect(x, `the loops come out otherwise than when gating-figures.json was written: ${again}`).toBeCloseTo(was[i], 10);
  });

  it.skipIf(WRITE)('as docs/gating.md states them', () => {
    const page = readFileSync(fileURLToPath(new URL('../../../docs/gating.md', import.meta.url)), 'utf8');
    const kept = JSON.parse(readFileSync(FILE, 'utf8')) as Kept;
    for (const text of sentences(kept.figures, kept.histories)) expect(page.includes(text), `docs/gating.md says: ${text}`).toBe(true);
    // A young golden's green says less than a mature one's: after the same drop, it is green more often.
    expect(kept.figures.young['95-75'].passed + kept.figures.young['95-75'].warned).toBeGreaterThan(kept.figures.mature.passed);
  });
});
