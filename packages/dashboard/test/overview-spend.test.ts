import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { overviewSummary } from '../src/overview.js';
import { addRun, DAY, HOUR } from './read-model-store.js';

/**
 * Spent live holds what was spent on calls that are no run, on the day each was made: a preview's and
 * a migration's asking and judging, and a repairer's own answer. What they replayed is runs, so it is
 * never added twice.
 */

// Thursday, Oct 1 2026, 10:15 UTC: this week is Sep 25–Oct 1, last week Sep 18–24.
const NOW = Date.UTC(2026, 9, 1, 10, 15);

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => store.close());

const summary = () => overviewSummary(store, { tz: 'UTC', now: NOW });
const session = (sessionId: string, kind: 'decisions' | 'migrate', at: number, data: Record<string, unknown>) => store.putDecisionSession({ sessionId, kind, at, change: 'the model m', actor: null, revision: null, data, runs: [] });

describe('Spent live', () => {
  it('adds what previews and migrations spent asking and judging to the week and the day they were kept, never their verify', () => {
    const rec = addRun(store, { startedAt: NOW - 2 * DAY, calls: 'llll' });
    const before = summary();
    expect(before.sums.week.spent).toBeGreaterThan(0);
    // The preview's verify replayed a run: that run's spend is the week's already, once.
    addRun(store, { parent: rec, startedAt: NOW - HOUR, calls: 'rrll', meta: { repeat: { group: 'v', attempt: 1, of: 1 } } });
    const withVerify = summary().sums.week.spent;
    expect(withVerify).toBeGreaterThan(before.sums.week.spent);
    session('dc-01M50000000000000000000001', 'decisions', NOW - HOUR, { cost: { spent: 0.25 }, judge: { spent: 0.05 }, verify: { spent: 40 } });
    session('mg-01M50000000000000000000002', 'migrate', NOW - 3 * DAY, { costs: { checking: { decisions: 0.5, judge: 0.125, verify: 30 } } });
    session('dc-01M50000000000000000000003', 'decisions', NOW - 9 * DAY, { cost: { spent: 2 } });
    const after = summary();
    expect(after.sums.week.spent).toBeCloseTo(withVerify + 0.3 + 0.625, 10);
    expect(after.sums.lastWeek.spent).toBeCloseTo(before.sums.lastWeek.spent + 2, 10);
    // Each on its day's bar, and the outcome the header states.
    expect(after.daily[6].spent - summaryDay(before, 6)).toBeCloseTo(withVerify - before.sums.week.spent + 0.3, 10);
    expect(after.daily[3].spent - summaryDay(before, 3)).toBeCloseTo(0.625, 10);
    expect(after.outcomes.spent).toMatchObject({ value: after.sums.week.spent, lastWeek: after.sums.lastWeek.spent });
  });

  it('adds a repair’s own model on the repair’s day, and nothing for its blame and verify, whose attempts are runs', () => {
    const failed = addRun(store, { startedAt: NOW - 2 * DAY, status: 'failed', calls: 'llll' });
    const base = summary().sums.week.spent;
    // Its candidate's verify: an attempt bundled under the failed run, spending live.
    addRun(store, { parent: failed, startedAt: NOW - DAY, calls: 'rrll', meta: { repeat: { group: 'verify', attempt: 1, of: 1 } } });
    const attempts = summary().sums.week.spent - base;
    expect(attempts).toBeGreaterThan(0);
    // The repair's report counts blame and verify again (fixCost's figure); only the repairer is no run.
    store.putRepair({ repairId: 'repair-1', at: NOW - DAY, dir: '.shadowlap/repairs/repair-1', outcome: 'fixed', accepted: true, report: { candidates: [], cost: { blame: 5, repairer: 0.4, verify: attempts } } as never, expect: null, command: 'shadowlap repair' });
    // A repairer with no price adds nothing.
    store.putRepair({ repairId: 'repair-2', at: NOW - DAY, dir: '.shadowlap/repairs/repair-2', outcome: 'not-fixed', accepted: false, report: { candidates: [], cost: { blame: 1, repairer: null, verify: 0 } } as never, expect: null, command: 'shadowlap repair' });
    const after = summary();
    expect(after.sums.week.spent).toBeCloseTo(base + attempts + 0.4, 10);
    expect(after.daily[5].spent).toBeCloseTo(attempts + 0.4, 10);
  });
});

const summaryDay = (s: ReturnType<typeof summary>, i: number) => s.daily[i].spent;
