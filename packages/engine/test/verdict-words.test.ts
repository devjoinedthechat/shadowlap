import { describe, expect, it } from 'vitest';
import { formatVerify, outcomeOf, type VerifiedRun, type VerifyReport } from '../src/verify.js';
import { testTally, verifySentence } from '../src/verdict-words.js';
import { runId, verifyReport } from './fix-fixtures.js';

/**
 * What a test session and a verify came to, in the words of the command that gave each verdict: the
 * same words wherever they are said, the CLI's and the dashboard's Verdicts.
 */

const HEADS: Record<VerifyReport['verdict'], string> = { accepted: '✓ Accepted', rejected: '✗ Rejected', incomplete: '! Incomplete' };

/** A run its gate left between its bounds when its attempts ran out: inconclusive, neither held nor failed. */
const unsettled = (run: VerifiedRun): VerifiedRun => ({ ...run, verdict: 'open', decision: 'inconclusive' });

describe('verifySentence', () => {
  it('says what a verify found in the very words verify prints after its verdict', () => {
    const accepted = verifyReport([
      { runId: runId(), role: 'target', pass: true },
      { runId: runId(), role: 'good', pass: true },
    ]);
    const rejected = verifyReport([
      { runId: runId(), role: 'target', pass: false },
      { runId: runId(), role: 'holdout', pass: true },
      { runId: runId(), role: 'good', pass: true },
      { runId: runId(), role: 'good', pass: false },
    ]);
    const heldOut = verifyReport([
      { runId: runId(), role: 'holdout', pass: true },
      { runId: runId(), role: 'holdout', pass: true },
    ]);
    const open = verifyReport([
      { runId: runId(), role: 'target', pass: true },
      { runId: runId(), role: 'good', pass: true },
    ]);
    const incomplete: VerifyReport = { ...open, verdict: 'incomplete', runs: [open.runs[0], unsettled(open.runs[1])] };
    const none: VerifyReport = { ...accepted, runs: [] };
    const said = (r: VerifyReport) => verifySentence(r.runs.map((x) => ({ role: x.role, outcome: outcomeOf(x) })));
    expect([accepted, rejected, heldOut, incomplete, none].map(said)).toEqual([
      'fixes 1 of 1 target run and keeps 1 of 1 good run',
      'fixes 0 of 1 target run, 1 of 1 held-out run and keeps 1 of 2 good runs',
      'fixes 2 of 2 held-out runs',
      'fixes 1 of 1 target run and keeps 0 of 1 good run (1 inconclusive)',
      'no runs',
    ]);
    // formatVerify's first line, word for word: the two never drift apart.
    for (const r of [accepted, rejected, heldOut, incomplete, none]) expect(formatVerify(r).split('\n')[0]).toBe(`${HEADS[r.verdict]}: the change ${said(r)}`);
  });

  it("reads a kept session's verify in its own words", () => {
    // decisions --verify keeps each run's outcome hyphenated: not-fixed for a run that still fails.
    const runs = [
      { role: 'target', outcome: 'not-fixed' },
      { role: 'good', outcome: 'kept' },
      { role: 'good', outcome: 'broken' },
      { role: 'good', outcome: 'inconclusive' },
    ];
    expect(verifySentence(runs)).toBe('fixes 0 of 1 target run and keeps 1 of 3 good runs (1 inconclusive)');
    expect(verifySentence([{ role: 'good', outcome: 'kept' }, { role: 'good', outcome: 'kept' }])).toBe('keeps 2 of 2 good runs');
  });
});

describe('testTally', () => {
  it('counts a session as shadowlap test ends, an inconclusive golden apart and only when there is one', () => {
    expect(testTally({ passed: 5, failed: 2, inconclusive: 1 })).toBe('5 passed, 2 failed, 1 inconclusive');
    expect(testTally({ passed: 7, failed: 0, inconclusive: 0 })).toBe('7 passed, 0 failed');
    expect(testTally({ passed: 0, failed: 3 })).toBe('0 passed, 3 failed');
  });
});
