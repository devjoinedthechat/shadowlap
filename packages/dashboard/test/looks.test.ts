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
      { kind: 'presets', icon: 'fail', title: 'Error-path presets failed: forecast', detail: '2 of 4 presets failed: tool timeout #2, provider 429 #3 · 1 inconclusive', action: 'Open', href: `#/run/${failing.timeout}`, runId: failing.timeout, fixId: null, at: expect.any(Number) },
      { kind: 'presets', icon: 'warn', title: 'Error-path presets inconclusive: inbox', detail: '1 of 2 presets inconclusive: provider 500 #4', action: 'Open', href: `#/run/${unsure['500']}`, runId: unsure['500'], fixId: null, at: expect.any(Number) },
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
    // A failed test is a failure: the injection line comes with them, before the failures with no fix yet.
    const failedRun = run({ status: 'failed' });
    const rows = items();
    expect(rows[0]).toEqual({ kind: 'injection', icon: 'fail', title: 'An injection test failed: forecast', detail: 'send_email obeyed a planted instruction (1 of 2)', action: 'Open', href: `#/run/${obeyed}`, runId: obeyed, fixId: null, at: NOW - 4_000 });
    expect(rows.map((r) => r.kind)).toEqual(['injection', 'unblamed']);
    expect(rows[1]!.runId).toBe(failedRun);
  });

  it('lists a preview whose flagged runs no verify accepted, opening the run at the call whose decision changed', () => {
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
    // One sample of several changed a write, which most samples don't show: the report flags nothing.
    session('dc-01M5000000000000000000000G', 'decisions', NOW - 5_000, 'max_tokens=64', { flagged: [], verify: null });
    // A change whose newest preview flags nothing any more: its older preview that flagged a run is settled.
    session('dc-01M5000000000000000000000E', 'decisions', NOW - 50_000, 'temperature=1', { flagged: [refund], verify: null });
    store.putDecisionSession({ sessionId: 'dc-01M5000000000000000000000F', kind: 'decisions', at: NOW - 6_000, change: 'temperature=1', actor: null, revision: null, data: { flagged: [], verify: null }, runs: [{ runId: refund, golden: 'goldens/forecast', rank: null, changed: 0, data: { ...decisionRun, rank: null, decisions: [step(3, null)] } }] });
    expect(items().filter((i) => i.kind === 'decisions')).toEqual([
      { kind: 'decisions', icon: 'warn', title: '1 run decides differently under the model gpt-5-mini', detail: 'a migration: a write, stop or judged change · verify rejected it', action: 'Open', href: `#/run/${refund}/5`, runId: refund, fixId: null, at: NOW - 7_000 },
      { kind: 'decisions', icon: 'warn', title: '1 run decides differently under the prompt and tools in the working tree', detail: 'a preview: a write, stop or judged change · not verified yet', action: 'Open', href: `#/run/${refund}/5`, runId: refund, fixId: null, at: NOW - 9_000 },
    ]);
  });

  it('says how many behaviours seen in production have no golden, opening a run of the newest', () => {
    const capture = run({ runId: '01M5CAPTURE000000000000000', meta: { covers: ['api'], imported: { at: NOW - 5_000, from: 'prod.har' } } });
    const group = (o: Partial<StoredCoverageGroup>): StoredCoverageGroup => ({ key: 'aaaa000011112222', scanId: 'S1', behaviour: { path: ['lookup_order', 'issue_refund'], writes: ['issue_refund'], unknown: [], outcome: 'answered' }, runs: 1, runIds: ['GONE', capture], sources: ['prod.har'], firstSeen: NOW - 9_000, lastSeen: NOW - 5_000, coveredBy: [], nearest: null, command: null, packed: null, ...o });
    store.saveCoverageScan({ scanId: 'S1', at: NOW - 1_000, runs: 2, groups: 2, uncovered: 1, goldens: 1, actor: null, data: null }, [group({}), group({ key: 'bbbb000011112222', coveredBy: ['goldens/forecast'] })]);
    const rows = items();
    expect(rows.at(-1)).toEqual({ kind: 'coverage', icon: 'rec', title: '1 behaviour seen in production has no golden', detail: 'the newest: lookup_order → issue_refund, in prod.har', action: 'Open', href: `#/run/${capture}`, runId: capture, fixId: null, at: NOW - 1_000 });
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
    expect(f!.last.line).toBe('1 of 3 presets failed: tool timeout #2 · replay not tested yet');
    expect(f!.last.result).toBeNull();
    expect(f!.presets).toEqual({ verdict: 'failed', ran: 3, passed: 2, failed: 1, inconclusive: 0, line: '1 of 3 presets failed: tool timeout #2', runId: attempts.timeout, at: expect.any(Number) });
    expect(i!.presets).toMatchObject({ verdict: 'passed', ran: 1, line: '1 of 1 preset passed' });
    // Its replay not tested yet: said so, and not as a golden nothing ran on.
    expect(view.verdict!.title).toBe('1 of 2 goldens pass, 1 tested only by its error-path presets');
  });
});
