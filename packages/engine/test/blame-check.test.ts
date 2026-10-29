import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blameCheckFor, failedCheckLabels, recordBlame, Store } from '../src/index.js';
import { blameReport, EXPECT, makeRun } from './fix-fixtures.js';

/**
 * The check a blame starts from when nobody names one. The dashboard and the terminal UI both ask
 * the engine for it, so a run is blamed under the same check from either; they once had a copy each,
 * which read a check that could not be decided differently.
 */

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => {
  store.close();
});

const LABEL = 'judge: the reply apologises for the late refund';
/** A judge check as a run keeps it: an undecided one is stored with `ok: false` too, and one from before checks had a status has only `ok`. */
const judge = (status?: 'failed' | 'inconclusive') => ({ ok: false, ...(status ? { status } : {}), label: LABEL, detail: null });
const runOf = (o: Parameters<typeof makeRun>[1]) => store.getRun(makeRun(store, o))!;

describe('the check a blame starts from', () => {
  it('blames a run whose agent exited with an error on the exit when its only other check could not be decided', () => {
    const run = runOf({ status: 'failed', meta: { checks: [judge('inconclusive')] } });
    expect(failedCheckLabels(run)).toEqual([]);
    expect(blameCheckFor(store, run)).toEqual({ expect: null, from: 'exit' });
  });

  it('has none for a run that exited cleanly with only an undecided check: nothing failed to look for', () => {
    expect(blameCheckFor(store, runOf({ status: 'completed', meta: { checks: [judge('inconclusive')] } }))).toBeNull();
  });

  it('asks for the check a run failed that nothing names, kept with a status or from before checks had one', () => {
    for (const failed of [judge('failed'), judge()]) {
      const run = runOf({ status: 'failed', meta: { checks: [failed, { ...judge('inconclusive'), label: 'judge: undecided' }] } });
      expect(failedCheckLabels(run)).toEqual([LABEL]);
      expect(blameCheckFor(store, run)).toBeNull();
    }
  });

  it('takes the run’s own --expect first, then the fix it fails in, then a fix its labels point to', () => {
    const blamed = makeRun(store, { labels: ['refund-limit'] });
    recordBlame(store, { runId: blamed, report: blameReport(blamed), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'refund over the limit', checkText: 'no refund over 200', at: 2_000, actor: 'dana', ci: null });
    const failed = { status: 'failed' as const, meta: { checks: [judge('failed')] } };
    expect(blameCheckFor(store, store.getRun(blamed)!)).toEqual({ expect: EXPECT, from: 'fix' });
    expect(blameCheckFor(store, runOf({ ...failed, labels: ['refund-limit'] }))).toEqual({ expect: EXPECT, from: 'labels' });
    expect(blameCheckFor(store, runOf({ ...failed, labels: ['refund-limit'], meta: { ...failed.meta, expect: { tools: { escalate: 1 } } } }))).toEqual({ expect: { tools: { escalate: 1 } }, from: 'replay' });
  });
});
