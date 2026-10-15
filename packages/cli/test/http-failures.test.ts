import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';

/**
 * `--fail-at <call>=timeout|error` on an HTTP host recorded as a tool: the agent's HTTP client raises
 * the error it raises for the real thing, so the agent's own handling of a timeout or a dropped
 * connection is what runs. Through the CLI, with the in-process capture of Node and Python.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const NODE_AGENT = fileURLToPath(new URL('./http-failure-agent.mjs', import.meta.url));
const PYTHON_AGENT = fileURLToPath(new URL('./http_failure_agent.py', import.meta.url));

/** The Python to run, and which of its HTTP libraries it has (SHADOWLAP_PYTHON picks another interpreter). */
function python(): { cmd: string; libraries: string[] } | null {
  for (const cmd of [process.env.SHADOWLAP_PYTHON, 'python3', 'python'].filter((c): c is string => !!c)) {
    try {
      const found = execFileSync(cmd, ['-c', 'import importlib.util as u; print(",".join(m for m in ("requests", "urllib3", "httpx") if u.find_spec(m)))'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return { cmd, libraries: found ? found.split(',') : [] };
    } catch {
      // the next one
    }
  }
  return null;
}
const PYTHON = python();

let server: Server;
let cwd: string;
let db: string;
let searchUrl: string;
let hits = 0;

function shadowlap(args: string[]): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], { cwd, env: { ...process.env, SEARCH_URL: searchUrl, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => ((out += d.toString()), (stdout += d.toString())));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out, stdout }));
  });
}
const report = (stdout: string) => JSON.parse(stdout.split('\n').filter((l) => l.startsWith('{')).pop()!) as Record<string, Record<string, unknown>>;

async function record(argv: string[]): Promise<{ runId: string; calls: number }> {
  const r = await shadowlap(['run', '--', ...argv]);
  expect(r.code, r.out).toBe(0);
  const runId = /recording run (\w{26})/.exec(r.out)![1]!;
  const store = Store.open(db);
  try {
    return { runId, calls: store.getCalls(runId).filter((c) => c.kind === 'tool').length };
  } finally {
    store.close();
  }
}
const failEvery = (calls: number, failure: string) => Array.from({ length: calls }, (_, i) => ['--fail-at', `${i + 1}=${failure}`]).flat();

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hits: ['Refunds above $200 need approval.'] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  searchUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cwd = mkdtempSync(join(tmpdir(), 'fp-http-fail-'));
  db = join(cwd, 'store.db');
  writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify({ http: { [new URL(searchUrl).host]: 'read' } }));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('an HTTP tool failed with --fail-at, from Node', () => {
  it('raises fetch\'s timeout and "fetch failed", and runs the agent\'s own request timeout', async () => {
    const { runId } = await record([process.execPath, NODE_AGENT]);
    const before = hits;
    const timeout = await shadowlap(['replay', runId, '--fail-at', '1=timeout', '--fail-at', '2=timeout']);
    expect(timeout.code, timeout.out).toBe(0);
    expect(report(timeout.stdout)).toEqual({
      // What fetch(url, { signal: AbortSignal.timeout(ms) }) rejects with.
      fetch: { error: 'TimeoutError', message: 'The operation was aborted due to timeout', cause: null, causeMessage: null },
      // The request's 'timeout' event fired, and the agent's handler raised its own error.
      request: { error: 'AGENT_TIMEOUT', message: 'the search took too long' },
    });
    const error = await shadowlap(['replay', runId, '--fail-at', '1=error', '--fail-at', '2=error:connection reset by peer']);
    expect(error.code, error.out).toBe(0);
    expect(report(error.stdout)).toEqual({
      fetch: { error: 'TypeError', message: 'fetch failed', cause: 'ECONNRESET', causeMessage: 'read ECONNRESET' },
      request: { error: 'ECONNRESET', message: 'connection reset by peer' },
    });
    // The tool never ran.
    expect(hits).toBe(before);
  });
});

describe.skipIf(!PYTHON?.libraries.length)('an HTTP tool failed with --fail-at, from Python', () => {
  it('raises the timeout and the connection error each library raises for the real thing', async () => {
    const libraries = PYTHON!.libraries;
    const { runId, calls } = await record([PYTHON!.cmd, PYTHON_AGENT]);
    expect(calls).toBe(libraries.length);
    const before = hits;
    const timeout = report((await shadowlap(['replay', runId, ...failEvery(calls, 'timeout')])).stdout);
    const error = report((await shadowlap(['replay', runId, ...failEvery(calls, 'error:connection reset by peer')])).stdout);
    const expected: Record<string, [string, string, RegExp]> = {
      requests: ['requests.exceptions.ReadTimeout', 'requests.exceptions.ConnectionError', /Connection aborted\..*connection reset by peer/],
      urllib3: ['urllib3.exceptions.ReadTimeoutError', 'urllib3.exceptions.ProtocolError', /Connection aborted\..*connection reset by peer/],
      httpx: ['httpx.ReadTimeout', 'httpx.ReadError', /^connection reset by peer$/],
    };
    for (const library of libraries) {
      const [timedOut, failed, message] = expected[library]!;
      expect(timeout[library], library).toMatchObject({ error: timedOut });
      expect(error[library], library).toMatchObject({ error: failed, message: expect.stringMatching(message) });
    }
    expect(hits).toBe(before);
  });
});
