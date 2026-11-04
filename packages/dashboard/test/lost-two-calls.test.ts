import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordBlame, recordEvent, recordRepair, Store } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, repairReport } from '../../engine/test/fix-fixtures.js';
import { activity } from '../src/activity.js';
import { fixDetail, fixForRun, fixList, needsLookFixes } from '../src/fixes.js';
import { runState } from '../src/runs-list.js';
import { normalizeOutcome } from '../ui/normalize.js';
import { blameWords } from '../ui/overview/model.js';
import { bannerFor, type BannerInput } from '../ui/run/banner.js';
import { runOutcome, sideLine, sideStatus, type RunLike } from '../ui/runs.js';

/**
 * A run blame placed on no one call, but around or between two, as the dashboard says it: lost
 * gradually around two calls (the check of the call its probes pinned found no drop from it to the
 * next, so no one call lost it), or lost between two (the probes between them could not decide, so
 * it was lost at one of the calls from the first to the second), as the CLI's report says them.
 * Never "lost at" the first of them. The words are the engine's lostWords.
 */

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => {
  store.close();
});

/** A failed recording as Runs lists it. */
const run: RunLike = { runId: '01K5CQ4N7GQ0000000000000AA', parentRunId: null, mode: 'record', status: 'failed', divergence: null, command: 'python refund_agent.py', codeVersion: null, startedAt: 1, calls: 30, spent: 0, saved: 0, captured: 0, imported: false, covers: null, source: null, labels: [], failed: true };

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
  it('say a run lost gradually around two calls so in the sidebar, from the server\'s outcome or, without one, its blame, and Runs the check it failed', () => {
    const lost = { ...run, outcome: { kind: 'lost', callNo: 5, range: gradual } };
    expect(sideLine(lost)).toEqual({ err: 'lost gradually around #5 and #7', text: ' · 30 calls' });
    expect(sideStatus(lost)).toEqual({ text: 'lost gradually around #5 and #7', tone: 'err' });
    expect(sideStatus({ ...run, blame: { callNo: 5, range: gradual } })).toEqual({ text: 'lost gradually around #5 and #7', tone: 'err' });
    // At one call, the call.
    expect(sideStatus({ ...run, outcome: { kind: 'lost', callNo: 5 } })).toEqual({ text: 'lost at #5', tone: 'err' });
    // Runs' Status says how it came out: the check blame saw it fail.
    expect(runOutcome(lost)).toEqual({ tone: 'err', text: 'check failed' });
    expect(runOutcome({ ...run, blame: { callNo: 5, range: gradual } })).toEqual({ tone: 'err', text: 'check failed' });
  });
});

describe('a run blame found lost between two calls, the probes between them undecided', () => {
  const between = { from: 3, to: 5, fromStep: 2, toStep: 3 };
  const two = { from: 3, to: 5 };

  it('reads as lost between them in Fixes, Needs a look, the activity feed, the run page and Today, as the CLI says it', () => {
    const failing = makeRun(store, { labels: ['refund-bug'] });
    const report = { ...blameReport(failing), blamed: { ...blameReport(failing).blamed!, callNo: 3, step: 2 }, range: between };
    const { fix } = recordBlame(store, { runId: failing, report, expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: 1_000 });
    expect(fixList(store).fixes[0].steps[0]).toMatchObject({ short: 'lost between #3 and #5', title: 'Lost between model calls #3 and #5' });
    expect(fixDetail(store, fix.fixId)!.blame).toMatchObject({ title: 'Lost between model calls #3 and #5' });
    expect(fixDetail(store, fix.fixId)!.blames).toEqual([expect.objectContaining({ lostAt: 3, range: two })]);
    expect(needsLookFixes(store).find((x) => x.fixId === fix.fixId)?.detail).toBe('lost between model calls #3 and #5 · no change yet');
    expect(fixForRun(store, failing)!.blame).toMatchObject({ lostAt: 3, range: two });
    // Blame's event, and the blame kept on the run, as the activity feed tells them.
    recordEvent(store, { kind: 'blame.done', runId: failing, ref: fix.fixId, data: { outcome: 'blamed', callNo: 3, confidence: 'low', title: 'refund over the limit', opened: true, range: between }, at: 3_000 });
    expect(activity(store, { limit: 50 }).items.find((i) => i.at === 3_000)?.text).toBe('Blamed · refund over the limit, lost between model calls #3 and #5');
    // The run as its page and the lists read it.
    store.updateRunMeta(failing, { blame: { at: 3_000, outcome: 'blamed', callNo: 3, confidence: 'low', range: between, rescuedRunId: null, fields: {}, oracle: [], probes: [], spent: 0 } });
    expect(runState(store, failing)?.outcome).toEqual({ kind: 'lost', callNo: 3, range: two });
    expect(blameWords({ outcome: 'blamed', lostAt: 3, range: two })).toBe('lost between #3 and #5');
  });

  it('reads as lost between them in the sidebar and the run page\'s banner, and as the check it failed in Runs', () => {
    const lost = { ...run, outcome: normalizeOutcome({ kind: 'lost', callNo: 3, range: between }) };
    expect(lost.outcome).toEqual({ kind: 'lost', callNo: 3, range: two });
    expect(runOutcome(lost)).toEqual({ tone: 'err', text: 'check failed' });
    expect(sideLine(lost)).toEqual({ err: 'lost between #3 and #5', text: ' · 30 calls' });
    expect(sideStatus(lost)).toEqual({ text: 'lost between #3 and #5', tone: 'err' });
    // The banner names both calls, and where the first sits among the model calls: from there on.
    const base = { status: 'failed', type: 'recording', divergence: null, intervention: null, interventions: [], flagCall: null, rescued: null, notRecorded: null, checks: [], fix: null, upstreamRequests: 0, calls: [], callCount: 30, modelCalls: 4 } as unknown as BannerInput;
    expect(bannerFor({ ...base, blame: { callNo: 3, range: two, modelCall: { k: 2, m: 4 }, confidence: 'low', rescuedRunId: null, scope: null } })).toEqual({ kind: 'lost', callNo: 3, words: 'lost between #3 and #5', why: 'from model call 2 of 4 · confidence low', rescuedRunId: null });
    expect(bannerFor({ ...base, blame: { callNo: 3, range: two } })).toMatchObject({ words: 'lost between #3 and #5', why: 'calls #3 to #5' });
  });
});
