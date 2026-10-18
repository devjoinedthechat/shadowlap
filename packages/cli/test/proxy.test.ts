import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockOpenAI, turn, type MockServer } from '@shadowlap-testing/mock-openai';
import { agentEnv, noProxyEnv } from '../src/run-agent.js';

/**
 * Behind a proxy (HTTP_PROXY set, as corporate networks set it), traffic to Shadowlap's loopback
 * sidecar must never go through the proxy: a model call to the sidecar carries the API key, the
 * prompt and the session token in clear text, and the proxy can't reach the machine's loopback
 * anyway, so nothing would be recorded. A stand-in proxy logs whatever reaches it and answers 502.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const PY_SDK = fileURLToPath(new URL('../../../sdks/python', import.meta.url));

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

let proxy: Server;
const proxied: string[] = [];
let other: TcpServer;
let mock: MockServer;
let cwd: string;

beforeAll(async () => {
  proxy = createServer((req, res) => {
    proxied.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
    req.resume();
    res.writeHead(502).end('proxy: cannot reach upstream');
  });
  proxy.on('connect', (req, socket) => {
    proxied.push(`CONNECT ${req.url}`);
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
  // Something the agent connects to that Shadowlap doesn't record: the guard reports it to the sidecar.
  other = createTcpServer((s) => s.end());
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r()));
  mock = await startMockOpenAI({ script: (ctx) => ({ turn: turn(`refund noted (${ctx.request.messages.length})`) }) });
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sl-proxy-')));
});
afterAll(async () => {
  await new Promise<void>((r) => proxy.close(() => r()));
  await new Promise<void>((r) => other.close(() => r()));
  await mock.close();
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function run(argv: string[], input: string, env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: { ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', PYTHONPATH: PY_SDK, SHADOWLAP_UPSTREAM_OPENAI: mock.url, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, NO_PROXY: 'corp.internal', no_proxy: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    child.on('exit', (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

// A model call as an SDK built on urllib makes it (urllib reads the proxy variables, as httpx and
// requests do), a wrapped tool, an input() and a connection the guard reports.
const AGENT = (otherPort: number) => `
import json, os, socket, urllib.request
import shadowlap

@shadowlap.tool(effect="read")
def find_customer(email):
    return {"id": "cust-1", "email": email}

print("tool:", find_customer("jane@example.com")["id"])
body = {"model": "gpt-5", "messages": [{"role": "user", "content": "PRIVATE PROMPT: refund order A-17"}]}
req = urllib.request.Request(os.environ["OPENAI_BASE_URL"].rstrip("/") + "/chat/completions", data=json.dumps(body).encode(), headers={"authorization": "Bearer sk-proj-CONFIRM-SECRET", "content-type": "application/json"})
print("model:", json.load(urllib.request.urlopen(req))["choices"][0]["message"]["content"])
print("you said:", input("you? "))
socket.create_connection(("127.0.0.1", ${otherPort})).close()
`;

describe('behind a proxy', () => {
  it('keeps the existing NO_PROXY entries and adds the loopback addresses, in both spellings', () => {
    expect(noProxyEnv({ NO_PROXY: 'corp.internal, .example.com', no_proxy: 'localhost' })).toEqual({ NO_PROXY: 'corp.internal,.example.com,localhost,127.0.0.1,::1', no_proxy: 'corp.internal,.example.com,localhost,127.0.0.1,::1' });
    expect(noProxyEnv({})).toEqual({ NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' });
    const saved = process.env.NO_PROXY;
    process.env.NO_PROXY = 'corp.internal';
    try {
      const env = agentEnv({ envFor: () => ({ SHADOWLAP_URL: 'http://127.0.0.1:1/t/x' }), httpRules: [] } as never, 'r1', 'warn', {});
      expect(env.NO_PROXY).toBe('corp.internal,127.0.0.1,localhost,::1');
      expect(env.no_proxy).toBe(env.NO_PROXY);
    } finally {
      if (saved === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = saved;
    }
  });

  it.skipIf(!PYTHON)('records a Python agent with nothing sent to the proxy: model calls, tools, input and the guard', async () => {
    writeFileSync(join(cwd, 'agent.py'), AGENT((other.address() as AddressInfo).port));
    proxied.length = 0;
    const rec = await run([process.execPath, CLI, '--db', join(cwd, 'store.db'), 'run', '--', PYTHON!, 'agent.py'], 'refund it\n', {});
    expect(rec.out).toContain('tool: cust-1');
    expect(rec.out).toContain('model: refund noted (1)');
    expect(rec.out).toContain('you said: refund it');
    expect(rec.out).toMatch(/outbound connection to 127\.0\.0\.1:\d+ bypasses Shadowlap/);
    expect(rec.out).toMatch(/Recorded \w+: 3 calls \(1 api, 2 tool\)/);
    expect(proxied).toEqual([]);
  });

  it.skipIf(!PYTHON)('records a test with shadowlap.testing with nothing sent to the proxy', async () => {
    writeFileSync(
      join(cwd, 'test_refund.py'),
      `
import json, os, urllib.request
from shadowlap.testing import recording

with recording("__recordings__/refund") as rec:
    body = {"model": "gpt-5", "messages": [{"role": "user", "content": "PRIVATE PROMPT"}]}
    req = urllib.request.Request(os.environ["OPENAI_BASE_URL"].rstrip("/") + "/chat/completions", data=json.dumps(body).encode(), headers={"authorization": "Bearer sk-proj-CONFIRM-SECRET", "content-type": "application/json"})
    print("model:", json.load(urllib.request.urlopen(req))["choices"][0]["message"]["content"])
    print("calls:", len(rec.calls()))
`,
    );
    proxied.length = 0;
    const r = await run([PYTHON!, 'test_refund.py'], '', { SHADOWLAP_CLI: CLI, SHADOWLAP_RECORD: 'all' });
    expect(r.out).toContain('model: refund noted (1)');
    expect(r.out).toContain('calls: 1');
    expect(proxied).toEqual([]);
  });
});
