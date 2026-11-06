import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cacheUse, countOrigins, gateResult, recordBlame, recordRepair, recordVerdict, Store, storedModelResolver, summarizeRun } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, repairReport, verifyReport } from '../../engine/test/fix-fixtures.js';
import { assistant, cachedUsage, RunBuilder, toolResult, toolUse, usage, user } from '../../engine/test/run-fixtures.js';
import { fixesSummary } from '../src/fixes.js';
import type { GoldenSource } from '../src/tests.js';
import { type NeedsLookRow, overviewOptions, overviewSummary, type OverviewSummary } from '../src/overview.js';
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
  return id[name];
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
  run('probeA', { parent: id.failed1, startedAt: at(9, 29, 9), divergence: 3, calls: 'rrllll', meta: { probe: { of: id.failed1, callNo: 3, passed: true }, repeat: { group: 'p', attempt: 1, of: 2 } } });
  run('probeB', { parent: id.failed1, startedAt: at(9, 29, 9, 5), divergence: 3, calls: 'rrllll', meta: { probe: { of: id.failed1, callNo: 3, passed: false }, repeat: { group: 'p', attempt: 2, of: 2 } } });
  store.updateRunMeta(id.failed1, { blame: blameOf(3, id.probeA, at(9, 29, 10)) });
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
  return names.reduce((t, n) => t + f(summarizeRun(store.getRun(id[n])!, store.getCalls(id[n]), [], [], { modelOf })), 0);
};
const WEEK = ['rec1', 'clean1', 'fork1', 'rep1', 'live1', 'failed1', 'probeA', 'probeB', 'test1', 'test2', 'big', 'bigfork'];
const WEEK_ROWS = WEEK.filter((n) => n !== 'rep1' && n !== 'probeB');

/** A row's step as its button says it: Open with none. */
const stepLabel = (i: NeedsLookRow): string => (!i.step ? 'Open' : i.step.of === 'run' ? i.step.step.label : i.step.of === 'fix' ? i.step.lead.label : i.step.label);

describe('the Overview: this week against last week', () => {
  it('takes the last seven of the viewer’s days as this week, and the seven before as last week', () => {
    expect(o.windows.week).toEqual({ from: Date.UTC(2026, 8, 24, 22), to: Date.UTC(2026, 9, 1, 22) });
    expect(o.windows.lastWeek).toEqual({ from: Date.UTC(2026, 8, 17, 22), to: Date.UTC(2026, 8, 24, 22) });
    expect(o.daily.map((d) => d.day)).toEqual(['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']);
  });

  it('counts runs and calls without attempts, and money and time with them', () => {
    const w = o.sums.week;
    expect(w.runs).toBe(WEEK_ROWS.length);
    expect(w.calls).toBe(WEEK_ROWS.reduce((t, n) => t + codes[n].length, 0));
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
  it('says what was served from recordings today, counting runs, and what is recording now', () => {
    const t = o.today;
    expect(t.day).toBe('2026-10-01');
    // The clean replay, the fork's replayed prefix and the passing test: the --repeat attempt is left out.
    expect(t.served).toBe(10 + 5 + 3);
    // Money counts the attempt, as the day's bar in the chart does: what it replayed was not re-spent either.
    expect(t.notRespent).toBeCloseTo(sumOf(['clean1', 'fork1', 'test1', 'rep1'], (s) => s.cost.saved), 10);
    expect(t.notRespent).toBeCloseTo(o.daily[6].notRespent, 10);
    expect(sumOf(['rep1'], (s) => s.cost.saved)).toBeGreaterThan(0);
    // A recording that sent no request yet says what it is about by its command.
    expect(t.recording).toEqual([{ runId: id.live1, command: 'python refund_agent.py', calls: 3, startedAt: at(10, 1, 10, 10), about: { text: 'python refund_agent.py', from: 'command' } }]);
  });
});

describe('the Overview: recordings in progress', () => {
  it('counts only runs something is recording: one its recorder stopped without ending is not', () => {
    const s = Store.open(':memory:');
    try {
      const live = addRun(s, { startedAt: NOW - 10 * 60_000, status: 'running', calls: 'll' });
      // Killed two days ago, never ended: still marked running, with no recorder left (as a run its
      // process lost reads once that process is gone).
      const left = '01K4ZZ0000000000000000LEFT';
      s.importRun({ runId: left, parentRunId: null, mode: 'record', status: 'running', divergence: null, command: { argv: ['python', 'refund_agent.py'], cwd: '/work' }, codeVersion: null, startedAt: NOW - 2 * DAY, endedAt: null });
      const out = overviewSummary(s, { tz: 'UTC', now: NOW });
      expect(out.today.recording.map((r) => r.runId)).toEqual([live]);
    } finally {
      s.close();
    }
  });
});

describe('the Overview: what a run is about', () => {
  it('names a failed run by its id with its about line, and a recording by its first request', () => {
    const local = Store.open(':memory:');
    try {
      const ask = (text: string) => ({ system: 'You are a support agent.', messages: [{ role: 'user', content: text }] });
      addRun(local, { startedAt: NOW - DAY, calls: [{ code: 'l', request: ask('Ticket T-8812: order A-1042 arrived damaged. Please refund it.') }, { code: 'l', kind: 'tool' }] });
      const live = addRun(local, { startedAt: NOW - 60_000, status: 'running', calls: [{ code: 'l', request: ask('My blender arrived broken. What now?') }] });
      const failed = addRun(local, { startedAt: NOW - 3 * HOUR, status: 'failed', meta: { labels: ['digest'] }, calls: [{ code: 'l', request: ask("Write this week's refund digest and post it to #refunds.") }] });
      const out = overviewSummary(local, { tz: TZ, now: NOW });
      // Needs a look names a failed run by its id, and says what it was about: its label is no name.
      // The page fits the about line to one line, then what is left to do, kept whole.
      expect(out.needsLook.items.find((x) => x.runId === failed)).toMatchObject({ kind: 'unblamed', title: '1 failing run nobody has blamed', about: { text: "Write this week's refund digest and post it to #refunds", from: 'user' }, detail: `${failed.slice(0, 10)} · failed` });
      // A recording in progress says what it is about from its first request on, for Watch live's hover.
      expect(out.today.recording).toEqual([expect.objectContaining({ runId: live, about: { text: 'My blender arrived broken', from: 'user' } })]);
    } finally {
      local.close();
    }
  });
});

describe('the Overview: outcomes, the prompt cache, fixes and what needs a look', () => {
  // The refund story as the Fixes tests tell it: a failure blamed this week, verified by a repair,
  // with a rejected verify before it; an older failure blamed last week; a failed run never blamed.
  const story = (local: Store) => {
    const blame = (runId: string, at: number, title: string) =>
      recordBlame(local, { runId, report: blameReport(runId), expect: EXPECT, scope: null, command: `shadowlap blame ${runId.slice(0, 10)}`, title, checkText: 'issue_refund never called with {"amount":240}', at });
    const failing = makeRun(local, { labels: ['refund-bug'], startedAt: NOW - 3 * DAY, calls: ['api', 'tool', 'api', 'tool', 'api', 'tool', 'api'] });
    const held = makeRun(local, { labels: ['refund-bug'], startedAt: NOW - 3 * DAY });
    const good = makeRun(local, { labels: ['good'], status: 'completed', startedAt: NOW - 3 * DAY });
    const { fix } = blame(failing, NOW - 2 * DAY, 'issue_refund called with amount 240');
    recordVerdict(local, { report: verifyReport([{ runId: failing, role: 'target', pass: true }, { runId: held, role: 'holdout', pass: true }, { runId: good, role: 'good', pass: false }]), expect: EXPECT, command: 'v', at: NOW - 2 * DAY + 1 });
    recordRepair(local, { repairId: 'repair-ov', dir: '.shadowlap/repairs/repair-ov', report: repairReport({ targets: [failing], holdout: [held], good: [good] }), expect: EXPECT, command: 'r', at: NOW - DAY });
    const old = makeRun(local, { labels: ['double-email'], startedAt: NOW - 11 * DAY });
    const { fix: oldFix } = blame(old, NOW - 10 * DAY, 'send_email called twice, not once');
    const never = makeRun(local, { status: 'failed', startedAt: NOW - HOUR, calls: ['api'] });
    return { fixId: fix.fixId, oldFix: oldFix.fixId, never };
  };

  it('takes failures reproduced, fixes verified and the funnel from Fixes, each against last week', () => {
    const local = Store.open(':memory:');
    try {
      const { fixId, oldFix } = story(local);
      const s = overviewSummary(local, { tz: 'UTC', now: NOW });
      const f = fixesSummary(local, NOW);
      expect(s.outcomes.reproduced).toEqual({ value: 1, lastWeek: 1, open: 1 });
      expect(s.outcomes.fixesVerified).toEqual({ value: 1, lastWeek: 0, rejected: 1 });
      expect(s.fixes).toEqual({ ...f.funnel, open: f.open, readyToApply: f.readyToApply, broken: f.broken, attempts: f.attempts, spent: f.spent });
      expect(s.fixes).toMatchObject({ failures: 3, blamed: 2, verified: 1, applied: 0, open: 1, readyToApply: 1, broken: 0 });
      // Needs a look: the open fix and the run never blamed are failures with no fix yet; the verified fix waits to be applied.
      expect(s.needsLook.items.map((i) => [i.group, i.kind, stepLabel(i), i.fixId ?? i.runId])).toEqual([
        ['failing', 'unblamed', 'Run blame', expect.any(String)],
        ['failing', 'open', 'Run repair', oldFix],
        ['ship', 'ready', 'Apply fix', fixId],
      ]);
      expect(s.needsLook.total).toBe(3);
    } finally {
      local.close();
    }
  });

  it('counts failures reproduced in the unit the funnel counts blamed: a failure is a fix, however many of its runs blame replayed', () => {
    const local = Store.open(':memory:');
    try {
      const runs = [0, 1, 2].map((i) => makeRun(local, { labels: ['refund-bug'], startedAt: NOW - 2 * DAY + i * HOUR, calls: ['api', 'tool', 'api', 'tool', 'api', 'tool', 'api'] }));
      // Three runs of one failure, each blamed: the second and third join the first one's fix.
      for (const [i, runId] of runs.entries()) recordBlame(local, { runId, report: blameReport(runId), expect: EXPECT, scope: null, command: `shadowlap blame ${runId.slice(0, 10)}`, title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: NOW - DAY + i * HOUR });
      expect(local.listFixes()).toHaveLength(1);
      const s = overviewSummary(local, { tz: 'UTC', now: NOW });
      expect(s.outcomes.reproduced).toEqual({ value: 1, lastWeek: 0, open: 1 });
      expect(s.fixes).toMatchObject({ failures: 1, blamed: 1 });
    } finally {
      local.close();
    }
  });

  it('counts blames and verdicts in the viewer’s weeks, the weeks its runs are counted in', () => {
    const local = Store.open(':memory:');
    try {
      // Thursday Oct 8 2026, 00:30 in Los Angeles: this week began there on Friday Oct 2, so a
      // failure blamed and fixed on Thursday Oct 1 is last week's, though it is within 7 × 24 hours.
      const now = Date.UTC(2026, 9, 8, 7, 30);
      const la = (day: number, hour: number) => Date.UTC(2026, 9, day, hour + 7);
      const failing = makeRun(local, { labels: ['refund-bug'], startedAt: la(1, 9), calls: ['api', 'tool', 'api', 'tool', 'api', 'tool', 'api'] });
      const held = makeRun(local, { labels: ['refund-bug'], startedAt: la(1, 9) });
      recordBlame(local, { runId: failing, report: blameReport(failing), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: la(1, 12) });
      recordRepair(local, { repairId: 'repair-la', dir: '.shadowlap/repairs/repair-la', report: repairReport({ targets: [failing], holdout: [held] }), expect: EXPECT, command: 'r', at: la(1, 15) });
      const s = overviewSummary(local, { tz: 'America/Los_Angeles', now });
      expect(s.windows.week.from).toBe(la(2, 0));
      expect([s.sums.week.runs, s.sums.lastWeek.runs]).toEqual([0, 2]);
      expect(s.outcomes.reproduced).toEqual({ value: 0, lastWeek: 1, open: 0 });
      expect(s.outcomes.fixesVerified).toMatchObject({ value: 0, lastWeek: 1 });
      // Fixes on its own counts the 7 × 24 hours up to now: there, the same blame and verdict are this week's.
      expect(fixesSummary(local, now)).toMatchObject({ reproduced: { thisWeek: 1, lastWeek: 0 }, verified: { thisWeek: 1, lastWeek: 0 } });
      // An hour later in Berlin it is already Thursday morning: the same instants, the same weeks there.
      const berlin = overviewSummary(local, { tz: 'Europe/Berlin', now });
      expect(berlin.outcomes.reproduced).toMatchObject({ value: 0, lastWeek: 1 });
    } finally {
      local.close();
    }
  });

  it('stands for this week’s failed runs nobody has blamed with one row, naming the newest', () => {
    const local = Store.open(':memory:');
    try {
      const { fixId } = story(local);
      // Twelve more failed runs never blamed this week, thirteen with the story's own, and one of last week's.
      for (let i = 0; i < 12; i++) makeRun(local, { status: 'failed', startedAt: NOW - 2 * HOUR - i * 60_000 });
      makeRun(local, { status: 'failed', startedAt: NOW - 8 * 24 * HOUR });
      const s = overviewSummary(local, { tz: 'UTC', now: NOW });
      expect(s.needsLook.items.map((i) => i.kind)).toEqual(['unblamed', 'open', 'ready']);
      const row = s.needsLook.items[0];
      expect(row).toMatchObject({ key: `attn:unblamed:${row.runId}`, group: 'failing', icon: 'fail', title: '13 failing runs nobody has blamed', href: '#/runs?types=failed&from=2026-09-25&to=2026-10-01' });
      expect(row.detail).toMatch(/^newest \w{10} · /);
      expect(s.needsLook.total).toBe(3);
      expect(s.needsLook.items.at(-1)).toMatchObject({ kind: 'ready', fixId });
    } finally {
      local.close();
    }
  });

  it('says Tests passing and lists failing tests from the goldens on disk, and nothing without goldens', () => {
    const local = Store.open(':memory:');
    try {
      const goldens: GoldenSource[] = [
        { path: 'goldens/refund-flow', runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] },
        { path: 'goldens/refund-in-limit', runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] },
      ];
      const failed = addRun(local, { startedAt: NOW - HOUR, status: 'failed', divergence: 1, calls: 'f', meta: { test: { golden: 'goldens/refund-in-limit', session: 's' } } });
      const session = (at: number, limitOk: boolean) => {
        const t = local.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'c91d0f4', actor: 'ci', startedAt: at });
        local.addTestResult({ sessionId: t.sessionId, golden: 'goldens/refund-flow', ok: true, reason: null, runId: null, revision: 'c91d0f4', at: at + 1, data: { mode: 'replay' } });
        local.addTestResult({ sessionId: t.sessionId, golden: 'goldens/refund-in-limit', ok: limitOk, ...(limitOk ? {} : { failure: 'diverged' as const }), reason: limitOk ? null : 'diverged at call 1 (api POST /v1/messages)', runId: limitOk ? null : failed, revision: 'c91d0f4', at: at + 2, data: { mode: 'replay' } });
        local.finishTestSession(t.sessionId, { passed: limitOk ? 2 : 1, failed: limitOk ? 0 : 1, upstreamRequests: 0, endedAt: at + 10 });
      };
      session(NOW - 9 * DAY, true);
      session(NOW - HOUR, false);
      const s = overviewSummary(local, { tz: 'UTC', now: NOW, goldens });
      expect(s.outcomes.testsPassing).toEqual({ goldens: 2, passing: 1, inconclusive: 0, untested: 0, lastWeek: 2, regressions: 1, lastRunAt: NOW - HOUR + 10 });
      // No fix holds the failure yet: the line opens the failing run, and says so.
      expect(s.needsLook.items[0]).toMatchObject({ kind: 'test', icon: 'fail', title: 'A golden failed: refund-in-limit', action: 'Open', runId: failed, href: `#/run/${failed}` });
      // Blamed, the failure has a fix: Fix leads to it.
      const { fix } = recordBlame(local, { runId: failed, report: blameReport(failed), expect: EXPECT, scope: null, command: 'c', title: 'refund-in-limit diverged', checkText: 'x', at: NOW - HOUR / 2 });
      expect(overviewSummary(local, { tz: 'UTC', now: NOW, goldens }).needsLook.items.find((i) => i.kind === 'test')).toMatchObject({ action: 'Fix', runId: failed, fixId: fix.fixId, href: `#/fixes/${fix.fixId}` });
      expect(overviewSummary(local, { tz: 'UTC', now: NOW }).outcomes.testsPassing).toBeNull();
      expect(overviewSummary(local, { tz: 'UTC', now: NOW }).needsLook.items.some((i) => i.kind === 'test')).toBe(false);
    } finally {
      local.close();
    }
  });

  it('says a gated golden’s verdict as its gate does, the rule apart for the line’s hover (decision 9)', () => {
    const local = Store.open(':memory:');
    try {
      const goldens: GoldenSource[] = [{ path: 'goldens/eval-pushy', runId: null, packedAt: null, mode: 'fork', repeat: 1, passes: 1, checks: ['issue_refund called 0 times'], gate: { kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 20 } }];
      const t = local.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'c91d0f4', startedAt: NOW - HOUR });
      const g = gateResult({ kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 20 }, [false, false, false]);
      local.addTestResult({ sessionId: t.sessionId, golden: 'goldens/eval-pushy', ok: false, failure: 'check', reason: g.sentence, runId: null, revision: 'c91d0f4', at: NOW - HOUR + 1, data: { mode: 'fork', attempts: { total: 3, passed: 0, required: null, runs: [] }, verdict: 'failed', gate: g } });
      local.finishTestSession(t.sessionId, { passed: 0, failed: 1, upstreamRequests: 0, endedAt: NOW - HOUR + 2 });
      const row = overviewSummary(local, { tz: 'UTC', now: NOW, goldens }).needsLook.items[0];
      // The verdict word, the tally and the bound, whole: no rule in the line to cut off mid-figure.
      expect(row).toMatchObject({ kind: 'test', title: 'A golden failed: eval-pushy', detail: 'failed · 0 of 3 · rate <= 0.71 (95%)', rule: 'gate: tells 90%+ from 70%- at <= 5% risk, up to 20 attempts' });
    } finally {
      local.close();
    }
  });

  it('puts runs only on this machine last, when a team store is set', () => {
    const local = Store.open(':memory:');
    try {
      story(local);
      const s = overviewSummary(local, { tz: 'UTC', now: NOW, teamStore: { name: 'northwind-agent-runs/support-agent', onlyLocal: 7 } });
      // On Runs, as the design has it: the local tags show which, and the bulk bar pushes them.
      // Push leads to those runs: Runs with Local picked.
      expect(s.needsLook.items.at(-1)).toEqual({ kind: 'local', icon: 'rec', title: '7 runs are only on this machine', detail: 'push them so the team can open them', action: 'Push', href: '#/runs?types=local', runId: null, fixId: null, at: 0 });
      expect(overviewSummary(local, { tz: 'UTC', now: NOW, teamStore: { name: 'x', onlyLocal: 1 } }).needsLook.items.at(-1)).toMatchObject({ title: '1 run is only on this machine', detail: 'push it so the team can open it' });
      expect(overviewSummary(local, { tz: 'UTC', now: NOW, teamStore: { name: 'x', onlyLocal: 0 } }).needsLook.items.some((i) => i.kind === 'local')).toBe(false);
      // A store's setup left unfinished leads back to it, first.
      const setup = overviewSummary(local, { tz: 'UTC', now: NOW, teamStore: { name: 'x', onlyLocal: 7, setup: { step: 3, title: 'Push from CI' } } }).needsLook;
      expect(setup.items[0]).toEqual({ kind: 'store-setup', icon: 'setting', title: 'The team store’s setup isn’t finished', detail: 'step 3 of 4: push from CI', action: 'Continue', href: '#/setup/store', runId: null, fixId: null, at: 0 });
      expect(setup.total).toBe(s.needsLook.total + 1);
    } finally {
      local.close();
    }
  });

  it('finds where the prompt cache stopped hitting by the run page’s rule, and names each run’s kind', () => {
    const local = Store.open(':memory:');
    try {
      const turn = (b: RunBuilder, m: number, broken = false) => {
        const q: unknown[] = [user('Begin.')];
        for (let i = 1; i < m; i++) q.push(assistant([toolUse('step', { i }, `toolu_${i}`)]), user([toolResult(`toolu_${i}`, 'ok')]));
        const u = broken ? usage(10, 0, cachedUsage(m).cacheReadInputTokens! + cachedUsage(m).cacheCreationInputTokens!) : cachedUsage(m);
        b.model({ messages: q }, [toolUse('step', { i: m }, `toolu_${m}`)], { usage: u });
      };
      const b = RunBuilder.start(local, { startedAt: NOW - HOUR });
      for (let m = 1; m <= 4; m++) turn(b, m, m === 3);
      const runId = b.end();
      // Last week's runs are not this week's cache.
      const old = RunBuilder.start(local, { startedAt: NOW - 9 * DAY });
      for (let m = 1; m <= 4; m++) turn(old, m, m === 2);
      old.end();
      const s = overviewSummary(local, { tz: 'UTC', now: NOW });
      const engine = cacheUse(local, s.windows.week.from, { limit: 4 });
      expect(s.cache).toEqual({ input: engine.liveInput, cacheRead: engine.liveRead, readShare: engine.readShare, misses: [{ runId, kind: 'recording', callNo: 3, scope: null, model: 'sonnet-5', tokens: engine.largest[0].sentAgain }], sentAgain: engine.sentAgain, missCount: 1 });
      expect(engine.largest.map((m) => [m.runId, m.callNo, m.model])).toEqual([[runId, 3, 'sonnet-5']]);
      expect(s.cache.readShare).toBeGreaterThan(0);
      const empty = overviewSummary(Store.open(':memory:'), { tz: 'UTC', now: NOW });
      expect(empty.cache).toEqual({ input: 0, cacheRead: 0, readShare: null, misses: [], sentAgain: 0, missCount: 0 });
      expect(empty.sums.week).toMatchObject({ runs: 0, calls: 0, spent: 0 });
      expect(empty.needsLook).toEqual({ items: [], total: 0 });
    } finally {
      local.close();
    }
  });

  it('refuses a time zone it does not know', () => {
    expect(() => overviewSummary(store, { tz: 'Mars/Olympus' })).toThrow(RangeError);
    expect(overviewOptions(new URLSearchParams('tz=Asia/Tokyo'))).toEqual({ tz: 'Asia/Tokyo' });
    expect(overviewOptions(new URLSearchParams('tz=nowhere'))).toMatchObject({ error: expect.stringContaining('time zone') });
    expect(overviewOptions(new URLSearchParams(''))).toEqual({});
  });
});
