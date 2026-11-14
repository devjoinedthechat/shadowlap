import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordBlame, recordRepair, Store } from '@shadowlap/engine';
import { blameReport, makeRun, repairReport } from '../../engine/test/fix-fixtures.js';
import { startDashboard, type Dashboard, type JobView } from '../src/index.js';

/**
 * A fix handed over as a pull request, as the CLI hands one over: Run repair commits the accepted
 * change to a branch of its own (`repair --branch`) and opens it with gh (`--pr`), and a pull request
 * opened for a fix by hand is recorded on it (`fix pr <fix> <url>`), each refused in the CLI's words
 * before anything runs.
 */

let store: Store;
let project: string;
let dash: Dashboard | null = null;
const spawned: string[][] = [];
// Run repair asks your own Claude Code, which must be found: any program found does, as nothing runs here.
const claudeWas = process.env.SHADOWLAP_CLAUDE;
beforeEach(() => {
  store = Store.open(':memory:');
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-fix-handover-')));
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

const SEND_ONCE = { tools: { send_email: 1 } };
let at = 10 * 24 * 60 * 60 * 1000;

function blamed(label = 'double-email', meta?: Record<string, unknown>) {
  const run = makeRun(store, { labels: [label], ...(meta ? { meta } : {}) });
  const { fix } = recordBlame(store, { runId: run, report: blameReport(run), expect: SEND_ONCE, scope: null, command: 'shadowlap blame', title: 'send_email called twice', checkText: 'send_email called once', at: (at += 1000) });
  return { run, fixId: fix.fixId };
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
async function started(body: Record<string, unknown>): Promise<{ args: string[]; view: JobView }> {
  const res = await job(body);
  expect(res.status, await res.clone().text()).toBe(202);
  const view = (await res.json()) as JobView;
  for (let i = 0; i < 200; i++) {
    const now = (await (await fetch(`${dash!.url}/api/jobs/${view.id}`, { headers: { 'x-shadowlap-token': dash!.token } })).json()) as { done: boolean };
    if (now.done) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return { args: spawned.at(-1)!, view };
}
async function refused(body: Record<string, unknown>, status = 400): Promise<string> {
  const res = await job(body);
  expect(res.status).toBe(status);
  return ((await res.json()) as { error: string }).error;
}

describe('Run repair’s hand-over', () => {
  it('commits the accepted change to the branch named, and opens it as a pull request with gh where asked, as repair --branch and --pr do', async () => {
    const f = blamed();
    await start();
    expect((await started({ kind: 'repair', fixId: f.fixId, repairer: 'claude-code', branch: 'fix/double-email' })).args.slice(-4)).toEqual(['--repairer', 'claude-code', '--branch', 'fix/double-email']);
    expect((await started({ kind: 'repair', fixId: f.fixId, repairer: 'claude-code', branch: 'fix/double-email', pr: true, budget: 2 })).args.slice(-5)).toEqual(['--branch', 'fix/double-email', '--pr', '--budget', '2.00']);
    expect(await refused({ kind: 'repair', fixId: f.fixId, repairer: 'claude-code', pr: true })).toBe('--pr opens a pull request from the branch --branch <name> makes; give both');
    for (const branch of ['--upload-pack=x', 'two words', '', 'a..b', 'x‮y'.repeat(2)]) expect(await refused({ kind: 'repair', fixId: f.fixId, repairer: 'claude-code', branch }), branch).toBe('name the branch to commit the fix to, such as fix/refund-limit');
    expect(spawned).toHaveLength(2);
  });

  it('asks first, for a command from someone else’s pack, about the line with the branch it commits to', async () => {
    const f = blamed('packed', { imported: true });
    await start();
    const asked = await job({ kind: 'repair', fixId: f.fixId, repairer: 'claude-code', branch: 'fix/packed', pr: true });
    expect(asked.status).toBe(409);
    const { error, confirm } = (await asked.json()) as { error: string; confirm: string };
    expect(error).toContain('--branch fix/packed --pr');
    // That yes runs that line, and no other branch.
    expect((await job({ kind: 'repair', fixId: f.fixId, repairer: 'claude-code', branch: 'fix/other', pr: true, yes: confirm })).status).toBe(409);
    expect((await started({ kind: 'repair', fixId: f.fixId, repairer: 'claude-code', branch: 'fix/packed', pr: true, yes: confirm })).args.slice(-4)).toEqual(['--branch', 'fix/packed', '--pr', '--yes']);
  });
});

describe('Record pull request…', () => {
  it('records the pull request opened for a fix, as fix pr <fix> <url> does, refusing an address that isn’t one', async () => {
    const f = blamed();
    recordRepair(store, { repairId: 'repair-ok', dir: '.shadowlap/repairs/repair-ok', report: repairReport({ targets: [f.run], accepted: true }), expect: SEND_ONCE, command: 'shadowlap repair', at: (at += 1000) });
    await start();
    const url = 'https://github.com/example/agent/pull/138';
    const { args, view } = await started({ kind: 'fix-pr', fixId: f.fixId, url });
    expect(args).toEqual(['fix', 'pr', f.fixId, url]);
    expect(view).toMatchObject({ fixId: f.fixId, title: 'Recording pull request' });
    expect(await refused({ kind: 'fix-pr', fixId: f.fixId, url: 'example.com/pull/1' })).toBe("example.com/pull/1 is not a pull request's address: give its https:// link");
    expect(await refused({ kind: 'fix-pr', fixId: f.fixId })).toBe('url is the pull request’s https:// link');
    expect(await refused({ kind: 'fix-pr', fixId: 'fx-nosuchfix', url }, 404)).toContain('fx-nosuchfix');
    expect(spawned).toHaveLength(1);
  });
});
