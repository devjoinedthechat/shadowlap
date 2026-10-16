import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Store } from '@shadowlap/engine';
import { JobManager, type JobBuild, type JobView, type SpawnCli, type SpawnCliOptions } from '../src/index.js';

/**
 * Where each command of a job runs on a dashboard that serves several projects: every command of a
 * job of several (`JobBuild.then`) gets the store, folder and environment of the project the job
 * started in, not the spawner's own; and what a kind does once its job has started (`started`)
 * happens only for a job whose command did start.
 */

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly events = new PassThrough();
  readonly stdio = [null, this.stdout, this.stderr, this.events];
  readonly kill = vi.fn(() => true);
  readonly pid = undefined;

  end(code: number | null): void {
    this.emit('exit', code, null);
    this.stdout.end();
    this.stderr.end();
    this.events.end();
    setImmediate(() => this.emit('close', code, null));
  }
}

const store = Store.open(':memory:');
afterAll(() => store.close());

function setup(build: () => JobBuild, options: { refuse?: boolean } = {}) {
  const children: FakeChild[] = [];
  const spawned: Array<{ args: string[]; options: SpawnCliOptions | undefined }> = [];
  const spawnCli: SpawnCli = (args, o) => {
    if (options.refuse) throw new Error('no such program');
    spawned.push({ args, options: o });
    const c = new FakeChild();
    children.push(c);
    return c as unknown as ChildProcess;
  };
  // The project a job starts in: the second of the dashboard's, with its own store and folder.
  const place = () => ({ store, project: { name: 'triage-bot', path: '/srv/demo/triage-bot', id: 'triage-bot' }, dbPath: '/srv/demo/triage-bot/.shadowlap/shadowlap.db', projectId: 'triage-bot' });
  const jobs = new JobManager({ store, project: null, spawnCli, stopGraceMs: 50, place });
  jobs.registerJobKind('keep', { title: () => 'Packing and testing', build });
  return { jobs, children, spawned };
}

async function until(jobs: JobManager, id: string): Promise<JobView> {
  for (let i = 0; i < 300; i++) {
    const view = jobs.view(id);
    if (view.done) return view;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`job ${id} did not end`);
}

describe('where a job’s commands run', () => {
  it('runs every command of a job of several against its project’s store, in its folder, with its environment', async () => {
    const { jobs, children, spawned } = setup(() => ({ args: ['pack', '01K5CQ7A3M00000000000000AB', 'goldens/triage-bot'], then: [['test', 'goldens/triage-bot']], env: { SHADOWLAP_UPSTREAM_OPENAI: 'http://127.0.0.1:11434' } }));
    const started = await jobs.start('keep', {});
    children[0]!.end(0);
    await new Promise((r) => setTimeout(r, 30));
    children[1]!.end(0);
    const view = await until(jobs, started.id);
    expect(view.code).toBe(0);
    expect(spawned.map((s) => s.args)).toEqual([['pack', '01K5CQ7A3M00000000000000AB', 'goldens/triage-bot'], ['test', 'goldens/triage-bot']]);
    for (const s of spawned) expect(s.options).toMatchObject({ dbPath: '/srv/demo/triage-bot/.shadowlap/shadowlap.db', cwd: '/srv/demo/triage-bot', env: { SHADOWLAP_UPSTREAM_OPENAI: 'http://127.0.0.1:11434' } });
  });

  it('does what a kind does once its job started, only when its command started', async () => {
    const started = vi.fn();
    const { jobs, children } = setup(() => ({ args: ['run', '--', 'node', 'agent.mjs'], started }));
    const job = await jobs.start('keep', {});
    expect(started).toHaveBeenCalledTimes(1);
    children[0]!.end(0);
    await until(jobs, job.id);

    // A command that couldn't start: never.
    const refused = vi.fn();
    const other = setup(() => ({ args: ['run', '--', 'node', 'agent.mjs'], started: refused }), { refuse: true });
    const failed = await other.jobs.start('keep', {});
    expect(failed).toMatchObject({ done: true, code: 127 });
    expect(refused).not.toHaveBeenCalled();
    // Refused after it built (the dashboard stopping): never.
    const late = vi.fn();
    const closing = setup(() => ({ args: ['run', '--', 'node', 'agent.mjs'], started: late }));
    const stopping = closing.jobs.close();
    await expect(closing.jobs.start('keep', {})).rejects.toMatchObject({ status: 503 });
    await stopping;
    expect(late).not.toHaveBeenCalled();
  });
});
