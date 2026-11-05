import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_COMMAND, Store } from '@shadowlap/engine';
import { loadRunIndex } from '../src/run-index.js';
import { judgeFor } from '../src/run-outcome.js';
import { fixedByOf, termReads, type JudgeRun } from '../src/runs-filter.js';
import { listRunsPage, recentRuns, runsByDay, type RunRow } from '../src/runs-list.js';
import { addRun, DAY, HOUR } from './read-model-store.js';

/**
 * What the lists count as failed besides a run's own outcome: a capture its import judged failed, and
 * not a failed test replay its golden's next replay passed, which is fixed by that run. The Failed
 * chip, `types=failed`, the days' failures and each row's `failed` read the same set.
 */

const NOW = Date.UTC(2026, 9, 1, 10, 15);
const MIN = 60_000;
const failedCheck = { status: 'failed' as const, ok: false, label: 'every issue_refund call: amount <= 100', detail: 'issue_refund #1: amount 240' };

let store: Store;
const id: Record<string, string> = {};

beforeAll(() => {
  store = Store.open(':memory:');
  const imported = (verdict: 'passed' | 'failed', at: number) =>
    addRun(store, { startedAt: at, argv: [NO_COMMAND], calls: 'll', meta: { imported: { at, from: '/work/cap.jsonl' }, covers: ['api'], judged: { rules: 'r', at, verdict, why: null, checks: [verdict === 'failed' ? failedCheck : { ...failedCheck, status: 'passed', ok: true, detail: null }] } } as never });
  id.capFailed = imported('failed', NOW - 2 * HOUR);
  id.capPassed = imported('passed', NOW - 3 * HOUR);
  id.pack = addRun(store, { startedAt: NOW - 5 * DAY, calls: 'llll', meta: { imported: { at: NOW - 5 * DAY, from: 'goldens/refund' } } });
  const test = (golden: string, at: number, failed: boolean) =>
    addRun(store, { parent: id.pack, startedAt: at, calls: failed ? 'f' : 'rrrr', ...(failed ? { status: 'failed' as const, divergence: 1 } : {}), meta: { test: { golden, session: `s-${at}` } } });
  id.diverged = test('goldens/refund', NOW - 4 * HOUR, true);
  id.passing = test('goldens/refund', NOW - HOUR, false);
  id.still = test('goldens/refund-over', NOW - 4 * HOUR + MIN, true);
  const session = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], startedAt: NOW - 4 * HOUR }).sessionId;
  store.addTestResult({ sessionId: session, golden: 'goldens/refund', ok: false, failure: 'diverged', runId: id.diverged, at: NOW - 4 * HOUR + 2 * MIN });
  store.addTestResult({ sessionId: session, golden: 'goldens/refund-over', ok: false, failure: 'diverged', runId: id.still, at: NOW - 4 * HOUR + 3 * MIN });
  const again = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/refund'], startedAt: NOW - HOUR }).sessionId;
  store.addTestResult({ sessionId: again, golden: 'goldens/refund', ok: true, runId: id.passing, at: NOW - HOUR + MIN });
});
afterAll(() => store.close());

const rowsOf = (rows: RunRow[]) => new Map(rows.map((r) => [r.runId, r]));

describe('a capture its import judged failed', () => {
  it('is failed in the table, the chip, the Failed filter and the days, and one it judged passing is not', () => {
    const page = listRunsPage(store, { limit: 500 });
    const rows = rowsOf(page.runs);
    expect(rows.get(id.capFailed)).toMatchObject({ failed: true });
    expect(rows.get(id.capPassed)).toMatchObject({ failed: false });
    const failedOnly = listRunsPage(store, { limit: 500, types: ['failed'] }).runs.map((r) => r.runId);
    expect(failedOnly).toContain(id.capFailed);
    expect(failedOnly).not.toContain(id.capPassed);
    expect(page.chipCounts.failed).toBe(failedOnly.length);
    expect(runsByDay(store, { tz: 'UTC', now: NOW }).totals.failed).toBe(failedOnly.length);
  });

  it('is read from the verdict it kept, with no call read', () => {
    expect(loadRunIndex(store).byId.get(id.capFailed)!.meta.judged).toBe('failed');
    expect(loadRunIndex(store).byId.get(id.capPassed)!.meta.judged).toBe('passed');
    expect(loadRunIndex(store).byId.get(id.pack)!.meta.judged).toBeNull();
  });
});

describe('a failed test replay its golden passed since', () => {
  it('is fixed by the run that passed, and only while that run is newer than it', () => {
    const fixed = fixedByOf(store, loadRunIndex(store));
    expect(fixed.get(id.diverged)).toBe(id.passing);
    expect(fixed.has(id.still)).toBe(false);
    expect(fixed.has(id.passing)).toBe(false);
  });

  it('leaves Failed, the chip and the days, and its row names the run that passed', () => {
    const page = listRunsPage(store, { limit: 500 });
    const rows = rowsOf(page.runs);
    expect(rows.get(id.diverged)).toMatchObject({ failed: false, fixedBy: id.passing });
    expect(rows.get(id.still)).toMatchObject({ failed: true });
    expect(rows.get(id.still)!.fixedBy).toBeUndefined();
    const failedOnly = listRunsPage(store, { limit: 500, types: ['failed'] }).runs.map((r) => r.runId);
    expect(failedOnly).toEqual(expect.arrayContaining([id.still, id.capFailed]));
    expect(failedOnly).not.toContain(id.diverged);
    expect(page.chipCounts.failed).toBe(2);
    expect(runsByDay(store, { tz: 'UTC', now: NOW }).totals.failed).toBe(2);
  });

  it('says the same in the sidebar, whose rows read the same set', () => {
    const rows = rowsOf(recentRuns(store));
    expect(rows.get(id.diverged)).toMatchObject({ failed: false, fixedBy: id.passing });
  });

  it('is failed again once the run that passed is gone', () => {
    const local = Store.open(':memory:');
    try {
      const pack = addRun(local, { startedAt: NOW - DAY, calls: 'll' });
      const failed = addRun(local, { parent: pack, startedAt: NOW - 3 * HOUR, status: 'failed', divergence: 1, calls: 'f', meta: { test: { golden: 'g', session: 's1' } } });
      const passed = addRun(local, { parent: pack, startedAt: NOW - 2 * HOUR, calls: 'rr', meta: { test: { golden: 'g', session: 's2' } } });
      const s = local.startTestSession({ command: ['shadowlap', 'test', 'g'], startedAt: NOW - 2 * HOUR }).sessionId;
      local.addTestResult({ sessionId: s, golden: 'g', ok: true, runId: passed, at: NOW - 2 * HOUR + MIN });
      expect(rowsOf(listRunsPage(local, { limit: 50 }).runs).get(failed)).toMatchObject({ failed: false, fixedBy: passed });
      local.deleteRun(passed);
      expect(rowsOf(listRunsPage(local, { limit: 50 }).runs).get(failed)).toMatchObject({ failed: true });
    } finally {
      local.close();
    }
  });
});

describe('the filter’s status:', () => {
  const ids = (q: string) => listRunsPage(store, { limit: 500, q, judge: judgeFor(store, null) }).runs.map((r) => r.runId);

  it('reads a capture’s kept verdict, and a failed test replay fixed since as no verdict, as Status says them', () => {
    expect(ids('status:failed').sort()).toEqual([id.capFailed, id.still].sort());
    expect(ids('status:passed')).toContain(id.capPassed);
    expect(ids('status:passed')).not.toContain(id.diverged);
    expect(runsByDay(store, { tz: 'UTC', now: NOW, q: 'status:failed', judge: judgeFor(store, null) }).totals.runs).toBe(2);
  });

  it('judges the runs whose calls it must read while they fit its budget, newest first, and says how many it knows', () => {
    const index = loadRunIndex(store);
    const read: string[] = [];
    // Each run's calls must be read to judge it.
    const judge: JudgeRun = (runId, quick) => {
      if (quick) return undefined;
      read.push(runId);
      return { by: 'own', verdict: 'failed' };
    };
    const reads = termReads(store, index, { q: 'status:failed', judge }, 5);
    const runs = index.runs.filter((r) => !r.bundled);
    const matched = runs.filter((r) => reads.verdict!(r) === 'failed').map((r) => r.runId);
    // 4 calls, then 1: the runs between are past what was left, and match nothing yet.
    expect(read).toEqual([id.passing, id.still]);
    expect(matched).toEqual([id.passing, id.still]);
    expect(reads.warming()).toEqual({ done: 2, total: runs.length, what: 'verdicts' });
    // Without a status: term nothing is judged.
    expect(termReads(store, index, { q: 'refund', judge }, 5).verdict).toBeUndefined();
  });
});
