import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, summarizeRun, storedModelResolver } from '@shadowlap/engine';
import { loadRunIndex } from '../src/run-index.js';
import { countRuns, deleteRuns, labelRuns, listRunsPage, recentRuns, runsByDay, runsByDayOptions, runsPageOptions, type RunRow, type RunType } from '../src/runs-list.js';
import { addDays, dayIndex, daysFrom, isTimeZone, localDay } from '../src/local-days.js';
import { addRun, blameOf, capture, DAY, HOUR, OFFLINE } from './read-model-store.js';

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
      // By calls or spent, the run in progress comes first (its numbers still grow), then the most first.
      const finished = seen.filter((r) => r.status !== 'running');
      if (sort !== 'when') expect(seen[0]!.runId).toBe(id.live);
      if (sort === 'calls') expect(finished.map((r) => r.calls)).toEqual([...finished.map((r) => r.calls)].sort((a, b) => b - a));
      if (sort === 'spent') expect(finished.map((r) => r.spent)).toEqual([...finished.map((r) => r.spent)].sort((a, b) => b - a));
    }
    expect(() => listRunsPage(store, { cursor: 'not-a-cursor' })).toThrow(RangeError);
    expect(listRunsPage(store, { limit: Number.NaN }).runs).toHaveLength(14);
    expect(listRunsPage(store, { limit: -5 }).runs).toHaveLength(1);
    const whenCursor = listRunsPage(store, { limit: 2 }).next!;
    expect(() => listRunsPage(store, { cursor: whenCursor, sort: 'calls' })).toThrow(RangeError);
  });

  it('never skips a run in progress that gains calls between pages', () => {
    const local = Store.open(':memory:');
    try {
      const made = [5, 9, 2, 7, 4, 6].map((n, i) => addRun(local, { startedAt: NOW - (i + 2) * HOUR, calls: 'l'.repeat(n) }));
      const live = addRun(local, { startedAt: NOW - HOUR, status: 'running', calls: 'lll' });
      for (const sort of ['calls', 'spent'] as const) {
        const first = listRunsPage(local, { limit: 3, sort });
        // The recording goes on: 10 calls now, more than any run already listed.
        const more = 10 - local.countCalls(live);
        for (let k = 0; k < more; k++) {
          const callNo = local.countCalls(live) + 1;
          local.appendCallStart({ runId: live, callNo, kind: 'tool', name: 't', fingerprint: `x${sort}${callNo}`, occurrence: 1, origin: 'live', effect: 'read', requestRef: null, meta: {}, at: NOW });
        }
        const seen = [...first.runs];
        for (let cursor = first.next; cursor; ) {
          const page = listRunsPage(local, { limit: 3, sort, cursor });
          seen.push(...page.runs);
          cursor = page.next;
        }
        expect(new Set(seen.map((r) => r.runId))).toEqual(new Set([...made, live]));
        expect(seen).toHaveLength(7);
        expect(seen[0]!.runId).toBe(live);
      }
    } finally {
      local.close();
    }
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

  it('counts attempts only when asked', () => {
    const d = (o: Parameters<typeof runsByDay>[1]) => new Map(runsByDay(store, { tz: 'Europe/Berlin', now: NOW, ...o }).days.map((x) => [x.day, x]));
    // Sep 29: the blamed run and its rescued probe, and the two probes that did not rescue it.
    expect(d({}).get('2026-09-29')).toMatchObject({ runs: 2, byKind: { recording: 1, fork: 1 } });
    expect(d({ includeAttempts: true }).get('2026-09-29')).toMatchObject({ runs: 4, byKind: { recording: 1, fork: 3 } });
    // Sep 30: the recording, and the two --repeat attempts and the verify attempt replaying it.
    expect(d({ includeAttempts: true }).get('2026-09-30')).toMatchObject({ runs: 4, byKind: { recording: 1, clean: 3 } });
    expect(runsByDay(store, { tz: 'Europe/Berlin', now: NOW, includeAttempts: true }).totals.runs).toBe(18);
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

  it('takes full run ids only: a prefix names no run', () => {
    expect(labelRuns(store, [id.fork.slice(0, 6)], ['x'], [])).toEqual({ done: [], skipped: [{ runId: id.fork.slice(0, 6), reason: 'no such run' }] });
    const local = Store.open(':memory:');
    try {
      const only = addRun(local, { startedAt: NOW, calls: 'l' });
      expect(deleteRuns(local, [only.slice(0, 1)])).toMatchObject({ done: [], skipped: [{ runId: only.slice(0, 1), reason: 'no such run' }] });
      expect(local.getRun(only)).not.toBeNull();
    } finally {
      local.close();
    }
  });

  it('skips a run that cannot take another label, and labels the rest', () => {
    const local = Store.open(':memory:');
    try {
      const full = addRun(local, { startedAt: NOW, calls: 'l', meta: { labels: Array.from({ length: 50 }, (_, i) => `l${i}`) } });
      const other = addRun(local, { startedAt: NOW + 1, calls: 'l' });
      expect(labelRuns(local, [full, other], ['one-more'], [])).toEqual({ done: [{ runId: other, labels: ['one-more'] }], skipped: [{ runId: full, reason: 'a run has at most 50 labels' }] });
      expect(local.getRun(full)!.meta?.labels).toHaveLength(50);
    } finally {
      local.close();
    }
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

  it('leaves a run alone while a replay of it, or an attempt of it, still runs', () => {
    const local = Store.open(':memory:');
    try {
      const rec = addRun(local, { startedAt: NOW - DAY, calls: 'llllll' });
      // Replaying it now: two calls served, four still to come from the recording.
      const replay = addRun(local, { parent: rec, startedAt: NOW - 5 * MIN, status: 'running', calls: 'rr' });
      const other = addRun(local, { startedAt: NOW - DAY + HOUR, calls: 'llll', status: 'failed' });
      const probe = addRun(local, { parent: other, startedAt: NOW - MIN, status: 'running', divergence: 3, calls: 'rr', meta: { repeat: { group: 'g-3', attempt: 1, of: 4 }, probe: { of: other, callNo: 3, passed: false } } });
      const out = deleteRuns(local, [rec, other, replay, probe]);
      expect(out).toMatchObject({
        done: [],
        skipped: [
          { runId: rec, reason: 'a replay of it is still running' },
          { runId: other, reason: 'an attempt of it is still running' },
          { runId: replay, reason: 'still running' },
          { runId: probe, reason: 'still running' },
        ],
      });
      expect(local.getRun(rec)).not.toBeNull();
      local.endRun(replay, 'completed', NOW);
      expect(deleteRuns(local, [rec])).toMatchObject({ done: [rec], skipped: [] });
    } finally {
      local.close();
    }
  });
});

describe('the sidebar’s recent runs', () => {
  it('lists the runs as a tree, each family under its first run, attempts bundled', () => {
    const tree = recentRuns(store);
    expect(tree.map((r) => r.runId).sort()).toEqual(all().runs.map((r) => r.runId).sort());
    const at = new Map(tree.map((r, i) => [r.runId, i]));
    // Oldest family first; a run's replays and forks right under it, deeper by one.
    expect(tree[0]!.runId).toBe(id.old);
    for (const r of tree) {
      if (!r.parentRunId || !at.has(r.parentRunId)) expect(r.depth).toBe(0);
      else {
        expect(at.get(r.runId)!).toBeGreaterThan(at.get(r.parentRunId)!);
        expect(r.depth).toBe(tree[at.get(r.parentRunId)!]!.depth + 1);
      }
    }
    expect(tree.find((r) => r.runId === id.fork2)!.depth).toBe(2);
    expect(tree.find((r) => r.runId === id.rec)).toMatchObject({ attempts: 3, kind: 'recording' });
    expect(tree.find((r) => r.runId === id.failed)).toMatchObject({ outcome: { kind: 'lost', callNo: 5 }, lostAt: 5, origins: 'llllllll' });
  });

  it('lists attempts when asked, and only the runs named for an exported copy', () => {
    expect(recentRuns(store, { includeAttempts: true })).toHaveLength(19);
    const two = recentRuns(store, { ids: [id.p2, id.failed] });
    expect(two.map((r) => [r.runId, r.depth, r.attemptKind])).toEqual([
      [id.failed, 0, null],
      [id.p2, 1, 'probe'],
    ]);
    expect(recentRuns(store, { limit: 2 }).map((r) => r.runId).sort()).toEqual([id.live, id.failat].sort());
  });

  it('hangs a run made from an attempt under the run that attempt came from', () => {
    const local = Store.open(':memory:');
    try {
      const rec = addRun(local, { startedAt: NOW - DAY, calls: 'llll' });
      const attempt = addRun(local, { parent: rec, startedAt: NOW - HOUR, calls: 'rrrr', meta: { repeat: { group: 'g', attempt: 1, of: 2 } } });
      const forkOfAttempt = addRun(local, { parent: attempt, startedAt: NOW, divergence: 2, calls: 'rlll' });
      expect(recentRuns(local).map((r) => [r.runId, r.depth])).toEqual([
        [rec, 0],
        [forkOfAttempt, 1],
      ]);
      expect(recentRuns(local, { includeAttempts: true }).map((r) => [r.runId, r.depth])).toEqual([
        [rec, 0],
        [attempt, 1],
        [forkOfAttempt, 2],
      ]);
    } finally {
      local.close();
    }
  });
});

describe('what the index works out about a run', () => {
  it('calls a replay that reproduced its failing recording a clean replay whose check failed', () => {
    const local = Store.open(':memory:');
    try {
      const rec = addRun(local, { startedAt: NOW - DAY, status: 'failed', calls: 'llllllll' });
      const reproduced = addRun(local, { parent: rec, startedAt: NOW - HOUR, status: 'failed', calls: 'rrrrrrrr' });
      // Stopped at call 3 of 8, for some reason of its own: not the recorded failure.
      const short = addRun(local, { parent: rec, startedAt: NOW - 30 * MIN, status: 'failed', calls: 'rrr' });
      const rows = byId(listRunsPage(local).runs);
      expect(rows.get(reproduced)).toMatchObject({ kind: 'clean', label: 'clean replay', outcome: { kind: 'check-failed', check: null }, failed: true });
      expect(rows.get(short)).toMatchObject({ kind: 'replay', label: 'replay' });
      expect(listRunsPage(local, { types: ['clean'] }).runs.map((r) => r.runId)).toEqual([reproduced]);
    } finally {
      local.close();
    }
  });

  it('says a test that left its golden offline diverged, whatever its checks', () => {
    const local = Store.open(':memory:');
    try {
      const golden = addRun(local, { startedAt: NOW - 10 * DAY, calls: 'llll', meta: { imported: { at: NOW - 10 * DAY, from: 'goldens/refund-in-limit' } } });
      const checks = [
        { ok: true, label: 'issue_refund called once', detail: null },
        { ok: false, label: 'send_email called once', detail: 'it was called 0 times' },
      ];
      const offline = addRun(local, { parent: golden, startedAt: NOW - HOUR, status: 'failed', divergence: 1, calls: [{ code: 'f', endMeta: OFFLINE }], meta: { test: { golden: 'goldens/refund-in-limit', session: 's1' }, checks } });
      const live = addRun(local, { parent: golden, startedAt: NOW - 30 * MIN, divergence: 1, calls: 'llll', meta: { test: { golden: 'goldens/refund-over', session: 's1' }, checks: checks.map((c) => ({ ...c, ok: true })) } });
      const rows = byId(listRunsPage(local).runs);
      expect(rows.get(offline)).toMatchObject({ kind: 'test', label: 'test', outcome: { kind: 'diverged', callNo: 1 }, failed: true });
      expect(rows.get(live)).toMatchObject({ kind: 'test', outcome: { kind: 'passed', checks: 2 }, failed: false });
    } finally {
      local.close();
    }
  });
});

describe('the run index', () => {
  it('is read again only after something wrote to the store, here or in another process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowlap-run-index-'));
    const path = join(dir, 'shadowlap.db');
    const here = Store.open(path);
    const other = Store.open(path);
    try {
      const rec = addRun(here, { startedAt: NOW - DAY, calls: 'll' });
      const first = loadRunIndex(here);
      expect(loadRunIndex(here)).toBe(first);
      // Another process records a run: this one sees it on its next read.
      const theirs = addRun(other, { startedAt: NOW, calls: 'l' });
      const second = loadRunIndex(here);
      expect(second).not.toBe(first);
      expect(second.byId.has(theirs)).toBe(true);
      expect(loadRunIndex(here)).toBe(second);
      // So does a write of its own.
      labelRuns(here, [rec], ['bug'], []);
      expect(loadRunIndex(here).byId.get(rec)!.meta.labels).toEqual(['bug']);
      // A call added to a run in progress changes its count.
      const live = addRun(other, { startedAt: NOW + 1, calls: 'l', status: 'running' });
      expect(loadRunIndex(here).byId.get(live)!.calls).toBe(1);
      other.appendCallStart({ runId: live, callNo: 2, kind: 'tool', name: 't', fingerprint: 'f', occurrence: 1, origin: 'live', effect: 'read', requestRef: null, meta: {}, at: NOW });
      expect(loadRunIndex(here).byId.get(live)!.calls).toBe(2);
    } finally {
      here.close();
      other.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
