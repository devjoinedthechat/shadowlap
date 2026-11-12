import { describe, expect, it } from 'vitest';
import { fixVerifyHead, goldensPassed, openRunWhy, runOutcomeWord, verdictWord, verifyHead } from '../src/verdict-words.js';
import { outcomeOf, type VerifiedRun, type VerifyReport } from '../src/verify.js';
import { runId, verifyReport } from './fix-fixtures.js';

/**
 * What a test session and a verify came to, as a page says it beside the verdict: a tally counts what
 * passed, and a verify's verdict is said by the runs it took, in their roles.
 */

/** A run its gate left between its bounds when its attempts ran out: inconclusive, neither held nor failed. */
const unsettled = (run: VerifiedRun): VerifiedRun => ({ ...run, verdict: 'open', decision: 'inconclusive' });
/** A verify's runs as its head reads them: each one's role and verify's word for how it came out. */
const said = (r: VerifyReport) => verifyHead(r.verdict, r.runs.map((x) => ({ role: x.role, outcome: outcomeOf(x) })));

describe('a verify, in the one word a page has for each state', () => {
  it('says a verdict that did not settle every run inconclusive, verify’s own incomplete left to its report', () => {
    expect((['accepted', 'rejected', 'incomplete'] as const).map(verdictWord)).toEqual(['accepted', 'rejected', 'inconclusive']);
  });

  it('says a run its attempts left open inconclusive, whether its gate could not decide or it stopped first', () => {
    expect((['fixed', 'not fixed', 'kept', 'broken', 'unsettled', 'inconclusive'] as const).map(runOutcomeWord)).toEqual(['fixed', 'not fixed', 'kept', 'broken', 'inconclusive', 'inconclusive']);
    // A budget that stopped a run's attempts before its gate decided: verify's report says unsettled, a page inconclusive.
    expect(runOutcomeWord(outcomeOf({ role: 'target', verdict: 'open', decision: 'continue' }))).toBe('inconclusive');
  });
});

describe('openRunWhy', () => {
  it('tells a run whose gate ran out from one that stopped first and one an attempt it could not judge stopped, in a kept session and a verdict alike', () => {
    expect(openRunWhy('inconclusive', null)).toBe('ran-out');
    expect(openRunWhy('unsettled', null)).toBe('stopped');
    expect(openRunWhy('inconclusive', 'the judge gave no answer')).toBe('unjudged');
    for (const settled of ['fixed', 'not-fixed', 'not fixed', 'kept', 'broken']) expect(openRunWhy(settled, null)).toBeNull();
    // A verdict's run, by verify's own word for it.
    const open = (decision: 'inconclusive' | 'undecided' | undefined, undecided: string | null) => openRunWhy(outcomeOf({ role: 'target', verdict: 'open', decision: decision as never, undecided }), undecided);
    expect(open('inconclusive', null)).toBe('ran-out');
    expect(open(undefined, null)).toBe('stopped');
    expect(open(undefined, 'attempt 3 timed out')).toBe('unjudged');
  });
});

describe('goldensPassed', () => {
  it('counts what passed, of every golden the session judged', () => {
    expect(goldensPassed(2, 7)).toBe('2 of 7 goldens passed');
    expect(goldensPassed(7, 7)).toBe('7 of 7 goldens passed');
    expect(goldensPassed(1, 1)).toBe('1 of 1 golden passed');
    expect(goldensPassed(0, 3)).toBe('0 of 3 goldens passed');
  });
});

describe('verifyHead', () => {
  it('says an accepted verify fixed the runs that failed and kept those that worked', () => {
    expect(said(verifyReport([{ runId: runId(), role: 'target', pass: true }]))).toBe('Fixes the run that failed');
    expect(said(verifyReport([{ runId: runId(), role: 'target', pass: true }, { runId: runId(), role: 'good', pass: true }]))).toBe('Fixes the run that failed, keeps the one that worked');
    // A held-out run failed as recorded too: it is one of the runs that failed.
    expect(
      said(
        verifyReport([
          { runId: runId(), role: 'target', pass: true },
          { runId: runId(), role: 'holdout', pass: true },
          { runId: runId(), role: 'good', pass: true },
          { runId: runId(), role: 'good', pass: true },
        ]),
      ),
    ).toBe('Fixes the 2 runs that failed, keeps the 2 that worked');
    // A preview's verify of runs that all passed as recorded.
    expect(said(verifyReport([{ runId: runId(), role: 'good', pass: true }, { runId: runId(), role: 'good', pass: true }]))).toBe('Every run it verified kept passing');
    expect(verifyHead('accepted', [])).toBe('No run verified');
  });

  it('says a rejected verify broke a run that worked before it says one that failed still fails', () => {
    expect(said(verifyReport([{ runId: runId(), role: 'target', pass: true }, { runId: runId(), role: 'good', pass: false }]))).toBe('The change broke a run that worked');
    expect(said(verifyReport([{ runId: runId(), role: 'target', pass: false }, { runId: runId(), role: 'good', pass: false }, { runId: runId(), role: 'good', pass: false }]))).toBe('The change broke 2 runs that worked');
    expect(said(verifyReport([{ runId: runId(), role: 'target', pass: false }, { runId: runId(), role: 'good', pass: true }]))).toBe('The change did not fix the run that failed');
    expect(said(verifyReport([{ runId: runId(), role: 'target', pass: false }, { runId: runId(), role: 'holdout', pass: false }]))).toBe('The change did not fix the 2 runs that failed');
    // It fixed the others: only the one it didn't is said not fixed.
    expect(
      said(
        verifyReport([
          { runId: runId(), role: 'target', pass: true },
          { runId: runId(), role: 'holdout', pass: false },
          { runId: runId(), role: 'holdout', pass: true },
        ]),
      ),
    ).toBe('The change did not fix 1 of the 3 runs that failed');
  });

  it("says a verify that couldn't settle every run did not, and reads a kept session's words", () => {
    const open = verifyReport([{ runId: runId(), role: 'target', pass: true }, { runId: runId(), role: 'good', pass: true }]);
    expect(said({ ...open, verdict: 'incomplete', runs: [open.runs[0], unsettled(open.runs[1])] })).toBe('Not every run settled');
    // decisions --verify keeps each run's outcome hyphenated: not-fixed for a run that still fails.
    expect(verifyHead('rejected', [{ role: 'target', outcome: 'not-fixed' }, { role: 'good', outcome: 'kept' }])).toBe('The change did not fix the run that failed');
    expect(verifyHead('accepted', [{ role: 'target', outcome: 'fixed' }, { role: 'good', outcome: 'kept' }, { role: 'good', outcome: 'kept' }])).toBe('Fixes the run that failed, keeps the 2 that worked');
  });
});

describe('fixVerifyHead', () => {
  const run = (runId: string, role: string, verdict: string) => ({ runId, role, verdict });
  it("heads a fix's verify as its Verify step does, by the runs it checked and the fix's failing runs", () => {
    expect(fixVerifyHead('accepted', [run('A', 'target', 'pass'), run('G', 'good', 'pass')], ['A'])).toBe('Every failing run fixed, every good run kept');
    expect(fixVerifyHead('accepted', [run('A', 'target', 'pass')], ['A'])).toBe('Every failing run fixed');
    // It left out a failing run of the fix: what it did, role by role.
    expect(fixVerifyHead('accepted', [run('A', 'target', 'pass'), run('H', 'holdout', 'pass'), run('G', 'good', 'pass')], ['A', 'B'])).toBe('Fixes 1 of 1 target run, 1 of 1 held-out, keeps 1 of 1 good');
    expect(fixVerifyHead('accepted', [], [])).toBe('No runs checked');
    expect(fixVerifyHead('rejected', [run('A', 'target', 'pass'), run('G', 'good', 'fail')], ['A'])).toBe('The change broke a run that worked');
    expect(fixVerifyHead('rejected', [run('A', 'target', 'fail'), run('G', 'good', 'pass')], ['A'])).toBe('The change did not fix the failing runs it checked');
    expect(fixVerifyHead('incomplete', [run('A', 'target', 'open')], ['A'])).toBe('Not every run settled');
  });
});
