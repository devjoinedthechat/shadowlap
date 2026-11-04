import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordBlame, recordVerdict, Store, type BlameReport, type VerifiedRun } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, verifyReport } from '../../engine/test/fix-fixtures.js';
import { fixBundles, fixDetail, fixList } from '../src/fixes.js';
import { runsRule, verifiedLine } from '../src/verdict.js';
import { bundleLine } from '../ui/fixes/model.js';

/**
 * A good run verify keeps against its own baseline is said by its baseline: both tallies and the
 * bound on its drop, never a pass rate alone, under the baseline's rule; a run a verify left open is
 * inconclusive, as its verdict is; and a blame that rescued the run from no call is headed as blame's
 * report heads it, "any model call" only where its bound bears that out.
 */

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => {
  store.close();
});

const KEPT = { margin: 0.1, risk: 0.05, max: 200, source: 'paired' as const, revision: '35034be' };

/** A good run kept against its baseline at the base revision, attempt for attempt. */
function keptRun(runId: string, o: { hi?: number | null; lo?: number | null; decision?: VerifiedRun['decision']; verdict?: VerifiedRun['verdict'] } = {}): VerifiedRun {
  const attempts = Array.from({ length: 38 }, () => ({ runId: `${runId}a`, passed: true, exitCode: 0, failures: [], forkedAt: 1, spent: 0.001, upstreamRequests: 2 }));
  return {
    runId,
    role: 'good',
    attempts,
    passes: 38,
    deterministic: false,
    verdict: o.verdict ?? 'pass',
    decision: o.decision ?? 'pass',
    recorded: { passed: true, failures: [] },
    baseline: { passes: 38, attempts: 38, source: 'paired', revision: '35034be' },
    margin: 0.1,
    drop: { lo: o.lo === undefined ? -0.06 : o.lo, hi: o.hi === undefined ? 0.1 : o.hi, confidence: 0.95, method: 'exact' },
  } as unknown as VerifiedRun;
}

describe('a good run kept against its baseline', () => {
  it('reads by both tallies and the bound on its drop, never a pass rate alone', () => {
    expect(verifiedLine(keptRun('01M5G00000000000000000000A'))).toEqual({ line: 'kept · 38 of 38, baseline 38 of 38 · drop <= 0.10 (95%)', tone: 'ok' });
    // Broken: the bound that bears on it is the drop's least.
    expect(verifiedLine(keptRun('01M5G00000000000000000000B', { verdict: 'fail', decision: 'fail', lo: 0.12, hi: 0.4 })).line).toBe('broken · 38 of 38, baseline 38 of 38 · drop >= 0.12 (95%)');
    // Nothing to bound: the tallies alone.
    expect(verifiedLine({ ...keptRun('01M5G00000000000000000000C'), drop: null }).line).toBe('kept · 38 of 38, baseline 38 of 38');
  });

  it('is decided by its baseline’s rule, any other run by the gate', () => {
    const gate = { kind: 'sprt' as const, good: 0.9, bad: 0.7, risk: 0.05, max: 80 };
    const run = keptRun('01M5G00000000000000000000D');
    expect(runsRule({ gate, needed: 4, attemptsPerRun: 5, kept: KEPT }, run)).toBe('baseline: kept unless it drops 10+ points below its baseline at 35034be, attempt for attempt, <= 5% risk, up to 200 pairs');
    // From the golden's history.
    expect(runsRule({ gate, needed: 4, attemptsPerRun: 5, kept: { ...KEPT, source: 'history' } }, { baseline: { passes: 47, attempts: 50, source: 'history' } })).toBe("baseline: kept unless it drops 10+ points below its golden's history, <= 5% risk, up to 200 attempts");
    // A run with no baseline, in the same report: its gate.
    expect(runsRule({ gate, needed: 4, attemptsPerRun: 5, kept: KEPT }, {})).toBe('gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts');
    expect(runsRule({ gate: null, needed: 4, attemptsPerRun: 5 })).toBe('a run passes when 4 of 5 attempts pass');
  });

  it('says so in the Forks view’s bundle under the good run, line and rule', () => {
    const failing = makeRun(store, { labels: ['refund-bug'] });
    const good = makeRun(store, { labels: ['good'], status: 'completed' });
    recordBlame(store, { runId: failing, report: blameReport(failing), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: 1_000 });
    const report = verifyReport([
      { runId: failing, role: 'target', pass: true },
      { runId: good, role: 'good', pass: true },
    ]);
    // Its attempts, filed under it as verify files them.
    const attempts = report.runs[1].attempts.map((a, i) => {
      const runId = `01M5G0000000000000000000A${i}`;
      store.createRun({ runId, mode: 'replay', parentRunId: good, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, startedAt: 2_000 + i, meta: { verify: { role: 'good', passed: true, verdict: 'passed' } } });
      store.endRun(runId, 'completed');
      return { ...a, runId };
    });
    report.runs[1] = { ...keptRun(good), attempts, passes: attempts.length };
    report.kept = KEPT;
    recordVerdict(store, { report, expect: EXPECT, command: 'shadowlap verify --fixes label:refund-bug --keeps label:good', at: 2_000 });
    const [bundle] = fixBundles(store, good)!.filter((b) => b.kind === 'verify');
    expect(bundle).toMatchObject({ verdictLine: `kept · ${report.runs[1].passes} of ${report.runs[1].attempts.length}, baseline 38 of 38 · drop <= 0.10 (95%)`, rule: 'baseline: kept unless it drops 10+ points below its baseline at 35034be, attempt for attempt, <= 5% risk, up to 200 pairs' });
  });
});

describe('a run a verify left open', () => {
  it('is inconclusive in the Forks view, its verdict too, never unsettled or incomplete', () => {
    const failing = makeRun(store, { labels: ['refund-bug'] });
    recordBlame(store, { runId: failing, report: blameReport(failing), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: 1_000 });
    // Stopped before its gate decided: three attempts passed, and the run is left open.
    const report = { ...verifyReport([{ runId: failing, role: 'target', pass: true }]), verdict: 'incomplete' as const, stopReason: 'the budget ran out' };
    const attempts = report.runs[0].attempts.slice(0, 3).map((a, i) => {
      const runId = `01M5G0000000000000000000B${i}`;
      store.createRun({ runId, mode: 'replay', parentRunId: failing, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, startedAt: 2_000 + i, meta: { verify: { role: 'target', passed: true, verdict: 'passed' } } });
      store.endRun(runId, 'completed');
      return { ...a, runId };
    });
    report.runs[0] = { ...report.runs[0], attempts, passes: 3, verdict: 'open' };
    recordVerdict(store, { report, expect: EXPECT, command: 'shadowlap verify --fixes label:refund-bug', at: 2_000 });
    const [bundle] = fixBundles(store, failing)!.filter((b) => b.kind === 'verify');
    expect(bundle).toMatchObject({ verdictLine: 'inconclusive · 3 of 3', tone: 'y', verdict: 'incomplete' });
    expect(bundleLine(bundle!, (usd) => `≈$${usd.toFixed(3)}`)).toBe('inconclusive · 3 of 3 · ≈$0.036 · 370712a+dirty · inconclusive');
  });
});

describe('a blame that rescued the run from no call', () => {
  it('is headed "not rescued from any model call" only where its bound bears it out', () => {
    const a = makeRun(store, { labels: ['a'] });
    const b = makeRun(store, { labels: ['b'] });
    const record = (runId: string, report: BlameReport) => recordBlame(store, { runId, report, expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: 1_000 });
    // Its first probe found the run lost, with an error past what bears out a claim about every call.
    const loose: BlameReport = { ...blameReport(a, 'unrescuable'), confidence: 'low', errorBound: 0.3 };
    record(a, loose);
    record(b, { ...blameReport(b, 'unrescuable'), confidence: 'high', errorBound: 0.04 });
    const titles = fixList(store).fixes.map((f) => f.steps[0].title);
    expect(titles.sort()).toEqual(['Not rescued from any model call', 'Not rescued from the first model call']);
    expect(fixList(store).fixes.every((f) => f.steps[0].short === 'not rescued')).toBe(true);
    // Its fix's Blame step heads it the same way, from blame's own headline.
    const step = (label: string) => fixDetail(store, fixList(store).fixes.find((f) => f.label === label)!.fixId)!.blame!.title;
    expect([step('a'), step('b')]).toEqual(['Not rescued from the first model call', 'Not rescued from any model call']);
  });
});
