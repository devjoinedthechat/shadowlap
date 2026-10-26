import { mkdtempSync, rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Store, summarizeRun, storedModelResolver } from '@shadowlap/engine';
import { loadRunIndex } from '../src/run-index.js';
import { countRuns, deleteRuns, filterTerms, labelRuns, listRunsPage, recentRuns, runsByDay, runsByDayOptions, runsPageOptions, type RunRow, type RunType } from '../src/runs-list.js';
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
      meta: { repeat: { group: 'g-5', attempt: i, of: 3 }, probe: { of: id.failed, callNo: 5, passed }, checks: [{ ok: passed, label: 'issue_refund called 0 times', detail: passed ? null : 'it was called 1 time' }] },
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
    const k = (name: string) => [rows.get(id[name])!.kind, rows.get(id[name])!.outcome];
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
    expect(all().chipCounts).toEqual({ all: 14, recording: 5, fork: 5, clean: 1, test: 2, capture: 1, failed: 3, local: 0 });
  });

  it('shows the runs only on this machine under Local, with a team store, and counts them in the date range', () => {
    // As the team store's status counts them: what Needs a look's Push leads to.
    const localRuns = new Set([id.rec, id.failed, id.old]);
    const page = all({ types: ['local'], localRuns });
    expect(page.runs.map((r) => r.runId)).toEqual([id.rec, id.failed, id.old]);
    expect(page.chipCounts.local).toBe(3);
    expect(all({ types: ['local', 'failed'], localRuns }).runs.map((r) => r.runId)).toEqual([id.failed]);
    expect(all({ localRuns, from: NOW - 3 * DAY }).chipCounts.local).toBe(2);
    // The calendar counts the failures among them out of them, not out of every run.
    expect(runsByDay(store, { types: ['local'], localRuns, tz: 'UTC', now: NOW }).totals).toMatchObject({ runs: 2, failed: 1, all: 2 });
    // Without a team store, nothing is local.
    expect(all({ types: ['local'] }).runs).toEqual([]);
    expect(runsPageOptions(new URLSearchParams('types=local'))).toEqual({ types: ['local'] });
  });

  it('matches every word of the filter field against id, labels, command, source, revision and kind', () => {
    const ids = (q: string) => all({ q }).runs.map((r) => r.runId);
    // What the line under the id calls a run, as an exported copy's filter finds it.
    expect(ids('clean replay')).toEqual([id.clean]);
    expect(ids('fork @5')).toEqual([id.p1]);
    expect(ids('capture')).toEqual([id.cap]);
    expect(runsByDay(store, { tz: 'UTC', now: NOW, q: 'clean replay' }).totals).toMatchObject({ runs: 1 });
    expect(ids('refund-bug')).toEqual([id.failed]);
    expect(ids('AGENT.MJS')).toEqual([id.failed]);
    expect(ids('2026-09-30')).toEqual([id.cap]);
    expect(ids(id.fork2.slice(0, 12).toLowerCase())).toEqual([id.fork2]);
    expect(ids('refund_agent.py injection')).toEqual([id.inj]);
    expect(ids('nothing-like-this')).toEqual([]);
    // The chips count the date range, not the filter field.
    expect(all({ q: 'injection' }).chipCounts.all).toBe(14);
  });

  it('lists the runs with a label exactly, from label:<name>, as --keeps label:good takes them', () => {
    const ids = (q: string) => all({ q }).runs.map((r) => r.runId);
    // A word matches anywhere: `refund` finds both labels and more; label:refund finds no run, none being labelled just that.
    expect(ids('refund-flow')).toContain(id.rec);
    expect(ids('label:refund')).toEqual([]);
    expect(ids('label:refund-flow')).toEqual([id.rec]);
    expect(ids('label:refund-bug')).toEqual([id.failed]);
    // As typed, as the CLI takes it, and with the words beside it.
    expect(ids('label:Refund-Bug')).toEqual([]);
    expect(ids('agent.mjs label:refund-bug')).toEqual([id.failed]);
    expect(ids('refund_agent.py label:refund-bug')).toEqual([]);
    expect(filterTerms('Refund label:good  label:Bad x')).toEqual({ words: ['refund', 'x'], labels: ['good', 'Bad'] });
  });

  it('narrows to a date range, and the chip counts follow it', () => {
    const today = localDay(NOW, 'Europe/Berlin');
    const page = all({ from: today.start, to: today.end });
    expect(page.runs.map((r) => r.runId)).toEqual([id.live, id.failat, id.fork2, id.fork, id.clean, id.test2, id.test1, id.inj]);
    expect(page.chipCounts).toEqual({ all: 8, recording: 1, fork: 4, clean: 1, test: 2, capture: 0, failed: 2, local: 0 });
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
      if (sort !== 'when') expect(seen[0].runId).toBe(id.live);
      if (sort === 'calls') expect(finished.map((r) => r.calls)).toEqual([...finished.map((r) => r.calls)].sort((a, b) => b - a));
      // By what the table shows: a run recorded elsewhere (the capture) by what its calls cost there.
      if (sort === 'spent') expect(finished.map((r) => r.spent + r.captured)).toEqual([...finished.map((r) => r.spent + r.captured)].sort((a, b) => b - a));
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
        expect(seen[0].runId).toBe(live);
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

  it('deletes the attempts bundled under an attempt too, and counts every one on the row', () => {
    const local = Store.open(':memory:');
    try {
      const rec = addRun(local, { startedAt: NOW - DAY, calls: 'llll', status: 'failed' });
      const probe = addRun(local, { parent: rec, startedAt: NOW - DAY + MIN, divergence: 3, calls: 'rrll', meta: { probe: { of: rec, callNo: 3, passed: false }, repeat: { group: 'g-3', attempt: 1, of: 1 } } });
      // A --repeat of the probe: bundled under the probe, which is bundled under the run.
      const again = addRun(local, { parent: probe, startedAt: NOW - DAY + 2 * MIN, calls: 'rrll', meta: { repeat: { group: 'again', attempt: 1, of: 1 } } });
      expect(listRunsPage(local).runs).toMatchObject([{ runId: rec, attempts: 2 }]);
      expect(deleteRuns(local, [rec])).toMatchObject({ done: [rec], attempts: [probe, again], skipped: [] });
      // Nothing of it is left to show as a run of its own.
      expect(local.allRuns()).toEqual([]);
    } finally {
      local.close();
    }
  });

  it('deletes a run its recording process left marked running, as gc would', () => {
    const local = Store.open(':memory:');
    try {
      // Still marked running, recorded by no process here and silent for two days, as a crash leaves a run.
      const left = '01K5CQ4N7G0000000000000009';
      local.importRun({ runId: left, parentRunId: null, mode: 'record', status: 'running', divergence: null, command: { argv: ['x'], cwd: '.' }, codeVersion: null, startedAt: Date.now() - 2 * 86_400_000, endedAt: null });
      expect(deleteRuns(local, [left])).toMatchObject({ done: [left], skipped: [] });
      expect(local.getRun(left)).toBeNull();
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
    expect(tree[0].runId).toBe(id.old);
    for (const r of tree) {
      if (!r.parentRunId || !at.has(r.parentRunId)) expect(r.depth).toBe(0);
      else {
        expect(at.get(r.runId)!).toBeGreaterThan(at.get(r.parentRunId)!);
        expect(r.depth).toBe(tree[at.get(r.parentRunId)!].depth + 1);
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

  it('classifies a replay by the agent’s calls: a judge check’s are none of what it reproduced', () => {
    const local = Store.open(':memory:');
    try {
      const judge = { code: 'l', scope: 'shadowlap:judge' };
      // A recording that failed after four calls, judged twice after them; its replay served every
      // one of the agent's calls and failed the same way, with no judge asked.
      const rec = addRun(local, { startedAt: NOW - DAY, status: 'failed', calls: [...Array.from('llll', (code) => ({ code })), judge, judge] });
      const reproduced = addRun(local, { parent: rec, startedAt: NOW - HOUR, status: 'failed', calls: 'rrrr' });
      expect(loadRunIndex(local).byId.get(rec)).toMatchObject({ calls: 6, agentCalls: 4 });
      expect(byId(listRunsPage(local).runs).get(reproduced)).toMatchObject({ kind: 'clean', label: 'clean replay' });
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
      // Another process records a run: this one sees it on its next read, taken into the index it has.
      const theirs = addRun(other, { startedAt: NOW, calls: 'l' });
      const second = loadRunIndex(here);
      expect(second).toBe(first);
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

describe('the run index’s query', () => {
  it('counts each run’s calls and leaves a judge check’s out without reading a call: both through an index', () => {
    const local = Store.open(':memory:');
    try {
      addRun(local, { startedAt: NOW, calls: [{ code: 'l' }, { code: 'l', scope: 'shadowlap:judge' }] });
      const query = vi.spyOn(local, 'query');
      expect(loadRunIndex(local).runs[0]).toMatchObject({ calls: 2, agentCalls: 1 });
      const sql = query.mock.calls.map(([q]) => q).find((q) => /\bFROM runs r\b/.test(q))!;
      const db = (local as unknown as { db: DatabaseSync }).db;
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((step) => String(step.detail));
      // Per run, its calls from the primary key's index alone (a covering index: no call is read),
      // and its judge calls from the index that holds them and no other call.
      expect(plan.filter((step) => step.startsWith('SEARCH c '))).toEqual([expect.stringMatching(/ USING COVERING INDEX /), expect.stringMatching(/ USING INDEX call_events_judge /)]);
      // Nothing else in it reads every call either: the runs are the one table it goes through whole.
      expect(plan.filter((step) => step.startsWith('SCAN '))).toEqual(['SCAN r']);
    } finally {
      local.close();
    }
  });
});

describe('a golden replayed several times in one test session', () => {
  it('is one test run in the table, the sidebar and the counts, with its attempts under the one its result shows', () => {
    const local = Store.open(':memory:');
    try {
      const golden = addRun(local, { startedAt: NOW - DAY, calls: 'lll' });
      const test = (attempt: number, of?: string) => ({ golden: 'goldens/refund-over-limit', session: 's1', attempt, ...(of ? { of } : {}) });
      // Five attempts, each filed under the fifth: the last that passed, which the result shows.
      const shown = addRun(local, { parent: golden, startedAt: NOW - 5 * 60_000, calls: 'rrr', meta: { test: test(5), checks: [{ ok: true, label: 'issue_refund called 0 times', detail: null }] } });
      const others = [1, 2, 3, 4].map((n) => addRun(local, { parent: golden, startedAt: NOW - (10 - n) * 60_000, calls: 'rrr', meta: { test: test(n, shown), checks: [{ ok: true, label: 'issue_refund called 0 times', detail: null }] } }));
      // A run from a pack that names a run of another golden is no attempt of it.
      const other = addRun(local, { parent: golden, startedAt: NOW - 20 * 60_000, calls: 'rrr', meta: { test: { golden: 'goldens/refund-in-limit', session: 's1' } } });
      const odd = addRun(local, { parent: golden, startedAt: NOW - 19 * 60_000, calls: 'rrr', meta: { test: { golden: 'goldens/x', session: 's9', attempt: 2, of: other } } });

      const page = listRunsPage(local, {});
      const tests = page.runs.filter((r) => r.kind === 'test');
      expect(tests.map((r) => r.runId)).toEqual([shown, odd, other]);
      expect(tests[0]).toMatchObject({ attempts: 4, outcome: { kind: 'passed', checks: 1 }, attemptOf: null });
      expect(tests[1]).toMatchObject({ attempts: 0, attemptOf: null, attemptKind: null });
      expect(page.chipCounts.test).toBe(3);
      expect(countRuns(local)).toEqual({ runs: 4, attempts: 4 });
      const listed = listRunsPage(local, { includeAttempts: true }).runs.filter((r) => r.attemptOf === shown);
      expect(listed.map((r) => r.runId).sort()).toEqual([...others].sort());
      expect(listed.every((r) => r.attemptKind === 'test')).toBe(true);
      expect(recentRuns(local).map((r) => r.runId)).not.toContain(others[0]);
      // Deleted, the run takes its attempts with it, and not the run that only named another.
      expect(deleteRuns(local, [shown])).toMatchObject({ done: [shown], attempts: expect.arrayContaining(others) });
      expect(local.allRuns().map((r) => r.runId).sort()).toEqual([golden, other, odd].sort());
    } finally {
      local.close();
    }
  });
});
