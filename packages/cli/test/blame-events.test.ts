import { describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { blameReport, makeRun } from '../../engine/test/fix-fixtures.js';
import { recordBlameFix } from '../src/fixes.js';

/**
 * The `blame.done` event a blame records with its fix: what the activity feed tells it from. It
 * carries the calls the run was lost between, so the feed says a run lost gradually around two calls
 * was, rather than that the first of them lost it.
 */

const settings = { spec: null, expect: null, fields: {}, attempts: 5, needed: 2, gate: null };
const recording = { checks: [], failures: ['the agent exited with code 1'] };

describe('the event a blame records', () => {
  it('carries the calls the run was lost between, two gradual ones when it was lost gradually around them', () => {
    const store = Store.open(':memory:');
    try {
      const gradual = makeRun(store, { labels: ['refund-bug'] });
      recordBlameFix(store, { runId: gradual, report: { ...blameReport(gradual), range: { from: 5, to: 7, fromStep: 3, toStep: 4, gradual: true } }, settings, recording });
      const pinned = makeRun(store, { labels: ['double-email'] });
      recordBlameFix(store, { runId: pinned, report: { ...blameReport(pinned), range: { from: 5, to: 5, fromStep: 3, toStep: 3 } }, settings, recording });
      const lost = makeRun(store, { labels: ['wrong-ticket'] });
      recordBlameFix(store, { runId: lost, report: blameReport(lost, 'unrescuable'), settings, recording });
      const data = (runId: string) => store.listEvents({ kinds: ['blame.done'] }).find((e) => e.runId === runId)?.data;
      expect(data(gradual)).toMatchObject({ outcome: 'blamed', callNo: 5, range: { from: 5, to: 7, gradual: true } });
      expect(data(pinned)).toMatchObject({ outcome: 'blamed', callNo: 5, range: { from: 5, to: 5 } });
      expect(data(pinned)?.range).not.toHaveProperty('gradual');
      // No call rescued the run: no range to carry.
      expect(data(lost)).not.toHaveProperty('range');
    } finally {
      store.close();
    }
  });
});
