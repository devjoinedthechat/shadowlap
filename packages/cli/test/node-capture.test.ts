import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttp2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { message, startMockAnthropic, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { removeTempProject, tempProject } from '../../../testing/temp-project.mjs';
import { agentEnv, guardEnv } from '../src/run-agent.js';

/**
 * In-process capture in Node, in real agent processes: fetch goes to the sidecar on a connection of
 * its own, so a global undici dispatcher (a proxy) sees neither a captured call nor one a base URL
 * points at the sidecar, and the agent still gets what fetch gives (a streamed body, a decoded one,
 * redirects, aborts, its errors). The OpenAI SDK's Azure client takes its endpoint while the agent's
 * own code still reads the sidecar's OPENAI_BASE_URL, and a WebSocket for the sidecar opens as ws://.
 */

const run = promisify(execFile);
let dir: string;
/** Where agents are written: below a link to this repository's packages, so they import the monorepo's `openai` and `ws`. */
let agents: string;
let store: Store;
let mock: MockServer;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sl-capture-'));
  agents = tempProject('sl-capture-agents-');
  store = Store.open(':memory:');
  mock = await startMockAnthropic({ script: () => ({ message: message([{ type: 'text', text: 'hi there' }]) }), eventDelayMs: () => 0 });
});
afterAll(async () => {
  await mock.close();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  removeTempProject(agents);
});

/** Writes an agent where it resolves the monorepo's packages and runs it with `env`. */
async function agent(name: string, source: string, env: NodeJS.ProcessEnv) {
  const file = join(agents, `${name}.mjs`);
  writeFileSync(file, source);
  try {
    return await run(process.execPath, [file], { env, cwd: dir });
  } finally {
    rmSync(file, { force: true });
  }
}

/** A global dispatcher that stands for a proxy which can't reach this machine's loopback: it says what reached it and fails it. */
const PROXY_DISPATCHER = `
globalThis[Symbol.for('undici.globalDispatcher.1')] = {
  dispatch(opts, handler) {
    process.stderr.write('PROXIED ' + opts.origin + opts.path + '\\n');
    queueMicrotask(() => handler.onError(new Error('proxy: cannot reach upstream')));
    return true;
  },
  close: async () => {},
  destroy: async () => {},
};
`;

describe('fetch, captured, with a proxy of its own set as the global dispatcher', () => {
  it('records captured calls and calls a base URL points at the sidecar, with nothing sent to the proxy', async () => {
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
    try {
      const r = sidecar.startRun({ mode: 'record', command: { argv: ['node'], cwd: dir } });
      const env = { ...agentEnv(sidecar, r.runId, 'warn', { anthropic: mock.url }), MOCK: mock.url };
      const { stdout, stderr } = await agent(
        'dispatcher',
        `${PROXY_DISPATCHER}
const body = (stream) => JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, stream, messages: [{ role: 'user', content: 'hello' }] });
const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-test' };
// Captured: the host is the provider's upstream, which a client may hardcode.
const captured = await fetch(process.env.MOCK + '/v1/messages', { method: 'POST', headers, body: body(false) });
console.log('captured', captured.status, (await captured.json()).content[0].text, captured.url === process.env.MOCK + '/v1/messages');
// Pointed at the sidecar by its base URL, as the SDKs are.
const based = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers, body: body(false) });
console.log('based', based.status, (await based.json()).content[0].text);
// Streamed, read as it comes.
const streamed = await fetch(new Request(process.env.MOCK + '/v1/messages', { method: 'POST', headers, body: body(true) }));
let events = '';
for await (const chunk of streamed.body) events += Buffer.from(chunk).toString();
console.log('streamed', streamed.headers.get('content-type'), events.includes('message_stop'));
`,
        env,
      );
      expect(stderr).not.toContain('PROXIED');
      expect(stdout).toContain('captured 200 hi there true');
      expect(stdout).toContain('based 200 hi there');
      expect(stdout).toMatch(/streamed text\/event-stream(; charset=utf-8)? true/);
      const calls = store.getCalls(r.runId).filter((c) => c.kind === 'api');
      expect(calls.map((c) => c.name)).toEqual(['POST /v1/messages', 'POST /v1/messages', 'POST /v1/messages']);
      sidecar.endRun(r.runId, 'completed');
    } finally {
      await sidecar.close();
    }
  });
});

describe("the preload's own requests", () => {
  it("leave the agent's connections alone: a model call slower than a second is still waited for", async () => {
    // The hello and the guard's reports go on agents of their own; on the sidecar's pooled
    // connection they would let go of a socket the agent's call had taken over, and the agent
    // would end mid-call with nothing left to keep it running (exit 13).
    const slow = await startMockAnthropic({ script: () => ({ message: message([{ type: 'text', text: 'slow answer' }]), delayMs: 1_800 }), eventDelayMs: () => 0 });
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: slow.url } });
    try {
      const r = sidecar.startRun({ mode: 'record', command: { argv: ['node'], cwd: dir } });
      const env = agentEnv(sidecar, r.runId, 'warn', { anthropic: slow.url });
      const { stdout } = await agent(
        'slow',
        `
// Once the hello has its answer, its socket would be the only one in a pool shared with the
// agent's calls, and the slow call would take it.
await new Promise((resolve) => setTimeout(resolve, 300));
const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-test' }, body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] }) });
console.log('answer', (await res.json()).content[0].text);
`,
        env,
      );
      expect(stdout).toContain('answer slow answer');
      sidecar.endRun(r.runId, 'completed');
    } finally {
      await sidecar.close();
      await slow.close();
    }
  });
});

describe('fetch, captured, answered as fetch answers', () => {
  let fake: Server;
  let base: string;
  const seen: string[] = [];
  /** Where a redirect off the origin lands, and the headers each request there brought. */
  let away: Server;
  let awayUrl: string;
  const landed: Array<Record<string, string | string[] | undefined>> = [];
  /** The credentials the fake sidecar saw on a redirect that stayed on its origin. */
  const sameOrigin: Array<string | undefined> = [];
  beforeAll(async () => {
    away = createServer((req: IncomingMessage, res: ServerResponse) => {
      landed.push(req.headers);
      req.resume();
      res.writeHead(200, { 'content-type': 'text/plain' }).end('landed');
    });
    await new Promise<void>((r) => away.listen(0, '127.0.0.1', () => r()));
    awayUrl = `http://127.0.0.1:${(away.address() as AddressInfo).port}/landing`;
    // Stands in for the sidecar: the answers fetch must make of a gzip body, a redirect, a slow body and a reset.
    fake = createServer((req: IncomingMessage, res: ServerResponse) => {
      seen.push(`${req.method} ${req.url} ${String(req.headers['x-shadowlap-upstream'] ?? '')} ${req.headers['accept-encoding'] ?? ''} ${req.headers['user-agent'] ?? ''}`);
      req.resume();
      const path = req.url!.replace(/^\/t\/token\/r\/R1\/anthropic/, '');
      if (path === '/v1/gzip') res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }).end(gzipSync('{"ok":"unzipped"}'));
      else if (path === '/v1/moved') res.writeHead(307, { location: '/v1/here' }).end();
      else if (path === '/v1/here') res.writeHead(200, { 'content-type': 'text/plain' }).end('arrived');
      else if (path === '/v1/away') res.writeHead(302, { location: awayUrl }).end();
      else if (path === '/v1/stay') res.writeHead(307, { location: '/v1/stayed' }).end();
      else if (path === '/v1/loop') res.writeHead(302, { location: '/v1/loop' }).end();
      else if (path === '/v1/stayed') {
        sameOrigin.push(`${String(req.headers.authorization)} ${String(req.headers.cookie)}`);
        res.writeHead(200, { 'content-type': 'text/plain' }).end('stayed');
      }
      else if (path === '/v1/slow') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('first ');
      } else if (path === '/v1/reset') req.socket.destroy();
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/t/token`;
  });
  afterAll(async () => {
    fake.closeAllConnections();
    away.closeAllConnections();
    await new Promise<void>((r) => away.close(() => r()));
    return new Promise<void>((r) => fake.close(() => r()));
  });

  it('decodes a gzip body, follows a redirect on the host it was going to, aborts a body, and fails on a reset as fetch does', async () => {
    const env = { ...process.env, ...guardEnv('off', {}, { anthropic: 'http://models.internal:8080' }), SHADOWLAP_URL: base, SHADOWLAP_RUN_ID: 'R1' };
    const { stdout } = await agent(
      'answers',
      `
const host = 'http://models.internal:8080';
const gz = await fetch(host + '/v1/gzip');
console.log('gzip', JSON.stringify(await gz.json()), gz.headers.get('content-encoding'));
const moved = await fetch(host + '/v1/moved', { method: 'POST', body: 'again' });
console.log('redirect', moved.status, moved.redirected, moved.url, await moved.text());
const controller = new AbortController();
const slow = await fetch(host + '/v1/slow', { signal: controller.signal });
const reader = slow.body.getReader();
console.log('first', Buffer.from((await reader.read()).value).toString());
controller.abort();
try { await reader.read(); console.log('aborted no'); } catch (e) { console.log('aborted', e.name); }
try { await fetch(host + '/v1/reset'); } catch (e) { console.log('reset', e.name, e.message, e.cause?.code); }
`,
      env,
    );
    expect(stdout).toContain('gzip {"ok":"unzipped"} gzip');
    expect(stdout).toContain('redirect 200 true http://models.internal:8080/v1/here arrived');
    expect(stdout).toContain('first first ');
    expect(stdout).toContain('aborted AbortError');
    expect(stdout).toContain('reset TypeError fetch failed');
    // The redirect went where the agent's request would have, on the host it named, again through the sidecar.
    expect(seen).toContainEqual(expect.stringMatching(/^GET \/t\/token\/r\/R1\/anthropic\/v1\/gzip http:\/\/models\.internal:8080 gzip, deflate node$/));
    expect(seen).toContainEqual(expect.stringMatching(/^POST \/t\/token\/r\/R1\/anthropic\/v1\/here http:\/\/models\.internal:8080 /));
  });

  it('follows a redirect off the origin without the authorization, cookie and proxy-authorization the request carried, as fetch does, and keeps them on the same origin', async () => {
    const env = { ...process.env, ...guardEnv('off', {}, { anthropic: 'http://models.internal:8080' }), SHADOWLAP_URL: base, SHADOWLAP_RUN_ID: 'R1' };
    const { stdout } = await agent(
      'cross-origin',
      `
const host = 'http://models.internal:8080';
const secret = { authorization: 'Bearer SECRET-AUTH', cookie: 'session=SECRET-COOKIE', 'proxy-authorization': 'Basic SECRET-PROXY', 'x-trace': 'kept' };
const away = await fetch(host + '/v1/away', { headers: secret });
console.log('away', away.status, away.redirected, await away.text());
const stay = await fetch(host + '/v1/stay', { headers: secret });
console.log('stay', stay.status, await stay.text());
try { await fetch(host + '/v1/loop'); console.log('loop ended no'); } catch (e) { console.log('loop', e.name, e.cause?.message); }
`,
      env,
    );
    expect(stdout).toContain('away 200 true landed');
    expect(stdout).toContain('stay 200 stayed');
    expect(landed).toHaveLength(1);
    expect(landed[0]).toMatchObject({ 'x-trace': 'kept' });
    for (const name of ['authorization', 'cookie', 'proxy-authorization']) expect(landed[0], name).not.toHaveProperty(name);
    expect(JSON.stringify(landed)).not.toContain('SECRET');
    // On the origin it was sent to, the request keeps what it carried.
    expect(sameOrigin).toEqual(['Bearer SECRET-AUTH session=SECRET-COOKIE']);
    // A loop of redirects ends where fetch ends it: the twentieth is the last it follows.
    expect(stdout).toContain('loop TypeError redirect count exceeded');
    expect(seen.filter((l) => l.startsWith('GET /t/token/r/R1/anthropic/v1/loop '))).toHaveLength(21);
  });
});

describe("the OpenAI SDK's Azure client, with OPENAI_BASE_URL pointed at the sidecar", () => {
  it("takes its endpoint and a plain client its default host, each captured by the host it calls, while the agent's own code still reads the sidecar", async () => {
    let provider: Server | null = null;
    const asked: string[] = [];
    provider = createServer((req, res) => {
      asked.push(`${req.method} ${req.url} ${String(req.headers['api-key'] ?? req.headers.authorization ?? '')}`);
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'c1', object: 'chat.completion', created: 1, model: 'gpt', choices: [{ index: 0, message: { role: 'assistant', content: 'answered' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
    await new Promise<void>((r) => provider.listen(0, '127.0.0.1', () => r()));
    const upstream = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    const sidecar = await Sidecar.start({ store, upstreams: { azure: upstream, openai: upstream } });
    const saved = process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    try {
      const r = sidecar.startRun({ mode: 'record', command: { argv: ['node'], cwd: dir } });
      const env = agentEnv(sidecar, r.runId, 'warn', { azure: upstream, openai: upstream });
      expect(env.OPENAI_BASE_URL).toContain(sidecar.url);
      const { stdout } = await agent(
        'azure',
        `
import { AzureOpenAI, OpenAI } from 'openai';
import { execFileSync } from 'node:child_process';
// The agent's own code reads the sidecar, so a fallback of its own never runs.
console.log('own', String(process.env.OPENAI_BASE_URL).includes('/openai/v1'));
const azure = new AzureOpenAI({ endpoint: 'https://shadowlap-test.openai.azure.com', apiKey: 'az-key', apiVersion: '2024-10-21', deployment: 'gpt-prod', maxRetries: 0 });
const a = await azure.chat.completions.create({ model: 'gpt-prod', messages: [{ role: 'user', content: 'hi' }] });
console.log('azure', a.choices[0].message.content);
const plain = await new OpenAI({ apiKey: 'sk-plain', maxRetries: 0 }).chat.completions.create({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] });
console.log('openai', plain.choices[0].message.content);
console.log('children', execFileSync('sh', ['-c', 'echo "$OPENAI_BASE_URL"']).toString().includes('/openai/v1'));
`,
        env,
      );
      expect(stdout).toContain('own true');
      expect(stdout).toContain('azure answered');
      expect(stdout).toContain('openai answered');
      expect(stdout).toContain('children true');
      // Each went to the sidecar as the host it called says: azure, and openai.
      const calls = store.getCalls(r.runId).filter((c) => c.kind === 'api');
      expect(calls.map((c) => c.meta.provider)).toEqual(['azure', 'openai']);
      expect(asked[0]).toMatch(/^POST \/openai\/deployments\/gpt-prod\/chat\/completions\?api-version=2024-10-21 az-key$/);
      sidecar.endRun(r.runId, 'completed');

      // A process that can't load the openai package keeps process.env as it is.
      const away = join(dir, 'no-openai.mjs');
      writeFileSync(away, "import { types } from 'node:util'; console.log('proxy', types.isProxy(process.env), String(process.env.OPENAI_BASE_URL).includes('/openai/v1'));");
      const { stdout: plainEnv } = await run(process.execPath, [away], { env, cwd: dir });
      expect(plainEnv).toContain('proxy false true');
    } finally {
      if (saved !== undefined) process.env.OPENAI_BASE_URL = saved;
      await sidecar.close();
      await new Promise<void>((res) => provider.close(() => res()));
    }
  });
});

/** A server that completes each WebSocket handshake it is offered, then closes the connection, keeping each one's URL and x-shadowlap-upstream. */
async function handshakes(): Promise<{ origin: string; upgrades: Array<{ url: string; upstream: string | undefined }>; close(): Promise<void> }> {
  const upgrades: Array<{ url: string; upstream: string | undefined }> = [];
  const sockets = new Set<Duplex>();
  const server = createServer();
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    sockets.add(socket);
    upgrades.push({ url: req.url!, upstream: req.headers['x-shadowlap-upstream'] as string | undefined });
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    const protocol = String(req.headers['sec-websocket-protocol'] ?? '').split(',')[0].trim();
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []), '', ''].join('\r\n'));
    socket.end(Buffer.from([0x88, 0x00]));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    upgrades,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** An agent's source that opens `opens` ([label, expression] pairs) one after another, printing how each went. */
const opening = (imports: string, opens: Array<[string, string]>) => `
${imports}
const opened = (socket, label) => new Promise((resolve) => {
  const done = (what) => { console.log(label, what); resolve(); };
  if (socket.addEventListener) {
    socket.addEventListener('open', () => done('open'));
    socket.addEventListener('error', (e) => done('error ' + (e.message ?? e.error?.message)));
  } else {
    socket.on('open', () => done('open'));
    socket.on('error', (e) => done('error ' + e.message));
  }
});
${opens.map(([label, expression]) => `await opened(${expression}, ${JSON.stringify(label)});`).join('\n')}
`;

describe('a WebSocket for the sidecar', () => {
  // Stands in for the sidecar, which speaks plain HTTP.
  let sidecar: Awaited<ReturnType<typeof handshakes>>;
  let base: string;
  beforeAll(async () => {
    sidecar = await handshakes();
    base = `${sidecar.origin}/t/token`;
  });
  afterAll(() => sidecar.close());

  it("opens as ws:// from Node's WebSocket, the ws package and the OpenAI SDK's Realtime client, and on the sidecar's route from a provider's host", async () => {
    const env = { ...process.env, ...guardEnv('warn', {}), SHADOWLAP_URL: base, SHADOWLAP_RUN_ID: 'R1', OPENAI_API_KEY: 'sk-test' };
    const wsBase = base.replace(/^http:/, 'wss:');
    const { stdout } = await agent(
      'websocket',
      opening("import WS from 'ws';\nimport OpenAI from 'openai';\nimport { OpenAIRealtimeWS } from 'openai/realtime/ws';", [
        ['native', `new WebSocket(${JSON.stringify(wsBase)} + '/openai/v1/realtime?model=m1', ['realtime'])`],
        ['ws', `new WS(${JSON.stringify(wsBase)} + '/openai/v1/realtime?model=m2')`],
        ['realtime', "new OpenAIRealtimeWS({ model: 'm3' }, new OpenAI({ baseURL: process.env.SHADOWLAP_URL + '/openai/v1' })).socket"],
        ['by-host', "new WebSocket('wss://api.openai.com/v1/realtime?model=m4')"],
      ]),
      env,
    );
    expect(stdout).toContain('native open');
    expect(stdout).toContain('ws open');
    expect(stdout).toContain('realtime open');
    expect(stdout).toContain('by-host open');
    expect(sidecar.upgrades.map((u) => u.url)).toEqual(['/t/token/openai/v1/realtime?model=m1', '/t/token/openai/v1/realtime?model=m2', '/t/token/openai/v1/realtime?model=m3', '/t/token/r/R1/openai/v1/realtime?model=m4']);
    expect(sidecar.upgrades[3].upstream).toBe('https://api.openai.com');
  });

  it("goes where it was going for a declared HTTP service, as the sidecar tunnels only a model provider's", async () => {
    const service = await handshakes();
    try {
      const host = new URL(service.origin).host;
      const env = { ...process.env, ...guardEnv('warn', {}, {}, [{ host, effect: 'read' }]), SHADOWLAP_URL: base, SHADOWLAP_RUN_ID: 'R1' };
      const before = sidecar.upgrades.length;
      const { stdout } = await agent(
        'websocket-http',
        opening("import WS from 'ws';", [
          ['native', `new WebSocket('ws://${host}/live?via=native')`],
          ['ws', `new WS('ws://${host}/live?via=ws')`],
        ]),
        env,
      );
      expect(stdout).toContain('native open');
      expect(stdout).toContain('ws open');
      expect(service.upgrades.map((u) => u.url)).toEqual(['/live?via=native', '/live?via=ws']);
      expect(sidecar.upgrades).toHaveLength(before);
    } finally {
      await service.close();
    }
  });
});

describe('HTTP/2, captured', () => {
  it("keeps a request's method, path and headers when the client gives them as raw headers", async () => {
    // Node's http2 takes a request's headers as an object or as raw headers, [name, value, ...]. The
    // capture redirects either to the sidecar; spread into an object, raw headers became numbered
    // keys and the request lost its method and path.
    const seen: Array<Record<string, unknown>> = [];
    const upstream = createHttp2Server();
    upstream.on('stream', (stream, headers) => {
      seen.push({ method: headers[':method'], path: headers[':path'], test: headers['x-test'], keys: Object.keys(headers).filter((k) => /^\d+$/.test(k)) });
      stream.resume();
      stream.on('end', () => {
        stream.respond({ ':status': 200, 'content-type': 'application/json' });
        stream.end(JSON.stringify(message([{ type: 'text', text: 'raw and sound' }])));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const sidecar = await Sidecar.start({ store, upstreams: { bedrock: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` } });
    try {
      const r = sidecar.startRun({ mode: 'record', command: { argv: ['node'], cwd: dir } });
      const { stdout } = await agent(
        'http2-raw',
        `
import http2 from 'node:http2';
const session = http2.connect('https://bedrock-runtime.us-east-1.amazonaws.com');
const req = session.request([':method', 'POST', ':path', '/model/anthropic.claude-3-5-haiku-20241022-v1%3A0/invoke', 'content-type', 'application/json', 'x-test', 'raw']);
let out = '';
req.setEncoding('utf8');
req.on('response', (h) => console.log('status', h[':status']));
req.on('data', (c) => (out += c));
req.on('end', () => {
  console.log('answer', JSON.parse(out).content[0].text);
  session.close();
});
req.end(JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }));
`,
        agentEnv(sidecar, r.runId, 'warn', {}),
      );
      expect(seen).toEqual([{ method: 'POST', path: '/model/anthropic.claude-3-5-haiku-20241022-v1%3A0/invoke', test: 'raw', keys: [] }]);
      expect(stdout).toContain('status 200');
      expect(stdout).toContain('answer raw and sound');
      sidecar.endRun(r.runId, 'completed');
      expect(store.getCalls(r.runId).map((c) => c.name)).toEqual(['POST /model/anthropic.claude-3-5-haiku-20241022-v1%3A0/invoke']);
    } finally {
      await sidecar.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
