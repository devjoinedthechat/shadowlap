import { describe, expect, it } from 'vitest';
import { formatChecks } from '../src/golden-test.js';
import { githubAnnotations, markdownReport, testReport, type PackResult } from '../src/test-report.js';

/** A judge check's verdict and reason beside it in every report, and the judge's cost apart from the agent's. */

const label = 'explains: the judge answers yes to "Does the reply say why?"';
const passed = { ok: true, status: 'passed' as const, label, detail: 'the judge answered yes: It names the $100 limit.', reason: 'It names the $100 limit.', judge: { name: 'explains', model: 'claude-haiku-4-5', of: 'answer' as const, verdict: 'yes' as const, source: 'recording' as const, cost: 0, redactions: 0, cut: 0 } };
const notJudged = { ok: false, status: 'inconclusive' as const, label, detail: 'not judged: no recorded verdict and the test runs offline', judge: { ...passed.judge, verdict: null, source: null, cost: null } };

const base: PackResult = { name: 'refund', dir: 'goldens/refund', golden: 'goldens/refund', mode: 'replay', ok: true, verdict: 'passed', failure: null, message: null, details: null, output: null, seconds: 1, runId: 'R1', runs: [], goldenRunId: 'G1', calls: { total: 30, replayed: 30, live: 0, blocked: 0, stubbed: 0 }, upstreamRequests: 0, tokensNotRespent: 1000, divergence: null, checks: [passed], attempts: null, gate: null, expect: null, updated: null, judge: { calls: 1, replayed: 1, live: 0, notAsked: 0, upstreamRequests: 0, spent: 0, saved: 0.0005, unknownModels: [] } };
const unjudged: PackResult = { ...base, name: 'escalate', dir: 'goldens/escalate', golden: 'goldens/escalate', ok: false, verdict: 'inconclusive', failure: 'inconclusive', message: `check inconclusive: ${label}, not judged: no recorded verdict and the test runs offline`, details: 'details', checks: [notJudged], judge: { calls: 1, replayed: 0, live: 0, notAsked: 1, upstreamRequests: 0, spent: 0, saved: 0, unknownModels: [] } };
const live: PackResult = { ...base, name: 'fork', dir: 'goldens/fork', golden: 'goldens/fork', mode: 'fork', checks: [{ ...passed, judge: { ...passed.judge, source: 'live', cost: 0.0025 } }], judge: { calls: 2, replayed: 0, live: 2, notAsked: 0, upstreamRequests: 2, spent: 0.005, saved: 0, unknownModels: [] } };

describe('judge checks in the reports', () => {
  it('give the terminal and JUnit each verdict with its reason and where it came from', () => {
    expect(formatChecks([passed, notJudged])).toBe(
      [`✓ ${label}: the judge answered yes: It names the $100 limit. (judged from the recording, free)`, `? ${label}: inconclusive, not judged: no recorded verdict and the test runs offline`].join('\n'),
    );
  });

  it('list the verdicts of goldens that passed in the Markdown report, those that did not pass under them, and the judges\' cost apart', () => {
    const report = testReport([base, live, unjudged]);
    // An inconclusive golden fails the run, and is counted apart from the failures.
    expect(report).toMatchObject({ passed: 2, failed: 1, inconclusive: 1 });
    const md = markdownReport(report);
    expect(md.startsWith('### Shadowlap: 1 of 3 recordings is inconclusive\n')).toBe(true);
    expect(md).toContain(`| 🟡 | \`escalate\` | check inconclusive: ${label}`);
    expect(md).toContain(`- \`refund\` ✅ ${label}: the judge answered yes: It names the $100 limit. (judged from the recording, free)`);
    expect(md).toContain('- `fork` ✅');
    expect(md).toContain('(judged live, ≈$0.0025)');
    expect(md).toContain(`- ⚠️ ${label}: inconclusive, not judged: no recorded verdict and the test runs offline`);
    expect(md).toContain("4 judge calls: 1 from the recordings, free; 2 live, ≈$0.0050, apart from the agents' calls above.");
    expect(md).toContain('Inconclusive means a check could not be decided');
    expect(md).not.toContain('A failed check means');
    // With a failure too, both are counted.
    const both = markdownReport(testReport([base, { ...unjudged, name: 'bad', verdict: 'failed', failure: 'check' }, unjudged]));
    expect(both.startsWith('### Shadowlap: 1 of 3 recordings failed, 1 inconclusive\n')).toBe(true);
  });

  it('annotate a golden whose judge check was not judged with why', () => {
    expect(githubAnnotations(testReport([unjudged]))).toContain(`%0A%0A? ${label}: inconclusive, not judged: no recorded verdict and the test runs offline`);
  });
});

describe('fix on failure', () => {
  it('opens no fix for a golden whose only checks that did not pass are judge checks not judged', async () => {
    const { planFixes } = await import('../../../action/fix.mjs');
    const result = (name: string, checks: PackResult['checks'], failure: 'check' | 'inconclusive' = 'check') => ({ name, dir: `goldens/${name}`, golden: `goldens/${name}`, ok: false, failure, runId: 'R', runs: [{ runId: 'R', ok: false }], expect: { judge: [] }, checks });
    const plans = planFixes({ results: [result('escalate', [passed, notJudged], 'inconclusive'), result('wrong', [notJudged, { ok: false, label: 'issue_refund called 0 times', detail: 'called 1 time' }]), result('other', [{ ok: false, status: 'inconclusive', label: 'x', detail: 'y' }], 'inconclusive')] });
    expect(plans.map((p) => [p.result.name, p.skip])).toEqual([
      ['escalate', 'its judge check explains was not judged, which no prompt fix changes: record its verdict with shadowlap test goldens/escalate --update'],
      ['wrong', null],
      ['other', 'its verdict is inconclusive: a check could not be decided, which no prompt fix changes'],
    ]);
  });
});
