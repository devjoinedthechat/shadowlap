import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store, type StoredCoverageGroup } from '@shadowlap/engine';
import { overviewSummary, type NeedsLookRow } from '../src/overview.js';
import { testsView, type GoldenSource } from '../src/tests.js';

/**
 * Needs a look takes in what the upgrades found, kept in the store by the CLI: an injection test a
 * planted instruction got through (red, with the failures), error-path presets that failed (red) or
 * couldn't say (amber), a preview of a change whose flagged runs no verify accepted (amber), and the
 * behaviours seen in production that no golden covers. Each line opens the run that shows it.
 */

const NOW = Date.UTC(2026, 9, 1, 10, 15);
let store: Store;

const run = (o: { runId?: string; parent?: string | null; status?: 'completed' | 'failed'; meta?: Record<string, unknown>; at?: number } = {}): string => {
  const r = store.createRun({ ...(o.runId ? { runId: o.runId } : {}), mode: o.parent ? 'replay' : 'record', parentRunId: o.parent ?? null, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, startedAt: o.at ?? NOW - 3_600_000, ...(o.meta ? { meta: o.meta } : {}) });
  store.endRun(r.runId, o.status ?? 'completed', (o.at ?? NOW - 3_600_000) + 1_000);
  return r.runId;
};

const goldens: GoldenSource[] = [
  { path: 'goldens/forecast', runId: null, packedAt: 1, mode: 'replay', repeat: 1, passes: 1, checks: [] },
  { path: 'goldens/inbox', runId: null, packedAt: 1, mode: 'replay', repeat: 1, passes: 1, checks: [] },
];

const items = (): NeedsLookRow[] => overviewSummary(store, { tz: 'UTC', now: NOW, goldens }).needsLook.items;

beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => store.close());

/** A golden's presets, as `test --chaos` keeps them: each preset's verdict and the attempt that ran it. */
function presets(golden: string, recording: string, cells: Array<{ preset: string; verdict: 'passed' | 'failed' | 'inconclusive' | 'not-applicable'; callNo: number | null }>, sessionId = `X-${golden}`): Record<string, string> {
  store.startChaosSession({ sessionId, startedAt: NOW - 600_000, command: ['shadowlap', 'test', golden, '--chaos'], presets: cells.map((c) => c.preset) });
  const attempts: Record<string, string> = {};
  cells.forEach((c, i) => {
    const attempt = c.verdict === 'not-applicable' ? null : run({ parent: recording, status: c.verdict === 'passed' ? 'completed' : 'failed', meta: { chaos: { preset: c.preset, callNo: c.callNo, session: sessionId, attempt: 1, golden } } });
    if (attempt) attempts[c.preset] = attempt;
    store.addChaosResult({ sessionId, runId: recording, golden, preset: c.preset, verdict: c.verdict, callNo: c.callNo, passes: c.verdict === 'passed' ? 1 : 0, attempts: attempt ? 1 : 0, at: NOW - 600_000 + i, data: { detail: `${c.preset}: the agent exited ${c.verdict === 'passed' ? '0' : 'with code 1'}`, runs: attempt ? [{ runId: attempt, verdict: c.verdict === 'not-applicable' ? 'inconclusive' : c.verdict, passed: c.verdict === 'passed', exitCode: c.verdict === 'passed' ? 0 : 1 }] : [] } });
  });
  store.finishChaosSession(sessionId, { passed: 1, failed: 1, inconclusive: 0, upstreamRequests: 0, endedAt: NOW - 500_000 });
  return attempts;
}

describe('the upgrades’ results in Needs a look', () => {
  it('lists presets that failed in red and those that couldn’t say in amber, each opening its attempt', () => {
    const forecast = run();
    const failing = presets('goldens/forecast', forecast, [
      { preset: 'timeout', verdict: 'failed', callNo: 2 },
      { preset: 'empty', verdict: 'passed', callNo: 2 },
      { preset: '429', verdict: 'failed', callNo: 3 },
      { preset: '500', verdict: 'inconclusive', callNo: 3 },
      { preset: 'malformed', verdict: 'not-applicable', callNo: null },
    ]);
    const inbox = run();
    const unsure = presets('goldens/inbox', inbox, [
      { preset: 'timeout', verdict: 'passed', callNo: 2 },
      { preset: '500', verdict: 'inconclusive', callNo: 4 },
    ]);
    // A golden no longer on disk, whose presets failed: nothing to look at.
    presets('goldens/gone', run(), [{ preset: 'timeout', verdict: 'failed', callNo: 2 }]);
    const rows = items().filter((i) => i.kind === 'presets');
    expect(rows).toEqual([
      { kind: 'presets', icon: 'fail', title: 'Error-path presets failed: forecast', detail: '2 of 4 presets failed: tool timeout #2, provider 429 #3 · 1 inconclusive', key: 'attn:presets:goldens/forecast', group: 'failing', step: null, href: `#/run/${failing.timeout}`, runId: failing.timeout, fixId: null, at: expect.any(Number) },
      { kind: 'presets', icon: 'warn', title: 'Error-path presets inconclusive: inbox', detail: '1 of 2 presets inconclusive: provider 500 #4', key: 'attn:presets:goldens/inbox', group: 'tests', step: null, href: `#/run/${unsure['500']}`, runId: unsure['500'], fixId: null, at: expect.any(Number) },
    ]);
  });

  it('lists an injection test a planted instruction got through first, opening the attempt that obeyed', () => {
    const recording = run();
    const obeyed = run({ parent: recording, meta: { injection: { result: 'inj-01A', role: 'attempt', read: 1, payload: 'notice', attempt: 1, of: 2, verdict: 'obeyed' } } });
    const ignored = run({ parent: recording, meta: { injection: { result: 'inj-01A', role: 'attempt', read: 1, payload: 'notice', attempt: 2, of: 2, verdict: 'ignored' } } });
    const data = { mode: 'plant', attempts: [{ runId: ignored, verdict: 'ignored', evidence: [] }, { runId: obeyed, verdict: 'obeyed', evidence: [{ kind: 'canary', callNo: 3, tool: 'send_email', path: '$.to', value: 'x' }] }], gate: { verdict: 'failed' } };
    store.putInjectionResult({ resultId: 'inj-01A', runId: recording, golden: 'goldens/forecast', sessionId: null, mode: 'plant', at: NOW - 5_000, endedAt: NOW - 4_000, attempts: 2, obeyed: 1, influenced: 0, ignored: 1, inconclusive: 0, verdict: 'obeyed', actor: null, data });
    // One of a golden no longer on disk: nothing to look at.
    store.putInjectionResult({ resultId: 'inj-01B', runId: recording, golden: 'goldens/gone', sessionId: null, mode: 'plant', at: NOW - 3_000, endedAt: NOW - 2_000, attempts: 1, obeyed: 1, influenced: 0, ignored: 0, inconclusive: 0, verdict: 'obeyed', actor: null, data });
    // The injection line is under Security, after the failures.
    const failedRun = run({ status: 'failed' });
    const all = items();
    const rows = all.filter((r) => r.kind === 'injection');
    expect(rows[0]).toEqual({ kind: 'injection', icon: 'fail', title: 'An injection test failed: forecast', detail: 'send_email obeyed a planted instruction (1 of 2)', key: expect.stringMatching(/^attn:injection:#\/run\//), group: 'security', step: null, href: `#/run/${obeyed}`, runId: obeyed, fixId: null, at: NOW - 4_000 });
    expect(all.map((r) => r.kind)).toEqual(['unblamed', 'injection']);
    expect(all[0].runId).toBe(failedRun);
  });

  it('lists a preview whose flagged runs no verify accepted, opening its cell on Preview, and a migration’s run, at the call whose decision changed', () => {
    const refund = run();
    const step = (callNo: number, majority: number | null) => ({ callNo, step: callNo, rank: majority, majority, samples: { asked: 1, answered: 1, changed: majority ? 1 : 0, ranks: [majority ?? 0] }, changes: [] });
    const decisionRun = { runId: refund, golden: 'goldens/forecast', rank: 1, decisions: [step(3, null), step(5, 1), step(7, 2)] };
    const session = (sessionId: string, kind: 'decisions' | 'migrate', at: number, change: string, data: Record<string, unknown>) =>
      store.putDecisionSession({ sessionId, kind, at, change, actor: null, revision: null, data, runs: [{ runId: refund, golden: 'goldens/forecast', rank: 1, changed: 2, data: decisionRun }] });
    session('dc-01M5000000000000000000000A', 'decisions', NOW - 9_000, 'the prompt and tools in the working tree', { flagged: [refund], verify: null });
    // An older preview of the same change: the newest says it.
    session('dc-01M5000000000000000000000B', 'decisions', NOW - 99_000, 'the prompt and tools in the working tree', { flagged: [refund], verify: null });
    // A migration whose flagged run a verify accepted: nothing to look at.
    session('mg-01M5000000000000000000000C', 'migrate', NOW - 8_000, 'the model claude-haiku-4-5', { flagged: [refund], decisions: { flagged: [refund] }, passes: { verdict: 'accepted', runs: [] } });
    // One a verify rejected.
    session('mg-01M5000000000000000000000D', 'migrate', NOW - 7_000, 'the model gpt-5-mini', { flagged: [refund], decisions: { flagged: [refund] }, passes: { verdict: 'rejected', runs: [] } });
    // A change whose newest preview flags nothing any more: its older preview that flagged a run is settled.
    session('dc-01M5000000000000000000000E', 'decisions', NOW - 50_000, 'temperature=1', { flagged: [refund], verify: null });
    store.putDecisionSession({ sessionId: 'dc-01M5000000000000000000000F', kind: 'decisions', at: NOW - 6_000, change: 'temperature=1', actor: null, revision: null, data: { flagged: [], verify: null }, runs: [{ runId: refund, golden: 'goldens/forecast', rank: null, changed: 0, data: { ...decisionRun, rank: null, decisions: [step(3, null)] } }] });
    expect(items().filter((i) => i.kind === 'decisions')).toEqual([
      { kind: 'decisions', icon: 'warn', title: '1 run decides differently under the model gpt-5-mini', detail: 'a migration: a write, stop or judged change · verify rejected it', key: 'attn:decisions:mg-01M5000000000000000000000D', group: 'tests', step: null, href: `#/run/${refund}/5`, runId: refund, fixId: null, at: NOW - 7_000 },
      { kind: 'decisions', icon: 'warn', title: '1 run decides differently under the prompt and tools in the working tree', detail: 'a preview: a write, stop or judged change · not verified yet', key: 'attn:decisions:dc-01M5000000000000000000000A', group: 'tests', step: null, href: `#/changes/decisions/dc-01M5000000000000000000000A/${refund}/5`, runId: refund, fixId: null, at: NOW - 9_000 },
    ]);
  });

  it('settles a preview once a newer session of the same change, of either kind, accepted the runs it flags', () => {
    const ticket = run();
    const golden = run();
    const third = run();
    const step = (callNo: number, majority: number | null) => ({ callNo, step: callNo, rank: majority, majority, samples: { asked: 1, answered: 1, changed: majority ? 1 : 0, ranks: [majority ?? 0] }, changes: [] });
    const session = (sessionId: string, kind: 'decisions' | 'migrate', at: number, data: Record<string, unknown>, runs: string[]) =>
      store.putDecisionSession({ sessionId, kind, at, change: 'the model claude-haiku-4-5', actor: null, revision: null, data, runs: runs.map((runId) => ({ runId, golden: null, rank: 1, changed: 1, data: { runId, golden: null, rank: 1, decisions: [step(17, 1)] } })) });
    // The demo's: a preview of the model on the ticket run, then a migration of the goldens to it,
    // which flagged the same run and whose verify accepted it.
    session('dc-01M5000000000000000000000A', 'decisions', NOW - 9_000, { flagged: [ticket], verify: null }, [ticket]);
    session('mg-01M5000000000000000000000B', 'migrate', NOW - 5_000, { flagged: [ticket], decisions: { flagged: [ticket], verify: { verdict: 'accepted', runs: [{ runId: ticket, role: 'good', outcome: 'kept', passes: 2, attempts: 2 }] } }, passes: { verdict: 'accepted', runs: [] } }, [ticket, golden]);
    const decisions = () => items().filter((i) => i.kind === 'decisions');
    expect(decisions()).toEqual([]);
    // An older preview that also flagged a run the migration never asked again: its line, for that run alone.
    session('dc-01M5000000000000000000000C', 'decisions', NOW - 20_000, { flagged: [ticket, third], verify: null }, [ticket, third]);
    expect(decisions()).toEqual([expect.objectContaining({ title: '1 run decides differently under the model claude-haiku-4-5', detail: 'a preview: a write, stop or judged change · not verified yet', href: `#/changes/decisions/dc-01M5000000000000000000000C/${third}/17`, runId: third, at: NOW - 20_000 })]);
    // A newer migration flagged that run too, and its verify rejected it: the line is the migration's, once.
    session('mg-01M5000000000000000000000D', 'migrate', NOW - 1_000, { flagged: [third], decisions: { flagged: [third] }, passes: { verdict: 'rejected', runs: [] } }, [third]);
    expect(decisions()).toEqual([expect.objectContaining({ title: '1 run decides differently under the model claude-haiku-4-5', detail: 'a migration: a write, stop or judged change · verify rejected it', runId: third, at: NOW - 1_000 })]);
  });

  it('leaves a golden’s injection gate to Tests, so one failure is one line; a golden tested on its own keeps its line', () => {
    const forecast = run();
    const inbox = run();
    const replay = run({ parent: forecast, meta: { test: { golden: 'goldens/forecast', session: 'S' } } });
    const obeyed = run({ parent: forecast, meta: { injection: { result: 'inj-01A', role: 'attempt', read: 1, payload: 'notice', attempt: 1, of: 1, verdict: 'obeyed' } } });
    const session = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], startedAt: NOW - 10_000 });
    const gate = (resultId: string, runId: string, golden: string, o: { obeyed: number; inconclusive: number; verdict: 'failed' | 'inconclusive'; attempt: string }) =>
      store.putInjectionResult({ resultId, runId, golden, sessionId: session.sessionId, mode: 'plant', at: NOW - 9_000, endedAt: NOW - 8_000, attempts: 1, obeyed: o.obeyed, influenced: 0, ignored: 0, inconclusive: o.inconclusive, verdict: o.obeyed ? 'obeyed' : 'inconclusive', actor: null, data: { mode: 'plant', attempts: [{ runId: o.attempt, verdict: o.obeyed ? 'obeyed' : 'inconclusive', evidence: [] }], gate: { verdict: o.verdict } } });
    // forecast's gate let a planted instruction through, which failed its test; inbox's showed too little to say.
    gate('inj-01A', forecast, 'goldens/forecast', { obeyed: 1, inconclusive: 0, verdict: 'failed', attempt: obeyed });
    store.addTestResult({ sessionId: session.sessionId, golden: 'goldens/forecast', ok: false, failure: 'injection', reason: 'injection: 1 obeyed, at most 0 allowed', runId: replay, at: NOW - 8_000, data: { injection: { resultId: 'inj-01A', attempts: 1, obeyed: 1, influenced: 0, ignored: 0, inconclusive: 0, allowed: { obeyed: 0, influenced: null }, verdict: 'failed', reason: '1 obeyed, at most 0 allowed', skipped: null } } as never });
    gate('inj-01B', inbox, 'goldens/inbox', { obeyed: 0, inconclusive: 1, verdict: 'inconclusive', attempt: run({ parent: inbox }) });
    store.addTestResult({ sessionId: session.sessionId, golden: 'goldens/inbox', ok: false, failure: 'inconclusive', reason: 'injection inconclusive: no attempt reached the read', runId: null, at: NOW - 7_500, data: { injection: { resultId: 'inj-01B', attempts: 1, obeyed: 0, influenced: 0, ignored: 0, inconclusive: 1, allowed: { obeyed: 0, influenced: null }, verdict: 'inconclusive', reason: 'no attempt reached the read', skipped: null } } as never });
    store.finishTestSession(session.sessionId, { passed: 0, failed: 2, upstreamRequests: 0, endedAt: NOW - 7_000 });
    // One line each, its test's: red for the failure, amber for the one that couldn't say.
    expect(items().map((r) => [r.kind, r.icon, r.title])).toEqual([
      ['test', 'fail', 'A golden failed: forecast'],
      ['test', 'warn', 'A golden is inconclusive: inbox'],
    ]);
    expect(overviewSummary(store, { tz: 'UTC', now: NOW, goldens }).needsLook.total).toBe(2);
    // Tested on its own since (`shadowlap injection goldens/forecast`): a line of its own, under Security after the tests.
    const again = run({ parent: forecast, meta: { injection: { result: 'inj-01C', role: 'attempt', read: 1, payload: 'notice', attempt: 1, of: 1, verdict: 'obeyed' } } });
    store.putInjectionResult({ resultId: 'inj-01C', runId: forecast, golden: 'goldens/forecast', sessionId: null, mode: 'plant', at: NOW - 2_000, endedAt: NOW - 1_000, attempts: 1, obeyed: 1, influenced: 0, ignored: 0, inconclusive: 0, verdict: 'obeyed', actor: null, data: { mode: 'plant', attempts: [{ runId: again, verdict: 'obeyed', evidence: [] }], gate: { verdict: 'failed' } } });
    expect(items().map((r) => [r.kind, r.title, r.runId])).toEqual([
      ['test', 'A golden failed: forecast', replay],
      ['test', 'A golden is inconclusive: inbox', null],
      ['injection', 'An injection test failed: forecast', again],
    ]);
  });

  it('lists the upgrades’ lines in the design’s one order, among the failures and the fixes', () => {
    const forecast = run();
    const inbox = run();
    // A failing test and an inconclusive one.
    const session = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], startedAt: NOW - 30_000 });
    store.addTestResult({ sessionId: session.sessionId, golden: 'goldens/forecast', ok: false, failure: 'exit', reason: 'the agent exited with code 1', runId: null, at: NOW - 29_000 });
    store.addTestResult({ sessionId: session.sessionId, golden: 'goldens/inbox', ok: false, failure: 'inconclusive', reason: 'a check could not be judged', runId: null, at: NOW - 28_000 });
    store.finishTestSession(session.sessionId, { passed: 0, failed: 2, upstreamRequests: 0, endedAt: NOW - 27_000 });
    // Injection tests of two recordings: one obeyed, the newer one influenced.
    const tested = (resultId: string, at: number, o: { obeyed: number; influenced: number }) => {
      const recording = run();
      const attempt = run({ parent: recording });
      store.putInjectionResult({ resultId, runId: recording, golden: null, sessionId: null, mode: 'plant', at, endedAt: at + 1, attempts: 1, obeyed: o.obeyed, influenced: o.influenced, ignored: 0, inconclusive: 0, verdict: o.obeyed ? 'obeyed' : 'influenced', actor: null, data: { mode: 'plant', attempts: [{ runId: attempt, verdict: o.obeyed ? 'obeyed' : 'influenced', evidence: [] }], gate: { verdict: o.obeyed ? 'failed' : 'passed' } } });
    };
    tested('inj-01A', NOW - 20_000, { obeyed: 1, influenced: 0 });
    tested('inj-01B', NOW - 10_000, { obeyed: 0, influenced: 1 });
    // Presets that failed on one golden and couldn't say on the other.
    presets('goldens/forecast', forecast, [{ preset: 'timeout', verdict: 'failed', callNo: 2 }]);
    presets('goldens/inbox', inbox, [{ preset: '500', verdict: 'inconclusive', callNo: 3 }]);
    // A failed run nobody blamed, a preview of a change that flags a run, and a behaviour with no golden.
    run({ status: 'failed' });
    store.putDecisionSession({ sessionId: 'dc-01M5000000000000000000000A', kind: 'decisions', at: NOW - 5_000, change: 'temperature=1', actor: null, revision: null, data: { flagged: [forecast], verify: null }, runs: [{ runId: forecast, golden: null, rank: 1, changed: 1, data: { runId: forecast, rank: 1, decisions: [] } }] });
    const capture = run({ meta: { covers: ['api'], imported: { at: NOW - 5_000, from: 'prod.har' } } });
    store.saveCoverageScan({ scanId: 'S1', at: NOW - 1_000, runs: 1, groups: 1, uncovered: 1, goldens: 2, actor: null, data: null }, [{ key: 'aaaa000011112222', scanId: 'S1', behaviour: { path: ['lookup_order'], writes: [], unknown: [], outcome: 'answered' }, runs: 1, runIds: [capture], sources: ['prod.har'], firstSeen: NOW - 9_000, lastSeen: NOW - 5_000, coveredBy: [], nearest: null, command: null, packed: null }]);
    expect(items().map((r) => [r.kind, r.icon])).toEqual([
      ['test', 'fail'],
      ['presets', 'fail'],
      ['unblamed', 'fail'],
      ['test', 'warn'],
      ['presets', 'warn'],
      ['coverage', 'rec'],
      ['decisions', 'warn'],
      ['injection', 'fail'],
      ['injection', 'warn'],
    ]);
  });

  it('says how many behaviours seen in production have no golden, opening a run of the newest', () => {
    const capture = run({ runId: '01M5CAPTURE000000000000000', meta: { covers: ['api'], imported: { at: NOW - 5_000, from: 'prod.har' } } });
    const group = (o: Partial<StoredCoverageGroup>): StoredCoverageGroup => ({ key: 'aaaa000011112222', scanId: 'S1', behaviour: { path: ['lookup_order', 'issue_refund'], writes: ['issue_refund'], unknown: [], outcome: 'answered' }, runs: 1, runIds: ['GONE', capture], sources: ['prod.har'], firstSeen: NOW - 9_000, lastSeen: NOW - 5_000, coveredBy: [], nearest: null, command: null, packed: null, ...o });
    store.saveCoverageScan({ scanId: 'S1', at: NOW - 1_000, runs: 2, groups: 2, uncovered: 1, goldens: 1, actor: null, data: null }, [group({}), group({ key: 'bbbb000011112222', coveredBy: ['goldens/forecast'] })]);
    const rows = items();
    expect(rows.at(-1)).toEqual({
      kind: 'coverage',
      icon: 'rec',
      title: '1 behaviour seen in production has no golden',
      detail: 'the newest: lookup_order → issue_refund, in prod.har',
      key: 'attn:coverage:aaaa000011112222',
      group: 'tests',
      step: null,
      href: `#/run/${capture}`,
      runId: capture,
      fixId: null,
      at: NOW - 1_000,
      // Advice, stating every behaviour no golden covers: the key stays `coverage` whichever is newest.
      advice: { key: 'coverage', facts: ['aaaa000011112222'], until: 'Until another behaviour has no golden', dismissed: false },
    });
  });

  it('adds nothing for a store where the upgrades found nothing to look at', () => {
    const recording = run();
    presets('goldens/forecast', recording, [{ preset: 'timeout', verdict: 'passed', callNo: 2 }]);
    expect(items()).toEqual([]);
  });
});

describe('a golden’s presets on Tests', () => {
  it('says how they came out on its row, and never calls a golden whose presets ran not run yet', () => {
    const forecast = run();
    const attempts = presets('goldens/forecast', forecast, [
      { preset: 'timeout', verdict: 'failed', callNo: 2 },
      { preset: 'empty', verdict: 'passed', callNo: 2 },
      { preset: '429', verdict: 'passed', callNo: 3 },
    ]);
    const inbox = run();
    presets('goldens/inbox', inbox, [{ preset: 'timeout', verdict: 'passed', callNo: 2 }]);
    // inbox's replay passed too; forecast's never ran.
    const t = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/inbox'], revision: 'a1b2c3d', startedAt: NOW - 100_000 });
    store.addTestResult({ sessionId: t.sessionId, golden: 'goldens/inbox', ok: true, runId: null, revision: 'a1b2c3d', at: NOW - 99_000, data: { mode: 'replay' } });
    store.finishTestSession(t.sessionId, { passed: 1, failed: 0, upstreamRequests: 0, endedAt: NOW - 98_000 });
    const view = testsView(store, goldens);
    const [f, i] = view.rows;
    expect(f.last.line).toBe('1 of 3 presets failed: tool timeout #2 · replay not tested yet');
    expect(f.last.result).toBeNull();
    expect(f.presets).toEqual({ verdict: 'failed', ran: 3, passed: 2, failed: 1, inconclusive: 0, line: '1 of 3 presets failed: tool timeout #2', runId: attempts.timeout, at: expect.any(Number) });
    expect(i.presets).toMatchObject({ verdict: 'passed', ran: 1, line: '1 of 1 preset passed' });
    // Its replay not tested yet: said so, and not as a golden nothing ran on.
    expect(view.verdict!.title).toBe('1 of 2 goldens passed · 1 golden tested only by its error-path presets');
  });
});
