import { describe, expect, it } from 'vitest';
import type { JudgeOutcome, StoredCheck } from '@shadowlap/engine';
import { formatChecks } from '../../cli/src/golden-test.js';
import { checkReportLine } from '../ui/goldens.js';

// A golden's check line on Tests is the line `shadowlap test` prints under the golden, for every
// status and wherever a judge's verdict came from: one rule, the engine's, never a copy that drifts.
const judge = (over: Partial<JudgeOutcome>): JudgeOutcome => ({ name: 'explains', model: 'gpt-5-mini', of: 'answer', verdict: 'yes', source: 'live', cost: 0.0004, redactions: 0, ...over });
const JUDGE = 'judge "explains" answers yes';
const CHECKS: StoredCheck[] = [
  { status: 'passed', ok: true, label: 'escalate called 1 time', detail: null },
  { status: 'failed', ok: false, label: 'issue_refund called 0 times', detail: 'called 1 time (1 blocked or stubbed)' },
  { status: 'failed', ok: false, label: 'exits 0', detail: null },
  { status: 'inconclusive', ok: false, label: JUDGE, detail: 'not judged: no recorded verdict and the test runs offline', reason: 'unclear' },
  { status: 'not-applicable', ok: true, label: 'when lookup_order has result.total > 200: escalate called at least 1 time', detail: 'the condition never held: lookup_order #2: result.total 45 <= 200' },
  // Kept before checks had a status: as its `ok` says.
  { ok: true, label: 'exits 0', detail: null },
  { ok: false, label: 'exits 0', detail: 'exited 1' },
  // A judge's verdict: from the recording, free; live, at what it cost or with no price; with what was done to what it read.
  { status: 'passed', ok: true, label: JUDGE, detail: null, reason: 'It names the limit.', source: 'recording', judge: judge({ source: 'recording', cost: 0 }) },
  { status: 'passed', ok: true, label: JUDGE, detail: null, reason: 'It names the limit.', source: 'live', judge: judge({}) },
  { status: 'failed', ok: false, label: JUDGE, detail: 'the judge answered no', reason: 'It never says why.', source: 'live', judge: judge({ verdict: 'no', cost: 0.0021, redactions: 2 }) },
  { status: 'passed', ok: true, label: JUDGE, detail: null, reason: 'It names the limit.', source: 'live', judge: judge({ model: 'house-model', cost: null }) },
];

describe("a golden's check line on Tests", () => {
  it('reads as `shadowlap test` prints it under the golden, for every status and every judge source', () => {
    const printed = formatChecks(CHECKS as Parameters<typeof formatChecks>[0]).split('\n');
    expect(CHECKS.map((c) => checkReportLine(c).text)).toEqual(printed.map((line) => `    ${line}`));
    // What the engine's line says that the page's own copy never did: a judge's source, and nothing for an empty detail.
    expect(printed).toContain(`✓ ${JUDGE} · It names the limit. (judged live, <$0.001)`);
    expect(printed).toContain(`✓ ${JUDGE} · It names the limit. (judged from the recording, free)`);
    expect(printed).toContain('✗ exits 0: ');
  });
});
