import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changeFixCheck, checkKey, markFixApplied, recordBlame, Store } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun } from '../../engine/test/fix-fixtures.js';
import { fixDetail, fixList, goldensFolderIn } from '../src/fixes.js';

/**
 * Giving a fix another check, as the dashboard reads and asks it: a fix's judge and the golden that
 * guards it, the runs a check left out, the fix-check job and the preview it reads first.
 */

let store: Store;
let project: string;

beforeEach(() => {
  store = Store.open(':memory:');
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-fix-check-routes-')));
});
afterEach(() => {
  store.close();
  rmSync(project, { recursive: true, force: true });
});

const JUDGE = { name: 'explains-refusal', question: 'Does the answer say why the refund was refused?', of: 'run', model: 'claude-haiku-4-5', pass: 'yes' };

function opened(runId: string, expect: unknown = EXPECT) {
  return recordBlame(store, { runId, report: blameReport(runId), expect, scope: null, command: `shadowlap blame ${runId.slice(0, 10)}`, title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with amount 240' }).fix;
}

describe("a fix's judge, its guard and the runs a check left out", () => {
  it("reads the check's first judge as the Must line's card says it, and none from a check that doesn't parse", () => {
    const fix = opened(makeRun(store, { labels: ['refund-bug'] }), { ...EXPECT, judge: [JUDGE, { ...JUDGE, name: 'second', of: 'answer' }] });
    expect(fixList(store).fixes[0].judge).toEqual({ label: 'judge "explains-refusal" answers yes', question: JUDGE.question, reads: 'the whole run', model: 'claude-haiku-4-5' });
    expect(fixDetail(store, fix.fixId)!.judge?.reads).toBe('the whole run');
    const other = opened(makeRun(store, { labels: ['other-bug'] }), { judge: 'not a list' });
    expect(fixDetail(store, other.fixId)!.judge).toBeNull();
    expect(fixDetail(store, opened(makeRun(store, { labels: ['plain'] })).fixId)!.judge).toBeNull();
  });

  it('names the golden a failing run replayed, else one applying it copied that the goldens folder still holds', () => {
    const replayed = makeRun(store, { labels: ['refund-bug'], meta: { test: { golden: 'goldens/refund-flow', session: 's1' } } });
    expect(fixDetail(store, opened(replayed).fixId)!.guard).toBe('goldens/refund-flow');
    const fix = opened(makeRun(store, { labels: ['other-bug'] }));
    markFixApplied(store, fix.fixId, { patch: 'none', repairId: null, goldens: ['goldens/gone', 'goldens/Refund-Twice'], tests: 'skipped' });
    expect(fixDetail(store, fix.fixId)!.guard).toBeNull();
    mkdirSync(join(project, 'goldens', 'refund-twice'), { recursive: true });
    expect(fixDetail(store, fix.fixId, { goldensFolder: goldensFolderIn(project) })!.guard).toBe('goldens/Refund-Twice');
  });

  it('lists the runs a check given since left out, and no failing run that left names its guard', () => {
    const failing = makeRun(store, { labels: ['refund-bug'], meta: { test: { golden: 'goldens/refund-flow', session: 's1' } } });
    const other = makeRun(store, { labels: ['refund-bug'] });
    const fix = opened(failing);
    recordBlame(store, { runId: other, report: blameReport(other), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 't', checkText: 'c' });
    const expect2 = { tools: { issue_refund: 0 } };
    changeFixCheck(store, fix.fixId, { check: { expect: expect2, key: checkKey(expect2), oracle: ['the agent exits 0'], text: 'issue_refund never called' }, judged: { failing: { [failing]: 'passed', [other]: 'failed' }, good: {} } });
    const d = fixDetail(store, fix.fixId)!;
    expect(d.left).toEqual({ failing: [failing], good: [] });
    expect(d.failingRuns.map((r) => r.runId)).toEqual([other]);
    expect(d.guard).toBeNull();
  });
});
