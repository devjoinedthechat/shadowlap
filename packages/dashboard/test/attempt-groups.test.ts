import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordBlame, recordVerdict, Store, type Origin } from '@shadowlap/engine';
import { blameReport, EXPECT, verifyReport } from '../../engine/test/fix-fixtures.js';
import { fixAttemptGroups, groupAttempts, MAX_ATTEMPTS } from '../src/attempt-groups.js';
import { startDashboard, type Dashboard } from '../src/index.js';

/**
 * A gate's attempts grouped by what each did: the tool calls each made from where it left the run,
 * and how it came out, with how many took each path and one to open. So a fix's page shows how its
 * failing attempts differ from the passing ones.
 */

let store: Store;
let failing = '';
let fixId = '';

/** An attempt that replays `failing` up to `from` and then calls these tools, as they ran. */
function attempt(from: number, tools: Array<[string, Origin]>, meta: Record<string, unknown> = {}): string {
  const run = store.createRun({ mode: 'replay', parentRunId: failing, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, codeVersion: null, startedAt: 2_000, meta });
  const calls: Array<['api' | 'tool', string, Origin]> = [['api', 'POST /v1/messages', 'replayed'], ['tool', 'lookup_order', 'replayed'], ['api', 'POST /v1/messages', 'live'], ...tools.map(([name, origin]): ['tool', string, Origin] => ['tool', name, origin]), ['api', 'POST /v1/messages', 'live']];
  calls.forEach(([kind, name, origin], i) => {
    const callNo = i + 1;
    const identity = { kind, name, fingerprint: `f${callNo}${name}`, occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo, ...identity, origin, effect: kind === 'tool' ? (name === 'lookup_order' ? 'read' : 'write') : null, requestRef: null, meta: {}, at: 2_000 + callNo });
    store.appendCallEnd(identity, { runId: run.runId, callNo, attempt: 0, responseRef: null, outcome: origin === 'blocked' ? 'error' : 'ok', meta: {}, at: 2_000 + callNo });
  });
  store.setDivergence(run.runId, { type: 'forced', callNo: from, kind: 'api', name: 'POST /v1/messages', replayedBefore: from - 1 });
  store.endRun(run.runId, 'completed', 3_000);
  return run.runId;
}

const REFUND: Array<[string, Origin]> = [['issue_refund', 'blocked']];
const ESCALATE: Array<[string, Origin]> = [['escalate', 'stubbed']];
const FAILURE = 'issue_refund with {"amount":240} called 0 times, but called 1 time (1 blocked or stubbed)';

beforeAll(() => {
  store = Store.open(':memory:');
  const rec = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: '.' }, codeVersion: null, startedAt: 1_000, meta: { checks: [{ ok: false, label: 'issue_refund called 0 times', detail: 'it was called 1 time' }] } });
  failing = rec.runId;
  store.endRun(failing, 'completed', 1_500);
  // Blame probed #3: three attempts escalated and passed, two refunded and failed.
  const report = blameReport(failing);
  const probe = report.probes[1];
  const results: Array<[boolean, Array<[string, Origin]>]> = [
    [true, ESCALATE],
    [false, REFUND],
    [true, ESCALATE],
    [false, REFUND],
    [true, ESCALATE],
  ];
  probe.callNo = 3;
  probe.attempts = results.map(([passed, tools]) => ({ runId: attempt(3, tools, { probe: { of: failing, callNo: 3, passed } }), passed, exitCode: 0, failures: passed ? [] : [FAILURE], spent: 0.01, upstreamRequests: 2 }));
  probe.passes = 3;
  report.probes = [probe];
  report.blamed = probe;
  report.lost = null;
  fixId = recordBlame(store, { runId: failing, report, expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: 5_000 }).fix.fixId;
  // A verify of the failing run: four attempts escalated and passed, and one wrote nothing and failed.
  const verify = verifyReport([{ runId: failing, role: 'target', pass: true }]);
  const tries: Array<[boolean, Array<[string, Origin]>]> = [
    [true, ESCALATE],
    [true, ESCALATE],
    [false, []],
    [true, ESCALATE],
  ];
  verify.runs[0].attempts = tries.map(([passed, tools]) => ({ ...verify.runs[0].attempts[0], runId: attempt(3, tools, { verify: { role: 'target', passed } }), passed, failures: passed ? [] : ['the agent exited with code 1'], forkedAt: 3 }));
  recordVerdict(store, { report: verify, expect: EXPECT, command: 'shadowlap verify', at: 6_000, fixIds: [fixId] });
});
afterAll(() => store.close());

describe('a fix’s attempts grouped by what each did', () => {
  it('groups a blame probe’s attempts by the tools each called from the probed call and how it came out', () => {
    const g = fixAttemptGroups(store, fixId)!;
    expect(g.cut).toBe(false);
    expect(g.blame!.probes.map((p) => p.callNo)).toEqual([3]);
    const [probe] = g.blame!.probes;
    expect(probe.attempts).toBe(5);
    expect(probe.groups.map((x) => [x.count, x.verdict, x.path, x.why])).toEqual([
      [3, 'passed', ['escalate (stubbed)'], null],
      [2, 'failed', ['issue_refund (blocked)'], FAILURE],
    ]);
    // Each group opens one of its attempts, where it left the run.
    expect(probe.groups[1].example.href).toMatch(new RegExp(`^#/run/${probe.groups[1].example.runId}/3$`));
  });

  it('groups each verified run’s attempts, a run that called no tool among them', () => {
    const [verdict] = fixAttemptGroups(store, fixId)!.verify;
    expect(verdict.runs).toHaveLength(1);
    expect(verdict.runs[0]).toMatchObject({ runId: failing, role: 'target', attempts: 4 });
    expect(verdict.runs[0].groups.map((x) => [x.count, x.verdict, x.path, x.why])).toEqual([
      [3, 'passed', ['escalate (stubbed)'], null],
      [1, 'failed', [], 'the agent exited with code 1'],
    ]);
  });

  it('puts a failing group first among groups as large, and reads at most so many attempts', () => {
    const ids = [attempt(3, REFUND), attempt(3, ESCALATE)];
    const g = groupAttempts(store, [
      { runId: ids[1], passed: true, failures: [] },
      { runId: ids[0], passed: false, failures: ['no'] },
    ]);
    expect(g.groups.map((x) => x.verdict)).toEqual(['failed', 'passed']);
    const many = groupAttempts(store, Array.from({ length: MAX_ATTEMPTS + 1 }, () => ({ runId: ids[0], passed: false, failures: [] })));
    expect(many.cut).toBe(true);
    expect(many.groups[0].count).toBe(MAX_ATTEMPTS);
    // An attempt gc deleted since is passed over.
    expect(groupAttempts(store, [{ runId: '01GONE0000000000000000000A', passed: true, failures: [] }]).groups).toEqual([]);
  });

  it('knows no fix it isn’t given', () => {
    expect(fixAttemptGroups(store, 'fx-NOPE')).toBeNull();
  });
});

describe('GET /api/fixes/:id/groups', () => {
  let dash: Dashboard;
  beforeAll(async () => {
    dash = await startDashboard({ store });
  });
  afterAll(async () => {
    await dash.close();
  });

  it('answers a fix by its id or a prefix, and 404 for none', async () => {
    const get = (id: string) => fetch(`${dash.url}/api/fixes/${id}/groups`, { headers: { 'x-shadowlap-token': dash.token } });
    const res = await get(fixId.slice(0, 8));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { fixId: string }).fixId).toBe(fixId);
    expect((await get('fx-NOPE')).status).toBe(404);
  });
});
