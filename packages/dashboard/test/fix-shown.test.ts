import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changeFixCheck, checkKey, markFixApplied, recordBlame, recordRepair, Store } from '@shadowlap/engine';
import { blameReport, makeRun, repairReport } from '../../engine/test/fix-fixtures.js';
import { fixAttemptGroups, MAX_ATTEMPTS } from '../src/attempt-groups.js';
import { fixDetail, type FixDetail } from '../src/fixes.js';
import { runJob } from '../src/read-jobs.js';

/**
 * What a fix's page is told of it that someone working on it needs: every check it has had, with
 * when each was given; who opened it, applied it and gave each check, named only where checks are
 * shared (a team store), as Changes names who made a change; how many of a probe's attempts its
 * groups read.
 */

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => {
  store.close();
});

const SEND_ONCE = { tools: { send_email: 1 } };
const AT_MOST_ONCE = { tools: { send_email: { max: 1 } } };

function opened() {
  const run = makeRun(store, { labels: ['double-email'] });
  const { fix } = recordBlame(store, { runId: run, report: blameReport(run), expect: SEND_ONCE, scope: null, command: 'shadowlap blame', title: 'send_email called twice', checkText: 'send_email called once', actor: 'ana@example.com', at: 1_000 });
  return { run, fixId: fix.fixId };
}

describe('what a fix’s page is told of it', () => {
  it('holds every check it has had, the first first, each with when it was given and by whom', () => {
    const f = opened();
    changeFixCheck(store, f.fixId, { check: { expect: AT_MOST_ONCE, key: checkKey(AT_MOST_ONCE), oracle: ['send_email called at most once'], text: 'send_email called at most once' }, judged: { failing: { [f.run]: 'failed' }, good: {} }, at: 2_000, actor: 'ben@example.com' });
    expect(fixDetail(store, f.fixId)!.checks).toEqual([
      { text: 'send_email called once', at: 1_000, by: 'ana@example.com' },
      { text: 'send_email called at most once', at: 2_000, by: 'ben@example.com' },
    ]);
  });

  it('names who opened it, applied it and gave its checks only where checks are shared, as fix show names them always', async () => {
    const f = opened();
    recordRepair(store, { repairId: 'repair-ok', dir: '.shadowlap/repairs/repair-ok', report: repairReport({ targets: [f.run], accepted: true }), expect: SEND_ONCE, command: 'shadowlap repair', at: 1_500 });
    markFixApplied(store, f.fixId, { patch: 'applied', repairId: 'repair-ok', goldens: [], tests: 'passed', by: 'ben@example.com', via: 'fix apply' });
    expect(fixDetail(store, f.fixId)).toMatchObject({ openedBy: 'ana@example.com', applied: { by: 'ben@example.com', via: 'fix apply' }, checks: [{ by: 'ana@example.com' }] });
    const page = async (names: boolean) => JSON.parse((await runJob(store, { kind: 'fix', fixId: f.fixId, repairer: null, names }, { whole: true })).body) as FixDetail;
    expect(await page(false)).toMatchObject({ openedBy: null, applied: { by: null, via: 'fix apply' }, checks: [{ by: null }] });
    expect(await page(true)).toMatchObject({ openedBy: 'ana@example.com', applied: { by: 'ben@example.com' }, checks: [{ by: 'ana@example.com' }] });
  });

  it('says how many of a probe’s attempts its groups read', () => {
    const f = opened();
    const groups = fixAttemptGroups(store, f.fixId)!;
    expect(groups.blame!.probes.map((p) => [p.attempts, p.read])).toEqual(blameReport(f.run).probes.map((p) => [p.attempts.length, Math.min(p.attempts.length, MAX_ATTEMPTS)]));
    expect(groups).not.toHaveProperty('cut');
  });
});
