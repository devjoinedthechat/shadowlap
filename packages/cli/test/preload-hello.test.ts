import { execFile, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { missingPreload, Sidecar, SIDECAR_VERSION, sdkMismatch, shownCause } from '@shadowlap/sidecar';
import { message, startMockAnthropic, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { runDoctor } from '../src/doctor.js';
import { guardEnv } from '../src/index.js';
import { pythonWith } from './python-with.js';

/**
 * Every Node and Python process of an agent says its preload loaded (`POST /v1/hello`), and a run
 * that made model or tool calls with no hello from any process is one the network guard never
 * watched: its summary says so and why, naming Bun or Deno when the command shows them, `--guard
 * block` fails it, the run keeps the counts for its page, and `shadowlap doctor` explains it. The
 * SDKs name their version on every call (`x-shadowlap-sdk`), and one of another major.minor than
 * the CLI's is named once per run.
 */

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const PYTHON = pythonWith();

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sl-hello-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

describe('the preloads, as the sidecar counts them', () => {
  let store: Store;
  let sidecar: Sidecar;
  beforeEach(async () => {
    store = Store.open(':memory:');
    sidecar = await Sidecar.start({ store });
  });
  afterEach(async () => {
    await sidecar.close();
    store.close();
  });

  const post = (runId: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${sidecar.url}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shadowlap-run': runId, ...headers }, body: JSON.stringify(body) });
  const hello = (runId: string, runtime: string, pid: number) => post(runId, 'v1/hello', { runtime, runtimeVersion: '1.0.0', pid, ppid: 1, guard: 'warn', capture: true });
  /** A tool call the agent made, through the SDK's resolution API. */
  const tool = (runId: string, headers: Record<string, string> = {}) => post(runId, 'v1/calls/resolve', { kind: 'tool', name: 'lookup', effect: 'read', args: { id: 1 } }, headers);

  it('counts each process whose preload said it loaded once, by runtime, and keeps the count on the run', async () => {
    const r = sidecar.startRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: dir } });
    sidecar.expectPreloads(r.runId, 'warn');
    expect((await hello(r.runId, 'node', 101)).status).toBe(202);
    await hello(r.runId, 'node', 101);
    await hello(r.runId, 'python', 102);
    await tool(r.runId);
    const ended = sidecar.endRun(r.runId, 'completed');
    expect(ended.preloads).toEqual({ guard: 'warn', hellos: { node: 1, python: 1 }, missing: null, failed: false });
    expect(ended.summary.warnings.join('\n')).not.toContain('No Shadowlap preload');
    expect(store.getRun(r.runId)!.meta?.preloads).toEqual({ guard: 'warn', hellos: { node: 1, python: 1 } });
  });

  it('says so of a run that made calls with no hello, and fails it under --guard block', async () => {
    const warned = sidecar.startRun({ mode: 'record', command: { argv: ['go', 'run', '.'], cwd: dir } });
    sidecar.expectPreloads(warned.runId, 'warn');
    await tool(warned.runId);
    const w = sidecar.endRun(warned.runId, 'completed');
    expect(w.preloads).toMatchObject({ hellos: {}, failed: false });
    expect(w.preloads!.missing).toContain('No Shadowlap preload loaded in the agent');
    expect(w.preloads!.missing).toContain('made 1 tool call');
    expect(w.summary.warnings).toContain(w.preloads!.missing);
    expect(w.run.status).toBe('completed');
    expect(store.getRun(warned.runId)!.meta?.preloads?.missing).toBe(w.preloads!.missing);

    const blocked = sidecar.startRun({ mode: 'record', command: { argv: ['go', 'run', '.'], cwd: dir } });
    sidecar.expectPreloads(blocked.runId, 'block');
    await tool(blocked.runId);
    const b = sidecar.endRun(blocked.runId, 'completed');
    expect(b.preloads).toMatchObject({ guard: 'block', failed: true });
    expect(b.preloads!.missing).toContain('under --guard block nothing stopped a connection that bypassed Shadowlap, so the run fails');
    expect(b.run.status).toBe('failed');
    expect(store.getRun(blocked.runId)!.status).toBe('failed');
  });

  it('expects no hello with the guard off, from a run that made no call, or from a run the CLI started no agent for', async () => {
    const off = sidecar.startRun({ mode: 'record', command: { argv: ['go'], cwd: dir } });
    sidecar.expectPreloads(off.runId, 'off');
    await tool(off.runId);
    expect(sidecar.endRun(off.runId, 'completed').preloads).toMatchObject({ guard: 'off', missing: null, failed: false });

    const quiet = sidecar.startRun({ mode: 'record', command: { argv: ['go'], cwd: dir } });
    sidecar.expectPreloads(quiet.runId, 'block');
    expect(sidecar.endRun(quiet.runId, 'completed').preloads).toMatchObject({ missing: null, failed: false });

    // A test runner's plugin records through the API: nothing said its agent got a preload.
    const hosted = sidecar.startRun({ mode: 'record', command: { argv: [], cwd: dir } });
    await tool(hosted.runId);
    const h = sidecar.endRun(hosted.runId, 'completed');
    expect(h.preloads).toBeNull();
    expect(store.getRun(hosted.runId)!.meta?.preloads).toBeUndefined();
  });

  it('names an SDK of another major.minor once per run, and none of the same version', async () => {
    const r = sidecar.startRun({ mode: 'record', command: { argv: ['python', 'agent.py'], cwd: dir } });
    await tool(r.runId, { 'x-shadowlap-sdk': 'python/9.9.0' });
    await tool(r.runId, { 'x-shadowlap-sdk': 'python/9.9.1' });
    await tool(r.runId, { 'x-shadowlap-sdk': `node/${SIDECAR_VERSION}` });
    await post(r.runId, 'v1/hello', { runtime: 'node', pid: 7 }, { 'x-shadowlap-sdk': 'node/9.8.0' });
    const warnings = sidecar.endRun(r.runId, 'completed').summary.warnings.filter((w) => w.includes('SDK is'));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toBe(sdkMismatch('python/9.9.0'));
    expect(warnings[0]).toContain(`pip install 'shadowlap==${SIDECAR_VERSION.split('.').slice(0, 2).join('.')}.*'`);
    expect(warnings[1]).toContain('Node SDK is 9.8.0');
    expect(sdkMismatch(`python/${SIDECAR_VERSION}`)).toBeNull();
    expect(sdkMismatch('not a version')).toBeNull();
  });

  it('turns away a hello for a run that has ended, which a preload never waits on', async () => {
    const r = sidecar.startRun({ mode: 'record', command: { argv: ['node'], cwd: dir } });
    sidecar.endRun(r.runId, 'completed');
    expect((await hello(r.runId, 'node', 5)).status).toBe(409);
  });
});

describe('why no preload loaded, as far as the command shows it', () => {
  it('names Bun and Deno, Python told to skip it, launchers that reset the environment, and opentelemetry-instrument', () => {
    expect(shownCause(['bun', 'agent.ts'])).toBe('The command runs Bun, which loads no Node preload');
    expect(shownCause(['/usr/local/bin/bunx', 'tsx', 'agent.ts'])).toContain('Bun');
    expect(shownCause(['sh', '-c', 'bun run agent.ts'])).toContain('Bun');
    expect(shownCause(['deno', 'run', '-A', 'agent.ts'])).toContain('Deno');
    expect(shownCause(['python3', '-I', 'agent.py'])).toContain('-I');
    expect(shownCause(['python', '-Es', 'agent.py'])).toContain('-E');
    expect(shownCause(['uv', 'run', 'python3.12', '-S', 'agent.py'])).toContain('-S');
    expect(shownCause(['python', '-c', 'import x', '-I'])).toBeNull();
    expect(shownCause(['opentelemetry-instrument', 'python', 'agent.py'])).toContain('opentelemetry-instrument');
    expect(shownCause(['env', '-i', 'PATH=/bin', 'node', 'agent.js'])).toContain('env -i');
    expect(shownCause(['sudo', 'node', 'agent.js'])).toContain('sudo');
    expect(shownCause(['docker', 'exec', 'box', 'python', 'agent.py'])).toContain('container');
    expect(shownCause(['node', 'agent.js'])).toBeNull();
  });

  it('gives the likely causes when the command shows none, and says how to go on under block', () => {
    const warned = missingPreload(['./agent'], { api: 3, tool: 0 }, 'warn');
    expect(warned).toContain('made 3 model calls');
    expect(warned).toContain('Go, Rust, Java, Bun, Deno');
    expect(warned).toContain('shadowlap doctor');
    const blocked = missingPreload(['bun', 'agent.ts'], { api: 1, tool: 2 }, 'block');
    expect(blocked).toContain('made 1 model call and 2 tool calls');
    expect(blocked).toContain('The command runs Bun');
    expect(blocked).toContain('--guard warn');
  });
});

describe('the preloads say they loaded, from real processes', () => {
  let server: Server;
  let base: string;
  const hellos: Array<{ path: string; run: string | undefined; body: Record<string, unknown> }> = [];
  beforeAll(async () => {
    // A stand-in for the sidecar that keeps what each hello said.
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        if (req.url?.endsWith('/v1/hello')) hellos.push({ path: req.url, run: req.headers['x-shadowlap-run'] as string | undefined, body: JSON.parse(body) as Record<string, unknown> });
        res.writeHead(202).end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/t/token`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const env = (mode: 'warn' | 'block' | 'off', run: string) => ({ ...process.env, ...guardEnv(mode, process.env), SHADOWLAP_URL: base, SHADOWLAP_RUN_ID: run });

  it('from Node, once per process even with a worker thread, saying what it set up, from a process that ends at once', async () => {
    writeFileSync(join(dir, 'worker.mjs'), 'export {};');
    writeFileSync(join(dir, 'with-worker.mjs'), `import { Worker } from 'node:worker_threads'; await new Promise((r) => new Worker(${JSON.stringify(join(dir, 'worker.mjs'))}).on('exit', r));`);
    await run(process.execPath, [join(dir, 'with-worker.mjs')], { env: env('block', 'R-node') });
    await run(process.execPath, ['-e', ''], { env: env('off', 'R-node-off') });
    const mine = hellos.filter((h) => h.run === 'R-node');
    expect(new Set(mine.map((h) => h.body.pid)).size).toBe(1);
    expect(mine[0]).toMatchObject({ path: '/t/token/v1/hello', body: { runtime: 'node', runtimeVersion: process.versions.node, guard: 'block', capture: true } });
    expect(hellos.find((h) => h.run === 'R-node-off')?.body).toMatchObject({ runtime: 'node', guard: 'off' });
  });

  it.skipIf(!PYTHON)('from Python, once per process, and not from python -I, which skips it', async () => {
    await run(PYTHON![0]!, [...PYTHON!.slice(1), '-c', 'pass'], { env: env('warn', 'R-py') });
    await run(PYTHON![0]!, [...PYTHON!.slice(1), '-I', '-c', 'pass'], { env: env('warn', 'R-py-isolated') });
    expect(hellos.filter((h) => h.run === 'R-py').map((h) => h.body)).toEqual([expect.objectContaining({ runtime: 'python', guard: 'warn', capture: true })]);
    expect(hellos.filter((h) => h.run === 'R-py-isolated')).toEqual([]);
  });
});

// A command named bun stands in for Bun, which loads no Node preload; curl makes its model call.
describe.skipIf(process.platform === 'win32')('a run whose agent loads no preload, end to end', () => {
  let mock: MockServer;
  beforeAll(async () => {
    mock = await startMockAnthropic({ script: () => ({ message: message([{ type: 'text', text: 'hi' }]) }) });
  });
  afterAll(() => mock.close());

  function shadowlap(args: string[], cwd: string): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, '--db', join(cwd, 'store.db'), ...args], { cwd, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_HOME: join(cwd, 'home') }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      child.on('exit', (code) => resolve({ code, out }));
    });
  }

  /** A project in `name` with a command named bun that makes one model call, and the path to that command. */
  function bunProject(name: string): { cwd: string; bun: string } {
    const cwd = join(dir, name);
    mkdirSync(join(cwd, 'bin'), { recursive: true });
    const bun = join(cwd, 'bin', 'bun');
    writeFileSync(
      bun,
      `#!/bin/sh
curl -s -X POST "$ANTHROPIC_BASE_URL/v1/messages" -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' -H 'x-api-key: sk-test' -d '{"model":"claude-sonnet-5","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}' > /dev/null
echo answered
`,
    );
    chmodSync(bun, 0o755);
    return { cwd, bun };
  }

  it('says so, naming Bun, and shadowlap test fails its golden under --guard block and passes it under warn', async () => {
    const { cwd, bun } = bunProject('bun-project');
    const recorded = await shadowlap(['run', '--', bun, 'agent.ts'], cwd);
    expect(recorded.code, recorded.out).toBe(0);
    expect(recorded.out).toContain('No Shadowlap preload loaded in the agent');
    expect(recorded.out).toContain('The command runs Bun, which loads no Node preload');
    const runId = /recording run (\w{26})/.exec(recorded.out)![1]!;
    expect((await shadowlap(['pack', runId, 'goldens/bun'], cwd)).code).toBe(0);

    const blocked = await shadowlap(['test', 'goldens/bun'], cwd);
    expect(blocked.code, blocked.out).toBe(1);
    expect(blocked.out).toContain('under --guard block nothing stopped a connection that bypassed Shadowlap, so the run fails');
    const warned = await shadowlap(['test', 'goldens/bun', '--guard', 'warn'], cwd);
    expect(warned.code, warned.out).toBe(0);

    // shadowlap doctor explains it, from the store.
    const checks = runDoctor({ cwd, env: {}, version: '0.0.0', dbPath: join(cwd, 'store.db'), python: () => 'Python 3.12.1' });
    const preload = checks.find((c) => c.name === 'preload');
    expect(preload, JSON.stringify(checks)).toMatchObject({ verdict: 'warn' });
    expect(preload!.detail).toContain('The command runs Bun');
    expect(preload!.fix).toContain('NODE_OPTIONS');
  });

  it("ends a replay under --guard block with status 1 though the agent exited 0, as every attempt of --repeat, and with the agent's status under warn", async () => {
    const { cwd, bun } = bunProject('bun-replay');
    const recorded = await shadowlap(['run', '--', bun, 'agent.ts'], cwd);
    expect(recorded.code, recorded.out).toBe(0);
    const runId = /recording run (\w{26})/.exec(recorded.out)![1]!;
    const failsBecause = 'under --guard block nothing stopped a connection that bypassed Shadowlap, so the run fails';

    const blocked = await shadowlap(['replay', runId, '--guard', 'block'], cwd);
    expect(blocked.code, blocked.out).toBe(1);
    expect(blocked.out).toContain('answered');
    expect(blocked.out).toContain(failsBecause);
    const warned = await shadowlap(['replay', runId, '--guard', 'warn'], cwd);
    expect(warned.code, warned.out).toBe(0);
    expect(warned.out).not.toContain(failsBecause);

    // Every attempt fails for it, and the line that says why is printed once.
    const repeated = await shadowlap(['replay', runId, '--guard', 'block', '--repeat', '2'], cwd);
    expect(repeated.code, repeated.out).toBe(1);
    expect(repeated.out.split(failsBecause).length - 1, repeated.out).toBe(1);
    expect(repeated.out).toContain('2 of 2 exited 0');
    const repeatedWarned = await shadowlap(['replay', runId, '--repeat', '2'], cwd);
    expect(repeatedWarned.code, repeatedWarned.out).toBe(0);
  }, 60_000);
});
