import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type RunRecord } from '@shadowlap/engine';
import { Sidecar } from '../src/index.js';

/** Drives the Python SDK's test agent as a real subprocess against an in-process sidecar. */

const SCRIPT = fileURLToPath(new URL('../../../sdks/python/tests/agent_script.py', import.meta.url));

function pythonAvailable(): string | null {
  for (const cmd of ['python3', 'python']) {
    try {
      const v = execFileSync(cmd, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      if (/Python 3\.(9|[1-9]\d)/.test(v)) return cmd;
    } catch {
      // try the next one
    }
  }
  return null;
}

const PYTHON = pythonAvailable();

interface Output {
  active: boolean;
  started_at: number;
  request_id: string;
  rand: number;
  search: { results: string[] };
  file: string;
  file_again: string;
  missing: string;
  page: { url: string; status: number };
  ctx: { topic: string; has_ctx: boolean };
  email: unknown;
  executed: string[];
}

describe.skipIf(!PYTHON)('Python SDK', () => {
  let store: Store;
  let sidecar: Sidecar;

  beforeAll(async () => {
    store = Store.open(':memory:');
    sidecar = await Sidecar.start({ store });
  });
  afterAll(async () => {
    await sidecar.close();
    store.close();
  });

  // Async on purpose: the sidecar serves from this event loop, so a blocking spawnSync would deadlock.
  async function runScript(run: RunRecord | null, extraEnv: Record<string, string> = {}): Promise<Output> {
    const env = { ...process.env, ...(run ? sidecar.envFor(run.runId) : {}), ...extraEnv };
    if (!run) delete env.SHADOWLAP_URL;
    const { stdout } = await promisify(execFile)(PYTHON!, [SCRIPT], { env, encoding: 'utf8' });
    return JSON.parse(stdout.trim().split('\n').pop()!) as Output;
  }

  let recording: RunRecord;
  let recorded: Output;

  it('is a passthrough without SHADOWLAP_URL', async () => {
    const out = await runScript(null);
    expect(out.active).toBe(false);
    expect(out.executed).toEqual(['search_web', 'read_file', 'read_file', 'read_file', 'fetch_async', 'with_context', 'send_email']);
  });

  it('records tool, clock and random calls with named arguments', async () => {
    recording = sidecar.startRun({ mode: 'record', command: { argv: ['python', 'agent_script.py'], cwd: '.' } });
    recorded = await runScript(recording);
    sidecar.endRun(recording.runId, 'completed');
    expect(recorded.active).toBe(true);
    expect(recorded.executed).toHaveLength(7);
    expect(recorded.missing).toMatch(/^FileNotFoundError/);
    expect(recorded.ctx).toEqual({ topic: 'replay', has_ctx: true });
    const calls = store.getCalls(recording.runId);
    expect(calls.map((c) => `${c.kind}:${c.name}`)).toEqual([
      'clock:now',
      'random:uuid',
      'random:random',
      'tool:search_web',
      'tool:read_file',
      'tool:read_file',
      'tool:read_file',
      'tool:fetch_async',
      'tool:with_context',
      'tool:send_email',
    ]);
    expect(store.getJson(calls[3]!.requestRef!)).toEqual({ args: { query: 'replay', limit: 3 } });
    expect(calls[4]!.occurrence).toBe(1);
    expect(calls[5]!.occurrence).toBe(2); // same args → second occurrence
    expect(calls[6]!.end?.outcome).toBe('error');
    expect(calls[6]!.end?.meta.error).toMatchObject({ name: 'FileNotFoundError' });
    expect(store.getJson(calls[8]!.requestRef!)).toEqual({ args: { topic: 'replay' } }); // ctx excluded
    expect(calls[9]!.effect).toBe('write');
    expect(calls.every((c) => c.kind !== 'tool' || typeof c.meta.implHash === 'string')).toBe(true);
  });

  it('replays without executing any tool, including the recorded error', async () => {
    const replay = sidecar.startRun({ mode: 'replay', parentRunId: recording.runId, command: { argv: [], cwd: '.' } });
    const out = await runScript(replay);
    const { summary } = sidecar.endRun(replay.runId, 'completed');
    expect(summary.divergence).toBeNull();
    expect(summary.byOrigin.replayed).toBe(10);
    expect(out.executed).toEqual([]);
    expect(out.ctx).toEqual(recorded.ctx);
    expect(out.started_at).toBe(recorded.started_at);
    expect(out.request_id).toBe(recorded.request_id);
    expect(out.rand).toBe(recorded.rand);
    expect(out.search).toEqual(recorded.search);
    expect(out.page).toEqual(recorded.page);
    expect(out.missing).toMatch(/^FileNotFoundError: no such file/);
    expect(out.email).toEqual(recorded.email);
  });

  it('forks on changed arguments and blocks the write', async () => {
    const fork = sidecar.startRun({ mode: 'replay', parentRunId: recording.runId, command: { argv: [], cwd: '.' } });
    const out = await runScript(fork, { VARIANT: 'changed' });
    const { summary } = sidecar.endRun(fork.runId, 'completed');
    expect(summary.divergence).toMatchObject({ type: 'request_changed', name: 'search_web', replayedBefore: 3 });
    expect(summary.divergence?.diff).toEqual([{ path: '$.args.limit', op: 'changed', before: 3, after: 2 }]);
    expect(out.executed).toEqual(['search_web', 'fetch_async', 'with_context']); // reads live; pure read_file replayed
    expect(out.email).toBe('blocked: send_email');
    expect(summary.byOrigin.blocked).toBe(1);
  });

  it('passes the SDK\'s own unit tests: context left out, clear errors, JSON results', async () => {
    const tests = fileURLToPath(new URL('../../../sdks/python/tests', import.meta.url));
    const { stdout, stderr } = await promisify(execFile)(PYTHON!, ['-m', 'unittest', 'discover', '-s', tests, '-p', 'test_*.py'], { encoding: 'utf8' });
    expect(`${stdout}${stderr}`).toMatch(/\nOK\s*$/);
  });

  it('fails tools as --fail-at asks, sync and async, without running them', async () => {
    const calls = store.getCalls(recording.runId);
    const search = calls.find((c) => c.name === 'search_web')!.callNo;
    const page = calls.find((c) => c.name === 'fetch_async')!.callNo;
    const fork = sidecar.startRun({ mode: 'replay', parentRunId: recording.runId, command: { argv: [], cwd: '.' }, replay: { toolFailures: new Map([[search, { kind: 'timeout' as const }], [page, { kind: 'status' as const, status: 503 }]]) } });
    const out = await runScript(fork);
    const { summary } = sidecar.endRun(fork.runId, 'completed');
    expect(out.search).toEqual({ failed: 'ShadowlapInjectedTimeout', message: 'search_web timed out', timeout: true });
    expect(out.page).toEqual({ failed: 'ShadowlapInjectedHTTPError', status: 503 });
    expect(out.executed).not.toContain('search_web');
    expect(out.executed).not.toContain('fetch_async');
    expect(summary.injected).toBe(2);
    expect(summary.divergence).toMatchObject({ type: 'forced', callNo: search });
  });

  it('stubs the write with on_fork under --writes stub', async () => {
    const fork = sidecar.startRun({ mode: 'replay', parentRunId: recording.runId, command: { argv: [], cwd: '.' }, replay: { writes: 'stub' } });
    const out = await runScript(fork, { VARIANT: 'changed' });
    sidecar.endRun(fork.runId, 'completed');
    expect(out.email).toEqual({ sent: false, suppressed: true, to: 'team@example.com' });
    expect(out.executed).not.toContain('send_email');
  });
});
