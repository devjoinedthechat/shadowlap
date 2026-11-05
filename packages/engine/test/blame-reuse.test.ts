import { describe, expect, it } from 'vitest';
import { recordBlame, reusedBlame, Store, type BlameRecord } from '../src/index.js';
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
});
