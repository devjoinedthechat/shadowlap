import { describe, expect, it } from 'vitest';
import { normalizeOutcome, normalizeRunDetail } from '../ui/normalize.js';
import { bannerFor, failureText, type BannerInput } from '../ui/run/banner.js';
import { countChecks, isFailed, repeatBundle, runOutcome } from '../ui/runs.js';
import type { RunDetail, RunListItem } from '../ui/types.js';

/**
 * The pages read the four verdicts the server sends: a check that did not apply is shown apart, in
 * grey, and never counted as passed; one that could not be decided is amber, neither a pass nor a
 * failure. Old servers, which send none of it, read as they did.
 */

const row = (over: Partial<RunListItem> = {}): RunListItem => ({
  runId: '01K5CQ4V3H8M2XWQH6V3T9RB1D',
  parentRunId: null,
  depth: 0,
  mode: 'replay',
  status: 'completed',
  label: 'test',
  divergence: null,
  command: 'python agent.py',
  codeVersion: null,
  startedAt: 1_000,
  endedAt: 2_000,
  calls: 4,
  spent: 0,
  saved: 0,
  captured: 0,
  imported: false,
  covers: null,
  source: null,
  labels: [],
  ...over,
});

describe('the Runs table', () => {
  it('says how many checks passed and how many did not apply, and inconclusive in amber', () => {
    expect(runOutcome(row({ outcome: { kind: 'passed', checks: 1, notApplicable: 2 } }))).toEqual({ tone: 'ok', text: '1 check passed, 2 not applicable' });
    expect(runOutcome(row({ outcome: { kind: 'passed', checks: 0, notApplicable: 2 } }))).toEqual({ tone: 'ok', text: '2 checks not applicable' });
    expect(runOutcome(row({ outcome: { kind: 'inconclusive', check: 'judge "j" answers yes' } }))).toEqual({ tone: 'warn', text: 'check inconclusive' });
    // From the counts alone, as a server that sends no outcome has it.
    expect(runOutcome(row({ checks: { passed: 1, total: 3, notApplicable: 2 } }))).toEqual({ tone: 'ok', text: '1 check passed, 2 not applicable' });
    expect(runOutcome(row({ checks: { passed: 1, total: 2, inconclusive: 1 } }))).toEqual({ tone: 'warn', text: 'check inconclusive' });
    expect(runOutcome(row({ checks: { passed: 1, total: 2 } }))).toEqual({ tone: 'err', text: 'check failed' });
    expect(isFailed({ ...row({ checks: { passed: 1, total: 3, notApplicable: 2 } }), failed: undefined } as never)).toBe(false);
  });

  it('counts a run page\'s checks as the server counts them, an old one\'s by its ok', () => {
    expect(countChecks([{ ok: true, status: 'passed' }, { ok: true, status: 'not-applicable' }, { ok: false, status: 'inconclusive' }])).toEqual({ passed: 1, total: 3, inconclusive: 1, notApplicable: 1 });
    expect(countChecks([{ ok: true }, { ok: false }])).toEqual({ passed: 1, total: 2 });
  });

  it('reads the new outcome from the server, and an old one as before', () => {
    expect(normalizeOutcome({ kind: 'inconclusive', check: 'judge "j" answers yes' })).toEqual({ kind: 'inconclusive', check: 'judge "j" answers yes' });
    expect(normalizeOutcome({ kind: 'passed', checks: 1, notApplicable: 2 })).toEqual({ kind: 'passed', checks: 1, notApplicable: 2 });
    expect(normalizeOutcome({ kind: 'passed', checks: 2 })).toEqual({ kind: 'passed', checks: 2 });
  });

  it('counts a repeat attempt whose checks did not all apply as passed, and one that could not decide as not', () => {
    const attempt = (n: number, checks: { passed: number; total: number; inconclusive?: number; notApplicable?: number }) => ({ runId: `01K5CQ4V3H8M2XWQH6V3T9RB${n}A`, status: 'completed' as const, divergence: { callNo: 2 }, spent: 0, startedAt: n, repeat: { attempt: n, of: 2 }, checks });
    const b = repeatBundle([attempt(1, { passed: 1, total: 3, notApplicable: 2 }), attempt(2, { passed: 1, total: 2, inconclusive: 1 })]);
    expect(b.line).toBe('forked 2 attempts, 1 passed');
    expect(b.attempts.map((a) => [a.text.replace(/^\S+ · /, ''), a.ok])).toEqual([
      ['checks 1 of 3, 2 not applicable', true],
      ['checks 1 of 2, 1 inconclusive', false],
    ]);
  });
});

describe('the run page', () => {
  const base: BannerInput = { status: 'completed', type: 'test', divergence: null, intervention: null, rescued: null, blame: null, notRecorded: null, checks: [], fix: null, upstreamRequests: 0 };

  it('lists checks that did not apply or could not be decided, with why in a few words, not as a failure', () => {
    const checks = [
      { label: 'issue_refund called 0 times', ok: true, status: 'passed', count: 1, of: 1 },
      { label: 'when lookup_order has result.total > 200: escalate called at least 1 time', ok: true, status: 'not-applicable', detail: 'the condition never held: lookup_order #2: result.total 180 <= 200', count: 1, of: 1 },
      { label: 'judge "j" answers yes', ok: false, status: 'inconclusive', detail: 'not judged: no recorded verdict and no key for anthropic', count: 0, of: 1 },
    ];
    expect(bannerFor({ ...base, checks, outcome: { kind: 'inconclusive', check: 'judge "j" answers yes' }, failed: false })).toEqual({
      kind: 'checks',
      checks: [
        { label: 'issue_refund called 0 times', text: 'issue_refund called 0 times · 1 of 1', status: 'passed' },
        { label: checks[1]!.label, text: `${checks[1]!.label} · not applicable · the condition never held`, status: 'not-applicable' },
        { label: 'judge "j" answers yes', text: 'judge "j" answers yes · inconclusive · not judged', status: 'inconclusive' },
      ],
      why: 'replayed offline · 0 upstream',
    });
    // A failed check is still the failure, whatever else could not be decided.
    expect(failureText({ status: 'completed', checks: [checks[2]!, { label: 'send_email called 0 times', ok: false, status: 'failed', detail: 'called 1 time' }], blame: null })).toBe('check failed: send_email called 0 times, but called 1 time');
    expect(failureText({ status: 'completed', checks: [checks[2]!], blame: null })).toBeNull();
  });

  it('keeps each check\'s status, and a judge\'s reason, from the server', () => {
    const d = normalizeRunDetail({ run: { runId: 'R' }, checks: [{ label: 'judge "j" answers yes', ok: true, status: 'passed', reason: 'It does.', source: 'live', count: 1, of: 1 }, { label: 'x', ok: true, status: 'nonsense' }] } as unknown as RunDetail);
    expect(d.checks).toEqual([
      { label: 'judge "j" answers yes', ok: true, status: 'passed', reason: 'It does.', source: 'live', count: 1, of: 1 },
      { label: 'x', ok: true },
    ]);
  });
});
