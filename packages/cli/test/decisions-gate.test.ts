import { describe, expect, it } from 'vitest';
import { emptyCounts, NO_TOKENS, type DecisionRun, type DecisionsReport, type DecisionsVerify } from '@shadowlap/engine';
import { decisionsInconclusive, migrateExit } from '../src/commands/changes.js';
import { mergeVerify } from '../src/decisions-verify.js';
import { passesOf, type MigrateReport } from '../src/migrate.js';

/**
 * How decisions and migrate keep what verify's gate decided about the runs they flag: each run's
 * outcome in verify's own words with its tally and Wilson bound under the rule that decided it, each
 * rule said once, and an inconclusive gate left inconclusive, for `--inconclusive` to decide,
 * wherever the verdict is kept.
 */

const GATE = 'gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts';
const SHORT = 'gate: tells 90%+ from 70%- at <= 5% risk, up to 2 attempts';

const verified = (o: Partial<DecisionsVerify> = {}): DecisionsVerify => ({ verdict: 'accepted', verifyIds: ['vf-1'], runs: [], rule: GATE, commands: ['shadowlap verify --keeps 01A'], spent: 0.1, upstreamRequests: 12, reasons: [], ...o });

const run = (runId: string, golden: string | null = null): DecisionRun => ({ runId, golden, steps: 1, asked: 1, rank: 1, majority: 1, counts: emptyCounts(), cost: { before: 0.01, after: 0.01, spent: 0.01 }, tokens: { before: NO_TOKENS, after: NO_TOKENS }, thinkingStripped: 0, refused: null, decisions: [], warnings: [] });

describe('a session verified more than once', () => {
  it('stays incomplete while a run its gate left inconclusive is kept, and keeps the rule that decided each run', () => {
    // The first verify ran out of attempts between the gate's bounds; a later one keeps another run, under verify's own gate.
    const first = verified({ verdict: 'incomplete', runs: [{ runId: '01A', role: 'good', outcome: 'inconclusive', passes: 2, attempts: 2, bound: 'rate 0.34 to 1 (95%)', rule: SHORT }], rule: SHORT, reasons: ['good run 01A inconclusive: 2 of 2 passed · rate 0.34 to 1 (95%), between the gate\'s bounds when its attempts ran out'] });
    const later = verified({ verifyIds: ['vf-2'], runs: [{ runId: '01B', role: 'good', outcome: 'kept', passes: 12, attempts: 12, bound: 'rate >= 0.76 (95%)', rule: GATE }], commands: ['shadowlap verify --keeps 01B'] });
    const merged = mergeVerify(first, later);
    expect(merged.verdict).toBe('incomplete');
    // Each run's tally and bound under the rule that decided it; two rules decided them, so none is stated for all.
    expect(merged.runs.map((r) => [r.runId, r.outcome, r.bound, r.rule])).toEqual([
      ['01A', 'inconclusive', 'rate 0.34 to 1 (95%)', SHORT],
      ['01B', 'kept', 'rate >= 0.76 (95%)', GATE],
    ]);
    expect(merged.rule).toBeNull();
    expect(merged.verifyIds).toEqual(['vf-1', 'vf-2']);
    // A run kept before runs carried their rule was decided by the one its verify stated.
    const before = verified({ verdict: 'incomplete', runs: [{ runId: '01A', role: 'good', outcome: 'inconclusive', passes: 2, attempts: 2, bound: 'rate 0.34 to 1 (95%)' }], rule: SHORT });
    expect(mergeVerify(before, verified({ runs: [{ runId: '01B', role: 'good', outcome: 'kept', passes: 12, attempts: 12, bound: 'rate >= 0.76 (95%)' }] })).runs.map((r) => [r.runId, r.rule])).toEqual([
      ['01A', SHORT],
      ['01B', GATE],
    ]);

    // Verified again and settled, each run's new outcome replaces the old, with the rule it was decided by: one rule for all, stated once.
    const settled = mergeVerify(merged, verified({ verifyIds: ['vf-3'], runs: [{ runId: '01A', role: 'good', outcome: 'kept', passes: 12, attempts: 12, bound: 'rate >= 0.76 (95%)', rule: GATE }, { runId: '01B', role: 'good', outcome: 'kept', passes: 12, attempts: 12, bound: 'rate >= 0.76 (95%)', rule: GATE }] }));
    expect(settled.verdict).toBe('accepted');
    expect(settled.rule).toBe(GATE);
    expect(settled.runs.map((r) => r.rule)).toEqual([GATE, GATE]);
    expect(mergeVerify(merged, verified({ runs: [{ runId: '01A', role: 'good', outcome: 'broken', passes: 0, attempts: 4, bound: 'rate <= 0.49 (95%)', rule: GATE }] })).verdict).toBe('rejected');
  });

  it("reads a migrate session's inconclusive run as inconclusive, with its tally and bound under the rule that decided it", () => {
    const v = verified({ verdict: 'incomplete', runs: [{ runId: '01A', role: 'good', outcome: 'inconclusive', passes: 2, attempts: 2, bound: 'rate 0.34 to 1 (95%)', rule: SHORT }], rule: SHORT });
    expect(passesOf([run('01A', 'goldens/research')], ['01A'], v, () => true)).toEqual([{ runId: '01A', golden: 'goldens/research', verdict: 'inconclusive', outcome: 'inconclusive', verified: true, tally: { passes: 2, attempts: 2, bound: 'rate 0.34 to 1 (95%)', rule: SHORT, undecided: null } }]);
    // A run kept before runs carried their rule: the one the session's verify states.
    const kept = verified({ runs: [{ runId: '01A', role: 'good', outcome: 'kept', passes: 12, attempts: 12, bound: 'rate >= 0.76 (95%)' }] });
    expect(passesOf([run('01A', 'goldens/research')], ['01A'], kept, () => true)[0]!.tally).toEqual({ passes: 12, attempts: 12, bound: 'rate >= 0.76 (95%)', rule: GATE, undecided: null });
  });
});

describe('the exit status of an inconclusive gate', () => {
  it('fails decisions unless --inconclusive warn lets it through', () => {
    const report = { stopReason: null, runs: [run('01A')], flagged: ['01A'], verify: verified({ verdict: 'incomplete', runs: [{ runId: '01A', role: 'good', outcome: 'inconclusive', passes: 2, attempts: 2, bound: 'rate 0.34 to 1 (95%)', rule: SHORT }], rule: SHORT }) } as unknown as DecisionsReport;
    expect(decisionsInconclusive(report)).toBe('verify did not settle every run it took');
    expect(decisionsInconclusive({ ...report, verify: verified({ runs: [{ runId: '01A', role: 'good', outcome: 'kept', passes: 12, attempts: 12, bound: 'rate >= 0.76 (95%)', rule: GATE }] }) })).toBeNull();
  });

  it('fails migrate unless --inconclusive warn lets it through', () => {
    const passes: MigrateReport['passes'] = { verdict: 'incomplete', runs: [{ runId: '01A', golden: 'goldens/research', verdict: 'inconclusive', outcome: 'inconclusive', verified: true, tally: { passes: 2, attempts: 2, bound: 'rate 0.34 to 1 (95%)', rule: SHORT } }] };
    const report = { stopReason: null, passes } as unknown as MigrateReport;
    expect(migrateExit(report)).toBe(1);
    expect(migrateExit(report, 'warn')).toBe(0);
    expect(migrateExit({ ...report, passes: { verdict: 'accepted', runs: [{ ...passes.runs[0]!, verdict: 'passed', outcome: 'kept', tally: { passes: 12, attempts: 12, bound: 'rate >= 0.76 (95%)', rule: GATE } }] } })).toBe(0);
  });
});
