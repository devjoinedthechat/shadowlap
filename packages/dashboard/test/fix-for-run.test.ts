import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markFixApplied, recordBlame, recordRepair, recordVerdict, Store } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, repairReport, verifyReport } from '../../engine/test/fix-fixtures.js';
import { fixDetail, fixForRun } from '../src/fixes.js';

/**
 * How a run's page says its fix stands, from the fix's records, as Fixes says it, in the words the
 * server sends (`said` for its link and its Open fix, `state` for its finding): merged with its pull
 * request, broken when an applied fix doesn't hold, what changed for an open one, and what a good run
 * of it is for.
 */

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => {
  store.close();
});

const DAY = 24 * 60 * 60 * 1000;
let at = 10 * DAY;

function blame(runId: string, expect: unknown = EXPECT) {
  return recordBlame(store, { runId, report: blameReport(runId), expect, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: (at += DAY) });
}

describe('the fix a run’s page names', () => {
  it('stands as Fixes says it: its rung, why an applied one doesn’t hold, and what changed for an open one', () => {
    const failing = makeRun(store, { labels: ['refund-bug'] });
    const { fix } = blame(failing);
    recordRepair(store, { repairId: 'repair-munzln2i', dir: '.shadowlap/repairs/repair-munzln2i', report: repairReport({ targets: [failing] }), expect: EXPECT, command: 'shadowlap repair', at: (at += DAY) });
    // Verified, not applied: never "ready to apply", which a patch in the working tree already isn't.
    expect(fixForRun(store, failing)!.fix).toMatchObject({ status: 'verified', said: { tone: 'ok', text: 'fix verified', why: 'verified: a change fixed its failing runs, not applied yet' }, state: 'fixed: “issue_refund called with amount 240”, verified' });
    // Applied, then its goldens failed their test: broken, in red, as Fixes and Needs a look say.
    markFixApplied(store, fix.fixId, { patch: 'applied', repairId: 'repair-munzln2i', goldens: ['goldens/refund-bug'], tests: 'failed', via: 'fix apply' });
    expect(fixForRun(store, failing)!.fix).toMatchObject({ status: 'applied', said: { tone: 'err', text: 'fix broken', why: 'applied, but it doesn’t hold: shadowlap test failed on its goldens' }, state: '“issue_refund called with amount 240” is applied but doesn’t hold · shadowlap test failed on its goldens' });
    // Merged with its pull request: merged, which nothing waits to apply.
    const shipped = makeRun(store, { labels: ['double-email'] });
    const { fix: merged } = blame(shipped, { tools: { send_email: 1 } });
    recordRepair(store, { repairId: 'repair-mr', dir: '.shadowlap/repairs/repair-mr', report: repairReport({ targets: [shipped], pr: 'https://github.com/example/agent/pull/42' }), expect: { tools: { send_email: 1 } }, command: 'r', at: (at += DAY) });
    store.mergeFixData(merged.fixId, { source: { pr: { state: 'merged' } } });
    expect(fixForRun(store, shipped)!.fix).toMatchObject({ status: 'verified', said: { tone: 'ok', text: 'fix merged · PR #42', why: 'merged: its change shipped with its pull request' }, state: 'fixed: “issue_refund called with amount 240”, merged' });
    // Open, with a change no verdict that counts accepted: what changed, in Needs a look's words.
    const open = makeRun(store, { labels: ['lookup'] });
    const { fix: opened } = blame(open, { tools: { lookup_order: 1 } });
    expect(fixForRun(store, open)!.fix).toMatchObject({ status: 'open', said: { tone: 'warn', why: 'open: no change has been verified for it yet' }, state: 'no change yet for “issue_refund called with amount 240”' });
    recordVerdict(store, { report: verifyReport([{ runId: open, role: 'target', pass: false }]), expect: { tools: { lookup_order: 1 } }, command: 'shadowlap verify', at: (at += DAY) });
    expect(fixDetail(store, opened.fixId)!.status).toBe('open');
    expect(fixForRun(store, open)!.fix).toMatchObject({ status: 'open', said: { why: 'open: changed by hand, verify rejected it' }, state: '“issue_refund called with amount 240”: changed by hand, verify rejected it' });
  });

  it('names a good run’s fix, saying what a good run of it is for', () => {
    const failing = makeRun(store, { labels: ['refund-bug'] });
    const good = makeRun(store, { labels: ['good'], status: 'completed' });
    blame(failing);
    recordRepair(store, { repairId: 'repair-kept', dir: '.shadowlap/repairs/repair-kept', report: repairReport({ targets: [failing], good: [good] }), expect: EXPECT, command: 'shadowlap repair', at: (at += DAY) });
    expect(fixForRun(store, good)).toMatchObject({ role: 'good', fix: { title: 'issue_refund called with amount 240', state: 'a good run of “issue_refund called with amount 240”: a change must keep it passing' } });
  });
});
