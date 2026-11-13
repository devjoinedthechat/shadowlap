import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeBaselineRule, emptyCounts, formatVerify, gateResult, outcomeOf, plain, recordBlame, recordVerdict, Store, tallyParts, verifyTally, verifyTallyLine, type DecisionRun, type DecisionsVerify, type VerifiedRun, type VerifyReport } from '@shadowlap/engine';
import { verifyLines } from '../../cli/src/commands/changes.js';
import { verifyJson } from '../../cli/src/commands/fix-report.js';
import { entryOf } from '../../cli/src/decisions-verify-runs.js';
import { formatFixDetail } from '../../cli/src/fix-format.js';
import { formatMigrate, passesOf, type MigrateReport } from '../../cli/src/migrate.js';
import { settledLine } from '../../cli/src/verify.js';
import { blameReport, EXPECT } from '../../engine/test/fix-fixtures.js';
import { fixDetail, type FixDetail } from '../src/fixes.js';
import { verifiedLine, verifiedParts } from '../src/verdict.js';
import { attempt, GATE, passing, reportOf, tallyCases, verifiedRun } from './verify-tally-cases.js';

/**
 * A run verify took reads the same wherever it shows: the line `shadowlap verify` prints for it, the
 * dashboard's verdict line and parts, `fix show --json`'s verify rows, and in the CLI `fix show`'s
 * rows, verify's line as the run settles, verify --json's sentence for a run kept against its
 * baseline, the decisions report's bound and parts, `decisions`' verify lines and `migrate`'s What
 * still passes all build from the engine's parts (`verifyTally`), for each kind of run
 * (verify-tally-cases.ts). Where a stored report's figures give no bound, each says
 * the tally alone, and none throws.
 */

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => {
  store.close();
});

/** The tally verify prints for a run in its report's table: the cell after its outcome. */
function printed(report: VerifyReport, x: VerifiedRun): string {
  const row = formatVerify(report).split('\n').find((l) => l.startsWith('    ') && l.includes(x.runId.slice(0, 10)));
  return row!.trim().split(/ {2,}/)[3];
}

/** The fix the report's first failing run opened, as `fix show --json` prints it once the report is kept. */
function shown(report: VerifyReport): FixDetail {
  const first = report.runs.find((x) => x.role !== 'good')!.runId;
  const { fix } = recordBlame(store, { runId: first, report: blameReport(first), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: 1_000 });
  recordVerdict(store, { report, expect: EXPECT, command: 'shadowlap verify --fixes label:refund-bug --keeps label:good', at: 2_000 });
  return JSON.parse(JSON.stringify(fixDetail(store, fix.fixId))) as FixDetail;
}

/** The verify rows `fix show --json` prints for the fix the report's first failing run opened. */
const shownRows = (report: VerifyReport): FixDetail['verify'][number]['rows'] => shown(report).verify[0].rows;

/** The tally `fix show` prints for a run in a terminal: the cell after its outcome in its verify row. */
function shownCell(fix: FixDetail, x: VerifiedRun): string {
  const row = formatFixDetail(fix, plain).split('\n').find((l) => l.startsWith('    ') && l.includes(x.runId.slice(0, 10)));
  return row!.trim().split(/ {2,}/)[3];
}

/** verify --json's sentence for a run kept against its baseline: its line, then the baseline's rule. */
function keptSentence(report: VerifyReport, x: VerifiedRun): string {
  const json = verifyJson(report) as { runs: Array<{ runId: string; rate: { sentence: string } | null }> };
  return json.runs.find((y) => y.runId === x.runId)!.rate!.sentence;
}

/** The rule a report's good runs were kept by, as verify --json's sentence ends on it. */
const keptRule = (report: VerifyReport) => describeBaselineRule({ ...report.kept!, revision: report.kept!.label ?? report.kept!.revision ?? null });

/** A migration with only what migrate's report reads to word What still passes: its runs, as verify found them. */
function migration(passes: MigrateReport['passes']['runs'], verify: DecisionsVerify): MigrateReport {
  return {
    from: ['claude-old'],
    to: 'claude-new',
    migrateId: null,
    decisions: { runs: passes.map((x) => ({ runId: x.runId })), counts: emptyCounts(), verify, cost: { unknownModels: [] } },
    changes: { runs: passes.length, flagged: 0, steps: [] },
    passes: { verdict: 'accepted', runs: passes },
    costs: { perRun: { before: null, after: null }, total: { before: null, after: null }, tokensPerRun: { before: 0, after: 0 }, checking: { decisions: 0, judge: 0, verify: 0 } },
    set: { flags: [], fields: [], given: {}, byHand: [] },
    configChange: null,
    retirements: [],
    notes: [],
    warnings: [],
    files: null,
  } as unknown as MigrateReport;
}

/** A verify row's parts joined as verify's line joins them. */
const joined = (row: { tally: string; cutShort: string | null; bound: string | null }) => `${row.tally}${row.cutShort ? ` (${row.cutShort})` : ''}${row.bound ? ` · ${row.bound}` : ''}`;

/**
 * Runs a report kept by another version or another machine holds, whose figures give no bound: a gate
 * with no interval, or one missing its figures, and a drop with no confidence to state it at.
 */
function unbounded(): VerifiedRun[] {
  const failed = () => [attempt(), attempt(), attempt({ passed: false })];
  return [
    verifiedRun(store, 'target', failed(), { verdict: 'fail', decision: 'fail', gate: { kind: 'sprt', decision: 'fail', passes: 2, attempts: 3, sentence: 'failed · 2 of 3' } as unknown as NonNullable<VerifiedRun['gate']> }),
    verifiedRun(store, 'target', failed(), { verdict: 'fail', decision: 'fail', gate: { ...gateResult(GATE, [true, true, false]), interval: {} } as unknown as NonNullable<VerifiedRun['gate']> }),
    verifiedRun(store, 'good', passing(38), { decision: 'pass', baseline: { passes: 38, attempts: 38, source: 'paired', revision: '35034be' }, margin: 0.1, drop: { lo: null, hi: 0.1 } as unknown as NonNullable<VerifiedRun['drop']> }),
  ];
}

/** What each of those runs counted: its tally alone. */
const UNBOUNDED = ['2 of 3 passed', '2 of 3 passed', '38 of 38 passed, baseline 38 of 38'];

describe('a verified run’s tally', () => {
  it('is printed by verify from the engine’s parts, and the dashboard’s line and parts are the same words', () => {
    const cases = tallyCases(store);
    const report = reportOf(cases.map((c) => c.run));
    for (const c of cases) {
      expect(verifyTally(c.run), c.kind).toEqual(c.parts);
      expect(verifyTallyLine(c.parts), c.kind).toBe(c.line);
      expect(printed(report, c.run), c.kind).toBe(c.line);
      expect(verifiedParts(c.run), c.kind).toMatchObject({ word: c.word, ...c.parts });
      expect(verifiedLine(c.run).line, c.kind).toBe(`${c.word} · ${c.line}`);
    }
  });

  it('reads the same in fix show --json’s verify rows, its parts joined as verify joins them', () => {
    const cases = tallyCases(store);
    const rows = shownRows(reportOf(cases.map((c) => c.run)));
    for (const c of cases) {
      const row = rows.find((y) => y.runId === c.run.runId)!;
      expect({ tally: row.tally, cutShort: row.cutShort, bound: row.bound }, c.kind).toEqual({ tally: verifyTallyLine({ tally: c.parts.tally, undecided: c.parts.undecided }), cutShort: c.parts.cutShort, bound: c.parts.bound });
      expect(joined(row), c.kind).toBe(c.line);
    }
  });

  it('is the tally alone where a stored report’s figures give no bound, in verify’s line, the dashboard’s and fix show --json’s, never a throw', () => {
    const runs = unbounded();
    const report = reportOf(runs);
    const lines = UNBOUNDED;
    expect(runs.map((x) => printed(report, x))).toEqual(lines);
    expect(report.reasons.slice(0, 2)).toEqual(runs.slice(0, 2).map((x) => `target run ${x.runId.slice(0, 10)} not fixed: 2 of 3 passed (issue_refund called)`));
    expect(runs.map((x) => verifiedLine(x).line)).toEqual([`not fixed · ${lines[0]}`, `not fixed · ${lines[1]}`, `kept · ${lines[2]}`]);
    expect(shownRows(report).map((row) => [row.bound, joined(row)])).toEqual(lines.map((line) => [null, line]));
  });

  it('reads the same in the CLI: fix show’s rows, verify’s line as a run settles, verify --json’s sentence for a kept run, and the decisions report’s bound', () => {
    const cases = tallyCases(store);
    const report = reportOf(cases.map((c) => c.run));
    const fix = shown(report);
    for (const c of cases) {
      const word = outcomeOf(c.run);
      expect(shownCell(fix, c.run), c.kind).toBe(c.line);
      // A run an attempt it could not judge stopped settles on its outcome alone: that attempt's line said why.
      expect(settledLine(c.run, plain), c.kind).toBe(c.run.undecided ? word : `${word} · ${c.line}`);
      expect(entryOf(report, 'the rule')(c.run).bound, c.kind).toBe(c.parts.bound);
    }
    // Only a run kept against its baseline has a sentence of its own: the gate's says the others.
    const kept = cases.filter((c) => c.run.baseline);
    expect(kept.map((c) => keptSentence(report, c.run))).toEqual(kept.map((c) => `kept · ${c.line} · ${keptRule(report)}`));
  });

  it('reads the same in decisions’ verify lines and migrate’s report, and a session kept before the parts in verify’s words from its figures', () => {
    const cases = tallyCases(store);
    const report = reportOf(cases.map((c) => c.run));
    const entries = cases.map((c) => entryOf(report, 'the rule')(c.run));
    const verify: DecisionsVerify = { verdict: 'accepted', verifyIds: [], runs: entries, rule: 'the rule', commands: [], spent: 0, upstreamRequests: 0, reasons: [] };
    const lines = verifyLines(verify, null).replace(/\x1b\[[0-9;]*m/g, '').split('\n');
    const runs = cases.map((c) => ({ runId: c.run.runId, golden: null, decisions: [] }) as unknown as DecisionRun);
    const migrated = formatMigrate(migration(passesOf(runs, [], verify, () => true), verify)).replace(/\x1b\[[0-9;]*m/g, '').split('\n');
    const rowOf = (rows: string[], c: (typeof cases)[number]) => rows.find((l) => l.includes(c.run.runId.slice(0, 10)))!;
    for (const [i, c] of cases.entries()) {
      expect(entries[i].parts, c.kind).toEqual(c.parts);
      expect(rowOf(lines, c).trim().split(/ {2,}/)[2], c.kind).toBe(c.line);
      expect(rowOf(migrated, c).split('verified · ')[1], c.kind).toBe(c.line);
      // Kept before the parts: the same words from the figures it kept, but for what only the parts hold.
      const { parts: _parts, ...old } = entries[i];
      const onlyParts = c.parts.cutShort || c.parts.undecided === 'the provider unavailable' || c.parts.tally === 'clean replay';
      if (!onlyParts) expect(verifyTallyLine(tallyParts(old)), c.kind).toBe(c.line);
      expect(verifyTallyLine(tallyParts(old)), c.kind).not.toMatch(/^\d+ of \d+(,| ·|$)/);
    }
  });

  it('is the tally alone in the CLI too where a stored report’s figures give no bound, never a throw', () => {
    const runs = unbounded();
    const report = reportOf(runs);
    const fix = shown(report);
    expect(runs.map((x) => shownCell(fix, x))).toEqual(UNBOUNDED);
    expect(runs.map((x) => settledLine(x, plain))).toEqual([`not fixed · ${UNBOUNDED[0]}`, `not fixed · ${UNBOUNDED[1]}`, `kept · ${UNBOUNDED[2]}`]);
    expect(runs.map((x) => entryOf(report, 'the rule')(x).bound)).toEqual([null, null, null]);
    expect(keptSentence(report, runs[2])).toBe(`kept · ${UNBOUNDED[2]} · ${keptRule(report)}`);
  });
});
