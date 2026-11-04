import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordBlame, recordRepair, Store } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, repairReport } from '../../engine/test/fix-fixtures.js';
import { fixDetail, needsLookFixes } from '../src/fixes.js';

/**
 * Needs a look says what the last repair of a fix still open left in a change's words, as a repair
 * makes a change and the fix is the failure worked through: never that no fix was found.
 */

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => {
  store.close();
});

describe('a fix still open after a repair', () => {
  it('says the repair found no change to try, or that the change it made is not verified for the fix yet', () => {
    const run = makeRun(store, { labels: ['refund-bug'] });
    const { fix } = recordBlame(store, { runId: run, report: blameReport(run), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: 1_000 });
    const detail = () => needsLookFixes(store).find((x) => x.fixId === fix.fixId)!.detail;
    // Its repairer answered with nothing to try: no candidate, and none rejected.
    const empty = { ...repairReport({ targets: [run], accepted: false }), candidates: [], why: 'there was no candidate to try' };
    recordRepair(store, { repairId: 'repair-empty', dir: '.shadowlap/repairs/repair-empty', report: empty, expect: EXPECT, command: 'r', at: 2_000 });
    expect(detail()).toBe('lost at model call #5 · the last repair found no change to try');
    // A change accepted under the exit code alone: its verdict doesn't count for the fix, which stays open.
    recordRepair(store, { repairId: 'repair-exit', dir: '.shadowlap/repairs/repair-exit', report: repairReport({ targets: [run], oracle: ['the agent exits 0'] }), expect: null, command: 'r', at: 3_000 });
    expect(fixDetail(store, fix.fixId)!.status).toBe('open');
    expect(detail()).toBe('lost at model call #5 · the last repair’s change is not verified yet');
  });
});
