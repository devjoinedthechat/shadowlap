import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type StoredCheck } from '@shadowlap/engine';
import { activity } from '../src/index.js';
import { runDetail } from '../src/api.js';
import { listRunsPage, runState } from '../src/runs-list.js';
import { addRun, DAY, HOUR } from './read-model-store.js';

/**
 * The four verdicts on every read model the dashboard already had: a check that did not apply
 * (a `when` whose condition never held) is never counted as passed, and one that could not be
 * decided (a judge with no verdict) is neither a pass nor a failure. The run list's outcome, the
 * run's own page and the activity feed say so in the same words as the CLI.
 */

const NOW = Date.UTC(2026, 9, 1, 10, 15);
const passed: StoredCheck = { status: 'passed', ok: true, label: 'issue_refund called 0 times', detail: null };
const notApplied: StoredCheck = { status: 'not-applicable', ok: true, label: 'when lookup_order has result.total > 200: escalate called at least 1 time', detail: 'the condition never held: lookup_order #2: result.total 180 <= 200' };
const undecided: StoredCheck = { status: 'inconclusive', ok: false, label: 'judge "explains" answers yes', detail: 'not judged: no recorded verdict and no key for anthropic' };
const judged: StoredCheck = { status: 'passed', ok: true, label: 'judge "polite" answers yes', detail: null, reason: 'It thanks the customer.', source: 'recording' };

let store: Store;
const id: Record<string, string> = {};

beforeAll(() => {
  store = Store.open(':memory:');
  id.rec = addRun(store, { startedAt: NOW - DAY, calls: 'l'.repeat(4) });
  // shadowlap test on a golden whose when never held: one check passed, two did not apply.
  id.applied = addRun(store, { parent: id.rec, startedAt: NOW - 3 * HOUR, calls: 'rrrr', meta: { test: { golden: 'goldens/in-limit', session: 's1' }, checks: [passed, notApplied, notApplied] } });
  // A judge check with no verdict, and nothing failed.
  id.undecided = addRun(store, { parent: id.rec, startedAt: NOW - 2 * HOUR, calls: 'rrrr', meta: { test: { golden: 'goldens/escalated', session: 's2' }, checks: [passed, undecided] } });
  // A replay judged by --expect, with a judge's verdict and its reason.
  id.judged = addRun(store, { parent: id.rec, startedAt: NOW - HOUR, calls: 'rrrr', meta: { expect: { judge: [] }, checks: [judged, notApplied] } });
});
afterAll(() => store.close());

const row = (runId: string) => listRunsPage(store, { limit: 500, includeAttempts: true }).runs.find((r) => r.runId === runId)!;

describe('verdicts on the run list and the run page', () => {
  it('counts a check that did not apply apart from those that passed', () => {
    expect(row(id.applied!)).toMatchObject({ outcome: { kind: 'passed', checks: 1, notApplicable: 2 }, failed: false, checks: { passed: 1, total: 3, notApplicable: 2 } });
    expect(runState(store, id.applied!)).toMatchObject({ outcome: { kind: 'passed', checks: 1, notApplicable: 2 }, failed: false });
  });

  it('says inconclusive for a check that could not be decided: no failure, and no pass', () => {
    expect(row(id.undecided!)).toMatchObject({ outcome: { kind: 'inconclusive', check: 'judge "explains" answers yes' }, failed: false, checks: { passed: 1, total: 2, inconclusive: 1 } });
    expect(runState(store, id.undecided!)).toMatchObject({ outcome: { kind: 'inconclusive' }, failed: false });
  });

  it('gives the run page each check\'s status, and a judge\'s reason and where its verdict came from', () => {
    expect(runDetail(store, id.judged!)!.checks).toEqual([
      { label: 'judge "polite" answers yes', ok: true, detail: null, count: 1, of: 1, status: 'passed', reason: 'It thanks the customer.', source: 'recording' },
      { label: notApplied.label, ok: true, detail: notApplied.detail, count: 1, of: 1, status: 'not-applicable' },
    ]);
    expect(runDetail(store, id.undecided!)!.checks!.map((c) => c.status)).toEqual(['passed', 'inconclusive']);
  });
});

describe('verdicts in the activity feed', () => {
  it('tells checks that did not apply, or could not be decided, in those words', () => {
    const { items } = activity(store);
    const text = (runId: string) => items.find((i) => i.id === `r:${runId}:end`)?.text;
    expect(text(id.applied!)).toBe('Test passed · in-limit · 1 of 1 checks passed, 2 not applicable');
    expect(text(id.undecided!)).toBe('Test failed · escalated check inconclusive: judge "explains" answers yes');
    expect(text(id.judged!)).toMatch(/^Replay clean · 4\/4 · 0 upstream · 1 of 1 checks passed, 1 not applicable$/);
  });
});
