import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectHost, ProjectRegistry, calibrationOutcome, goldenPath, quoteArgv, setupJobArgs, type ProjectContext, type RecordPlan } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { loadConfig, type ShadowlapConfig } from '../src/config.js';

/**
 * A project's setup from end to end, the way the dashboard's jobs will run it: each step's CLI
 * arguments from the projects module, run in the project's folder against its store, and what each
 * job reports fed back to the project list. The agent sends a new UUID and a random temp path on
 * every run, so step 3 has something to find; its model is the mock in testing/.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./volatile-agent.mjs', import.meta.url));

let mock: MockServer;
const dirs: string[] = [];
beforeAll(async () => {
  mock = await startMockAnthropic({ script: () => ({ message: message([text('triaged')]) }) });
});
afterAll(async () => {
  await mock.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function tempDir(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

interface Job {
  code: number | null;
  /** stdout and stderr, as the job drawer shows them. */
  out: string;
  stdout: string;
  events: Array<{ type: string; data?: unknown }>;
}

/** Runs the CLI as a dashboard job: in the project's folder, against its store, hearing its events on fd 3. */
function job(ctx: ProjectContext<ShadowlapConfig>, args: readonly string[], env: Record<string, string>): Promise<Job> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...ctx.cliArgs(args)], {
      cwd: ctx.cwd,
      env: { ...process.env, ...env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_EVENTS_FD: '3' },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let stdout = '';
    let events = '';
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      stdout += d.toString();
    });
    child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
    (child.stdio[3] as NodeJS.ReadableStream).on('data', (d: Buffer) => (events += d.toString()));
    child.on('close', (code) => resolve({ code, out, stdout, events: events.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; data?: unknown }) }));
  });
}

/**
 * Calibrate's result as a job hears it: its `result` event, the object `calibrate --json` prints.
 * Calibrate's owners report that event; until their change is merged, `--json` gives the same object.
 */
async function calibrate(ctx: ProjectContext<ShadowlapConfig>, args: readonly string[], env: Record<string, string>): Promise<{ job: Job; result: unknown }> {
  const run = await job(ctx, [...args, '--json'], env);
  return { job: run, result: run.events.find((e) => e.type === 'result')?.data ?? (run.stdout.trim() ? JSON.parse(run.stdout) : null) };
}

function world() {
  const home = tempDir('sl-flow-home-');
  const slHome = join(home, '.sl');
  const folder = tempDir('sl-flow-project-');
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: 'triage-bot', dependencies: { '@anthropic-ai/sdk': '^0.60.0' } }));
  const registry = new ProjectRegistry({ home, env: { SHADOWLAP_HOME: slHome }, actor: () => null });
  const host = ProjectHost.open<ShadowlapConfig>(folder, { registry, loadConfig });
  const env = { SHADOWLAP_HOME: slHome };
  return { registry, host, folder, env, id: host.currentProject() };
}

describe('a project’s setup, step by step through the CLI', () => {
  it('inspects, records, makes the replay clean and keeps the golden, each job moving the setup on', async () => {
    const { registry, host, folder, env, id } = world();
    const ctx = host.current();
    expect(host.setup(id)).toMatchObject({ stage: 'added', shows: 'everywhere' });

    // 1 · Inspect: init writes its findings to the list itself.
    const inspected = await job(ctx, setupJobArgs.inspect(), env);
    expect(inspected.code, inspected.out).toBe(0);
    expect(inspected.events.map((e) => e.type)).toEqual(['result']);
    expect(registry.get(id)!.setup).toMatchObject({ stage: 'inspected', findings: { sdk: '@anthropic-ai/sdk 0.60.0' } });

    // 2 · Record: the typed command, confirmed once, then the run noted as it starts.
    const planned = host.planRecording(id, quoteArgv([process.execPath, AGENT]));
    if (!planned.ok) throw new Error(planned.error);
    const plan: RecordPlan = planned.plan;
    expect(plan.confirm).not.toBeNull();
    host.confirmCommand(id, plan);
    expect(host.planRecording(id, quoteArgv([process.execPath, AGENT]))).toMatchObject({ ok: true, plan: { confirm: null } });
    const recorded = await job(ctx, plan.args, { ...env, ...plan.env });
    expect(recorded.code, recorded.out).toBe(0);
    const runId = /recording run (\w{26})/.exec(recorded.out)![1]!;
    registry.noteRecording(id, runId, plan.argv);
    expect(host.setup(id)).toMatchObject({ stage: 'recorded', run: { runId, calls: 2 }, own: true, shows: 'overview' });

    // 3 · Calibrate streams its rounds; what it proposes is offered, then written with --write.
    const streamed = await job(ctx, setupJobArgs.calibrate(runId), env);
    expect(streamed.code, streamed.out).toBe(0);
    expect(streamed.out).toMatch(/round 1 {2}diverged at call 1/);
    const proposed = await calibrate(ctx, setupJobArgs.calibrate(runId), env);
    expect(proposed.job.code, proposed.job.out).toBe(0);
    expect(calibrationOutcome(proposed.result)).toMatchObject({
      done: false,
      added: [],
      proposed: [{ path: '$.metadata.user_id' }, { path: '$.system' }, { path: '$.args.path' }],
      stopped: null,
    });
    const written = await calibrate(ctx, setupJobArgs.calibrate(runId, true), env);
    expect(written.job.code, written.job.out).toBe(0);
    const outcome = calibrationOutcome(written.result, { write: true })!;
    expect(outcome).toMatchObject({ done: true, proposed: [] });
    expect(outcome.added.map((a) => a.path)).toEqual(['$.metadata.user_id', '$.system', '$.args.path']);
    registry.noteCalibrated(id, runId, outcome.added);
    expect(host.setup(id)).toMatchObject({ stage: 'clean', steps: { clean: true } });
    expect(ctx.config().normalize).toHaveLength(3);

    // 4 · Keep it as a test: the offered path is checked, packed, and tested offline.
    const golden = goldenPath(host.suggestGolden(id), { folder, runId });
    expect(golden).toEqual({ ok: true, path: `goldens/${id}` });
    if (!golden.ok) return;
    const packed = await job(ctx, setupJobArgs.pack(runId, golden.path), env);
    expect(packed.code, packed.out).toBe(0);
    const hits = mock.requests.length;
    const tested = await job(ctx, setupJobArgs.test(golden.path), env);
    expect(tested.code, tested.out).toBe(0);
    expect(mock.requests.length, 'the test replays offline').toBe(hits);
    registry.noteTested(id, runId, golden.path);
    expect(host.setup(id)).toMatchObject({ stage: 'tested', golden: golden.path, goldenFrom: 'tested' });
    // Packing again over it is refused, unless it is this run again.
    expect(goldenPath(golden.path, { folder })).toMatchObject({ ok: false, taken: true });
    expect(goldenPath(golden.path, { folder, runId })).toEqual({ ok: true, path: golden.path });

    // Go to the overview.
    expect(host.finishSetup(id).setup).toMatchObject({ stage: 'done', skipped: false, golden: golden.path, runId });
    expect(host.setup(id)).toMatchObject({ stage: 'done', shows: 'none' });
    expect(existsSync(join(folder, golden.path, 'run.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(folder, 'shadowlap.config.json'), 'utf8')).normalize).toHaveLength(3);
    host.close();
  });

  it('records nothing from a typo in the command, and won’t let the setup skip past it', async () => {
    const { registry, host, env, id } = world();
    const ctx = host.current();
    await job(ctx, setupJobArgs.inspect(), env);
    const planned = host.planRecording(id, 'nod agent.mjs');
    if (!planned.ok) throw new Error(planned.error);
    const typo = await job(ctx, planned.plan.args, env);
    expect(typo.code).toBe(127);
    const runId = /recording run (\w{26})/.exec(typo.out)![1]!;
    registry.noteRecording(id, runId, planned.plan.argv);
    expect(host.setup(id)).toMatchObject({ stage: 'inspected', run: null, steps: { recorded: false }, empty: { runId, calls: 0, status: 'failed' } });
    expect(() => host.finishSetup(id)).toThrow(expect.objectContaining({ code: 'setup' }));
    host.close();
  });
});
