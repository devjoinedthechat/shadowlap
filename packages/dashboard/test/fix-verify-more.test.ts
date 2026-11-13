import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decideVerify, recordBlame, recordVerdict, Store, type SprtGate } from '@shadowlap/engine';
import { blameReport, makeRun, verifyReport } from '../../engine/test/fix-fixtures.js';
import { verifyMore } from '../src/fix-verify-step.js';

/**
 * Run more attempts on a fix's verdict (fix-verify-step.ts `verifyMore`), read from the store alone:
 * the limits it raises for a verdict pulled from the team store. test/fixes-routes.test.ts starts the
 * job it builds.
 */

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => store.close());

describe('Run more attempts on a pulled verdict', () => {
  it('holds its good runs to the pulled cap, whatever --kept-max or pairs its record gives', () => {
    const failing = makeRun(store, { labels: ['double-email'] });
    const good = makeRun(store, { labels: ['digest'] });
    const check = { tools: { send_email: 1 } };
    recordBlame(store, { runId: failing, report: blameReport(failing), expect: check, scope: null, command: `shadowlap blame ${failing.slice(0, 10)}`, title: 'send_email called twice', checkText: 'send_email called once' });
    const gate: SprtGate = { kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 80 };
    // Its good run stopped (no gate decision): Run more attempts takes it again at what it ran under.
    const stopped = (pairs: number, flags: string[]) => {
      const report = verifyReport([{ runId: failing, role: 'target', pass: true }, { runId: good, role: 'good', pass: true }]);
      const x = report.runs[1];
      report.runs[1] = { ...x, verdict: 'open', attempts: Array.from({ length: pairs }, () => ({ ...x.attempts[0], passed: true })), passes: pairs };
      Object.assign(report, decideVerify(report.runs, 'the provider stopped answering'), { gate, attemptsPerRun: 80 });
      const v = recordVerdict(store, { report, expect: check, command: 'v', rerun: { flags, command: null } }).verdict;
      return { ...v, pulled: { from: 'team store', at: 1 } } as unknown as typeof v;
    };
    for (const v of [stopped(10, ['--kept-max', '1000']), stopped(900, [])]) {
      const more = verifyMore(v)!;
      expect(more).toMatchObject({ kind: 'more', keptMax: 400 });
      expect(more.argv.join(' ')).not.toMatch(/--kept-max (?!400\b)\d+/);
    }
  });
});
