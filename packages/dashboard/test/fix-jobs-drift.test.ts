import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as engine from '@shadowlap/engine';
import { fixRecords, quoteArgv, recordBlame, recordVerdict, Store, type StoredFix } from '@shadowlap/engine';
import { blameReport, makeRun, verifyReport } from '../../engine/test/fix-fixtures.js';
import { agentOfArgv, fixDetail, repairArgv } from '../src/fixes.js';
import { repairerProblem } from '../src/repairer-check.js';
import { startDashboard, type Dashboard } from '../src/index.js';

/**
 * The repair and verify commands the engine builds (fix-jobs.ts, which the terminal UI runs) are
 * the dashboard's: the same line for the same fix, and the same question before it runs when a run
 * it selects came from someone else's pack. Each store here holds what tells the builders apart:
 * the failing run labelled good, good runs of another agent, a good run from a pack, a label that a
 * passing run carries too, and a blame's scope.
 */

let store: Store;
let project: string;
let dash: Dashboard | null = null;
const spawned: string[][] = [];
const claudeWas = process.env.SHADOWLAP_CLAUDE;

beforeEach(() => {
  store = Store.open(':memory:');
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-fix-jobs-drift-')));
  spawned.length = 0;
  // The repair asks the user's own Claude Code, which must be found first: here it is this test's node.
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

const EXPECT = { tools: { send_email: 1 } };
const PACK = { imported: { at: 1, from: 'pack' } };

function blame(runId: string, scope: string | null = null, outcome: 'blamed' | 'unrescuable' = 'blamed'): StoredFix {
  return recordBlame(store, { runId, report: blameReport(runId, outcome), expect: EXPECT, scope, command: `shadowlap blame ${runId.slice(0, 10)}`, title: 'send_email called twice', checkText: 'send_email called once' }).fix;
}

/** The dashboard's repair job for a fix, as the page starts it: its question (409) first, if any, then the line it spawns once the page says yes. */
async function dashboardRepair(fixId: string): Promise<{ ask: { error: string; confirm: string } | null; spawned: string[] }> {
  if (!dash) {
    dash = await startDashboard({
      store,
      version: '0.1.0',
      project: { path: project },
      jobStopGraceMs: 200,
      spawnCli: (args, options) => {
        spawned.push(args);
        return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: options?.events ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] });
      },
    });
  }
  const post = (body: Record<string, unknown>) => fetch(`${dash!.url}/api/jobs`, { method: 'POST', body: JSON.stringify(body), headers: { 'x-shadowlap-token': dash!.token, 'content-type': 'application/json' } });
  let res = await post({ kind: 'repair', fixId });
  let ask: { error: string; confirm: string } | null = null;
  if (res.status === 409) {
    ask = (await res.json()) as { error: string; confirm: string };
    res = await post({ kind: 'repair', fixId, yes: ask.confirm });
  }
  expect(res.status, await res.clone().text()).toBe(202);
  const job = (await res.json()) as { id: string };
  await fetch(`${dash.url}/api/jobs/${job.id}/stop`, { method: 'POST', headers: { 'x-shadowlap-token': dash.token } });
  return { ask, spawned: spawned.at(-1)! };
}

/** The engine's repair of a fix as the terminal UI starts it: the line, the question over every run it selects, and the line once that question is said yes to. */
function engineRepair(fix: StoredFix): { argv: string[]; ask: { error: string; confirm: string } | null; spawned: string[] } {
  const argv = engine.repairArgv(store, fixRecords(store, fix));
  const args = engine.repairJobArgv(argv, null);
  const runs = engine.selectedRuns(store, argv);
  const first = engine.needsConsent({ runs, yes: undefined, args });
  const ask = 'ask' in first ? { error: first.ask.error, confirm: first.ask.confirm } : null;
  const answered = engine.needsConsent({ runs, yes: ask?.confirm, args });
  if ('ask' in answered) throw new Error('the engine asked again after a yes to its own question');
  return { argv, ask, spawned: [...args, ...answered.yes] };
}

/** The verify line the dashboard's Verify step shows, with short ids, against the engine's. */
function verifyLines(fix: StoredFix): { dashboard: string; engine: string } {
  const short = (a: string) => (/^[0-9A-Z]{26}$/.test(a) ? a.slice(0, 10) : a);
  return { dashboard: fixDetail(store, fix.fixId)!.commands.verify, engine: quoteArgv(['shadowlap', ...engine.verifyArgv(store, fixRecords(store, fix)).map(short)]) };
}

describe('the engine’s fix commands against the dashboard’s', () => {
  it('keep out the failing run and other agents’ good runs, and ask about the good run a pack brought', async () => {
    const failing = makeRun(store, { labels: ['double-email', 'good'], argv: ['node', 'agent.mjs', 'A-1150'] });
    const other = makeRun(store, { labels: ['good'], status: 'completed', argv: ['python', 'other_agent.py', '--persona', 'calm'] });
    // A replay of the other agent's run, whatever command it names: the agent is its recording's.
    makeRun(store, { labels: ['good'], status: 'completed', mode: 'replay', parent: other, argv: ['node', 'agent.mjs', 'A-9'] });
    const same = makeRun(store, { labels: ['good'], status: 'completed', argv: ['node', 'agent.mjs', 'A-1151'] });
    const packed = makeRun(store, { labels: ['good'], status: 'completed', argv: ['node', 'agent.mjs', 'A-77'], meta: PACK });
    const fix = blame(failing);

    const ours = engineRepair(fix);
    expect(ours.argv).toEqual(repairArgv(store, fixRecords(store, fix)));
    // The failing run, though labelled good, and the other agent's runs stay out: the keeps go by id.
    expect(ours.argv.slice(0, 4)).toEqual(['repair', '--fixes', 'label:double-email', '--keeps']);
    expect(ours.argv.slice(4, 6).sort()).toEqual([same, packed].sort());
    expect(ours.argv.slice(6)).toEqual(['--expect', JSON.stringify(EXPECT)]);
    expect(engine.selectedRuns(store, ours.argv).map((r) => r.runId).sort()).toEqual([failing, same, packed].sort());

    const theirs = await dashboardRepair(fix.fixId);
    expect(ours.ask).not.toBeNull();
    expect(ours.ask).toEqual(theirs.ask);
    expect(ours.spawned).toEqual(theirs.spawned);
    expect(ours.spawned.at(-1)).toBe('--yes');

    const verify = verifyLines(fix);
    expect(verify.engine).toBe(verify.dashboard);
    // A verify selects the runs a repair does, so it asks about the same ones.
    const verifyArgv = engine.verifyArgv(store, fixRecords(store, fix));
    expect(engine.selectedRuns(store, verifyArgv).map((r) => r.runId)).toEqual(engine.selectedRuns(store, ours.argv).map((r) => r.runId));
  });

  it('keep label:good when it holds only this agent’s runs, list failing runs by id when a passing run carries their label, and keep the blame’s scope', async () => {
    const failing = makeRun(store, { labels: ['double-email'], argv: ['node', 'agent.mjs', 'A-1150'] });
    const passing = makeRun(store, { labels: ['double-email'], status: 'completed', argv: ['node', 'agent.mjs', 'A-1152'] });
    makeRun(store, { labels: ['good'], status: 'completed', argv: ['node', 'agent.mjs', 'A-1151'] });
    makeRun(store, { labels: ['good'], status: 'completed', argv: ['node', 'agent.mjs', 'A-77'], meta: PACK });
    const fix = blame(failing, 'billing');

    const ours = engineRepair(fix);
    expect(ours.argv).toEqual(repairArgv(store, fixRecords(store, fix)));
    expect(ours.argv).toEqual(['repair', '--fixes', failing, '--keeps', 'label:good', '--scope', 'billing', '--expect', JSON.stringify(EXPECT)]);
    expect(engine.selectedRuns(store, ours.argv).map((r) => r.runId)).not.toContain(passing);

    const theirs = await dashboardRepair(fix.fixId);
    expect(ours.ask).toEqual(theirs.ask);
    expect(ours.spawned).toEqual(theirs.spawned);
    expect(fixDetail(store, fix.fixId)!.actions.repair!.noFix).toBe(engine.noFixToTry(store, fixRecords(store, fix), 'billing'));
    const verify = verifyLines(fix);
    expect(verify.engine).toBe(verify.dashboard);
  });

  it('keep the good runs a verify of the fix kept, before any labelled good', async () => {
    const failing = makeRun(store, { labels: ['double-email'] });
    const kept = makeRun(store, { status: 'completed', argv: ['python', 'other_agent.py'] });
    makeRun(store, { labels: ['good'], status: 'completed' });
    const fix = blame(failing);
    recordVerdict(store, { report: verifyReport([{ runId: failing, role: 'target', pass: false }, { runId: kept, role: 'good', pass: true }]), expect: EXPECT, command: 'shadowlap verify' });
    const ours = engineRepair(fix);
    expect(ours.argv).toEqual(repairArgv(store, fixRecords(store, fix)));
    expect(ours.argv).toEqual(['repair', '--fixes', 'label:double-email', '--keeps', kept, '--expect', JSON.stringify(EXPECT)]);
    expect(ours.spawned).toEqual((await dashboardRepair(fix.fixId)).spawned);
    const verify = verifyLines(fix);
    expect(verify.engine).toBe(verify.dashboard);
  });

  it('say alike why a repair would find no fix to try, and refuse a scope that reads as a flag', () => {
    const failing = makeRun(store, { labels: ['double-email'] });
    const fix = blame(failing, null, 'unrescuable');
    store.updateRunMeta(failing, { blame: { at: 1, outcome: 'unrescuable', oracle: fix.check.oracle, scope: null } } as never);
    const noFix = fixDetail(store, fix.fixId)!.actions.repair!.noFix;
    expect(noFix).toMatch(/No fix to try/);
    expect(engine.noFixToTry(store, fixRecords(store, fix), null)).toBe(noFix);
    const flagged = makeRun(store, { labels: ['wrong-refund'] });
    const scoped = blame(flagged, '--apply');
    expect(engine.repairArgv(store, fixRecords(store, scoped))).toEqual([]);
    expect(repairArgv(store, fixRecords(store, scoped))).toEqual([]);
  });

  it('ask nothing when no run it selects came from someone else', async () => {
    const failing = makeRun(store, { labels: ['double-email'] });
    makeRun(store, { labels: ['good'], status: 'completed' });
    const fix = blame(failing);
    const ours = engineRepair(fix);
    const theirs = await dashboardRepair(fix.fixId);
    expect(ours.ask).toBeNull();
    expect(theirs.ask).toBeNull();
    expect(ours.spawned).toEqual(theirs.spawned);
    expect(ours.spawned).not.toContain('--yes');
  });

  it('name the agent of a command, and say why a repairer can’t be asked, alike', () => {
    for (const argv of [['node', 'agent.mjs', 'A-1150'], ['node', '--env-file=.env', 'src/agent.ts', '--ticket', '7'], ['python', '-m', 'support.agent', '--persona', 'pushy'], ['pnpm', 'start'], []]) {
      expect(engine.agentOfArgv(argv)).toBe(agentOfArgv(argv));
    }
    const none = () => false;
    for (const [repairer, configured, env] of [
      ['claude-code', false, { PATH: '/usr/bin' }],
      ['claude-code:claude-opus-5-5', true, { PATH: '/usr/bin', SHADOWLAP_CLAUDE: '/opt/claude' }],
      ['anthropic', true, { PATH: '' }],
    ] as const) {
      expect(engine.repairerProblem(repairer, configured, { env, isFile: none })).toBe(repairerProblem(repairer, configured, { env, isFile: none }));
    }
  });
});
