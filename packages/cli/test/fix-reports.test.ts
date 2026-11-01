import { describe, expect, it } from 'vitest';
import { BLAME_DEFAULTS, decideVerify, gateResult, plain, recordBlame, recordVerdict, SPRT_DEFAULTS, Store, type SprtGate } from '@shadowlap/engine';
import { fixDetail } from '@shadowlap/dashboard';
import { blameReport, EXPECT, makeRun, runId, verifyReport } from '../../engine/test/fix-fixtures.js';
import { blamePlan } from '../src/commands/fix-blame.js';
import { repairPlan } from '../src/commands/fix-repair.js';
import { fixLine, verifyJson } from '../src/commands/fix-report.js';
import { verifyPlan } from '../src/commands/fix-verify.js';
import { formatFixDetail } from '../src/fix-format.js';
import { parseRepairer } from '../src/repairer.js';

/** `shadowlap fix show` in a terminal, from the read model its --json prints, `verify --json`, and what blame, repair and verify say before they start. */
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
      const [passed, unjudged] = first.attempts;
      blame.probes = [{ ...first, attempts: [{ ...passed, passed: true, verdict: 'passed', failures: [] }, { ...unjudged, passed: false, verdict: 'inconclusive', failures: [why] }], passes: 1, rescued: false, decision: 'inconclusive', undecided: why }];
      blame.lost = blame.probes[0]!;
      blame.confidence = 'low';
      const { fix } = recordBlame(store, { runId: failing, report: blame, expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: 1 });
      // A verify under a gate: the good run's third attempt could not be judged, after two that passed.
      const gate: SprtGate = { kind: 'sprt', ...SPRT_DEFAULTS };
      const verify = verifyReport([
        { runId: failing, role: 'target', pass: true },
        { runId: good, role: 'good', pass: true },
      ]);
      const kept = verify.runs[1];
      const attempts = [kept.attempts[0], kept.attempts[1], { ...kept.attempts[2], runId: runId(), passed: false, verdict: 'inconclusive' as const, failures: [why] }];
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

describe('shadowlap fix show, next', () => {
  it('says why the repair it suggests would end with no fix to try, under it, as the dashboard says', () => {
    const store = Store.open(':memory:');
    try {
      const run = makeRun(store, { labels: ['digest'] });
      const report = blameReport(run, 'unrescuable', { oracle: ['the agent exits 0'] });
      // The blame kept on the run, which a repair from the fix would reuse rather than search again.
      store.updateRunMeta(run, { blame: { at: 1, outcome: 'unrescuable', callNo: null, confidence: 'high', rescuedRunId: null, fields: {}, oracle: report.oracle, probes: [], spent: 0 } });
      const { fix } = recordBlame(store, { runId: run, report, expect: null, scope: null, command: 'shadowlap blame', title: 'The agent exited with code 1', checkText: 'the agent exits 0', at: 1 });
      const text = formatFixDetail(fixDetail(store, fix.fixId)!, plain);
      expect(text).toContain('  next: shadowlap repair --fixes label:digest --repairer claude-code\n  ! No failing run was rescued, so there is no passing path to learn from: the repair ends “No fix to try”.');
      // Its title says what failed: the header says only what its run must do.
      expect(text.split('\n')[2]).toBe('  must: the agent exits 0');
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
    const kept = verify.runs[1];
    verify.runs[1] = { ...kept, attempts: [kept.attempts[0], { ...kept.attempts[1], passed: false, verdict: 'inconclusive', failures: [why] }], passes: 1, verdict: 'open', decision: 'continue', undecided: why, gate: gateResult(gate, [true], { decision: 'continue' }) };
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

describe('what blame, repair and verify say they will do, before they start', () => {
  const gate: SprtGate = { kind: 'sprt', ...SPRT_DEFAULTS };
  const words = (lines: string[]) => lines.join(' ').split(/\s+/).filter(Boolean);
  /** The lines a terminal `columns` wide gets, against a pipe's: the same words, none broken, and each line that wrapped within the width, indented by two. */
  function expectFits(plan: (columns: number | null) => string[], columns: number): void {
    const whole = plan(null);
    const lines = plan(columns);
    expect(words(lines)).toEqual(words(whole));
    const wrapped = lines.filter((l) => !whole.includes(l));
    expect(wrapped.length).toBeGreaterThanOrEqual(2);
    for (const l of wrapped) expect(l.length <= columns && /^ {2}\S/.test(l), l).toBe(true);
  }

  it('wraps each dim line at whole words to a terminal’s width, indented as it is, and leaves it whole for a pipe', () => {
    // A 116-column terminal broke verify's at "its f|irst" and "5% r|isk".
    const base = { revision: '3a4f5e1c', label: 'HEAD (3a4f5e1)', build: null };
    expectFits((columns) => verifyPlan({ rule: { gate, attempts: gate.max, needed: 0 }, baseline: { source: 'paired', base } }, [{ role: 'target' }, { role: 'holdout' }, { role: 'good' }], { writes: 'stub', budget: 0.5 }, columns), 116);
    const store = Store.open(':memory:');
    try {
      const parent = store.getRun(makeRun(store))!;
      const blameGate: SprtGate = { kind: 'sprt', ...BLAME_DEFAULTS };
      expectFits((columns) => blamePlan({ rule: { gate: blameGate, attempts: blameGate.max, needed: 0 }, fields: {}, parent, steps: 5, argv: ['node', 'agent.mjs'] }, { scan: 2, writes: 'stub' }, columns), 116);
    } finally {
      store.close();
    }
    expectFits((columns) => repairPlan({ rule: { gate, attempts: gate.max, needed: 0 }, repairer: parseRepairer('openai:scripted-repairer') }, { targets: [1], held: [2], good: [3], heldOutAutomatically: true }, { writes: 'stub', budget: 0.5 }, columns), 100);
  });
});

describe('the fix a command reported to, after its report', () => {
  it('wraps at whole words to a terminal’s width, the command that shows the fix in one piece; a pipe gets one line', () => {
    const fix = { fixId: 'fx-01K5CQ2E8M7Z0000000000000', title: 'Refunds above the limit issued without a manager approving them first' };
    expect(fixLine(fix, 'verified')).toBe('  fix fx-01K5CQ2E8M · Refunds above the limit issued without a manager approving them first · verified · shadowlap fix show fx-01K5CQ2E8M\n');
    const lines = fixLine(fix, 'verified', 60).trimEnd().split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length <= 60 && /^ {2}\S/.test(l), l).toBe(true);
    expect(lines.at(-1)).toBe('  shadowlap fix show fx-01K5CQ2E8M');
  });
});
