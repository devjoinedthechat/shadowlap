import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NO_COMMAND, Store } from '@shadowlap/engine';
import { loadRunIndex, type IndexedRun } from '../src/run-index.js';
import { judgeFor, JUDGED_KEPT } from '../src/run-outcome.js';
import { judgedCanChange, verdictOf, type VerdictJudged, type VerdictRun } from '../src/run-verdict.js';
import { fixedByOf, STATUS_JUDGED_RUNS, termReads, type JudgeRun } from '../src/runs-filter.js';
import { listRunsPage, matchingRuns, recentRuns, runsByDay, type RunRow } from '../src/runs-list.js';
import { addRun, DAY, HOUR } from './read-model-store.js';

/**
 * What the lists count as failed besides a run's own outcome: a capture its import judged failed, and
 * not a failed test replay its golden's next replay passed, which is fixed by that run; and, where a
 * read passes the judge, a run its family's checks fail today. The Failed chip, `types=failed` and the
 * days' failures read one set: each row's `failed`, and the runs that fail only their family's checks,
 * whose rows keep their own outcome.
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
    // 4 calls: the runs after it are past what was left, and match nothing yet. A diverged run, and
    // one fixed since, need nothing judged: their outcome decides them.
    expect(read).toEqual([id.passing]);
    expect(matched).toEqual([id.passing, id.still]);
    expect(reads.warming()).toEqual({ done: 3, total: runs.length, what: 'verdicts' });
    // None has more calls than a read judges: none waits for a job after the read.
    expect(reads.judgeAfter()).toBeNull();
    // Without a status: term there is no verdict to match, and nothing is judged until Failed asks of a run.
    const plain = termReads(store, index, { q: 'refund', judge }, 5);
    expect(plain.verdict).toBeUndefined();
    expect(read).toEqual([id.passing]);
  });

  /** A run as the index has it, for what `status:` reads of it. */
  const indexed = (runId: string, outcome: IndexedRun['outcome'], o: { calls?: number; status?: string } = {}) => ({ runId, status: o.status ?? 'completed', outcome, calls: o.calls ?? 10 }) as unknown as IndexedRun;

  it('judges nothing where the outcome decides the verdict: diverged, lost, a check that failed, still recording', () => {
    const judge = vi.fn<JudgeRun>(() => undefined);
    const reads = termReads(store, loadRunIndex(store), { q: 'status:failed', judge }, 5);
    expect(reads.verdict!(indexed('D', { kind: 'diverged', callNo: 3 }))).toBe('failed');
    expect(reads.verdict!(indexed('L', { kind: 'lost', callNo: 2 }))).toBe('failed');
    expect(reads.verdict!(indexed('C', { kind: 'check-failed', check: 'send_email called at most 1 time' }, { calls: 5_010 }))).toBe('failed');
    expect(reads.verdict!(indexed('E', { kind: 'check-failed', check: null }))).toBe('failed');
    expect(reads.verdict!(indexed('R', { kind: 'running' }, { status: 'running' }))).toBe('live');
    expect(judge).not.toHaveBeenCalled();
    expect(reads.warming()).toBeNull();
  });

  it('says a judged verdict can change a run’s only where it can, as verdictOf reads them', () => {
    const judges: VerdictJudged[] = (['own', 'import', 'family'] as const).flatMap((by) => (['passed', 'failed', 'inconclusive', 'not-applicable'] as const).map((verdict) => ({ by, verdict })));
    const outcomes: Array<VerdictRun['outcome'] | undefined> = [undefined, null, { kind: 'none' }, { kind: 'clean' }, { kind: 'passed', checks: 2 }, { kind: 'inconclusive', check: 'c' }, { kind: 'lost', callNo: 2 }, { kind: 'check-failed', check: 'c' }, { kind: 'check-failed', check: null }, { kind: 'diverged', callNo: 3 }, { kind: 'running' }];
    for (const outcome of outcomes)
      for (const status of ['completed', 'failed', 'running', 'interrupted'])
        for (const fixedBy of [null, 'F']) {
          const r = { status, fixedBy, ...(outcome === undefined ? {} : { outcome }) };
          const bare = verdictOf({ ...r, judged: null });
          expect([outcome, status, fixedBy, judgedCanChange(r)]).toEqual([outcome, status, fixedBy, judges.some((judged) => verdictOf({ ...r, judged }) !== bare)]);
        }
  });

  it('hands a run with more calls than a read judges on to a job after the read, and knows it once that job judged it', () => {
    let judgedAfter = false;
    const judge: JudgeRun = (runId, quick) => (quick && !(runId === 'BIG' && judgedAfter) ? undefined : { by: 'family', verdict: 'failed' });
    const big = indexed('BIG', { kind: 'none' }, { calls: 6 });
    const small = indexed('SMALL', { kind: 'clean' }, { calls: 3 });
    const first = termReads(store, loadRunIndex(store), { q: 'status:failed', judge }, 5);
    expect([first.verdict!(big), first.verdict!(small)]).toEqual([undefined, 'failed']);
    expect(first.judgeAfter()).toBe('BIG');
    expect(first.warming()).toEqual({ done: 1, total: 2, what: 'verdicts' });
    judgedAfter = true;
    const again = termReads(store, loadRunIndex(store), { q: 'status:failed', judge }, 5);
    expect([again.verdict!(big), again.verdict!(small)]).toEqual(['failed', 'failed']);
    expect(again.judgeAfter()).toBeNull();
    expect(again.warming()).toBeNull();
  });

  it('judges by their checks only the newest runs a thread keeps judged with room to spare, and reads older ones by their own outcome', () => {
    expect(STATUS_JUDGED_RUNS * 2).toBeLessThanOrEqual(JUDGED_KEPT);
    const asked: string[] = [];
    const judge: JudgeRun = (runId, quick) => (quick ? undefined : (asked.push(runId), { by: 'family', verdict: 'failed' }));
    const runs = Array.from({ length: STATUS_JUDGED_RUNS + 2 }, (_, i) => indexed(`R${i}`, { kind: 'none' }, { calls: 1 }));
    const reads = termReads(store, loadRunIndex(store), { q: 'status:failed', judge }, 5_000);
    const verdicts = runs.map((r) => reads.verdict!(r));
    expect(asked).toHaveLength(STATUS_JUDGED_RUNS);
    expect(verdicts.slice(0, STATUS_JUDGED_RUNS).every((v) => v === 'failed')).toBe(true);
    // Past them, a run nothing judged reads as its outcome says, and isn't waited for.
    expect(verdicts.slice(STATUS_JUDGED_RUNS)).toEqual([null, null]);
    expect(reads.warming()).toBeNull();
    // A read with no budget, which judges whole, judges them all.
    const whole = termReads(store, loadRunIndex(store), { q: 'status:failed', judge }, Infinity);
    expect(runs.every((r) => whole.verdict!(r) === 'failed')).toBe(true);
  });
});

describe("a run that fails only its family's checks", () => {
  const judge: JudgeRun = (runId) => (runId === id.family ? { by: 'family', verdict: 'failed' } : null);
  beforeAll(() => {
    id.family = addRun(store, { startedAt: NOW - 30 * MIN, calls: 'll' });
  });

  it('is under Failed, in the chip and in the days, while its row keeps its own outcome', () => {
    const page = listRunsPage(store, { limit: 500, judge });
    expect(rowsOf(page.runs).get(id.family)).toMatchObject({ failed: false });
    const failedOnly = listRunsPage(store, { limit: 500, types: ['failed'], judge }).runs.map((r) => r.runId);
    expect(failedOnly).toEqual(expect.arrayContaining([id.family, id.still, id.capFailed]));
    expect(page.chipCounts.failed).toBe(failedOnly.length);
    expect(runsByDay(store, { tz: 'UTC', now: NOW, judge }).totals.failed).toBe(failedOnly.length);
  });

  it('is left out of what Find breaking commit starts from, and of Failed where a read passes no judge', () => {
    expect(matchingRuns(store, { types: ['failed'], judge, ownFailures: true }).map((r) => r.runId)).not.toContain(id.family);
    expect(listRunsPage(store, { limit: 500, types: ['failed'] }).runs.map((r) => r.runId)).not.toContain(id.family);
  });
});
