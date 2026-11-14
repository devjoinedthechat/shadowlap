import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { cliSpawner, startDashboard, type Dashboard, type JobView, type RouteModule } from '../src/index.js';

/**
 * A job the CLI refused because the run's model called a tool Shadowlap never recorded that writes
 * runs again from its drawer, allowing those tools: `POST /api/jobs/:id/again { allowUnrecorded }`
 * builds the same request again through its kind's builder, which checks every field as before, and
 * adds `--allow-unrecorded` to each command of it that replays a recording, before its `--`.
 */

const FAKE = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));

let project: string;
let store: Store;
let dash: Dashboard;
const built: Array<Record<string, unknown>> = [];

/** Kinds as the dashboard's are: a replay of a run with its command after `--`, a clean-up that replays nothing, and one asking a yes first. */
const kinds: RouteModule = {
  register: (_router, ctx) => {
    ctx.jobs.registerJobKind('fake-replay', {
      title: () => 'Replaying',
      build: (req) => {
        built.push({ ...req });
        if (req.ask === true && req.yes !== 'yes-1') return { error: 'the command came from someone else', status: 409, confirm: 'yes-1' };
        return { args: ['replay', '01K5CQ4N7GZ3W8X2V6B9TDRM4P', '--', 'node', 'agent.mjs'], then: [['normalize', 'list']] };
      },
    });
    ctx.jobs.registerJobKind('fake-clean', { title: () => 'Cleaning', build: () => ({ args: ['gc', '--older-than', '30d'] }) });
  },
};

beforeAll(async () => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-jobs-again-')));
  store = Store.open(':memory:');
  dash = await startDashboard({ store, spawnCli: cliSpawner({ command: [process.execPath, FAKE], cwd: project }), project: { path: project }, routes: [kinds] });
});
afterAll(async () => {
  await dash.close();
  store.close();
  rmSync(project, { recursive: true, force: true });
});

const api = (path: string, body?: unknown) => fetch(`${dash.url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-shadowlap-token': dash.token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

async function ended(res: Response): Promise<JobView> {
  expect(res.status, await res.clone().text()).toBe(202);
  const started = (await res.json()) as JobView;
  for (let i = 0; i < 400; i++) {
    const view = (await (await api(`jobs/${started.id}`)).json()) as JobView;
    if (view.done) return view;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job ${started.id} did not finish`);
}

describe('POST /api/jobs/:id/again', () => {
  it('builds the same request again, allowing the tools named on each command that replays, before its --', async () => {
    const first = await ended(await api('jobs', { kind: 'fake-replay', runId: 'R1', estimate: { usd: 0, ceiling: false } }));
    const again = await ended(await api(`jobs/${first.id}/again`, { allowUnrecorded: ['Bash', 'mcp__kb__write'] }));
    expect(again).toMatchObject({ kind: 'fake-replay', args: ['replay', '01K5CQ4N7GZ3W8X2V6B9TDRM4P', '--allow-unrecorded', 'Bash,mcp__kb__write', '--', 'node', 'agent.mjs'] });
    // The builder had the request as it was first sent, its fields checked again.
    expect(built.at(-1)).toMatchObject({ kind: 'fake-replay', runId: 'R1' });
  });

  it('asks the yes its kind asks, and runs once the request sends it', async () => {
    const first = await api('jobs', { kind: 'fake-replay', ask: true });
    expect(first.status).toBe(409);
    const asked = await ended(await api('jobs', { kind: 'fake-replay', ask: true, yes: 'yes-1' }));
    const again = await api(`jobs/${asked.id}/again`, { allowUnrecorded: ['Bash'] });
    expect([again.status, ((await again.json()) as { confirm?: string }).confirm]).toEqual([409, 'yes-1']);
    expect((await ended(await api(`jobs/${asked.id}/again`, { allowUnrecorded: ['Bash'], yes: 'yes-1' }))).args).toContain('--allow-unrecorded');
  });

  it('refuses names that are no tool’s, a job that replays nothing, and a job it never had', async () => {
    const first = await ended(await api('jobs', { kind: 'fake-replay' }));
    for (const allowUnrecorded of [[], ['--online'], ['Bash,Write'], ['a b'], 'Bash', [42]]) expect((await api(`jobs/${first.id}/again`, { allowUnrecorded })).status, JSON.stringify(allowUnrecorded)).toBe(400);
    const clean = await ended(await api('jobs', { kind: 'fake-clean' }));
    const none = await api(`jobs/${clean.id}/again`, { allowUnrecorded: ['Bash'] });
    expect([none.status, ((await none.json()) as { error: string }).error]).toEqual([400, 'this job runs no command that replays a recording, so it has no tool to allow']);
    expect((await api('jobs/0123456789abcdef/again', { allowUnrecorded: ['Bash'] })).status).toBe(404);
  });
});
