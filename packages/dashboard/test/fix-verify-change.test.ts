import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixRecords, recordBlame, recordRepair, Store, verifyArgv, type BlameReport } from '@shadowlap/engine';
import { blameReport, makeRun, repairReport } from '../../engine/test/fix-fixtures.js';
import { fixDetail } from '../src/fixes.js';
import { startDashboard, type Dashboard, type JobView } from '../src/index.js';

/**
 * Verify your change: a change made by hand, verified from a fix's page on its failing runs, the runs
 * it holds out and the good runs it keeps, under its check (the engine's `verifyArgv`), as the empty
 * Verify step's command does. Offered on any fix with a failing run left, leading where it is the next
 * step (a spent repair with nothing to settle, a repair that would end "No fix to try"), priced, and
 * asking first for a command from someone else's pack.
 */

let store: Store;
let project: string;
let dash: Dashboard | null = null;
const spawned: string[][] = [];
beforeEach(() => {
  store = Store.open(':memory:');
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-verify-change-')));
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

function blamed(o: { label?: string; report?: (run: string) => BlameReport; meta?: Record<string, unknown> } = {}) {
  const run = makeRun(store, { labels: [o.label ?? 'double-email'], ...(o.meta ? { meta: o.meta } : {}) });
  const { fix } = recordBlame(store, { runId: run, report: (o.report ?? blameReport)(run), expect: SEND_ONCE, scope: null, command: 'shadowlap blame', title: 'send_email called twice', checkText: 'send_email called once', at: (at += DAY) });
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
const api = (path: string, init: RequestInit = {}) => fetch(`${dash!.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': dash!.token, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}) } });
const job = (body: Record<string, unknown>) => api('jobs', { method: 'POST', body: JSON.stringify(body) });

describe('Verify your change', () => {
  it('is offered on a fix with a failing run left, as the empty Verify step’s command runs, and none without one', () => {
    const f = blamed();
    const argv = verifyArgv(store, fixRecords(store, store.getFix(f.fixId)!));
    expect(fixDetail(store, f.fixId)!.actions.verifyChange).toEqual({ runs: [f.run], argv, command: fixDetail(store, f.fixId)!.commands.verify.replace(f.run.slice(0, 10), f.run) });
    expect(argv).toEqual(['verify', '--fixes', 'label:double-email', '--expect', JSON.stringify(SEND_ONCE)]);
    // Its run deleted: nothing to verify, so it isn't offered.
    const gone = blamed({ label: 'gone' });
    store.deleteRun(gone.run);
    expect(fixDetail(store, gone.fixId)!.actions.verifyChange).toBeNull();
  });

  it('leads where it is the fix’s next step: after a repair that would end "No fix to try", or one whose gate rejected every candidate', () => {
    // Every attempt met a write's recorded error again: no answer of the model's lost the run, so the fix is in your code.
    const lost = blamed({ label: 'digest', report: (run) => ({ ...blameReport(run, 'unrescuable'), failedWrite: { name: 'post_digest', message: 'channel_not_found', callNo: 1 } }) });
    // The blame kept on the run, as the CLI keeps it beside the fix's: a repair would reuse it, and end "No fix to try".
    store.updateRunMeta(lost.run, { blame: { at, outcome: 'unrescuable', callNo: null, confidence: 'high', rescuedRunId: null, fields: {}, oracle: store.getFix(lost.fixId)!.check.oracle, probes: [], spent: 0 } });
    expect(fixDetail(store, lost.fixId)!.actions.repair?.noFix).toBeTruthy();
    expect(fixDetail(store, lost.fixId)!.lead).toMatchObject({ key: 'verify-change', label: 'Verify your change', use: 'reads', runs: [lost.run] });
    // A repair tried candidates and the gate accepted none: repairing again would try the same.
    const spent = blamed({ label: 'refund' });
    recordRepair(store, { repairId: 'repair-spent', dir: '.shadowlap/repairs/repair-spent', report: repairReport({ targets: [spent.run], accepted: false, oracle: ['send_email called 1 time'] }), expect: SEND_ONCE, command: 'shadowlap repair', at: (at += DAY) });
    expect(fixDetail(store, spent.fixId)!.actions.repair?.spent).toBe(true);
    expect(fixDetail(store, spent.fixId)!.lead).toMatchObject({ key: 'verify-change' });
    // A fix blame found the call of leads with Run repair, as before.
    expect(fixDetail(store, blamed({ label: 'other' }).fixId)!.lead).toMatchObject({ key: 'repair' });
  });

  it('runs that verify as a job, asks first for a command from someone else’s pack, is priced, and refuses a fix with no failing run left', async () => {
    const f = blamed();
    const imported = blamed({ label: 'packed', meta: { imported: true } });
    const gone = blamed({ label: 'gone' });
    store.deleteRun(gone.run);
    await start();
    const res = await job({ kind: 'verify', fixId: f.fixId, change: true });
    expect(res.status, await res.clone().text()).toBe(202);
    expect((await res.json()) as JobView).toMatchObject({ fixId: f.fixId, title: 'Verifying your change' });
    expect(spawned.at(-1)).toEqual(fixDetail(store, f.fixId)!.actions.verifyChange!.argv);
    // Someone else's command: the question first, then, said yes to, the same line with --yes.
    const asked = await job({ kind: 'verify', fixId: imported.fixId, change: true });
    expect(asked.status).toBe(409);
    const { confirm } = (await asked.json()) as { confirm: string };
    expect((await job({ kind: 'verify', fixId: imported.fixId, change: true, yes: confirm })).status).toBe(202);
    expect(spawned.at(-1)).toEqual([...fixDetail(store, imported.fixId)!.actions.verifyChange!.argv, '--yes']);
    const refused = await job({ kind: 'verify', fixId: gone.fixId, change: true });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe(`none of the failing runs of ${gone.fixId.slice(0, 13)} is left in the store, so there is nothing to verify`);
    const e = (await (await api(`fixes/${f.fixId}/estimates`)).json()) as { verifyChange: { kind: string } | null };
    expect(e.verifyChange).toMatchObject({ kind: 'verify' });
    expect(((await (await api(`fixes/${gone.fixId}/estimates`)).json()) as { verifyChange: unknown }).verifyChange).toBeNull();
  });
});
