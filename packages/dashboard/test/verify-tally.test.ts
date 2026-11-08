import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatVerify, gateResult, recordBlame, recordVerdict, Store, verifyTally, verifyTallyLine, type VerifiedRun, type VerifyReport } from '@shadowlap/engine';
import { blameReport, EXPECT } from '../../engine/test/fix-fixtures.js';
import { fixDetail, type FixDetail } from '../src/fixes.js';
import { verifiedLine, verifiedParts } from '../src/verdict.js';
import { attempt, GATE, passing, reportOf, tallyCases, verifiedRun } from './verify-tally-cases.js';

/**
 * A run verify took reads the same wherever it shows: the line `shadowlap verify` prints for it, the
 * dashboard's verdict line and parts, and `fix show --json`'s verify rows all build from the engine's
 * parts (`verifyTally`), for each kind of run (verify-tally-cases.ts). Where a stored report's figures
 * give no bound, each says the tally alone, and none throws.
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

/** The verify rows `fix show --json` prints for the fix the report's first failing run opened. */
function shownRows(report: VerifyReport): FixDetail['verify'][number]['rows'] {
  const first = report.runs.find((x) => x.role !== 'good')!.runId;
  const { fix } = recordBlame(store, { runId: first, report: blameReport(first), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: 1_000 });
  recordVerdict(store, { report, expect: EXPECT, command: 'shadowlap verify --fixes label:refund-bug --keeps label:good', at: 2_000 });
  const shown = JSON.parse(JSON.stringify(fixDetail(store, fix.fixId))) as FixDetail;
  return shown.verify[0].rows;
}

/** A verify row's parts joined as verify's line joins them. */
const joined = (row: { tally: string; cutShort: string | null; bound: string | null }) => `${row.tally}${row.cutShort ? ` (${row.cutShort})` : ''}${row.bound ? ` · ${row.bound}` : ''}`;

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
    // Kept by another version or another machine: a gate with no interval, or one missing its figures,
    // and a drop with no confidence to state it at.
    const failed = () => [attempt(), attempt(), attempt({ passed: false })];
    const runs = [
      verifiedRun(store, 'target', failed(), { verdict: 'fail', decision: 'fail', gate: { kind: 'sprt', decision: 'fail', passes: 2, attempts: 3, sentence: 'failed · 2 of 3' } as unknown as NonNullable<VerifiedRun['gate']> }),
      verifiedRun(store, 'target', failed(), { verdict: 'fail', decision: 'fail', gate: { ...gateResult(GATE, [true, true, false]), interval: {} } as unknown as NonNullable<VerifiedRun['gate']> }),
      verifiedRun(store, 'good', passing(38), { decision: 'pass', baseline: { passes: 38, attempts: 38, source: 'paired', revision: '35034be' }, margin: 0.1, drop: { lo: null, hi: 0.1 } as unknown as NonNullable<VerifiedRun['drop']> }),
    ];
    const report = reportOf(runs);
    const lines = ['2 of 3 passed', '2 of 3 passed', '38 of 38 passed, baseline 38 of 38'];
    expect(runs.map((x) => printed(report, x))).toEqual(lines);
    expect(report.reasons.slice(0, 2)).toEqual(runs.slice(0, 2).map((x) => `target run ${x.runId.slice(0, 10)} not fixed: 2 of 3 passed (issue_refund called)`));
    expect(runs.map((x) => verifiedLine(x).line)).toEqual([`not fixed · ${lines[0]}`, `not fixed · ${lines[1]}`, `kept · ${lines[2]}`]);
    expect(shownRows(report).map((row) => [row.bound, joined(row)])).toEqual(lines.map((line) => [null, line]));
  });
});
