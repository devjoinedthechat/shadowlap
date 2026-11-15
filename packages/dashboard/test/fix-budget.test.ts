import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decideVerify, gateResult, recordBlame, recordVerdict, Store, type BlameReport, type SprtGate } from '@shadowlap/engine';
import { blameReport, makeRun, verifyReport } from '../../engine/test/fix-fixtures.js';
import { fixDetail } from '../src/fixes.js';
import { startDashboard, type Dashboard } from '../src/index.js';

/**
 * Stop at $ on a fix's billed jobs: blame, blame again or with a stronger model, repair, and each
 * verify, as an injection test's: `budget`, an amount above 0, runs the command with `--budget` in
 * place of one it kept; null runs it with none; left out, the command as it was made. Run more
 * attempts keeps the budget its verdict ran with unless that is what stopped it.
 */

let store: Store;
let project: string;
let dash: Dashboard | null = null;
const spawned: string[][] = [];
// Run repair asks your own Claude Code, which must be found: any program found does, as nothing runs here.
const claudeWas = process.env.SHADOWLAP_CLAUDE;
beforeEach(() => {
  store = Store.open(':memory:');
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-fix-budget-')));
  spawned.length = 0;
  process.env.SHADOWLAP_CLAUDE = process.execPath;
});
afterEach(async () => {
  await dash?.close();
  dash = null;
  store.close();
  rmSync(project, { recursive: true, force: true });
  if (claudeWas === undefined) delete process.env.SHADOWLAP_CLAUDE;
  else process.env.SHADOWLAP_CLAUDE = claudeWas;
});

const DAY = 24 * 60 * 60 * 1000;
let at = 10 * DAY;
const SEND_ONCE = { tools: { send_email: 1 } };
const GATE: SprtGate = { kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 80 };

function blamed(label = 'double-email', report: (run: string) => BlameReport = blameReport, meta?: Record<string, unknown>) {
  const run = makeRun(store, { labels: [label], ...(meta ? { meta } : {}) });
  const { fix } = recordBlame(store, { runId: run, report: report(run), expect: SEND_ONCE, scope: null, command: 'shadowlap blame', rerun: { flags: [], command: null }, title: 'send_email called twice', checkText: 'send_email called once', at: (at += DAY) });
  return { run, fixId: fix.fixId };
}

/** A verdict left incomplete, kept with `--budget 0.012`: its gate ran out of attempts (`ranOut`), or that budget stopped it. */
function incomplete(ranOut: boolean) {
  const f = blamed(ranOut ? 'ran-out' : 'stopped');
  const report = verifyReport([{ runId: f.run, role: 'target', pass: true }]);
  const outcomes = ranOut ? Array.from({ length: 80 }, (_, i) => i % 5 !== 0) : [true, true, true];
  const target = report.runs[0];
  report.runs[0] = { ...target, attempts: outcomes.map((passed, i) => ({ ...target.attempts[0], runId: `${target.attempts[0].runId.slice(0, 20)}${String(i).padStart(6, '0')}`, passed })), passes: outcomes.filter(Boolean).length, verdict: 'open', decision: ranOut ? 'inconclusive' : 'continue', gate: gateResult(GATE, outcomes, ranOut ? { decision: 'inconclusive' } : {}) };
  const stopReason = ranOut ? null : 'the budget of $0.01 is spent';
  Object.assign(report, decideVerify(report.runs, stopReason), { gate: GATE, attemptsPerRun: GATE.max, stopReason, attempts: outcomes.length, spent: outcomes.length * 0.004 });
  const { verdict } = recordVerdict(store, { report, expect: SEND_ONCE, command: `shadowlap verify --fixes label:${ranOut ? 'ran-out' : 'stopped'} --budget 0.012`, rerun: { flags: ['--budget', '0.012'], command: null }, at: (at += DAY) });
  return { ...f, verifyId: verdict.verifyId };
}

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
const job = (body: Record<string, unknown>) => fetch(`${dash!.url}/api/jobs`, { method: 'POST', body: JSON.stringify(body), headers: { 'x-shadowlap-token': dash!.token, 'content-type': 'application/json' } });
/** The command a job ran, once it has ended: a repair holds the working tree, so the next job waits for it. */
async function started(body: Record<string, unknown>): Promise<string[]> {
  const res = await job(body);
  expect(res.status, await res.clone().text()).toBe(202);
  const { id } = (await res.json()) as { id: string };
  for (let i = 0; i < 200; i++) {
    const view = (await (await fetch(`${dash!.url}/api/jobs/${id}`, { headers: { 'x-shadowlap-token': dash!.token } })).json()) as { done: boolean };
    if (view.done) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return spawned.at(-1)!;
}

describe('Stop at $ on a fix’s jobs', () => {
  it('runs blame, blame again, repair and each verify with the --budget its dialog asked, and refuses an amount that isn’t one', async () => {
    const f = blamed();
    const unsettled = blamed('unsettled', (run) => ({ ...blameReport(run, 'unrescuable'), gate: GATE, probes: [{ ...blameReport(run, 'unrescuable').probes[0], decision: 'inconclusive' as const }] }));
    const failed = makeRun(store, { status: 'failed' });
    const more = incomplete(true);
    await start();
    expect(await started({ kind: 'blame', runId: failed, expect: SEND_ONCE, budget: 0.5 })).toEqual(['blame', failed, '--expect', JSON.stringify(SEND_ONCE), '--budget', '0.50']);
    expect((await started({ kind: 'blame', fixId: unsettled.fixId, again: true, budget: 1 })).slice(-2)).toEqual(['--budget', '1.00']);
    expect((await started({ kind: 'repair', fixId: f.fixId, repairer: 'claude-code', budget: 2 })).slice(-4)).toEqual(['--repairer', 'claude-code', '--budget', '2.00']);
    expect((await started({ kind: 'verify', fixId: f.fixId, change: true, budget: 0.25 })).slice(-2)).toEqual(['--budget', '0.25']);
    // A budget the command kept is replaced by the one asked, or taken out by none.
    expect((await started({ kind: 'verify', fixId: more.fixId, verifyId: more.verifyId, budget: 0.5 })).filter((a) => a === '--budget' || /^\d+\.\d+$/.test(a))).toEqual(['--budget', '0.50']);
    expect(await started({ kind: 'verify', fixId: more.fixId, verifyId: more.verifyId, budget: null })).not.toContain('--budget');
    const bad = await job({ kind: 'verify', fixId: f.fixId, change: true, budget: 'lots' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('budget is an amount in USD above 0, such as 25.00');
  });

  it('asks first, for a command from someone else’s pack, about the command with the budget it runs with', async () => {
    const f = blamed('packed', blameReport, { imported: true });
    await start();
    const asked = await job({ kind: 'verify', fixId: f.fixId, change: true, budget: 0.5 });
    expect(asked.status).toBe(409);
    const { error, confirm } = (await asked.json()) as { error: string; confirm: string };
    expect(error).toContain('--budget 0.50');
    // A yes to that line runs it; the same yes to another budget is asked again.
    expect((await job({ kind: 'verify', fixId: f.fixId, change: true, budget: 1, yes: confirm })).status).toBe(409);
    expect((await started({ kind: 'verify', fixId: f.fixId, change: true, budget: 0.5, yes: confirm })).slice(-3)).toEqual(['--budget', '0.50', '--yes']);
  });
});

describe('Run more attempts', () => {
  it('keeps the budget its verdict ran with when that didn’t stop it, and leaves it out when it did, saying which', () => {
    const ranOut = incomplete(true);
    const v = fixDetail(store, ranOut.fixId)!.verify[0].more!;
    expect(v).toMatchObject({ kind: 'more', budget: null, keptBudget: '0.012' });
    expect(v.argv.slice(-2)).toEqual(['--budget', '0.012']);
    const stopped = incomplete(false);
    const w = fixDetail(store, stopped.fixId)!.verify[0].more!;
    expect(w).toMatchObject({ kind: 'more', budget: '0.012', keptBudget: null });
    expect(w.argv).not.toContain('--budget');
  });
});
