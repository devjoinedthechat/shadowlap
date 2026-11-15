import { describe, expect, it } from 'vitest';
import { recordBlame, repairReuse, reusedBlame, Store, type BlameRecord, type BlameReport } from '../src/index.js';
import { blameReport, EXPECT, makeRun, ORACLE } from './fix-fixtures.js';

/**
 * The blame `shadowlap repair` reuses on a failing run rather than search again (blame-reuse.ts), as
 * the CLI and Run repair's estimate read it: the one stored on the run, under the same check, rescue
 * and scope, with one kept with its fix, that found the run unrescued or where it was lost.
 */

const stored = (o: Partial<BlameRecord> = {}): BlameRecord => ({ at: 1, outcome: 'blamed', callNo: 5, confidence: 'high', rescuedRunId: null, fields: {}, oracle: ORACLE, probes: [], spent: 0.03, ...o });

describe('the blame a repair reuses', () => {
  it('is the one stored under the same check, rescue and scope that found something to build on', () => {
    const store = Store.open(':memory:');
    const rescue = makeRun(store, {});
    const kept = (blame: BlameRecord): string => {
      const id = makeRun(store, { status: 'failed', meta: { blame } });
      recordBlame(store, { runId: id, report: blameReport(id, blame.outcome), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}' });
      return id;
    };
    const o = { oracle: ORACLE, fields: {}, scope: null };
    const blamed = kept(stored({ rescuedRunId: rescue }));
    expect(reusedBlame(store, blamed, o)).toMatchObject({ stored: { outcome: 'blamed', callNo: 5, rescuedRunId: rescue }, kept: { runId: blamed } });
    expect(reusedBlame(store, blamed, { ...o, oracle: ['the agent exits 0'] })).toBeNull();
    expect(reusedBlame(store, blamed, { ...o, fields: { model: 'claude-opus-5-5' } })).toBeNull();
    expect(reusedBlame(store, blamed, { ...o, scope: 'triage' })).toBeNull();
    expect(reusedBlame(store, kept(stored({ outcome: 'unrescuable', callNo: null })), o)).toMatchObject({ stored: { outcome: 'unrescuable' } });
    // Stopped part way, or rescued by a fork no longer in the store: the repair blames it again.
    expect(reusedBlame(store, kept(stored({ outcome: 'stopped', rescuedRunId: rescue })), o)).toBeNull();
    expect(reusedBlame(store, kept(stored({ rescuedRunId: `01M3RZ9999${'0'.repeat(16)}` })), o)).toBeNull();
    // Stored on the run, but none kept with a fix: a repair would have no fix to report to.
    expect(reusedBlame(store, makeRun(store, { status: 'failed', meta: { blame: stored({ rescuedRunId: rescue }) } }), o)).toBeNull();
    store.close();
  });

  it('falls back to the run’s earlier search under the same rescue, kept with a fix, once a blame with a stronger model followed it, its fields in any order', () => {
    const store = Store.open(':memory:');
    const run = makeRun(store, { status: 'failed' });
    const keep = (report: BlameReport) => recordBlame(store, { runId: run, report, expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}' });
    // Asked again at temperature=1, the recorded model rescued nothing; then a stronger one did, from call #5.
    keep({ ...blameReport(run, 'unrescuable'), rescue: { fields: { temperature: 1 } } });
    const rescued = makeRun(store, {});
    const found = blameReport(run);
    keep({ ...found, rescue: { fields: { temperature: 1, model: 'claude-opus-5-5' } }, contrast: { ...found.contrast!, rescuedRunId: rescued } });
    store.updateRunMeta(run, { blame: stored({ rescuedRunId: rescued, fields: { temperature: 1, model: 'claude-opus-5-5' } }) });
    const o = { oracle: ORACLE, scope: null };
    expect(reusedBlame(store, run, { ...o, fields: { model: 'claude-opus-5-5', temperature: 1 } })).toMatchObject({ stored: { outcome: 'blamed', callNo: 5, rescuedRunId: rescued } });
    expect(reusedBlame(store, run, { ...o, fields: { temperature: 1 } })).toMatchObject({ stored: { outcome: 'unrescuable', fields: { temperature: 1 } }, kept: { report: { rescue: { fields: { temperature: 1 } } } } });
    expect(reusedBlame(store, run, { ...o, fields: {} })).toBeNull();
    // As a repair given that model blames: resampling rescued nothing, so the stronger model's blame.
    expect(repairReuse(store, run, { ...o, fields: { temperature: 1 }, stronger: 'claude-opus-5-5' })).toMatchObject({ stored: { outcome: 'blamed', callNo: 5 } });
    expect(repairReuse(store, run, { ...o, fields: { temperature: 1 }, stronger: null })).toMatchObject({ stored: { outcome: 'unrescuable' } });
    // A model it was never blamed with: the repair blames with it afresh.
    expect(repairReuse(store, run, { ...o, fields: { temperature: 1 }, stronger: 'gpt-6' })).toBeNull();
    store.close();
  });
});
