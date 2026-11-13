import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { cliSpawner } from '../src/index.js';
import { JobManager, type JobBuild } from '../src/jobs.js';
import type { StepDone } from '../src/job-step.js';

/**
 * A job's server step (`JobBuild.step`): run between two of its commands, once the one before it
 * exited 0, its lines in the job's output; one that refuses ends the job there with its code, and
 * no command after it runs. Pack with injection gate… writes the golden's gate this way.
 */

const FAKE = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));

let store: Store;
let jobs: JobManager;
const builds = new Map<string, JobBuild>();

beforeAll(() => {
  store = Store.open(':memory:');
  jobs = new JobManager({ store, project: null, spawnCli: cliSpawner({ command: [process.execPath, FAKE], cwd: tmpdir() }) });
  jobs.registerJobKind('stepped', { title: () => 'Stepping', build: (req) => builds.get(String(req.as))! });
});
afterAll(async () => {
  await jobs.close();
  store.close();
});

async function run(build: JobBuild): Promise<{ lines: string[]; code: number | null }> {
  const as = String(builds.size);
  builds.set(as, build);
  const started = await jobs.start('stepped', { as });
  for (let i = 0; i < 400; i++) {
    const view = jobs.view(started.id);
    if (view.done) return { lines: view.lines, code: view.code };
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the job did not end');
}

const step = (before: number, done: StepDone, ran: string[]) => ({
  before,
  run: () => {
    ran.push('step');
    return done;
  },
});

describe('a job’s server step', () => {
  it('runs between the commands it sits between, its lines before the next command’s', async () => {
    const ran: string[] = [];
    const out = await run({ args: ['pack', 'r1', 'goldens/x'], then: [['test', 'goldens/x']], step: step(1, { lines: ['  added to shadowlap.config.json'] }, ran) });
    expect(ran).toEqual(['step']);
    expect(out.code).toBe(0);
    expect(out.lines).toEqual(['args ["pack","r1","goldens/x"]', '  added to shadowlap.config.json', '$ shadowlap test goldens/x', 'args ["test","goldens/x"]']);
  });

  it('runs first when it sits before the job’s first command, which then shows its line', async () => {
    const out = await run({ args: ['test', 'goldens/x'], step: step(0, { lines: ['written'] }, []) });
    expect(out.lines).toEqual(['written', '$ shadowlap test goldens/x', 'args ["test","goldens/x"]']);
    expect(out.code).toBe(0);
  });

  it('runs after a job’s git step, as a revert’s, and before the first command it sits before', async () => {
    const ran: string[] = [];
    const out = await run({ args: ['test', 'goldens/x'], git: { args: ['--version'], ok: 'git answered', doing: 'Asking git', verb: 'ask it' }, step: step(0, { lines: ['written'] }, ran) });
    expect(ran).toEqual(['step']);
    expect(out.code).toBe(0);
    expect(out.lines[0]).toBe('$ git --version');
    expect(out.lines.slice(2)).toEqual(['git answered', 'written', '$ shadowlap test goldens/x', 'args ["test","goldens/x"]']);
  });

  it('ends the job where it refuses, with its code, and runs nothing after it', async () => {
    const out = await run({ args: ['pack', 'r1', 'goldens/x'], then: [['test', 'goldens/x']], step: step(1, { lines: ['goldens/x is packed without its gate: it changed'], code: 1 }, []) });
    expect(out.code).toBe(1);
    expect(out.lines).toEqual(['args ["pack","r1","goldens/x"]', 'goldens/x is packed without its gate: it changed']);
  });

  it('never runs after a command that failed, and a step that throws ends the job in its words', async () => {
    const ran: string[] = [];
    const failed = await run({ args: ['fail'], then: [['test', 'goldens/x']], step: step(1, { lines: ['never'] }, ran) });
    expect(ran).toEqual([]);
    expect(failed.code).toBe(3);
    const threw = await run({
      args: ['test', 'goldens/x'],
      step: {
        before: 0,
        run: () => {
          throw new Error('the disk is full');
        },
      },
    });
    expect(threw).toEqual({ lines: ['failed: the disk is full'], code: 1 });
  });
});
