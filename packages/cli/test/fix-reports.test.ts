import { describe, expect, it } from 'vitest';
import { decideVerify, gateResult, plain, recordBlame, recordVerdict, SPRT_DEFAULTS, Store, type SprtGate } from '@shadowlap/engine';
import { fixDetail } from '@shadowlap/dashboard';
import { blameReport, EXPECT, makeRun, runId, verifyReport } from '../../engine/test/fix-fixtures.js';
import { verifyJson } from '../src/commands/fix.js';
import { formatFixDetail } from '../src/fix-format.js';

/** `shadowlap fix show` in a terminal, from the read model its --json prints, and `verify --json`. */
describe('shadowlap fix show', () => {
  it("counts an attempt that could not be judged apart in a probe's and a verified run's tally, never as one that failed", () => {
    const store = Store.open(':memory:');
    try {
      const why = 'judge "issued" answers yes, but it is inconclusive: not judged: the judge\'s call failed: HTTP 400';
      const failing = makeRun(store, { labels: ['refund-bug'], calls: ['api', 'tool', 'api'] });
      const good = makeRun(store, { labels: ['good'], status: 'completed' });
      // The first probe: one attempt passed, and the next could not be judged, which stopped it.
      const blame = blameReport(failing, 'unrescuable');
      const [first] = blame.probes;
      const [passed, unjudged] = first!.attempts;
      blame.probes = [{ ...first!, attempts: [{ ...passed!, passed: true, verdict: 'passed', failures: [] }, { ...unjudged!, passed: false, verdict: 'inconclusive', failures: [why] }], passes: 1, rescued: false, decision: 'inconclusive', undecided: why }];
      blame.lost = blame.probes[0]!;
      blame.confidence = 'low';
      const { fix } = recordBlame(store, { runId: failing, report: blame, expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: 1 });
      // A verify under a gate: the good run's third attempt could not be judged, after two that passed.
      const gate: SprtGate = { kind: 'sprt', ...SPRT_DEFAULTS };
      const verify = verifyReport([
        { runId: failing, role: 'target', pass: true },
        { runId: good, role: 'good', pass: true },
      ]);
      const kept = verify.runs[1]!;
      const attempts = [kept.attempts[0]!, kept.attempts[1]!, { ...kept.attempts[2]!, runId: runId(), passed: false, verdict: 'inconclusive' as const, failures: [why] }];
      verify.runs[1] = { ...kept, attempts, passes: 2, verdict: 'open', undecided: why, gate: gateResult(gate, [true, true], { decision: 'continue' }) };
      verify.gate = gate;
      Object.assign(verify, decideVerify(verify.runs, null));
      recordVerdict(store, { report: verify, expect: EXPECT, command: 'shadowlap verify --fixes label:refund-bug --keeps label:good', at: 2 });
      const text = formatFixDetail(fixDetail(store, fix.fixId)!, plain);
      expect(text).toMatch(/#1 +1 of 4 +1 of 1 passed, an attempt not judged +inconclusive/);
      expect(text).toMatch(new RegExp(`good +${good.slice(0, 10)} +inconclusive +2 of 2, an attempt not judged +an attempt could not be judged`));
      // Neither counts the attempt among the failures, and a gate it stopped gives no bound.
      expect(text).not.toMatch(/1 of 2 passed|2 of 3|rate 0/);
    } finally {
      store.close();
    }
  });
});

describe('verify --json', () => {
  it('counts an inconclusive run apart in its summary, and gives a run an unjudged attempt stopped no rate', () => {
    const why = 'judge "issued" answers yes, but it is inconclusive: not judged: the judge\'s call failed: HTTP 400';
    const gate: SprtGate = { kind: 'sprt', ...SPRT_DEFAULTS };
    const target = runId();
    const good = runId();
    const verify = verifyReport([
      { runId: target, role: 'target', pass: true },
      { runId: good, role: 'good', pass: true },
    ]);
    const kept = verify.runs[1]!;
    verify.runs[1] = { ...kept, attempts: [kept.attempts[0]!, { ...kept.attempts[1]!, passed: false, verdict: 'inconclusive', failures: [why] }], passes: 1, verdict: 'open', decision: 'continue', undecided: why, gate: gateResult(gate, [true], { decision: 'continue' }) };
    verify.gate = gate;
    Object.assign(verify, decideVerify(verify.runs, null));
    const json = verifyJson(verify) as { verdict: string; summary: Record<string, { passed: number; inconclusive: number; total: number }>; runs: Array<{ outcome: string; rate: unknown; undecided: string | null }> };
    expect(json.verdict).toBe('incomplete');
    expect(json.summary).toEqual({ targets: { passed: 1, inconclusive: 0, total: 1 }, holdout: { passed: 0, inconclusive: 0, total: 0 }, good: { passed: 0, inconclusive: 1, total: 1 } });
    // Its gate decided nothing: no rate, and so no verdict line other than the four words.
    expect(json.runs[1]).toMatchObject({ outcome: 'inconclusive', rate: null, undecided: why });
    expect(JSON.stringify(json)).not.toContain('undecided ·');
  });
});
