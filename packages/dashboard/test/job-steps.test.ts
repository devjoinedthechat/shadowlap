import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Store } from '@shadowlap/engine';
import { JobManager, type JobView, type SpawnCli } from '../src/index.js';

/**
 * A job of several commands (`JobBuild.then`), as Add normalizer and re-run is: each starts only when
 * the one before it exited 0, the output shows where each begins, and a stop between two of them
 * keeps the next from starting.
 */

/** A child process with nothing behind it: the test writes its output and says when it exits and closes. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly events = new PassThrough();
  readonly stdio = [null, this.stdout, this.stderr, this.events];
  readonly kill = vi.fn(() => true);
  readonly pid = undefined;

  end(code: number | null, line?: string): void {
    if (line) this.stdout.write(`${line}\n`);
    this.emit('exit', code, null);
    this.stdout.end();
    this.stderr.end();
    this.events.end();
    setImmediate(() => this.emit('close', code, null));
  }
}

const store = Store.open(':memory:');
afterAll(() => store.close());

function setup(then: unknown) {
  const children: FakeChild[] = [];
  const spawned: string[][] = [];
  const spawnCli: SpawnCli = (args) => {
    spawned.push(args);
    const c = new FakeChild();
    children.push(c);
    return c as unknown as ChildProcess;
  };
  const jobs = new JobManager({ store, project: null, spawnCli, stopGraceMs: 50 });
  jobs.registerJobKind('steps', { title: () => 'Adding a normalizer', build: () => ({ args: ['normalize', 'add', '--path', '$.id'], then: then as string[][] }) });
  return { jobs, children, spawned };
}

async function until(jobs: JobManager, id: string, ms = 3000): Promise<JobView> {
  const t = Date.now();
  for (;;) {
    const view = jobs.view(id);
    if (view.done) return view;
    if (Date.now() - t > ms) throw new Error(`job ${id} did not end`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('a job of several commands', () => {
  it('runs them in order, each after the one before it passed, and ends with the last one\'s code', async () => {
    const { jobs, children, spawned } = setup([['test', 'goldens/a'], ['test', 'goldens/b', '--json', 'report with space.json']]);
    const started = await jobs.start('steps', {});
    expect(started.args).toEqual(['normalize', 'add', '--path', '$.id']);
    children[0]!.end(0, 'added normalizer #1');
    await tick();
    expect(spawned).toHaveLength(2);
    children[1]!.end(0, '✓ a: 8/8 replayed');
    await tick();
    children[2]!.end(1, '✗ b: diverged at call 1');
    const view = await until(jobs, started.id);
    expect(spawned).toEqual([['normalize', 'add', '--path', '$.id'], ['test', 'goldens/a'], ['test', 'goldens/b', '--json', 'report with space.json']]);
    expect(view.code).toBe(1);
    expect(view.lines).toEqual(['added normalizer #1', '$ shadowlap test goldens/a', '✓ a: 8/8 replayed', "$ shadowlap test goldens/b --json 'report with space.json'", '✗ b: diverged at call 1']);
  });

  it('stops at the first command that fails: the ones after it never start', async () => {
    const { jobs, children, spawned } = setup([['test', 'goldens/a']]);
    const started = await jobs.start('steps', {});
    children[0]!.end(2, '✗ that rule would mask nothing');
    const view = await until(jobs, started.id);
    expect(spawned).toHaveLength(1);
    expect(view.code).toBe(2);
    expect(view.lines).toEqual(['✗ that rule would mask nothing']);
  });

  it('starts nothing more once asked to stop, and says what did not run', async () => {
    const { jobs, children, spawned } = setup([['test', 'goldens/a']]);
    const started = await jobs.start('steps', {});
    expect(jobs.stop(started.id)).toBe(true);
    // The first command had finished its work and exits 0 all the same.
    children[0]!.end(0, 'added normalizer #1');
    const view = await until(jobs, started.id);
    expect(spawned).toHaveLength(1);
    expect(view.code).toBeNull();
    expect(view.lines).toEqual(['added normalizer #1', '(stopped before shadowlap test goldens/a)']);
  });

  it('refuses a builder whose next command is not one', async () => {
    for (const then of [[[]], ['test'], [['test', 'a\0b']], 'test']) {
      const { jobs, spawned } = setup(then);
      await expect(jobs.start('steps', {})).rejects.toMatchObject({ status: 500 });
      expect(spawned).toHaveLength(0);
    }
  });
});
