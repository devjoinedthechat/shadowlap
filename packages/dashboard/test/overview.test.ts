import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countOrigins, emptyOriginCounts, Store, storedModelResolver, summarizeRun } from '@shadowlap/engine';
import { overviewOptions, overviewSummary, type OverviewSummary } from '../src/overview.js';
import { addRun, blameOf, DAY, HOUR } from './read-model-store.js';

// Thursday, Oct 1 2026, 10:15 UTC (12:15 in Berlin). This week is Sep 25–Oct 1 there; last week Sep 18–24.
const NOW = Date.UTC(2026, 9, 1, 10, 15);
const at = (month: number, day: number, hour: number, minute = 0) => Date.UTC(2026, month - 1, day, hour, minute);
const TZ = 'Europe/Berlin';

let store: Store;
const id: Record<string, string> = {};
const codes: Record<string, string> = {};
let o: OverviewSummary;

const run = (name: string, spec: Parameters<typeof addRun>[1]) => {
  id[name] = addRun(store, spec);
  codes[name] = typeof spec.calls === 'string' ? spec.calls : '';
  return id[name]!;
};

beforeAll(() => {
  store = Store.open(':memory:');
  run('pack', { startedAt: at(9, 1, 9), calls: 'llll', meta: { imported: { at: at(9, 1, 9), from: 'goldens/refund' } } });
  // Last week.
  run('recLW', { startedAt: at(9, 20, 10), calls: 'llll' });
  run('forkLW', { parent: id.recLW, startedAt: at(9, 21, 10), divergence: 3, calls: 'rrll' });
  run('failedLW', { startedAt: at(9, 19, 10), status: 'failed', calls: 'llll', meta: { blame: blameOf(2, null, at(9, 20, 12)) } });
  run('testLW', { parent: id.pack, startedAt: at(9, 22, 10), status: 'failed', divergence: 1, calls: 'f', meta: { test: { golden: 'g1', session: 'a' } } });
  // This week: a family with a clean replay, a fork whose first live call missed the prompt cache, and an attempt.
  run('rec1', {
    startedAt: at(9, 30, 9),
    calls: 'l'.repeat(10),
    // Call 8 starts a new conversation (its input is smaller), and call 9 is a sub-agent's first call: neither is a miss.
    at: { 8: { code: 'l', usage: { inputTokens: 500, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }, 9: { code: 'l', scope: 'agent/policy-checker', usage: { inputTokens: 3000, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } },
  });
  run('clean1', { parent: id.rec1, startedAt: at(10, 1, 8), calls: 'r'.repeat(10) });
  run('fork1', { parent: id.rec1, startedAt: at(10, 1, 8, 30), divergence: 6, calls: 'rrrrrllllb', at: { 6: { code: 'l', usage: { inputTokens: 40, outputTokens: 60, cacheReadInputTokens: 0, cacheCreationInputTokens: 1700 } } } });
  run('rep1', { parent: id.rec1, startedAt: at(10, 1, 9), calls: 'r'.repeat(10), meta: { repeat: { group: 'g', attempt: 1, of: 1 } } });
  run('live1', { startedAt: at(10, 1, 10, 10), status: 'running', calls: 'lll' });
  // A failure blamed on Sep 29, rescued by its first probe.
  run('failed1', { startedAt: at(9, 28, 10), status: 'failed', calls: 'llllll' });
  run('probeA', { parent: id.failed1, startedAt: at(9, 29, 9), divergence: 3, calls: 'rrllll', meta: { probe: { of: id.failed1!, callNo: 3, passed: true }, repeat: { group: 'p', attempt: 1, of: 2 } } });
  run('probeB', { parent: id.failed1, startedAt: at(9, 29, 9, 5), divergence: 3, calls: 'rrllll', meta: { probe: { of: id.failed1!, callNo: 3, passed: false }, repeat: { group: 'p', attempt: 2, of: 2 } } });
  store.updateRunMeta(id.failed1!, { blame: blameOf(3, id.probeA!, at(9, 29, 10)) });
  run('test1', { parent: id.pack, startedAt: at(10, 1, 7), calls: 'rrr', meta: { test: { golden: 'g1', session: 'b' } } });
  run('test2', { parent: id.pack, startedAt: at(10, 1, 7, 1), status: 'failed', divergence: 1, calls: 'f', meta: { test: { golden: 'g2', session: 'b' } } });
  // A long run and a fork of it that overrides call #906 and blocks a write at #917.
  run('big', { startedAt: at(9, 26, 12), calls: 'l'.repeat(1200) });
  run('bigfork', { parent: id.big, startedAt: at(9, 27, 12), divergence: 906, calls: 'r'.repeat(905) + 'o' + 'l'.repeat(10) + 'b' + 'lll' });
  o = overviewSummary(store, { tz: TZ, now: NOW });
});
afterAll(() => store.close());

const sumOf = (names: string[], f: (s: ReturnType<typeof summarizeRun>) => number) => {
  const modelOf = storedModelResolver(store);
  return names.reduce((t, n) => t + f(summarizeRun(store.getRun(id[n]!)!, store.getCalls(id[n]!), [], [], { modelOf })), 0);
};
const WEEK = ['rec1', 'clean1', 'fork1', 'rep1', 'live1', 'failed1', 'probeA', 'probeB', 'test1', 'test2', 'big', 'bigfork'];
const WEEK_ROWS = WEEK.filter((n) => n !== 'rep1' && n !== 'probeB');

describe('the Overview: this week against last week', () => {
  it('takes the last seven of the viewer’s days as this week, and the seven before as last week', () => {
    expect(o.windows.week).toEqual({ from: Date.UTC(2026, 8, 24, 22), to: Date.UTC(2026, 9, 1, 22) });
    expect(o.windows.lastWeek).toEqual({ from: Date.UTC(2026, 8, 17, 22), to: Date.UTC(2026, 8, 24, 22) });
    expect(o.daily.map((d) => d.day)).toEqual(['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']);
  });

  it('counts runs and calls without attempts, and money and time with them', () => {
    const w = o.sums.week;
    expect(w.runs).toBe(WEEK_ROWS.length);
    expect(w.calls).toBe(WEEK_ROWS.reduce((t, n) => t + codes[n]!.length, 0));
    expect(w.origins).toEqual(countOrigins(WEEK_ROWS.map((n) => codes[n]).join('')));
    expect(w.attempts).toBe(2);
    expect(w.spent).toBeCloseTo(sumOf(WEEK, (s) => s.cost.spent), 10);
    expect(w.notRespent).toBeCloseTo(sumOf(WEEK, (s) => s.cost.saved), 10);
    expect(w.attemptsSpent).toBeCloseTo(sumOf(['rep1', 'probeB'], (s) => s.cost.spent), 10);
    // Every replayed call took 2 s when it was recorded (the long fork's 905 among them).
    expect(w.notWaitedMs).toBe((10 + 5 + 10 + 2 + 2 + 3 + 905) * 2000);
    expect(o.sums.lastWeek).toMatchObject({ runs: 4, calls: 13, attempts: 0, notWaitedMs: 2 * 2000 });
    expect(o.sums.lastWeek.spent).toBeCloseTo(sumOf(['recLW', 'forkLW', 'failedLW', 'testLW'], (s) => s.cost.spent), 10);
    expect(o.counts).toEqual({ runs: 15, attempts: 2 }); // 17 runs in the store, two of them attempts
  });

  it('adds up each of the last seven days', () => {
    const d = new Map(o.daily.map((x) => [x.day, x]));
    expect(o.daily.reduce((t, x) => t + x.spent, 0)).toBeCloseTo(o.sums.week.spent, 10);
    expect(o.daily.reduce((t, x) => t + x.notRespent, 0)).toBeCloseTo(o.sums.week.notRespent, 10);
    expect(d.get('2026-09-26')!.spent).toBeCloseTo(sumOf(['big'], (s) => s.cost.spent), 10);
    expect(d.get('2026-09-25')).toMatchObject({ spent: 0, notRespent: 0 });
  });
});

describe('the Overview: today', () => {
  it('says what was served from recordings today, and what ran, counting runs as the grid does', () => {
    const t = o.today;
    expect(t.day).toBe('2026-10-01');
    // The clean replay, the fork's replayed prefix and the passing test: the --repeat attempt is left out.
    expect(t.served).toBe(10 + 5 + 3);
    expect(t.notRespent).toBeCloseTo(sumOf(['clean1', 'fork1', 'test1'], (s) => s.cost.saved), 10);
    // The day's money counts the attempt as well: what it replayed was not re-spent either.
    expect(o.daily[6]!.notRespent - t.notRespent).toBeCloseTo(sumOf(['rep1'], (s) => s.cost.saved), 10);
    expect(t.recording).toEqual([{ runId: id.live1, command: 'python refund_agent.py', calls: 3, startedAt: at(10, 1, 10, 10) }]);
    expect(t.replays).toBe(1);
    expect(t.forks).toEqual({ count: 1, live: 4, blocked: 1 });
    expect(t.tests).toEqual({ count: 2, failed: 1, latestFailure: { runId: id.test2, outcome: { kind: 'diverged', callNo: 1 } } });
    expect(t.blame).toEqual({ probes: 0, attempts: 0, runs: [] });
  });

  it('counts blame probes by the call they probed, and the rescued fork once, as a fork', () => {
    const sep29 = overviewSummary(store, { tz: TZ, now: at(9, 29, 18) });
    // Two runs probed call #3: the one that rescued the run is a fork row; the other is an attempt.
    expect(sep29.today.blame).toEqual({ probes: 1, attempts: 1, runs: [{ runId: id.failed1, lostAt: 3 }] });
    expect(sep29.today.forks).toMatchObject({ count: 1 });
  });
});

describe('the Overview: this week’s runs as rows of calls', () => {
  it('groups runs under the recording they came from, newest family first', () => {
    const g = o.grid;
    expect(g.runs).toBe(WEEK_ROWS.length);
    expect(g.calls).toBe(o.sums.week.calls);
    expect(g.origins).toEqual(o.sums.week.origins);
    expect(g.families.map((f) => f.rows.map((r) => [r.runId, r.depth, r.context]))).toEqual([
      [[id.live1, 0, false]],
      [[id.rec1, 0, false], [id.clean1, 1, false], [id.fork1, 1, false]],
      // The tests replay a golden packed before this week: it heads their family as a context row.
      [[id.pack, 0, true], [id.test1, 1, false], [id.test2, 1, false]],
      [[id.failed1, 0, false], [id.probeA, 1, false]],
      [[id.big, 0, false], [id.bigfork, 1, false]],
    ]);
    expect(g.shown).toBe(10);
    expect(g.more).toBe(0);
    const probe = g.families[3]!.rows[1]!;
    expect(probe).toMatchObject({ kind: 'fork', rescues: id.failed1, outcome: { kind: 'none' } });
  });

  it('gives a family one scale of at least 30 calls, and marks where a fork left', () => {
    const fam = o.grid.families[1]!;
    expect(fam).toMatchObject({ size: 1, cols: 30 });
    expect(fam.rows.map((r) => r.cells)).toEqual(['l'.repeat(10), 'r'.repeat(10), 'rrrrrllllb']);
    expect(fam.rows[2]).toMatchObject({ forkCell: 5, origins: { ...emptyOriginCounts(), r: 5, l: 4, b: 1 } });
    expect(fam.rows[0]!.forkCell).toBeNull();
  });

  it('past 60 calls lets a cell stand for a range, showing its most notable origin', () => {
    const fam = o.grid.families[4]!;
    expect(fam).toMatchObject({ size: 20, cols: 60 });
    expect(fam.rows[0]!.cells).toBe('l'.repeat(60));
    const fork = fam.rows[1]!;
    expect(fork.cells).toHaveLength(46);
    expect(fork.cells.slice(0, 45)).toBe('r'.repeat(45));
    expect(fork.cells[45]).toBe('b'); // calls 901–920: the blocked write outranks the override and the live calls
    expect(fork.forkCell).toBe(45);
  });

  it('keeps whole families while they fit, and says how many runs it left out', () => {
    const small = overviewSummary(store, { tz: TZ, now: NOW, gridRows: 4 });
    expect(small.grid.families.map((f) => f.rows.length)).toEqual([1, 3]);
    expect(small.grid).toMatchObject({ shown: 4, more: WEEK_ROWS.length - 4 });
    const one = overviewSummary(store, { tz: TZ, now: at(9, 30, 12), gridRows: 1 });
    expect(one.grid.families).toHaveLength(1);
    expect(one.grid.families[0]!.rows).toHaveLength(1);
  });

  it('lines forks of an older recording up under it, on the recording’s scale', () => {
    const local = Store.open(':memory:');
    try {
      // Recorded twenty days ago, 44 calls; forked twice this week, and a fork of an older fork.
      const rec = addRun(local, { startedAt: NOW - 20 * DAY, calls: 'l'.repeat(44) });
      const a = addRun(local, { parent: rec, startedAt: NOW - 2 * DAY, divergence: 12, calls: 'r'.repeat(11) + 'lll' });
      const b = addRun(local, { parent: rec, startedAt: NOW - DAY, divergence: 30, calls: 'r'.repeat(29) + 'l'.repeat(9) });
      const older = addRun(local, { parent: rec, startedAt: NOW - 15 * DAY, divergence: 20, calls: 'r'.repeat(19) + 'l'.repeat(5) });
      const c = addRun(local, { parent: older, startedAt: NOW - HOUR, divergence: 22, calls: 'r'.repeat(21) + 'll' });
      const g = overviewSummary(local, { tz: TZ, now: NOW }).grid;
      expect(g.families).toHaveLength(1);
      const fam = g.families[0]!;
      // One scale: the recording's 44 calls, so each fork's replayed prefix lines up under it.
      expect(fam).toMatchObject({ size: 1, cols: 44 });
      expect(fam.rows.map((r) => [r.runId, r.depth, r.context])).toEqual([
        [rec, 0, true],
        [older, 1, true],
        [c, 2, false],
        [a, 1, false],
        [b, 1, false],
      ]);
      expect(fam.rows.find((r) => r.runId === b)).toMatchObject({ forkCell: 29, cells: 'r'.repeat(29) + 'l'.repeat(9) });
      expect(fam.rows[0]!.origins).toEqual({ ...emptyOriginCounts(), l: 44 });
      expect(g).toMatchObject({ runs: 3, shown: 3, more: 0, calls: 14 + 38 + 23 });
    } finally {
      local.close();
    }
  });
});

describe('the Overview: outcomes, the prompt cache and fixes', () => {
  it('leads with failures reproduced, tests passing and what was spent, each against last week', () => {
    expect(o.outcomes.reproduced).toEqual({ value: 1, lastWeek: 1, open: 2 });
    expect(o.outcomes.fixesVerified).toBeNull();
    expect(o.outcomes.testsPassing).toEqual({ goldens: 2, passing: 1, lastWeek: 0, regressions: 1, lastRunAt: at(10, 1, 7, 1) });
    expect(o.outcomes.spent).toEqual({ value: o.sums.week.spent, lastWeek: o.sums.lastWeek.spent, notRespent: o.sums.week.notRespent, notWaitedMs: o.sums.week.notWaitedMs });
  });

  it('finds where the prompt cache stopped hitting, and not where a conversation started over', () => {
    const c = o.cache;
    expect(c.misses).toEqual([{ runId: id.fork1, kind: 'fork', callNo: 6, scope: null, tokens: 40 + 1500 + 100 }]);
    expect(c).toMatchObject({ sentAgain: 1640, missCount: 1 });
    expect(c.cacheRead).toBeLessThan(c.input);
    expect(c.input).toBeGreaterThan(0);
  });

  it('counts every failure on its way to a fix in one unit, and the attempts behind them', () => {
    // A fix starts from a blame: until fixes group runs into failures, each blamed run is one.
    expect(o.fixes).toMatchObject({ failures: 2, blamed: 2, verified: null, applied: null, open: 2, notBlamed: 0, attempts: 2 });
    expect(o.fixes.spent).toBeCloseTo(sumOf(['probeA', 'probeB'], (s) => s.cost.spent), 10);
  });

  it('takes what the fixes, tests and run-page slices know when they hook in', () => {
    const hooked = overviewSummary(store, {
      tz: TZ,
      now: NOW,
      hooks: {
        fixes: () => ({ failures: 3, blamed: 3, verified: 2, applied: 1, open: 1, accepted: 3, acceptedLastWeek: 1, rejected: 1 }),
        tests: () => ({ goldens: 4, passing: 3, lastWeek: 4, regressions: 1, lastRunAt: 5 }),
        cache: (ids) => ({ input: ids.length, cacheRead: 0, misses: [], sentAgain: 0, missCount: 0 }),
      },
    });
    expect(hooked.outcomes.fixesVerified).toEqual({ value: 3, lastWeek: 1, rejected: 1 });
    expect(hooked.outcomes.reproduced.open).toBe(1);
    expect(hooked.fixes).toMatchObject({ failures: 3, blamed: 3, verified: 2, applied: 1, open: 1 });
    expect(hooked.outcomes.testsPassing).toEqual({ goldens: 4, passing: 3, lastWeek: 4, regressions: 1, lastRunAt: 5 });
    expect(hooked.cache.input).toBe(WEEK_ROWS.length);
  });

  it('counts failed runs no blame has looked at, tests aside, for Needs a look', () => {
    const local = Store.open(':memory:');
    try {
      addRun(local, { startedAt: NOW - HOUR, status: 'failed', calls: 'll' });
      addRun(local, { startedAt: NOW - 2 * HOUR, status: 'failed', calls: 'll', meta: { blame: blameOf(1, null, NOW - HOUR) } });
      const pack = addRun(local, { startedAt: NOW - 9 * DAY, calls: 'l', meta: { imported: { at: NOW - 9 * DAY, from: 'goldens/g' } } });
      addRun(local, { parent: pack, startedAt: NOW - HOUR, status: 'failed', divergence: 1, calls: 'f', meta: { test: { golden: 'goldens/g', session: 's' } } });
      expect(overviewSummary(local, { tz: 'UTC', now: NOW }).fixes).toMatchObject({ failures: 1, blamed: 1, open: 1, notBlamed: 1 });
    } finally {
      local.close();
    }
  });

  it('says a golden passes only when enough attempts of its latest session passed, and an interrupted one did not', () => {
    const local = Store.open(':memory:');
    try {
      const pack = addRun(local, { startedAt: NOW - 30 * DAY, calls: 'll', meta: { imported: { at: NOW - 30 * DAY, from: 'goldens/g' } } });
      const test = (golden: string, session: string, startedAt: number, status: 'completed' | 'failed' | 'crashed', passes?: number) =>
        addRun(local, { parent: pack, startedAt, status, calls: 'rr', meta: { test: { golden, session, ...(passes ? { passes } : {}) } as never } });
      // Last week: g1 passed, g2 timed out (interrupted). This week: g1 passed 2 of 3 with 2 needed;
      // g2 passed 2 of 3 with all needed; g3's only attempt was interrupted.
      test('g1', 'a', NOW - 9 * DAY, 'completed');
      test('g2', 'a', NOW - 9 * DAY, 'crashed');
      for (const [i, st] of (['completed', 'failed', 'completed'] as const).entries()) test('g1', 'b', NOW - HOUR + i, st, 2);
      for (const [i, st] of (['completed', 'completed', 'failed'] as const).entries()) test('g2', 'b', NOW - HOUR + i, st);
      test('g3', 'b', NOW - HOUR + 9, 'crashed');
      expect(overviewSummary(local, { tz: 'UTC', now: NOW }).outcomes.testsPassing).toEqual({ goldens: 3, passing: 1, lastWeek: 1, regressions: 2, lastRunAt: NOW - HOUR + 9 });
    } finally {
      local.close();
    }
  });

  it('says there are no goldens yet rather than zero passing', () => {
    const empty = Store.open(':memory:');
    const none = Store.open(':memory:');
    try {
      addRun(empty, { startedAt: NOW - HOUR, calls: 'll' });
      const s = overviewSummary(empty, { tz: 'UTC', now: NOW });
      expect(s.outcomes.testsPassing).toBeNull();
      expect(s.cache).toEqual({ input: s.cache.input, cacheRead: s.cache.cacheRead, misses: [], sentAgain: 0, missCount: 0 });
      expect(overviewSummary(none, { now: NOW }).grid).toMatchObject({ runs: 0, families: [], shown: 0, more: 0 });
    } finally {
      empty.close();
      none.close();
    }
  });

  it('refuses a time zone it does not know', () => {
    expect(() => overviewSummary(store, { tz: 'Mars/Olympus' })).toThrow(RangeError);
    expect(overviewOptions(new URLSearchParams('tz=Asia/Tokyo'))).toEqual({ tz: 'Asia/Tokyo' });
    expect(overviewOptions(new URLSearchParams('tz=nowhere'))).toMatchObject({ error: expect.stringContaining('time zone') });
    expect(overviewOptions(new URLSearchParams(''))).toEqual({});
  });
});
