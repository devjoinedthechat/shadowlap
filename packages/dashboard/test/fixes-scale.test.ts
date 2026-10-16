import { cpuUsage } from 'node:process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { recordBlame, Store } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, repairReport, verifyReport } from '../../engine/test/fix-fixtures.js';
import { fixBundles } from '../src/fixes.js';

/**
 * The Forks view's bundles at scale: a recording replayed 2,000 times (a golden CI replays on every
 * push), in a store that keeps 400 verdicts and 60 repairs about other runs. The view asks again on
 * every change while it is open, so each read is bounded by the CPU time it takes, and the reports
 * the store keeps whole are read once for each change to fixes, not on every poll.
 */

const REPLAYS = 2000;
const VERDICTS = 400;
const REPAIRS = 60;

let store: Store;
let root: string;
let quiet: string;

/** CPU milliseconds `fn` takes, which a busy machine inflates far less than wall-clock time. */
function cpuMs(fn: () => void): number {
  const before = cpuUsage();
  fn();
  const used = cpuUsage(before);
  return (used.user + used.system) / 1000;
}

beforeAll(() => {
  store = Store.open(':memory:');
  root = makeRun(store, { labels: ['refund-flow'], calls: ['api', 'tool', 'api', 'tool', 'api', 'tool', 'api'] });
  // Blame's probes, under the recording.
  const report = blameReport(root);
  recordBlame(store, { runId: root, report, expect: EXPECT, scope: null, command: 'shadowlap blame x', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}' });
  store.transaction(() => {
    for (let i = 0; i < REPLAYS; i++) makeRun(store, { mode: 'replay', parent: root, status: 'completed', startedAt: 2_000 + i });
    for (const p of report.probes) for (const a of p.attempts) store.createRun({ runId: a.runId, mode: 'replay', parentRunId: root, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, startedAt: 9_000, meta: { probe: { of: root, callNo: p.callNo, passed: a.passed } } });
    // A verify's attempts, under it too.
    const verified = verifyReport([{ runId: root, role: 'target', pass: true }]);
    for (const x of verified.runs) for (const a of x.attempts) store.createRun({ runId: a.runId, mode: 'replay', parentRunId: root, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, startedAt: 9_500, meta: { verify: { role: x.role, passed: a.passed } } });
    store.putVerdict({ verifyId: 'vf-root', at: 9_600, verdict: verified.verdict, repairId: null, candidate: null, report: verified, expect: EXPECT, command: 'shadowlap verify --fixes x' });
    // Everything else the store keeps: reports about other runs.
    for (let i = 0; i < VERDICTS; i++) {
      const other = makeRun(store, {});
      store.putVerdict({ verifyId: `vf-${String(i).padStart(4, '0')}`, at: 10_000 + i, verdict: 'rejected', repairId: null, candidate: null, report: verifyReport([{ runId: other, role: 'target', pass: false }]), expect: EXPECT, command: 'shadowlap verify --fixes y' });
    }
    for (let i = 0; i < REPAIRS; i++) {
      const other = makeRun(store, {});
      const r = repairReport({ targets: [other], dir: `.shadowlap/repairs/repair-${i}` });
      store.putRepair({ repairId: `repair-${i}`, at: 20_000 + i, dir: `.shadowlap/repairs/repair-${i}`, outcome: r.outcome, accepted: r.accepted !== null, report: r, expect: EXPECT, command: 'shadowlap repair --fixes z' });
    }
    // A family of its own with no attempt in it: what most runs are.
    quiet = makeRun(store, {});
    for (let i = 0; i < 50; i++) makeRun(store, { mode: 'replay', parent: quiet, status: 'completed' });
  });
}, 60_000);

afterAll(() => {
  store.close();
});

describe('the Forks view’s bundles at scale', () => {
  it('bundles a family of 2,000 replays, and reads the reports once until fixes change', () => {
    const verdicts = vi.spyOn(store, 'listVerdicts');
    let bundles: ReturnType<typeof fixBundles> = null;
    const first = cpuMs(() => (bundles = fixBundles(store, root)));
    expect(bundles!.filter((b) => b.kind === 'blame').map((b) => b.title)).toEqual(['blame · probe #1', 'blame · probe #5', 'blame · probe #7']);
    expect(bundles!.filter((b) => b.kind === 'verify').map((b) => [b.title, b.verdict, b.href])).toEqual([['verify · target', 'accepted', '#/run/' + root]]);
    // Polled while nothing changes: the reports are not read again.
    const again = cpuMs(() => {
      for (let i = 0; i < 10; i++) fixBundles(store, root);
    });
    expect(verdicts).toHaveBeenCalledTimes(1);
    // A fix changes: they are read once more.
    store.putVerdict({ verifyId: 'vf-late', at: 30_000, verdict: 'rejected', repairId: null, candidate: null, report: verifyReport([{ runId: makeRun(store, {}), role: 'target', pass: false }]), expect: EXPECT, command: 'shadowlap verify --fixes w' });
    fixBundles(store, root);
    expect(verdicts).toHaveBeenCalledTimes(2);
    verdicts.mockRestore();
    console.log(`fixBundles over ${REPLAYS} replays, ${VERDICTS} verdicts and ${REPAIRS} repairs: ${first.toFixed(0)} ms CPU the first time, ${(again / 10).toFixed(0)} ms each after`);
    expect(first).toBeLessThan(2_000);
    expect(again / 10).toBeLessThan(1_000);
  });

  it('answers a family with no attempt in it without reading a blame or a report', () => {
    const verdicts = vi.spyOn(store, 'listVerdicts');
    const blames = vi.spyOn(store, 'blamesOfRun');
    expect(fixBundles(store, quiet)).toEqual([]);
    expect(verdicts).not.toHaveBeenCalled();
    expect(blames).not.toHaveBeenCalled();
    verdicts.mockRestore();
    blames.mockRestore();
  });
});
