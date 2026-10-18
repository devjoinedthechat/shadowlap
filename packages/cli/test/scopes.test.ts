import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';

/**
 * Sub-agents that send the same request at the same time, recorded in one order and replayed in the
 * other. Without scopes they get each other's answers and the replay forks; with scope() it is clean.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./subagents-agent.mjs', import.meta.url));
const PROCESSES = fileURLToPath(new URL('./subagents-processes.mjs', import.meta.url));
const PY_PROCESSES = fileURLToPath(new URL('./subagents_processes.py', import.meta.url));

/** A Python with an HTTP library the capture covers (SHADOWLAP_PYTHON picks another interpreter). */
function python(): string | null {
  for (const cmd of [process.env.SHADOWLAP_PYTHON, 'python3', 'python'].filter((c): c is string => !!c)) {
    try {
      if (execFileSync(cmd, ['-c', 'import importlib.util as u; print(any(u.find_spec(m) for m in ("httpx", "requests", "urllib3")))'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'True') return cmd;
    } catch {
      // next
    }
  }
  return null;
}
const PYTHON = python();

let mock: MockServer;
let cwd: string;
beforeAll(async () => {
  mock = await startMockAnthropic({ script: (ctx) => ({ message: message([text(ctx.assistantTurns === 0 ? `plan ${ctx.requestNo}` : 'done')]) }) });
  cwd = mkdtempSync(join(tmpdir(), 'fp-scopes-'));
});
afterAll(async () => {
  await mock.close();
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', join(cwd, 'store.db'), ...args], { cwd, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

describe('scopes for branches that run at once', () => {
  it('without them, identical concurrent requests swap answers when the order changes', async () => {
    const recorded = await shadowlap(['run', '--', process.execPath, AGENT]);
    expect(recorded.code, recorded.out).toBe(0);
    const runId = /recording run (\w{26})/.exec(recorded.out)![1]!;
    const replay = await shadowlap(['replay', runId, '--strict'], { ORDER: 'reverse' });
    expect(replay.code).toBe(1);
    expect(replay.out).toMatch(/Diverged at call \d+ \(api POST \/v1\/messages\)/);
  });

  it('with scope(), each branch replays its own answers in any order, and every call carries its scope', async () => {
    const recorded = await shadowlap(['run', '--', process.execPath, AGENT], { USE_SCOPE: '1' });
    expect(recorded.code, recorded.out).toBe(0);
    const runId = /recording run (\w{26})/.exec(recorded.out)![1]!;
    const hits = mock.requests.length;
    const replay = await shadowlap(['replay', runId, '--strict'], { USE_SCOPE: '1', ORDER: 'reverse' });
    expect(replay.code, replay.out).toBe(0);
    expect(replay.out).toMatch(/Replay clean: 4\/4 calls replayed/);
    expect(mock.requests.length).toBe(hits);
    const out = JSON.parse(replay.out.split('\n').find((l) => l.startsWith('["'))!) as string[];
    expect(out).toEqual(JSON.parse(recorded.out.split('\n').find((l) => l.startsWith('["'))!));

    const store = Store.open(join(cwd, 'store.db'));
    const scopes = store.getCalls(runId).map((c) => c.meta.scope);
    store.close();
    expect(scopes.sort()).toEqual(['alpha', 'alpha', 'beta', 'beta']);
  });

  /** Recorded in one order and replayed in the other: clean, from the recording, with each model call's scope. */
  async function replaysEachBranch(argv: string[], env: NodeJS.ProcessEnv = {}) {
    const recorded = await shadowlap(['run', '--', ...argv], env);
    expect(recorded.code, recorded.out).toBe(0);
    const runId = /recording run (\w{26})/.exec(recorded.out)![1]!;
    const store = Store.open(join(cwd, 'store.db'));
    const scopes = store.getCalls(runId).filter((c) => c.kind === 'api').map((c) => c.meta.scope);
    store.close();
    expect(scopes.sort()).toEqual(['alpha', 'alpha', 'beta', 'beta']);
    const hits = mock.requests.length;
    const replay = await shadowlap(['replay', runId, '--strict'], { ...env, ORDER: 'reverse' });
    expect(replay.code, replay.out).toBe(0);
    expect(replay.out).toMatch(/Replay clean: \d+\/\d+ calls replayed/);
    expect(mock.requests.length).toBe(hits);
    const answers = (out: string) => JSON.parse(out.split('\n').find((l) => l.startsWith('["'))!) as string[];
    expect(answers(replay.out)).toEqual(answers(recorded.out));
  }

  it('with SHADOWLAP_SCOPE set on each sub-agent process, its model calls carry the scope too', async () => {
    await replaysEachBranch([process.execPath, PROCESSES]);
  });

  it.skipIf(!PYTHON)('with SHADOWLAP_SCOPE set on each Python sub-agent process, its model calls carry the scope too', async () => {
    await replaysEachBranch([PYTHON!, PY_PROCESSES]);
  });

  it('inside scope(), a model call made through http.request carries the scope', async () => {
    await replaysEachBranch([process.execPath, PROCESSES], { VIA: 'http-request' });
  });
});
