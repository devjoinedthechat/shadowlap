import { describe, expect, it } from 'vitest';
import { Store, type RunMeta } from '@shadowlap/engine';
import { runDetail } from '../src/index.js';
import { RunBuilder } from '../../engine/test/run-fixtures.js';

/**
 * A run's judge checks on its page: each verdict with the judge's reason, whether it came from the
 * recording (free) or the judge live, and what it cost, as the banner shows them.
 */

const judged = { name: 'explains', model: 'claude-haiku-4-5', of: 'answer' as const, verdict: 'yes' as const, source: 'recording' as const, cost: 0, redactions: 1, cut: 0, callNo: 31 };
const label = 'explains: the judge answers yes to "Does the reply say why?"';

describe('the run page: judge checks', () => {
  it('gives each judge check its verdict, reason and where it came from, beside the other checks', () => {
    const store = Store.open(':memory:');
    const meta: RunMeta = {
      checks: [
        { ok: true, label: 'issue_refund called 0 times', detail: null },
        { ok: true, status: 'passed', label, detail: 'the judge answered yes: It names the limit.', reason: 'It names the limit.', judge: judged },
        { ok: false, status: 'inconclusive', label: 'polite: the judge answers yes to "Is it polite?"', detail: 'not judged: no recorded verdict and the test runs offline', judge: { ...judged, name: 'polite', verdict: null, source: null, cost: null, callNo: 32 } },
      ],
    };
    const runId = RunBuilder.start(store, { meta }).end();
    expect(runDetail(store, runId)!.checks).toEqual([
      { label: 'issue_refund called 0 times', ok: true, detail: null, count: 1, of: 1 },
      { label, ok: true, detail: 'the judge answered yes: It names the limit.', count: 1, of: 1, status: 'passed', reason: 'It names the limit.', judge: judged },
      { label: 'polite: the judge answers yes to "Is it polite?"', ok: false, detail: 'not judged: no recorded verdict and the test runs offline', count: 0, of: 1, status: 'inconclusive', judge: { ...judged, name: 'polite', verdict: null, source: null, cost: null, callNo: 32 } },
    ]);
  });

  it('keeps only what it can read of a judge check from someone else\'s pack', () => {
    const store = Store.open(':memory:');
    const meta = { checks: [{ ok: true, label, detail: null, status: 'great', reason: 7, judge: { name: 'explains', model: 'claude-haiku-4-5', of: 'everything', verdict: 'maybe', source: 'somewhere', cost: 'free', callNo: 1.5 } }] } as unknown as RunMeta;
    const runId = RunBuilder.start(store, { meta }).end();
    expect(runDetail(store, runId)!.checks).toEqual([{ label, ok: true, detail: null, count: 1, of: 1, judge: { name: 'explains', model: 'claude-haiku-4-5', of: 'answer', verdict: null, source: null, cost: null, redactions: 0, cut: 0 } }]);
  });
});
