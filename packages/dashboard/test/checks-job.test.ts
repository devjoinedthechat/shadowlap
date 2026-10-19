import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { CHECK_JOB_KIND, checkJob } from '../src/routes/checks.js';
import { startDashboard, type Dashboard, type JobView } from '../src/index.js';
import type { GoldenSource } from '../src/tests.js';

/**
 * The check builder's preview job: `shadowlap check` on the recordings a page names, with the check
 * being written. What matters here is the command line the server builds from what the browser
 * sends, and what it refuses; the CLI's own tests say what the command does.
 */

let store: Store;
let project: string;
let dash: Dashboard | null = null;
const spawned: string[][] = [];
const golden = (path: string): GoldenSource => ({ path, runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] });

beforeEach(() => {
  store = Store.open(':memory:');
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-checks-job-')));
  spawned.length = 0;
});
afterEach(async () => {
  await dash?.close();
  dash = null;
  store.close();
  rmSync(project, { recursive: true, force: true });
});

const RULE = { calls: [{ tool: 'issue_refund', after: 'lookup_order', args: { amount: { '<=': '@lookup_order.result.total' } } }] };

describe('the check job', () => {
  it('builds shadowlap check from checked fields: the recordings named, then the check', () => {
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: project } });
    const goldens = [golden('goldens/refund-in-limit')];
    expect(checkJob(store, goldens, { expect: RULE })).toEqual({ args: ['check', '--expect', JSON.stringify(RULE)], title: 'Checking recordings' });
    expect(checkJob(store, goldens, { expect: JSON.stringify(RULE), recordings: [run.runId.slice(0, 10), 'label:bug', 'goldens/refund-in-limit', run.runId] })).toEqual({
      args: ['check', run.runId, 'label:bug', 'goldens/refund-in-limit', '--expect', JSON.stringify(RULE)],
      title: 'Checking recordings',
    });
    // Without a check, each recording's own under "tests".
    expect(checkJob(store, goldens, { recordings: ['goldens/refund-in-limit'] })).toEqual({ args: ['check', 'goldens/refund-in-limit'], title: 'Checking a recording' });
  });

  it('refuses what it can\'t pass on as it is', () => {
    const goldens = [golden('goldens/refund-in-limit'), golden('-rf')];
    expect(checkJob(store, goldens, { expect: [] })).toMatchObject({ error: 'the check is an expect object, such as {"tools":{"send_email":0}}' });
    expect(checkJob(store, goldens, { expect: '{not json' })).toMatchObject({ error: expect.stringContaining('the check must be JSON') });
    expect(checkJob(store, goldens, { expect: { tools: { a: 'x'.repeat(70_000) } } })).toMatchObject({ error: 'that check is too long' });
    expect(checkJob(store, goldens, { recordings: 'goldens/*' })).toMatchObject({ error: expect.stringContaining('recordings is a list') });
    expect(checkJob(store, goldens, { recordings: ['goldens/elsewhere'] })).toMatchObject({ error: 'no run or golden goldens/elsewhere', status: 404 });
    expect(checkJob(store, goldens, { recordings: ['--json'] })).toMatchObject({ status: 404 });
    // A golden whose path the CLI would read as an option is never passed on.
    expect(checkJob(store, goldens, { recordings: ['-rf'] })).toMatchObject({ status: 404 });
    expect(checkJob(store, goldens, { recordings: ['label: '] })).toMatchObject({ error: 'a label cannot be empty', status: 400 });
    expect(checkJob(store, goldens, { recordings: Array.from({ length: 201 }, () => 'label:x') })).toMatchObject({ error: expect.stringContaining('at most 200') });
  });

  it('runs as a job kind of its own, the CLI given the arguments it built', async () => {
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: project } });
    dash = await startDashboard({
      store,
      version: '0.1.0',
      project: { path: project },
      goldens: () => [golden('goldens/refund-in-limit')],
      spawnCli: (args, options) => {
        spawned.push(args);
        return spawn(process.execPath, ['-e', ''], { stdio: options?.events ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] });
      },
    });
    const api = (path: string, init: RequestInit = {}) => fetch(`${dash!.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': dash!.token, 'content-type': 'application/json' } });
    const meta = (await (await api('meta')).json()) as { jobKinds?: string[] };
    expect(meta.jobKinds).toContain(CHECK_JOB_KIND);
    const res = await api('jobs', { method: 'POST', body: JSON.stringify({ kind: CHECK_JOB_KIND, expect: RULE, recordings: [run.runId, 'goldens/refund-in-limit'] }) });
    expect(res.status, await res.clone().text()).toBe(202);
    const job = (await res.json()) as JobView;
    expect(job.title).toBe('Checking recordings');
    expect(spawned).toEqual([['check', run.runId, 'goldens/refund-in-limit', '--expect', JSON.stringify(RULE)]]);
    const refused = await api('jobs', { method: 'POST', body: JSON.stringify({ kind: CHECK_JOB_KIND, recordings: ['nothing-here'] }) });
    expect(refused.status).toBe(404);
  });
});
