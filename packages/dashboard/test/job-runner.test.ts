import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '@shadowlap/engine';
import { JobManager, type JobView, type SpawnCli, type UploadSource } from '../src/index.js';
import { lines } from '../src/jobs.js';

/**
 * The job runner up close, with a stand-in for the CLI process: how much of a job's output it keeps,
 * how it cuts a line too long, what it does when asked to stop a command that has already exited,
 * and that nothing starts once the dashboard is stopping.
 */

/** A child process with nothing behind it: the test writes its output and says when it exits and closes. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly events = new PassThrough();
  readonly stdio = [null, this.stdout, this.stderr, this.events];
  readonly kill = vi.fn(() => true);
  constructor(readonly pid: number | undefined) {
    super();
  }

  exit(code: number | null): void {
    this.emit('exit', code, null);
  }

  close(code: number | null): void {
    this.stdout.end();
    this.stderr.end();
    this.events.end();
    setImmediate(() => this.emit('close', code, null));
  }
}

const store = Store.open(':memory:');
afterAll(() => store.close());
afterEach(() => vi.restoreAllMocks());

function manager(spawnCli: SpawnCli, uploads?: UploadSource): JobManager {
  const jobs = new JobManager({ store, project: null, spawnCli, ...(uploads ? { uploads } : {}) });
  jobs.registerJobKind('fake', { title: () => 'Faking', build: () => ({ args: ['fake'] }) });
  return jobs;
}

async function until(jobs: JobManager, id: string, ms = 5000): Promise<JobView> {
  const t = Date.now();
  for (;;) {
    const view = jobs.view(id);
    if (view.done) return view;
    if (Date.now() - t > ms) throw new Error(`job ${id} did not end`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('a job\'s output', () => {
  it('cuts a line too long, whether it came in one piece or many', async () => {
    const stream = new PassThrough();
    const got: Array<[string, boolean]> = [];
    const flush = lines(stream, 16 * 1024, (line, cut) => got.push([line.length > 20 ? `${line[0]}×${line.length}` : line, cut]));
    // A 40 KB line in one chunk, then a 20 KB one in two, then the start of a line.
    stream.write(`${'a'.repeat(40_000)}\nshort\r\n`);
    stream.write('b'.repeat(10_000));
    stream.write(`${'b'.repeat(10_000)}\nlast`);
    await new Promise((r) => setImmediate(r));
    flush();
    expect(got).toEqual([
      [`a×${16 * 1024}`, true],
      ['short', false],
      [`b×${16 * 1024}`, true],
      ['last', false],
    ]);
  });

  it('keeps the last 2,000 lines, and pages them from any line ever printed', async () => {
    const child = new FakeChild(undefined);
    const jobs = manager(() => child as unknown as ChildProcess);
    const job = await jobs.start('fake', { kind: 'fake' });
    for (let i = 1; i <= 5000; i++) child.stdout.write(`line ${i}\n`);
    await new Promise((r) => setImmediate(r));
    const view = jobs.view(job.id);
    expect(view.total).toBe(5000);
    expect(view.lines).toHaveLength(2000);
    expect(view.lines[0]).toBe('line 3001');
    expect(view.lines.at(-1)).toBe('line 5000');
    expect(jobs.view(job.id, 4990).lines).toEqual(['line 4991', 'line 4992', 'line 4993', 'line 4994', 'line 4995', 'line 4996', 'line 4997', 'line 4998', 'line 4999', 'line 5000']);
    expect(jobs.view(job.id, 100).lines[0], 'lines let go are not offered').toBe('line 3001');
    expect(jobs.view(job.id, 5000).lines).toEqual([]);
    expect(jobs.list()[0]!.total).toBe(5000);
    child.exit(0);
    child.close(0);
    expect((await until(jobs, job.id)).code).toBe(0);
  });
});

describe('stopping a job', () => {
  it.skipIf(process.platform === 'win32')('signals nobody once its command has exited, and ends it when the pipes are closed', async () => {
    // A command that exited while something it left behind holds its output open: its process group
    // may be gone, and its id taken by another, so a stop must not signal it.
    const child = new FakeChild(2_000_000_000);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const jobs = manager(() => child as unknown as ChildProcess);
    const job = await jobs.start('fake', { kind: 'fake' });
    child.exit(0);
    expect(jobs.stop(job.id), 'still running until its pipes close').toBe(true);
    const ended = await until(jobs, job.id);
    expect(ended).toMatchObject({ done: true, code: 0 });
    expect(kill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('signals its process group while its command runs', async () => {
    const child = new FakeChild(2_000_000_001);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const jobs = manager(() => child as unknown as ChildProcess);
    const job = await jobs.start('fake', { kind: 'fake' });
    expect(jobs.stop(job.id)).toBe(true);
    expect(kill).toHaveBeenCalledWith(-2_000_000_001, 'SIGTERM');
    child.exit(null);
    child.close(null);
    await until(jobs, job.id);
  });
});

describe('a dashboard that is stopping', () => {
  it('starts no job, not even one whose builder was still at work when it began to stop', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const spawned: string[][] = [];
    const uploads = { claim: vi.fn(() => ({ path: '/uploads/x.har', name: 'x.har', bytes: 1 })), release: vi.fn(), discard: vi.fn() };
    const jobs = manager((args) => {
      spawned.push(args);
      return new FakeChild(undefined) as unknown as ChildProcess;
    }, uploads);
    jobs.registerJobKind('slow', {
      title: () => 'Reading a capture',
      build: async (_req, ctx) => {
        ctx.upload('01K5CQ4P2R0000000000000000');
        await gate;
        return { args: ['import', '/uploads/x.har'] };
      },
    });
    const starting = jobs.start('slow', { kind: 'slow' });
    await jobs.close();
    finish();
    await expect(starting).rejects.toMatchObject({ status: 503, message: 'the dashboard is stopping' });
    expect(spawned, 'nothing ran after the close').toEqual([]);
    expect(uploads.release, 'the upload it claimed waits to be deleted with the rest').toHaveBeenCalled();
    await expect(jobs.start('fake', { kind: 'fake' })).rejects.toMatchObject({ status: 503 });
    expect(jobs.list()).toEqual([]);
  });
});
