import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockOpenAI, turn, type MockServer } from '@shadowlap-testing/mock-openai';
import { agentEnv, noProxyEnv } from '../src/run-agent.js';
import { pythonCommand } from '../../../testing/python-with.mjs';

/**
 * Behind a proxy (HTTP_PROXY set, as corporate networks set it), traffic to shadowlap's loopback
 * sidecar must never go through the proxy: a model call to the sidecar carries the API key, the
 * prompt and the session token in clear text, and the proxy can't reach the machine's loopback
 * anyway, so nothing would be recorded. A stand-in proxy logs whatever reaches it and answers 502.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const TS_SDK = new URL('../../sdk/dist/index.js', import.meta.url).href;
const PY_SDK = fileURLToPath(new URL('../../../sdks/python', import.meta.url));

const PYTHON = pythonCommand();

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
  // Something the agent connects to that shadowlap doesn't record: the guard reports it to the sidecar.
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

/**
 * How the input reaches the agent: through a pipe, as `printf … | shadowlap run` gives it, or on
 * Windows from a file, as `< answers.txt` gives it. Node and Python can't tell one pipe from another
 * there, so input through a pipe isn't recorded on Windows (user-input.test.ts), and a file's is.
 */
const INPUT_FROM_A_FILE = process.platform === 'win32';
let inputFiles = 0;

function run(argv: string[], input: string, env: Record<string, string>, dir = cwd): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    let stdin: 'pipe' | number = 'pipe';
    if (INPUT_FROM_A_FILE) {
      const file = join(cwd, `input-${++inputFiles}.txt`);
      writeFileSync(file, input);
      stdin = openSync(file, 'r');
    }
    const child = spawn(argv[0], argv.slice(1), {
      cwd: dir,
      env: { ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', PYTHONPATH: PY_SDK, SHADOWLAP_UPSTREAM_OPENAI: mock.url, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, NO_PROXY: 'corp.internal', no_proxy: '', ...env },
      stdio: [stdin, 'pipe', 'pipe'],
    });
    // The child has a copy of its own: this one would only keep Windows from deleting the file.
    if (typeof stdin === 'number') closeSync(stdin);
    let out = '';
    child.stdout!.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr!.on('data', (c: Buffer) => (out += c.toString()));
    child.on('exit', (code) => resolve({ code, out }));
    child.stdin?.end(input);
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

// A Node agent that sends its own traffic through a proxy in code, as corporate setups do:
// fetch through a dispatcher of its own (as setGlobalDispatcher(new ProxyAgent(...)) sets one,
// which ignores NO_PROXY) and http.request through a replaced http.globalAgent (as proxy packages
// do). Both stand-ins log what reached them and refuse it, as a proxy that can't reach the
// machine's loopback does. A wrapped tool, the clock, a readline answer and a connection the
// guard reports must still reach the sidecar.
const NODE_AGENT = (otherPort: number) => `
import http from 'node:http';
import net from 'node:net';
import readline from 'node:readline/promises';
import { now, tool } from ${JSON.stringify(TS_SDK)};

globalThis[Symbol.for('undici.globalDispatcher.1')] = {
  dispatch(opts, handler) {
    process.stderr.write('PROXIED fetch ' + opts.origin + opts.path + '\\n');
    queueMicrotask(() => handler.onError(new Error('proxy: cannot reach upstream')));
    return true;
  },
  close: async () => {},
  destroy: async () => {},
};
class ViaProxy extends http.Agent {
  addRequest(req, options) {
    process.stderr.write('PROXIED http ' + options.host + ':' + options.port + req.path + '\\n');
    process.nextTick(() => req.destroy(new Error('proxy: cannot reach upstream')));
  }
}
http.globalAgent = new ViaProxy();

const findCustomer = tool('find_customer', { effect: 'read' }, async ({ email }) => ({ id: 'cust-1', email }));
console.log('tool:', (await findCustomer({ email: 'jane@example.com' })).id);
// A declared HTTP host, called with http.request: captured, and sent to the sidecar.
const search = await new Promise((resolve, reject) => {
  const req = http.request(process.env.SEARCH_URL + '/search', { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => resolve(body));
  });
  req.on('error', reject);
  req.end(JSON.stringify({ query: 'refunds' }));
});
console.log('search:', search);
console.log('clock:', typeof (await now()));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log('you said:', await rl.question('you? '));
rl.close();
await new Promise((resolve) => net.connect(${otherPort}, '127.0.0.1').on('close', resolve).on('error', resolve));
await new Promise((resolve) => setTimeout(resolve, 200));
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
    expect(rec.out).toMatch(/outbound connection to 127\.0\.0\.1:\d+ bypasses shadowlap/);
    expect(rec.out).toMatch(/Recorded \w+: 3 calls \(1 api, 2 tool\)/);
    expect(proxied).toEqual([]);
  });

  it('records a Node agent whose fetch and http go through a proxy of its own, with nothing for the sidecar sent there', async () => {
    const search = createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end('{"hits":2}'));
    });
    await new Promise<void>((r) => search.listen(0, '127.0.0.1', () => r()));
    const dir = join(cwd, 'node');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify({ http: { [`127.0.0.1:${(search.address() as AddressInfo).port}`]: 'read' } }));
    writeFileSync(join(dir, 'agent.mjs'), NODE_AGENT((other.address() as AddressInfo).port));
    proxied.length = 0;
    const rec = await run([process.execPath, CLI, '--db', join(dir, 'store.db'), 'run', '--', process.execPath, 'agent.mjs'], 'refund it\n', { SEARCH_URL: `http://127.0.0.1:${(search.address() as AddressInfo).port}` }, dir).finally(
      () => new Promise<void>((r) => search.close(() => r())),
    );
    expect(rec.out).toContain('tool: cust-1');
    expect(rec.out).toContain('search: {"hits":2}');
    expect(rec.out).toContain('clock: number');
    expect(rec.out).toContain('you said: refund it');
    expect(rec.out).toMatch(/outbound connection to 127\.0\.0\.1:\d+ bypasses shadowlap/);
    expect(rec.out).toMatch(/Recorded \w+: 4 calls \(0 api, 3 tool, 1 clock\/random\)/);
    expect(rec.out).not.toContain('PROXIED');
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
