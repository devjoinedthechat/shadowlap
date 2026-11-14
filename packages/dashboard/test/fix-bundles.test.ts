import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordBlame, Store } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun } from '../../engine/test/fix-fixtures.js';
import { fixBundles } from '../src/fixes.js';

/**
 * The Forks view's bundles, for the attempts no report lists among its probe's: an attempt the
 * provider was unavailable for joins its probe's bundle, counted apart, never a loose bundle of its own.
 */

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => {
  store.close();
});

describe('a probe’s attempt the provider was unavailable for', () => {
  it('joins its probe’s bundle, marked apart, never a bundle of its own beside it', () => {
    const failing = makeRun(store, { labels: ['refund-bug'] });
    const report = blameReport(failing);
    recordBlame(store, { runId: failing, report, expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: 1_000 });
    // The probe's attempts its report lists, filed under the run as blame files them.
    for (const p of report.probes) for (const a of p.attempts) store.createRun({ runId: a.runId, mode: 'replay', parentRunId: failing, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, startedAt: 2_000, meta: { probe: { of: failing, callNo: p.callNo, passed: a.passed } } });
    // One at #5 the provider was unavailable for: blame marks it (blame.ts) and leaves it out of the probe's attempts.
    const down = makeRun(store, { mode: 'replay', parent: failing, status: 'failed', startedAt: 2_500, meta: { probe: { of: failing, callNo: 5, passed: false, verdict: 'unavailable' } } });
    const bundles = fixBundles(store, failing)!.filter((b) => b.kind === 'blame');
    expect(bundles.map((b) => b.title)).toEqual(['blame · probe #1', 'blame · probe #5', 'blame · probe #7']);
    const five = bundles[1];
    expect(five.attempts.at(-1)).toMatchObject({ runId: down, passed: false, unavailable: true, note: 'the provider was unavailable: retried, never counted' });
    // Its tally is still the probe's: 2 of the 4 attempts it counted.
    expect([five.passes, five.verdictLine]).toEqual([2, 'rescued · 2 of 4']);
  });
});
