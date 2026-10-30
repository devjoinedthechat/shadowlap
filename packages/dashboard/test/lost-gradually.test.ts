import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordBlame, recordRepair, Store } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, repairReport } from '../../engine/test/fix-fixtures.js';
import { fixDetail, fixForRun } from '../src/fixes.js';
import { runOutcome, sideLine, sideStatus, type RunLike } from '../ui/runs.js';

/**
 * A run blame found lost gradually around two calls (the check of the call its probes pinned found no
 * drop from it to the next, so no one call lost it), as the dashboard says it beyond the fix's list
 * and summary: every blame its Blame step lists, the run page's banner, the Repair step, and Runs and
 * the sidebar. Never "lost at" the first of them. The words are the engine's lostWords.
 */

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => {
  store.close();
});

const range = { from: 5, to: 7, fromStep: 3, toStep: 4, gradual: true as const };
const gradual = { from: 5, to: 7, gradual: true };

describe('a fix whose run blame found lost gradually around two calls', () => {
  it('carries the two calls to the Blame step and the run page, and the Repair step says them as repair does', () => {
    const failing = makeRun(store, { labels: ['refund-bug'] });
    const { fix } = recordBlame(store, { runId: failing, report: { ...blameReport(failing), range }, expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: 1_000 });
    expect(fixDetail(store, fix.fixId)!.blames).toEqual([expect.objectContaining({ lostAt: 5, range: gradual })]);
    expect(fixForRun(store, failing)!.blame).toMatchObject({ lostAt: 5, range: gradual });
    // As repair's report and the pull request it writes say where it was lost.
    const repair = repairReport({ targets: [failing] });
    recordRepair(store, { repairId: 'repair-gradual1', dir: '.shadowlap/repairs/repair-gradual1', report: { ...repair, targets: repair.targets.map((t) => ({ ...t, range })) }, expect: EXPECT, command: 'shadowlap repair', at: 2_000 });
    expect(fixDetail(store, fix.fixId)!.repair!.lost[0].at).toBe('gradually, around model calls #5 and #7 (3 and 4 of 4)');
  });

  it('keeps a blame pinned to one call at that call', () => {
    const failing = makeRun(store, { labels: ['refund-bug'] });
    const { fix } = recordBlame(store, { runId: failing, report: blameReport(failing), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: 1_000 });
    expect(fixDetail(store, fix.fixId)!.blames).toEqual([expect.objectContaining({ lostAt: 5, range: null })]);
    recordRepair(store, { repairId: 'repair-pinned1', dir: '.shadowlap/repairs/repair-pinned1', report: repairReport({ targets: [failing] }), expect: EXPECT, command: 'shadowlap repair', at: 2_000 });
    expect(fixDetail(store, fix.fixId)!.repair!.lost[0].at).toBe('model call #5 (3 of 4)');
  });
});

describe('Runs and the sidebar', () => {
  const run: RunLike = { runId: '01K5CQ4N7GQ0000000000000AA', parentRunId: null, mode: 'record', status: 'failed', divergence: null, command: 'python refund_agent.py', codeVersion: null, startedAt: 1, calls: 30, spent: 0, saved: 0, captured: 0, imported: false, covers: null, source: null, labels: [], failed: true };

  it('say a run lost gradually around two calls so, from the server\'s outcome or, without one, its blame', () => {
    const lost = { ...run, outcome: { kind: 'lost', callNo: 5, range: gradual } };
    expect(runOutcome(lost)).toEqual({ tone: 'err', text: 'lost gradually around #5 and #7' });
    expect(sideLine(lost)).toEqual({ err: 'lost gradually around #5 and #7', text: ' · 30 calls' });
    expect(sideStatus(lost)).toEqual({ text: 'lost gradually around #5 and #7', tone: 'err' });
    expect(runOutcome({ ...run, blame: { callNo: 5, range: gradual } })).toEqual({ tone: 'err', text: 'lost gradually around #5 and #7' });
    // At one call, the call.
    expect(runOutcome({ ...run, outcome: { kind: 'lost', callNo: 5 } })).toEqual({ tone: 'err', text: 'lost at #5' });
  });
});
