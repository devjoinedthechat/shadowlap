import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { afterForkLines, blameSteps, JUDGE_SCOPE, markFixApplied, plain, recordBlame, recordRepair, recordVerdict, Store, type VerifyReport } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, repairReport, verifyReport } from '../../engine/test/fix-fixtures.js';
import { fixDetail, type FixDetail } from '../src/fixes.js';
import { fixesView } from '../src/fixes-view.js';
import { startDashboard, type Dashboard, type JobView } from '../src/index.js';

/**
 * A fix's page, step by step: the step its header leads with (the same as its Fixes row's), Verify
 * this run for a failing run no accepted verify checked, Run repair waiting after a repair whose gate
 * rejected every candidate, and the jobs those start.
 */

let store: Store;
let project: string;
let dash: Dashboard | null = null;
const spawned: string[][] = [];
beforeEach(() => {
  store = Store.open(':memory:');
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-fix-steps-')));
  spawned.length = 0;
});
afterEach(async () => {
  await dash?.close();
  dash = null;
  store.close();
  rmSync(project, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
let at = 10 * DAY;
const SEND_ONCE = { tools: { send_email: 1 } };

/** A run blamed under the fix's check, opening the fix or joining the one its label points to. */
function blamed(label = 'double-email') {
  const run = makeRun(store, { labels: [label] });
  const { fix } = recordBlame(store, { runId: run, report: blameReport(run), expect: SEND_ONCE, scope: null, command: 'shadowlap blame', title: 'send_email called twice', checkText: 'send_email called once', at: (at += DAY) });
  return { run, fixId: fix.fixId };
}

/** A change made by hand, accepted on `runs`, with the flags its command kept. */
function acceptedByHand(runs: string[], o: { flags?: string[]; report?: Partial<VerifyReport> } = {}) {
  const report = { ...verifyReport(runs.map((runId) => ({ runId, role: 'target' as const, pass: true }))), ...o.report };
  return recordVerdict(store, { report, expect: SEND_ONCE, command: 'shadowlap verify', rerun: { flags: o.flags ?? [], command: null }, at: (at += DAY) }).verdict;
}

/** A fix with two failing runs, a change made by hand accepted on the first alone. */
function oneLeft(o: { flags?: string[]; report?: Partial<VerifyReport> } = {}) {
  const a = blamed();
  const b = blamed();
  expect(b.fixId).toBe(a.fixId);
  acceptedByHand([a.run], o);
  return { fixId: a.fixId, verified: a.run, left: b.run };
}

/** A fix verified with the patch an accepted repair made, its verdict the repair's, which keeps no flags. */
function repaired() {
  const run = makeRun(store, { labels: ['refund-bug'] });
  const other = makeRun(store, { labels: ['refund-bug'] });
  const { fix } = recordBlame(store, { runId: run, report: blameReport(run), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: (at += DAY) });
  recordBlame(store, { runId: other, report: blameReport(other), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: (at += DAY) });
  recordRepair(store, { repairId: 'repair-munzln2i', dir: '.shadowlap/repairs/repair-munzln2i', report: repairReport({ targets: [run] }), expect: EXPECT, command: 'shadowlap repair', at: (at += DAY) });
  return { run, other, fixId: fix.fixId };
}

const detail = (fixId: string, inTree?: boolean): FixDetail => fixDetail(store, fixId, inTree === undefined ? {} : { patchInTree: () => inTree })!;
const rowOf = (fixId: string) => fixesView(store).fixes.find((f) => f.fixId === fixId)!;

describe('the step a fix’s page leads with', () => {
  it('is the one its Fixes row leads with, worked out on the server', () => {
    const open = blamed('lookup');
    const left = oneLeft();
    const patched = repaired();
    for (const fixId of [open.fixId, left.fixId, patched.fixId]) expect(detail(fixId).lead).toEqual(rowOf(fixId).next);
    expect(detail(open.fixId).lead).toMatchObject({ key: 'repair', label: 'Run repair' });
    expect(detail(patched.fixId).lead).toMatchObject({ key: 'apply', label: 'Apply fix' });
  });

  it('makes Run repair wait after a repair whose gate rejected every candidate, until the fix is blamed again', () => {
    const f = blamed();
    expect(detail(f.fixId).actions.repair?.spent).toBe(false);
    recordRepair(store, { repairId: 'repair-none', dir: '.shadowlap/repairs/repair-none', report: repairReport({ targets: [f.run], accepted: false }), expect: SEND_ONCE, command: 'shadowlap repair', at: (at += DAY) });
    expect(detail(f.fixId)).toMatchObject({ actions: { repair: { spent: true } }, lead: null });
    recordBlame(store, { runId: f.run, report: blameReport(f.run), expect: SEND_ONCE, scope: null, command: 'shadowlap blame', title: 'send_email called twice', checkText: 'send_email called once', at: (at += DAY) });
    expect(detail(f.fixId)).toMatchObject({ actions: { repair: { spent: false } }, lead: { key: 'repair' } });
  });
});

describe('the Blame step’s row of calls', () => {
  it('draws the agent’s calls, the judge’s left out, and marks the model calls blame steps through, as many as the CLI’s blame header counts', () => {
    const judge = { kind: 'api' as const, scope: JUDGE_SCOPE };
    const run = makeRun(store, { labels: ['judged'], calls: ['api', 'tool', judge, 'api', judge, 'api'] });
    const steps = blameSteps(store.getCalls(run), null).length;
    const report = { ...blameReport(run), steps };
    const { fix } = recordBlame(store, { runId: run, report, expect: SEND_ONCE, scope: null, command: 'shadowlap blame', title: 'send_email called twice', checkText: 'send_email called once', at: (at += DAY) });
    const b = detail(fix.fixId).blame!;
    expect(b.callRow.map((c) => [c.callNo, c.kind, c.probed])).toEqual([
      [1, 'api', true],
      [2, 'tool', false],
      [4, 'api', true],
      [6, 'api', true],
    ]);
    expect(steps).toBe(3);
    expect(b.callRow.filter((c) => c.probed)).toHaveLength(b.steps);
  });
});

describe('the Verify step’s line on what answered the tool calls after the fork', () => {
  it('is the CLI report’s, in the engine’s words, and is none when no attempt made a tool call after its fork', () => {
    const f = blamed();
    const report = verifyReport([{ runId: f.run, role: 'target', pass: true }]);
    report.runs[0].attempts = report.runs[0].attempts.map((a, i) => ({ ...a, afterFork: { recorded: 3, inOrder: 0, live: 0, stubbed: i, blocked: 0 } }));
    recordVerdict(store, { report, expect: SEND_ONCE, command: 'shadowlap verify', at: (at += DAY) });
    const shown = detail(f.fixId).verify[0].afterFork;
    expect(shown).toBe(afterForkLines(report.runs, plain)[0].trim());
    expect(shown).toBe("after the fork, the change's 4 attempts made 18 tool calls: 12 answered as recorded, 6 stubbed");
    acceptedByHand([f.run]);
    expect(afterForkLines(store.listVerdicts().at(-1)!.report.runs, plain)).toEqual([]);
    expect(detail(f.fixId).verify[0].afterFork).toBeNull();
  });
});

describe('Verify this run', () => {
  it('verifies a failing run no accepted verdict checked on the code as it is, under the fix’s check, by the verdict’s count and flags but its budget and what only a good run reads', () => {
    const f = oneLeft({ flags: ['--budget', '0.012', '--writes', 'block', '--margin', '0.05', '--timeout', '30'] });
    const d = detail(f.fixId);
    const argv = ['verify', '--fixes', f.left, '--expect', JSON.stringify(SEND_ONCE), '--attempts', '5', '--passes', '4', '--writes', 'block', '--timeout', '30'];
    expect(d.actions.verifyLeft).toEqual({ runs: [f.left], argv, command: `shadowlap verify --fixes ${f.left} --expect '${JSON.stringify(SEND_ONCE)}' --attempts 5 --passes 4 --writes block --timeout 30`, pulled: null, left: [] });
    // Before Mark applied, on its page and on its Fixes row alike.
    expect(d.lead).toEqual({ key: 'verify-left', label: 'Verify this run', command: d.actions.verifyLeft!.command, use: 'reads', runs: [f.left] });
    expect(rowOf(f.fixId).next).toEqual(d.lead);
  });

  it('sets again the request fields the accepted change set, and words several runs left as these runs', () => {
    const a = blamed();
    const b = blamed();
    const c = blamed();
    acceptedByHand([a.run], { report: { fields: { temperature: 1, model: 'claude-opus-5-5' } } });
    const d = detail(a.fixId);
    expect(d.actions.verifyLeft?.runs).toEqual([b.run, c.run]);
    expect(d.actions.verifyLeft?.argv).toEqual(['verify', '--fixes', b.run, c.run, '--expect', JSON.stringify(SEND_ONCE), '--set', 'temperature=1', '--model', 'claude-opus-5-5', '--attempts', '5', '--passes', '4']);
    expect(d.lead).toMatchObject({ key: 'verify-left', label: 'Verify these runs' });
  });

  it('verifies a repair’s change by its gate alone once the patch is in the working tree, and leads with Apply fix while it isn’t', () => {
    const f = repaired();
    expect(detail(f.fixId, false)).toMatchObject({ actions: { verifyLeft: null }, lead: { key: 'apply' } });
    const d = detail(f.fixId, true);
    expect(d.actions.verifyLeft?.argv).toEqual(['verify', '--fixes', f.other, '--expect', JSON.stringify(EXPECT), '--attempts', '5', '--passes', '4']);
    expect(d.lead).toMatchObject({ key: 'verify-left', label: 'Verify this run', runs: [f.other] });
    // Merged with its pull request, it leads with Verify this run in place of nothing.
    store.mergeFixData(f.fixId, { source: { pr: { url: 'https://github.com/acme/agent/pull/9', number: 9, state: 'merged' } } });
    expect(detail(f.fixId, true).lead).toMatchObject({ key: 'verify-left' });
    expect(detail(f.fixId, false).lead).toBeNull();
  });

  it('is offered on an applied fix’s page, which leads only with what applying left undone, and on no fix whose failing runs were all verified', () => {
    const f = repaired();
    markFixApplied(store, f.fixId, { patch: 'applied', repairId: 'repair-munzln2i', goldens: [], tests: 'passed', via: 'fix apply' });
    expect(detail(f.fixId)).toMatchObject({ actions: { verifyLeft: { runs: [f.other] } }, lead: { key: 'apply', label: 'Finish applying' } });
    const all = blamed('all-verified');
    acceptedByHand([all.run]);
    expect(detail(all.fixId).actions.verifyLeft).toBeNull();
  });
});

describe('the Verify this run job', () => {
  async function start(): Promise<Dashboard> {
    dash = await startDashboard({
      store,
      version: '0.1.0',
      project: { path: project },
      spawnCli: (args, options) => {
        spawned.push(args);
        return spawn(process.execPath, ['-e', ''], { stdio: options?.events ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] });
      },
    });
    return dash;
  }
  const api = (path: string, init: RequestInit = {}) => fetch(`${dash!.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': dash!.token, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}) } });
  const job = (body: Record<string, unknown>) => api('jobs', { method: 'POST', body: JSON.stringify(body) });

  it('runs what the page offers, built from the fix’s records, and refuses a fix with nothing left to verify or a change not in the working tree', async () => {
    const f = oneLeft({ flags: ['--budget', '0.012'] });
    const all = blamed('all-verified');
    acceptedByHand([all.run]);
    const patched = repaired();
    const open = blamed('lookup');
    await start();
    const res = await job({ kind: 'verify', fixId: f.fixId, left: true });
    expect(res.status, await res.clone().text()).toBe(202);
    const view = (await res.json()) as JobView;
    expect(view).toMatchObject({ fixId: f.fixId, title: 'Verifying' });
    expect(spawned.at(-1)).toEqual(detail(f.fixId).actions.verifyLeft!.argv);
    const refusal = async (fixId: string) => {
      const r = await job({ kind: 'verify', fixId, left: true });
      expect(r.status).toBe(409);
      return ((await r.json()) as { error: string }).error;
    };
    expect(await refusal(all.fixId)).toBe(`${all.fixId.slice(0, 13)}'s failing runs are all verified: there is nothing left to verify`);
    expect(await refusal(patched.fixId)).toBe(`${patched.fixId.slice(0, 13)}'s change isn't in the working tree: apply it, then verify the code as it is now`);
    expect(await refusal(open.fixId)).toBe(`${open.fixId.slice(0, 13)} is open: no change has been accepted for it yet, so there is nothing to verify`);
  });

  it('is priced on the fix’s estimates: each run left from its recording, and what the gate is expected to take', async () => {
    const f = oneLeft();
    const none = blamed('lookup');
    await start();
    const e = (await (await api(`fixes/${f.fixId}/estimates`)).json()) as { verifyLeft: { kind: string; card: { lines: string[] } } | null };
    expect(e.verifyLeft).toMatchObject({ kind: 'verify' });
    expect(e.verifyLeft!.card.lines[0]).toMatch(/^An attempt costs about /);
    expect(((await (await api(`fixes/${none.fixId}/estimates`)).json()) as { verifyLeft: unknown }).verifyLeft).toBeNull();
  });
});
