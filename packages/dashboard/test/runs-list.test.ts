import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, summarizeRun, storedModelResolver } from '@shadowlap/engine';
import { countRuns, deleteRuns, labelRuns, listRunsPage, runsByDay, runsByDayOptions, runsPageOptions, type RunRow, type RunType } from '../src/runs-list.js';
import { addDays, dayIndex, daysFrom, isTimeZone, localDay } from '../src/local-days.js';
import { addRun, blameOf, capture, DAY, HOUR } from './read-model-store.js';

// Thursday, Oct 1 2026, 10:15 UTC: 12:15 in Berlin.
const NOW = Date.UTC(2026, 9, 1, 10, 15);
const MIN = 60_000;

let store: Store;
const id: Record<string, string> = {};

beforeAll(() => {
  store = Store.open(':memory:');
  id.rec = addRun(store, { startedAt: NOW - DAY, calls: 'l'.repeat(30), meta: { labels: ['refund-flow'], author: 'dana@example.com' } });
  id.clean = addRun(store, { parent: id.rec, startedAt: NOW - 3 * HOUR, calls: 'r'.repeat(30) });
  id.fork = addRun(store, { parent: id.rec, startedAt: NOW - 2 * HOUR, divergence: 17, calls: 'r'.repeat(16) + 'l'.repeat(12) + 'bl' });
  // A fork of the fork: its first 16 calls came from the recording, the next three from the fork.
  id.fork2 = addRun(store, { parent: id.fork, startedAt: NOW - HOUR, divergence: 20, calls: 'r'.repeat(19) + 'lllll' });
  // A failed run, blamed: lost at model call #5, and rescued by its first probe.
  id.failed = addRun(store, { startedAt: NOW - 2 * DAY, status: 'failed', argv: ['node', 'agent.mjs'], calls: 'l'.repeat(8), meta: { labels: ['refund-bug'], author: 'ci' } });
  const probe = (i: number, passed: boolean) =>
    addRun(store, {
      parent: id.failed,
      startedAt: NOW - 2 * DAY + HOUR + i * MIN,
      divergence: 5,
      calls: 'rrrrllll',
      meta: { repeat: { group: 'g-5', attempt: i, of: 3 }, probe: { of: id.failed!, callNo: 5, passed }, checks: [{ ok: passed, label: 'issue_refund called 0 times', detail: passed ? null : 'it was called 1 time' }] },
    });
  id.p1 = probe(1, true);
  id.p2 = probe(2, false);
  id.p3 = probe(3, false);
  store.updateRunMeta(id.failed, { blame: blameOf(5, id.p1, NOW - 2 * DAY + 2 * HOUR) });
  id.r1 = addRun(store, { parent: id.rec, startedAt: NOW - 20 * HOUR, calls: 'r'.repeat(30), meta: { repeat: { group: 'rp', attempt: 1, of: 2 } } });
  id.r2 = addRun(store, { parent: id.rec, startedAt: NOW - 20 * HOUR + MIN, calls: 'r'.repeat(30), meta: { repeat: { group: 'rp', attempt: 2, of: 2 } } });
  id.ver = addRun(store, { parent: id.rec, startedAt: NOW - 19 * HOUR, calls: 'r'.repeat(30), meta: { repeat: { group: 'v-rec', attempt: 1, of: 1 }, verify: { role: 'good', passed: true } } });
  id.cap = capture(store, NOW - 10 * DAY);
  id.pack = addRun(store, { startedAt: NOW - 30 * DAY, calls: 'llll', meta: { imported: { at: NOW - 30 * DAY, from: 'goldens/refund' } } });
  id.test1 = addRun(store, { parent: id.pack, startedAt: NOW - 4 * HOUR, status: 'failed', divergence: 1, calls: 'f', argv: ['python', 'refund_agent.py'], meta: { test: { golden: 'goldens/refund', session: 's1' } } });
  const ok = (label: string) => ({ ok: true, label, detail: null });
  id.test2 = addRun(store, { parent: id.pack, startedAt: NOW - 4 * HOUR + MIN, calls: 'rrrr', meta: { test: { golden: 'goldens/refund-over', session: 's1' }, checks: [ok('issue_refund never called'), ok('exit 0')] } });
  id.live = addRun(store, { startedAt: NOW - 5 * MIN, status: 'running', calls: 'lll' });
  // --fail-at 19=529: three injected failures, and the agent exits 1, as the fork meant it to.
  id.failat = addRun(store, { parent: id.rec, startedAt: NOW - 30 * MIN, status: 'failed', divergence: 19, calls: 'r'.repeat(18) + 'iii' });
  id.inj = addRun(store, { parent: id.rec, startedAt: NOW - 6 * HOUR, divergence: 3, calls: 'rrolll', meta: { labels: ['injection'], checks: [{ ok: false, label: 'send_email called 1 time', detail: 'it was called 2 times' }] } });
  id.old = addRun(store, { startedAt: NOW - 100 * DAY, calls: 'll' });
});
afterAll(() => store.close());

const all = (opts: Parameters<typeof listRunsPage>[1] = {}) => listRunsPage(store, { limit: 500, ...opts });
const byId = (rows: RunRow[]) => new Map(rows.map((r) => [r.runId, r]));

describe('the Runs table', () => {
  it('lists every run newest first, with attempts bundled under the run they came from', () => {
    const page = all();
    expect(page.runs.map((r) => r.runId)).toEqual([id.live, id.failat, id.fork2, id.fork, id.clean, id.test2, id.test1, id.inj, id.rec, id.p1, id.failed, id.cap, id.pack, id.old]);
    expect(page.total).toBe(14);
    expect(page.next).toBeNull();
    const rows = byId(page.runs);
    expect(rows.get(id.rec)!.attempts).toBe(3); // two --repeat attempts and a verify attempt
    expect(rows.get(id.failed)!.attempts).toBe(2); // the probes that did not rescue it
    expect(countRuns(store)).toEqual({ runs: 14, attempts: 5 });
  });

  it('says what kind each run is and how it came out', () => {
    const rows = byId(all().runs);
    const k = (name: string) => [rows.get(id[name]!)!.kind, rows.get(id[name]!)!.outcome];
    expect(k('rec')).toEqual(['recording', { kind: 'none' }]);
    expect(k('clean')).toEqual(['clean', { kind: 'clean' }]);
    expect(k('fork')).toEqual(['fork', { kind: 'none' }]);
    expect(k('failed')).toEqual(['recording', { kind: 'lost', callNo: 5 }]);
    expect(k('cap')).toEqual(['capture', { kind: 'none' }]);
    expect(k('pack')).toEqual(['pack', { kind: 'none' }]);
    expect(k('test1')).toEqual(['test', { kind: 'diverged', callNo: 1 }]);
    expect(k('test2')).toEqual(['test', { kind: 'passed', checks: 2 }]);
    expect(k('live')).toEqual(['recording', { kind: 'running' }]);
    expect(k('failat')).toEqual(['fork', { kind: 'none' }]);
    expect(k('inj')).toEqual(['fork', { kind: 'check-failed', check: 'send_email called 1 time' }]);
    // Blame's probe that passed is the fork that rescued the run: a row of its own.
    const p1 = rows.get(id.p1)!;
    expect(p1).toMatchObject({ kind: 'fork', rescues: id.failed, attemptKind: null, outcome: { kind: 'passed', checks: 1 }, label: 'fork @5' });
    expect(rows.get(id.failed)).toMatchObject({ lostAt: 5, failed: true, author: 'ci', labels: ['refund-bug'], command: 'node agent.mjs' });
    expect(rows.get(id.test2)!.checks).toEqual({ passed: 2, total: 2 });
    expect(rows.get(id.cap)).toMatchObject({ source: '2026-09-30.jsonl', imported: true, covers: ['api'], label: 'capture' });
  });

  it('gives every call one character for where its answer came from', () => {
    const rows = byId(all().runs);
    expect(rows.get(id.fork)!.origins).toBe('r'.repeat(16) + 'l'.repeat(12) + 'bl');
    expect(rows.get(id.failat)!.origins).toBe('r'.repeat(18) + 'iii');
    expect(rows.get(id.test1)!.origins).toBe('f');
    expect(rows.get(id.inj)!.origins).toBe('rrolll');
    expect(rows.get(id.live)!.origins).toBe('lll');
    expect([...rows.values()].every((r) => r.origins.length === r.calls)).toBe(true);
  });

  it('sums what each run spent and saved exactly as its own page does', () => {
    const modelOf = storedModelResolver(store);
    for (const row of all({ includeAttempts: true }).runs) {
      const s = summarizeRun(store.getRun(row.runId)!, store.getCalls(row.runId), [], [], { modelOf });
      expect(row.spent).toBeCloseTo(s.cost.spent, 12);
      expect(row.saved).toBeCloseTo(s.cost.saved, 12);
      expect(row.captured).toBeCloseTo(s.cost.captured, 12);
    }
    const rows = byId(all().runs);
    expect(rows.get(id.rec)!.spent).toBeGreaterThan(0);
    expect(rows.get(id.clean)!.spent).toBe(0);
    expect(rows.get(id.cap)!.spent).toBe(0);
    expect(rows.get(id.cap)!.captured).toBeGreaterThan(0);
  });

  it('filters by the type chips: kinds add up, Failed narrows them', () => {
    const ids = (types: RunType[]) => all({ types }).runs.map((r) => r.runId);
    expect(ids(['fork'])).toEqual([id.failat, id.fork2, id.fork, id.inj, id.p1]);
    expect(ids(['clean', 'test'])).toEqual([id.clean, id.test2, id.test1]);
    expect(ids(['recording'])).toEqual([id.live, id.rec, id.failed, id.pack, id.old]);
    expect(ids(['failed'])).toEqual([id.test1, id.inj, id.failed]);
    expect(ids(['fork', 'failed'])).toEqual([id.inj]);
    expect(all().chipCounts).toEqual({ all: 14, recording: 5, fork: 5, clean: 1, test: 2, capture: 1, failed: 3 });
  });

  it('matches every word of the filter field against id, labels, command, source and revision', () => {
    const ids = (q: string) => all({ q }).runs.map((r) => r.runId);
    expect(ids('refund-bug')).toEqual([id.failed]);
    expect(ids('AGENT.MJS')).toEqual([id.failed]);
    expect(ids('2026-09-30')).toEqual([id.cap]);
    expect(ids(id.fork2.slice(0, 12).toLowerCase())).toEqual([id.fork2]);
    expect(ids('refund_agent.py injection')).toEqual([id.inj]);
    expect(ids('nothing-like-this')).toEqual([]);
    // The chips count the date range, not the filter field.
    expect(all({ q: 'injection' }).chipCounts.all).toBe(14);
  });

  it('narrows to a date range, and the chip counts follow it', () => {
    const today = localDay(NOW, 'Europe/Berlin');
    const page = all({ from: today.start, to: today.end });
    expect(page.runs.map((r) => r.runId)).toEqual([id.live, id.failat, id.fork2, id.fork, id.clean, id.test2, id.test1, id.inj]);
    expect(page.chipCounts).toEqual({ all: 8, recording: 1, fork: 4, clean: 1, test: 2, capture: 0, failed: 2 });
  });

  it('lists attempts when asked, each naming the run it belongs to', () => {
    const rows = byId(all({ includeAttempts: true }).runs);
    expect(rows.size).toBe(19);
    expect(rows.get(id.p2)).toMatchObject({ attemptKind: 'probe', attemptOf: id.failed, kind: 'fork' });
    expect(rows.get(id.r1)).toMatchObject({ attemptKind: 'repeat', attemptOf: id.rec, kind: 'clean' });
    expect(rows.get(id.ver)).toMatchObject({ attemptKind: 'verify', attemptOf: id.rec });
  });

  it('pages with a cursor, in every sort, without repeating or skipping a run', () => {
    for (const sort of ['when', 'calls', 'spent'] as const) {
      const seen: RunRow[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const page = listRunsPage(store, { limit: 4, sort, ...(cursor ? { cursor } : {}) });
        expect(page.total).toBe(14);
        seen.push(...page.runs);
        cursor = page.next;
        if (!cursor) break;
      }
      expect(seen.map((r) => r.runId).sort()).toEqual(all().runs.map((r) => r.runId).sort());
      if (sort === 'calls') expect(seen.map((r) => r.calls)).toEqual([...seen.map((r) => r.calls)].sort((a, b) => b - a));
      if (sort === 'spent') expect(seen.map((r) => r.spent)).toEqual([...seen.map((r) => r.spent)].sort((a, b) => b - a));
    }
    expect(() => listRunsPage(store, { cursor: 'not-a-cursor' })).toThrow(RangeError);
    expect(listRunsPage(store, { limit: Number.NaN }).runs).toHaveLength(14);
    expect(listRunsPage(store, { limit: -5 }).runs).toHaveLength(1);
    const whenCursor = listRunsPage(store, { limit: 2 }).next!;
    expect(() => listRunsPage(store, { cursor: whenCursor, sort: 'calls' })).toThrow(RangeError);
  });

  it('reads its options from a query string, and refuses what it does not know', () => {
    expect(runsPageOptions(new URLSearchParams('limit=20&types=fork,failed&q=refund&attempts=1&sort=spent&from=5&to=9'))).toEqual({ limit: 20, types: ['fork', 'failed'], q: 'refund', includeAttempts: true, sort: 'spent', from: 5, to: 9 });
    expect(runsPageOptions(new URLSearchParams('types=forks'))).toMatchObject({ error: expect.stringContaining('unknown type') });
    expect(runsPageOptions(new URLSearchParams('limit=ten'))).toMatchObject({ error: expect.stringContaining('limit') });
    expect(runsPageOptions(new URLSearchParams('sort=cost'))).toMatchObject({ error: expect.stringContaining('sort') });
    expect(runsByDayOptions(new URLSearchParams('weeks=4&tz=Europe/Berlin&types=failed'))).toEqual({ weeks: 4, tz: 'Europe/Berlin', types: ['failed'] });
    expect(runsByDayOptions(new URLSearchParams('tz=Mars/Olympus'))).toMatchObject({ error: expect.stringContaining('time zone') });
  });
});

describe('the calendar', () => {
  it('counts runs per local day for twelve weeks, a column per week from Monday', () => {
    const cal = runsByDay(store, { tz: 'Europe/Berlin', now: NOW });
    expect(cal.today).toBe('2026-10-01');
    expect(cal.days[0]).toMatchObject({ day: '2026-07-13', weekday: 0 });
    expect(cal.days).toHaveLength(11 * 7 + 4);
    const d = new Map(cal.days.map((x) => [x.day, x]));
    expect(d.get('2026-10-01')).toMatchObject({ runs: 8, failed: 2, all: 8, level: 4 });
    expect(d.get('2026-09-30')).toMatchObject({ runs: 1, failed: 0, level: 1, byAuthor: { 'dana@example.com': 1 }, byKind: { recording: 1 } });
    expect(d.get('2026-09-29')).toMatchObject({ runs: 2, failed: 1, all: 2, level: 3, byAuthor: { ci: 1, '': 1 }, byKind: { recording: 1, fork: 1 } });
    expect(d.get('2026-09-21')!.byKind).toEqual({ capture: 1 });
    expect(cal.thresholds).toEqual([1, 1, 2]);
    expect(cal.totals).toEqual({ runs: 13, failed: 3, all: 13, busiest: { day: '2026-10-01', runs: 8 } });
    // The day a run falls on is the viewer's: before 09:00 on Oct 1 in Berlin is still Sep 30 in Los Angeles.
    const la = runsByDay(store, { tz: 'America/Los_Angeles', now: NOW });
    expect(la.today).toBe('2026-10-01');
    const laDays = new Map(la.days.map((x) => [x.day, x.runs]));
    expect(laDays.get('2026-09-30')).toBe(4); // the recording, and the two tests and the injection fork from Berlin's early morning
    expect(laDays.get('2026-10-01')).toBe(5);
  });

  it('counts failures when Failed is picked, out of every run the other filters match', () => {
    const cal = runsByDay(store, { tz: 'Europe/Berlin', now: NOW, types: ['failed'] });
    const d = new Map(cal.days.map((x) => [x.day, x]));
    expect(d.get('2026-10-01')).toMatchObject({ runs: 2, failed: 2, all: 8 });
    expect(d.get('2026-09-29')).toMatchObject({ runs: 1, failed: 1, all: 2 });
    const forks = runsByDay(store, { tz: 'Europe/Berlin', now: NOW, types: ['fork', 'failed'] });
    expect(new Map(forks.days.map((x) => [x.day, x])).get('2026-10-01')).toMatchObject({ runs: 1, failed: 1, all: 4 });
    const text = runsByDay(store, { tz: 'Europe/Berlin', now: NOW, q: 'refund-flow' });
    expect(text.totals).toMatchObject({ runs: 1, busiest: { day: '2026-09-30', runs: 1 } });
    expect(runsByDay(store, { tz: 'UTC', now: NOW, q: 'nothing-like-this' }).thresholds).toBeNull();
    expect(() => runsByDay(store, { tz: 'Mars/Olympus' })).toThrow(RangeError);
  });
});

describe('local days', () => {
  it('start at local midnight, also on the days daylight saving changes', () => {
    expect(isTimeZone('Europe/Berlin')).toBe(true);
    expect(isTimeZone('Nowhere/Special')).toBe(false);
    const spring = localDay(Date.UTC(2026, 2, 29, 12), 'Europe/Berlin');
    expect(spring).toMatchObject({ key: '2026-03-29', start: Date.UTC(2026, 2, 28, 23), end: Date.UTC(2026, 2, 29, 22), weekday: 6 });
    const autumn = localDay(Date.UTC(2026, 9, 25, 12), 'Europe/Berlin');
    expect(autumn.end - autumn.start).toBe(25 * HOUR);
    // Auckland leaves daylight saving at 03:00 on Apr 5 2026; the day still starts at its own midnight.
    expect(localDay(Date.UTC(2026, 3, 5, 0), 'Pacific/Auckland')).toMatchObject({ key: '2026-04-05', start: Date.UTC(2026, 3, 4, 11) });
    const week = daysFrom(addDays(spring, -6, 'Europe/Berlin'), spring, 'Europe/Berlin');
    expect(week.map((d) => d.key)).toEqual(['2026-03-23', '2026-03-24', '2026-03-25', '2026-03-26', '2026-03-27', '2026-03-28', '2026-03-29']);
    expect(dayIndex(week, Date.UTC(2026, 2, 28, 22, 59))).toBe(5);
    expect(dayIndex(week, Date.UTC(2026, 2, 28, 23, 0))).toBe(6);
    expect(dayIndex(week, Date.UTC(2026, 2, 29, 22, 0))).toBe(-1);
  });
});

describe('bulk actions', () => {
  it('labels several runs at once, skipping what is not there', () => {
    const out = labelRuns(store, [id.fork, id.clean, 'NOPE', id.fork], ['what-if'], []);
    expect(out).toEqual({ done: [{ runId: id.fork, labels: ['what-if'] }, { runId: id.clean, labels: ['what-if'] }], skipped: [{ runId: 'NOPE', reason: 'no such run' }] });
    expect(labelRuns(store, [id.fork], [], ['what-if'])).toEqual({ done: [{ runId: id.fork, labels: [] }], skipped: [] });
    expect(store.getRun(id.clean)!.meta?.labels).toEqual(['what-if']);
    expect(labelRuns(store, [id.fork], ['  '], [])).toEqual({ error: 'a label cannot be empty' });
    expect(labelRuns(store, [id.fork], ['x'.repeat(41)], [])).toMatchObject({ error: expect.stringContaining('at most 40') });
    expect(labelRuns(store, [], ['x'], [])).toMatchObject({ error: expect.stringContaining('ids') });
    expect(labelRuns(store, [id.fork], [], [])).toMatchObject({ error: expect.stringContaining('nothing to change') });
  });

  it('deletes runs with their attempts, leaves a run still recording, and unlinks forks', () => {
    const local = Store.open(':memory:');
    try {
      const rec = addRun(local, { startedAt: NOW - DAY, calls: 'llllllll', status: 'failed' });
      const rescued = addRun(local, { parent: rec, startedAt: NOW - DAY + MIN, divergence: 5, calls: 'rrrrllll', meta: { probe: { of: rec, callNo: 5, passed: true } } });
      const lost = addRun(local, { parent: rec, startedAt: NOW - DAY + 2 * MIN, divergence: 5, calls: 'rrrrllll', meta: { probe: { of: rec, callNo: 5, passed: false } } });
      local.updateRunMeta(rec, { blame: blameOf(5, rescued, NOW - DAY + 3 * MIN) });
      const live = addRun(local, { startedAt: NOW, status: 'running', calls: 'l' });
      const out = deleteRuns(local, [live, rec, 'NOPE']);
      expect(out).toMatchObject({ done: [rec], attempts: [lost], skipped: [{ runId: live, reason: 'still recording' }, { runId: 'NOPE', reason: 'no such run' }] });
      expect(local.getRun(rec)).toBeNull();
      expect(local.getRun(lost)).toBeNull();
      // The fork blame rescued it with keeps its own data and loses the link; with its run gone it is a row of its own.
      expect(local.getRun(rescued)!.parentRunId).toBeNull();
      expect(listRunsPage(local).runs.map((r) => r.runId)).toEqual([live, rescued]);
      expect(deleteRuns(local, [live])).toMatchObject({ done: [], skipped: [{ runId: live, reason: 'still recording' }] });
    } finally {
      local.close();
    }
  });
});
