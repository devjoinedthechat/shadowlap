import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Store } from '@shadowlap/engine';
import { HttpError } from '../src/http.js';
import { JobManager, type JobBuild } from '../src/jobs.js';
import { commandTreeUse, jobCommands, sameTree, treeClash, treeFolder, treeUse, type JobTree } from '../src/worktree.js';

/**
 * The working tree's lock: which commands change a project's files and which run the agent from
 * them, the strongest use among the commands a job chains, and which jobs share a tree. A repair in
 * one project holds that project's tree only; a project inside another shares its tree.
 */

describe('how a command uses the working tree', () => {
  it('changes it to repair or apply a patch, and runs the agent from it to record, replay, blame, verify, test, calibrate or score', () => {
    expect(commandTreeUse(['repair', '--fixes', 'label:x'])).toEqual({ use: 'writes', doing: 'a repair is verifying candidates made from your working tree', verb: 'repair' });
    expect(commandTreeUse(['fix', 'apply', 'fx-1'])).toMatchObject({ use: 'writes', verb: 'apply the patch' });
    // Applying a migration's config change writes the tree; migrate itself only runs the agent from it.
    expect(commandTreeUse(['migrate', 'apply', 'mg-01ABCDEFGH'])).toEqual({ use: 'writes', doing: "a migration's config change is being applied to your working tree", verb: 'apply the config change' });
    expect(commandTreeUse(['migrate', '--to', 'claude-haiku-4-5', 'goldens/a'])).toMatchObject({ use: 'reads', verb: 'migrate' });
    for (const [args, verb] of [
      [['run', '--', 'node', 'agent.mjs'], 'record'],
      [['replay', '01M3'], 'replay'],
      [['blame', '01M3'], 'blame'],
      [['verify', '--fixes', 'x'], 'verify'],
      [['test', 'goldens/a'], 'test'],
      [['calibrate', '01M3'], 'calibrate'],
      [['tasks', 'score', 'x'], 'score'],
    ] as const)
      expect(commandTreeUse(args)).toMatchObject({ use: 'reads', verb });
    // Bisect replays in worktrees of its own; the rest runs no agent.
    for (const args of [['bisect', '01M3'], ['pack', '01M3', 'dir'], ['fix', 'show', 'fx-1'], ['tasks', 'ls'], ['normalize', 'add', 'x'], []]) expect(commandTreeUse(args)).toBeNull();
  });

  it('holds a job by the strongest use among the commands it chains', () => {
    expect(treeUse([['normalize', 'add', 'x'], ['test', 'goldens/a']])).toMatchObject({ use: 'reads', verb: 'test' });
    expect(treeUse([['test', 'goldens/a'], ['repair', '--fixes', 'x'], ['replay', 'y']])).toMatchObject({ use: 'writes', verb: 'repair' });
    expect(treeUse([['pack', 'x', 'y']])).toBeNull();
    expect(treeUse([])).toBeNull();
  });

  it('reads the commands a builder chains after its first, leaving out anything that is not one', () => {
    expect(jobCommands({ args: ['normalize', 'add', 'x'] })).toEqual([['normalize', 'add', 'x']]);
    expect(jobCommands({ args: ['normalize', 'add', 'x'], then: [['test', 'goldens/a'], 'test', [], [1], ['replay', 'y']] })).toEqual([
      ['normalize', 'add', 'x'],
      ['test', 'goldens/a'],
      ['replay', 'y'],
    ]);
    expect(jobCommands({ args: ['x'], then: 'test' })).toEqual([['x']]);
  });
});

describe('which jobs share a tree', () => {
  it('is the same folder, or one inside the other, and the dashboard’s own folder shares every tree', () => {
    expect(sameTree('/p/agent', '/p/agent')).toBe(true);
    expect(sameTree('/p/agent', '/p/agent/sub')).toBe(true);
    expect(sameTree('/p/agent/sub', '/p/agent')).toBe(true);
    expect(sameTree('/p/agent', '/p/other')).toBe(false);
    expect(sameTree('/p/agent', '/p/agent-two')).toBe(false);
    expect(sameTree(null, '/p/agent')).toBe(true);
    expect(sameTree('/p/agent', null)).toBe(true);
  });

  it('finds the job a new one would clash with: in its tree, one that changes it, or any when the new one changes it', () => {
    const repairing: JobTree = { use: 'writes', doing: 'a repair is verifying candidates made from your working tree', folder: '/p/one' };
    const blaming: JobTree = { use: 'reads', doing: 'a blame is running your agent from your working tree', folder: '/p/one' };
    expect(treeClash([{ tree: repairing, at: '/p/one' }], 'reads', '/p/one')).toBe(repairing);
    expect(treeClash([{ tree: blaming, at: '/p/one' }], 'reads', '/p/one')).toBeNull();
    expect(treeClash([{ tree: null, at: '/p/one' }, { tree: blaming, at: '/p/one' }], 'writes', '/p/one')).toBe(blaming);
    // Another project's tree is its own.
    expect(treeClash([{ tree: repairing, at: '/p/one' }], 'writes', '/p/two')).toBeNull();
    expect(treeClash([{ tree: repairing, at: '/p/one' }], 'reads', '/p')).toBe(repairing);
  });

  it('tells folders apart through symbolic links', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sl-tree-')));
    try {
      mkdirSync(join(root, 'agent'));
      symlinkSync(join(root, 'agent'), join(root, 'link'), process.platform === 'win32' ? 'junction' : undefined);
      expect(treeFolder(join(root, 'link'))).toBe(join(root, 'agent'));
      expect(treeFolder(join(root, 'gone'))).toBe(join(root, 'gone'));
      expect(treeFolder(null)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** A CLI process that runs until the test ends it. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly events = new PassThrough();
  readonly stdio = [null, this.stdout, this.stderr, this.events];
  readonly pid = undefined;
  readonly kill = vi.fn(() => {
    this.end(null);
    return true;
  });

  end(code: number | null): void {
    this.emit('exit', code, null);
    this.stdout.end();
    this.stderr.end();
    this.events.end();
    setImmediate(() => this.emit('close', code, null));
  }
}

describe('the job manager’s lock', () => {
  const store = Store.open(':memory:');
  // A folder holding two projects side by side (`one` and `two`), as a dashboard serving both would run them.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sl-tree-jobs-')));
  for (const dir of ['one', 'two', 'one/goldens']) mkdirSync(join(root, dir));
  afterAll(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function manager(): { jobs: JobManager; children: FakeChild[] } {
    const children: FakeChild[] = [];
    const jobs = new JobManager({
      store,
      project: { name: 'p', path: root },
      spawnCli: () => {
        const child = new FakeChild();
        children.push(child);
        return child as unknown as ChildProcess;
      },
    });
    const at = (req: Record<string, unknown>) => (typeof req.dir === 'string' ? { cwd: req.dir } : {});
    jobs.registerJobKind('repair-in', { title: () => 'Repairing', build: (req) => ({ args: ['repair', '--fixes', 'label:x'], ...at(req) }) });
    jobs.registerJobKind('replay-in', { title: () => 'Replaying', build: (req) => ({ args: ['replay', '01M3'], ...at(req) }) });
    // A builder that chains a test after a command that runs no agent, as Add normalizer does.
    jobs.registerJobKind('normalize-and-test', {
      title: () => 'Adding a normalizer',
      build: (req) => {
        const built: JobBuild & { then: string[][] } = { args: ['normalize', 'add', 'x'], then: [['test', 'goldens/a']], ...at(req) };
        return built;
      },
    });
    return { jobs, children };
  }

  const refusal = async (p: Promise<unknown>): Promise<{ status: number; message: string }> => {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    return { status: (err as HttpError).status, message: (err as Error).message };
  };

  it('holds a repair’s project only: a job in another project starts, one in the same project or around it waits', async () => {
    const { jobs, children } = manager();
    const repair = await jobs.start('repair-in', { dir: 'one' });
    expect(repair.worktree).toEqual({ use: 'writes', doing: 'a repair is verifying candidates made from your working tree', folder: join(root, 'one') });
    expect(await refusal(jobs.start('replay-in', { dir: 'one' }))).toEqual({ status: 409, message: 'a repair is verifying candidates made from your working tree: replay once it is done' });
    // A folder inside the project, and the folder around it, are the same tree.
    expect((await refusal(jobs.start('replay-in', { dir: 'one/goldens' }))).status).toBe(409);
    expect((await refusal(jobs.start('replay-in', {}))).status).toBe(409);
    const other = await jobs.start('replay-in', { dir: 'two' });
    expect(other.worktree).toMatchObject({ use: 'reads', folder: join(root, 'two') });
    // The other project's replay holds its own tree against a repair there.
    expect((await refusal(jobs.start('repair-in', { dir: 'two' }))).message).toBe('a replay is running your agent from your working tree: repair once it is done');
    for (const c of children) c.end(0);
    await vi.waitFor(() => expect(jobs.list().every((j) => j.done)).toBe(true));
    // Once both are done, either tree is free.
    await jobs.start('replay-in', { dir: 'one' });
    for (const c of children) c.end(0);
  });

  it('holds a job that chains commands by the strongest of them', async () => {
    const { jobs, children } = manager();
    await jobs.start('repair-in', { dir: 'one' });
    expect(await refusal(jobs.start('normalize-and-test', { dir: 'one' }))).toEqual({ status: 409, message: 'a repair is verifying candidates made from your working tree: test once it is done' });
    const chained = await jobs.start('normalize-and-test', { dir: 'two' });
    expect(chained.worktree).toMatchObject({ use: 'reads', doing: 'a test is running your agent from your working tree' });
    for (const c of children) c.end(0);
  });
});
