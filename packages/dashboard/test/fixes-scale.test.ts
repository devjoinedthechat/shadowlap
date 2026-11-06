import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { recordBlame, recordVerdict, Store } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, repairReport, verifyReport } from '../../engine/test/fix-fixtures.js';
import { times, timesOf } from '../../engine/test/timing.js';
import { fixBundles } from '../src/fixes.js';
import { fixesView } from '../src/fixes-view.js';

/**
 * The Forks view's bundles at scale: a recording replayed 2,000 times (a golden CI replays on every
 * push), in a store that keeps 400 verdicts and 60 repairs about other runs. The view asks again on
 * every change while it is open, so the reports the store keeps whole are read once for each change
 * to fixes, not on every poll, and each read's CPU time is held against a plain read of the store's
 * runs on the same machine.
 */

const REPLAYS = 2000;
const VERDICTS = 400;
const REPAIRS = 60;

let store: Store;
let root: string;
let quiet: string;

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
    const bundles = fixBundles(store, root);
    expect(bundles!.filter((b) => b.kind === 'blame').map((b) => b.title)).toEqual(['blame · probe #1', 'blame · probe #5', 'blame · probe #7']);
    expect(bundles!.filter((b) => b.kind === 'verify').map((b) => [b.title, b.verdict, b.href])).toEqual([['verify · target', 'accepted', '#/run/' + root]]);
    // Polled while nothing changes: the reports are not read again.
    for (let i = 0; i < 10; i++) fixBundles(store, root);
    expect(verdicts).toHaveBeenCalledTimes(1);
    // A fix changes: they are read once more.
    const other = makeRun(store, {});
    let late = 0;
    const change = () => store.putVerdict({ verifyId: `vf-late-${late++}`, at: 30_000 + late, verdict: 'rejected', repairId: null, candidate: null, report: verifyReport([{ runId: other, role: 'target', pass: false }]), expect: EXPECT, command: 'shadowlap verify --fixes w' });
    change();
    fixBundles(store, root);
    expect(verdicts).toHaveBeenCalledTimes(2);
    verdicts.mockRestore();
    // Held against this machine, not a number of milliseconds: a poll costs about 4 times what a plain
    // read of every run's row does (the family's 2,000 replays among them), on Node 22 and 24 alike,
    // and the read after a change, which reads every report again, 5 to 8 times.
    const t = timesOf({
      poll: () => fixBundles(store, root),
      changed: () => {
        change();
        return fixBundles(store, root);
      },
      runs: () => store.query('SELECT * FROM runs'),
    });
    console.log(`fixBundles over ${REPLAYS} replays, ${VERDICTS} verdicts and ${REPAIRS} repairs: ${t.changed.toFixed(1)} ms CPU after a change to fixes, ${t.poll.toFixed(1)} ms a poll; a read of every run ${t.runs.toFixed(1)} ms`);
    expect(t.poll, `a poll took ${times(t.poll, t.runs)} a read of every run`).toBeLessThan(20 * t.runs);
    expect(t.changed, `a read after a change took ${times(t.changed, t.runs)} a read of every run`).toBeLessThan(25 * t.runs);
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

describe('the Fixes page at scale', () => {
  const FIXES = 200;
  const VERIFIED = 40;
  const UNBLAMED = 300;

  beforeAll(() => {
    const runs = store.transaction(() => {
      for (let i = 0; i < UNBLAMED; i++) makeRun(store, { startedAt: 50_000 + i });
      return Array.from({ length: FIXES }, (_, i) => makeRun(store, { labels: [`flow-${i}`] }));
    });
    runs.forEach((run, i) => {
      const expect = { tools: { [`tool_${i}`]: 1 } };
      recordBlame(store, { runId: run, report: blameReport(run), expect, scope: null, command: 'shadowlap blame x', title: `tool_${i} called twice`, checkText: `tool_${i} called once`, at: 40_000 + i });
      if (i < VERIFIED) recordVerdict(store, { report: verifyReport([{ runId: run, role: 'target', pass: true }]), expect, command: 'shadowlap verify --fixes x' });
    });
  }, 60_000);

  it('lists 200 fixes and the failed runs nobody blamed without a call, and works out none again while nothing changes', () => {
    const first = fixesView(store);
    expect(first.counts).toMatchObject({ all: FIXES + 1, ready: VERIFIED });
    expect(first.unblamed?.count).toBeGreaterThanOrEqual(UNBLAMED);
    const calls = vi.spyOn(store, 'getCalls');
    const all = vi.spyOn(store, 'allRuns');
    const verdicts = vi.spyOn(store, 'getVerdict');
    // Polled while nothing changes: no report, and no run's record but those nobody blamed.
    for (let i = 0; i < 5; i++) fixesView(store);
    expect(verdicts).not.toHaveBeenCalled();
    expect(all).not.toHaveBeenCalled();
    // A fix changes: every run's record is read once for every open fix's repair command, never once a fix.
    const other = makeRun(store, {});
    store.putVerdict({ verifyId: 'vf-page-0', at: 60_000, verdict: 'rejected', repairId: null, candidate: null, report: verifyReport([{ runId: other, role: 'target', pass: false }]), expect: EXPECT, command: 'shadowlap verify --fixes x' });
    fixesView(store);
    expect(all).toHaveBeenCalledTimes(1);
    expect(calls).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    let late = 0;
    const t = timesOf({
      poll: () => fixesView(store),
      changed: () => {
        store.putVerdict({ verifyId: `vf-page-late-${late++}`, at: 61_000 + late, verdict: 'rejected', repairId: null, candidate: null, report: verifyReport([{ runId: other, role: 'target', pass: false }]), expect: EXPECT, command: 'shadowlap verify --fixes x' });
        return fixesView(store);
      },
      runs: () => store.query('SELECT * FROM runs'),
    });
    console.log(`fixesView over ${FIXES} fixes and ${UNBLAMED} failed runs nobody blamed: ${t.changed.toFixed(1)} ms CPU after a change to fixes, ${t.poll.toFixed(1)} ms a poll; a read of every run's row ${t.runs.toFixed(1)} ms`);
    // Held against this machine: a poll, which works out nothing again, costs about a tenth of a plain
    // read of every run's row, and the read after a change to fixes, every row again, 25 to 30 times.
    expect(t.poll, `a poll took ${times(t.poll, t.runs)} a read of every run`).toBeLessThan(t.runs);
    expect(t.changed, `a read after a change took ${times(t.changed, t.runs)} a read of every run`).toBeLessThan(80 * t.runs);
  });
});
