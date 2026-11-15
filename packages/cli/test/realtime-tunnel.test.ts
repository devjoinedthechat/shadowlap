import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { removeTempProject, tempProject } from '../../../testing/temp-project.mjs';
import { pythonWith } from '../../../testing/python-with.mjs';

/**
 * A Realtime WebSocket end to end, through `shadowlap run`: the OpenAI SDK's Realtime client makes a
 * wss:// URL of the base URL the run gives it, the preload opens it as ws:// (the sidecar speaks no
 * TLS), and the sidecar's tunnel carries it to the provider, both ways. The provider here is a
 * stand-in that SHADOWLAP_UPSTREAM_OPENAI names. Nothing goes around shadowlap, and the run's
 * summary names the connections, as nothing sent over one is recorded.
 */

const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const PYTHON = pythonWith('openai', 'websockets');

interface Frame {
  opcode: number;
  payload: Buffer;
}

/** The whole frames in `buf` (RFC 6455; these clients send short, unfragmented ones), and the bytes of one not whole yet. */
function readFrames(buf: Buffer): { frames: Frame[]; rest: Buffer } {
  const frames: Frame[] = [];
  let at = 0;
  while (buf.length - at >= 2) {
    const masked = (buf[at + 1] & 0x80) !== 0;
    let len = buf[at + 1] & 0x7f;
    let head = 2;
    if (len === 126) {
      if (buf.length - at < 4) break;
      len = buf.readUInt16BE(at + 2);
      head = 4;
    } else if (len === 127) {
      if (buf.length - at < 10) break;
      len = Number(buf.readBigUInt64BE(at + 2));
      head = 10;
    }
    const start = at + head + (masked ? 4 : 0);
    if (buf.length < start + len) break;
    const payload = Buffer.from(buf.subarray(start, start + len));
    if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[at + head + (i % 4)];
    frames.push({ opcode: buf[at] & 0x0f, payload });
    at = start + len;
  }
  return { frames, rest: Buffer.from(buf.subarray(at)) };
}

/** A frame as a server sends it: final and unmasked. */
function serverFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  return Buffer.concat([len < 126 ? Buffer.from([0x80 | opcode, len]) : Buffer.from([0x80 | opcode, 126, len >> 8, len & 0xff]), payload]);
}

/**
 * Stands in for OpenAI's Realtime API: each connection gets a session.created, a session.update is
 * answered with the session as updated (with the instructions the client sent), a ping with a pong,
 * and a close with a close. It keeps each handshake as it arrived.
 */
async function realtimeProvider(): Promise<{ url: string; handshakes: Array<{ url: string; headers: IncomingHttpHeaders }>; close(): Promise<void> }> {
  const handshakes: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
  const sockets = new Set<Socket>();
  const server = createServer((_req, res) => res.writeHead(426, { 'content-type': 'text/plain' }).end('WebSocket only'));
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.on('end', () => socket.end());
    handshakes.push({ url: req.url ?? '', headers: req.headers });
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const model = new URL(req.url ?? '/', 'http://provider').searchParams.get('model');
    const send = (event: object) => socket.write(serverFrame(0x1, Buffer.from(JSON.stringify(event))));
    send({ type: 'session.created', event_id: 'event_1', session: { id: 'sess_1', model } });
    let pending: Buffer = Buffer.from(head);
    socket.on('data', (d: Buffer) => {
      const { frames, rest } = readFrames(Buffer.concat([pending, d]));
      pending = rest;
      for (const f of frames) {
        if (f.opcode === 0x8) return void socket.end(serverFrame(0x8, f.payload.subarray(0, 2)));
        if (f.opcode === 0x9) socket.write(serverFrame(0xa, f.payload));
        if (f.opcode !== 0x1) continue;
        try {
          const event = JSON.parse(f.payload.toString('utf8')) as { type?: string; session?: { instructions?: string } };
          if (event.type === 'session.update') send({ type: 'session.updated', event_id: 'event_2', session: { id: 'sess_1', model, instructions: event.session?.instructions ?? null } });
        } catch {
          send({ type: 'error', event_id: 'event_2', error: { message: 'not JSON' } });
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    handshakes,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

let dir: string;
let provider: Awaited<ReturnType<typeof realtimeProvider>>;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sl-realtime-'));
  provider = await realtimeProvider();
});
afterAll(async () => {
  await provider.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** `shadowlap run -- <agent>` in `cwd`, its provider the stand-in, with what it printed and its exit code. */
function shadowlapRun(agent: string[], cwd: string): Promise<{ code: number | null; out: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, SHADOWLAP_UPSTREAM_OPENAI: provider.url, OPENAI_API_KEY: 'sk-test', NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_HOME: join(cwd, 'home') };
  // A base URL or a proxy from this machine would decide where the clients go.
  for (const k of ['OPENAI_BASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', join(cwd, 'store.db'), 'run', '--', ...agent], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => resolve({ code, out }));
  });
}

/** The JSON line the agent printed last. */
function said(out: string): Record<string, unknown> {
  const line = out.split('\n').filter((l) => l.startsWith('{"')).at(-1);
  if (!line) throw new Error(`the agent printed nothing to read:\n${out}`);
  return JSON.parse(line) as Record<string, unknown>;
}

describe.skipIf(process.platform === 'win32')('a Realtime WebSocket from a Node agent, through shadowlap run', () => {
  it("reaches the provider through the sidecar's tunnel, both ways, from the OpenAI SDK's Realtime client and Node's own WebSocket", async () => {
    const cwd = mkdtempSync(join(dir, 'node-'));
    // In a folder below a link to this repository's packages, so it imports the monorepo's `openai` and `ws`.
    const agents = tempProject('sl-realtime-agent-');
    const agent = join(agents, 'agent.mjs');
    writeFileSync(
      agent,
      `
import OpenAI from 'openai';
import { OpenAIRealtimeWS } from 'openai/realtime/ws';

const said = {};
const seen = (event) => event.type + (event.session?.instructions ? ':' + event.session.instructions : '');
// The session the provider opened, then its answer to a session.update naming the client.
const converse = (label, rt) =>
  new Promise((resolve) => {
    const events = [];
    rt.on('event', (event) => {
      events.push(seen(event));
      if (event.type === 'session.created') rt.send({ type: 'session.update', session: { type: 'realtime', instructions: label } });
      else rt.close();
    });
    rt.on('error', (err) => events.push('error: ' + err.message));
    rt.socket.on('close', () => resolve((said[label] = { url: rt.url.origin, events })));
  });
// A client built the default way, and one given the run's base URL, as an agent's own code reads it.
await converse('sdk', new OpenAIRealtimeWS({ model: 'gpt-realtime' }));
await converse('sdk-base-url', new OpenAIRealtimeWS({ model: 'gpt-realtime' }, new OpenAI({ baseURL: process.env.OPENAI_BASE_URL })));
// Node's own WebSocket, on a wss:// URL made of the base URL.
const url = process.env.OPENAI_BASE_URL.replace(/^http:/, 'wss:') + '/realtime?model=gpt-realtime';
await new Promise((resolve) => {
  const ws = new WebSocket(url);
  const events = [];
  ws.addEventListener('message', (m) => {
    const event = JSON.parse(m.data);
    events.push(seen(event));
    if (event.type === 'session.created') ws.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', instructions: 'native' } }));
    else ws.close(1000);
  });
  ws.addEventListener('error', (e) => events.push('error: ' + (e.message ?? e.error?.message)));
  ws.addEventListener('close', () => resolve((said.native = { url: new URL(url).origin, events })));
});
console.log(JSON.stringify(said));
`,
    );
    const before = provider.handshakes.length;
    let result: { code: number | null; out: string };
    try {
      result = await shadowlapRun([process.execPath, agent], cwd);
    } finally {
      removeTempProject(agents);
    }
    const { code, out } = result;
    expect(code, out).toBe(0);
    const sidecar = /^wss:\/\/127\.0\.0\.1:\d+$/;
    expect(said(out)).toEqual({
      // The default client goes by its host, which the preload sends to the sidecar's route for it.
      sdk: { url: 'wss://api.openai.com', events: ['session.created', 'session.updated:sdk'] },
      'sdk-base-url': { url: expect.stringMatching(sidecar), events: ['session.created', 'session.updated:sdk-base-url'] },
      native: { url: expect.stringMatching(sidecar), events: ['session.created', 'session.updated:native'] },
    });
    const handshakes = provider.handshakes.slice(before);
    expect(handshakes.map((h) => h.url)).toEqual(Array(3).fill('/v1/realtime?model=gpt-realtime'));
    // The SDK's key went to the provider, and none of shadowlap's own headers did.
    expect(handshakes.slice(0, 2).map((h) => h.headers.authorization)).toEqual(['Bearer sk-test', 'Bearer sk-test']);
    expect(handshakes.flatMap((h) => Object.keys(h.headers).filter((k) => k.startsWith('x-shadowlap')))).toEqual([]);
    expect(out).toContain('3 WebSocket connections went to the provider live and were not recorded: openai /v1/realtime (3)');
    expect(out).not.toContain('bypassed shadowlap');
    // The run keeps them, for its page in the dashboard.
    const store = Store.open(join(cwd, 'store.db'));
    try {
      expect(store.listRuns(1)[0]?.meta?.websockets).toEqual([{ target: 'openai /v1/realtime', count: 3, action: 'tunnelled' }]);
    } finally {
      store.close();
    }
  }, 90_000);
});

describe.skipIf(!PYTHON || process.platform === 'win32')('a Realtime WebSocket from a Python agent, through shadowlap run', () => {
  it("reaches the provider through the sidecar's tunnel, both ways, from websockets' clients and the OpenAI SDK's Realtime client", async () => {
    const cwd = mkdtempSync(join(dir, 'python-'));
    writeFileSync(
      join(cwd, 'agent.py'),
      `
import asyncio, json, os
import openai
from websockets.asyncio.client import connect as async_connect
from websockets.sync.client import connect as sync_connect

base = os.environ["OPENAI_BASE_URL"]
wss = "wss://" + base.split("://", 1)[1] + "/realtime?model=gpt-realtime"
said = {}

def seen(event):
    instructions = (event.get("session") or {}).get("instructions")
    return event["type"] + (":" + instructions if instructions else "")

def update(label):
    return {"type": "session.update", "session": {"type": "realtime", "instructions": label}}

# websockets' own clients, on a wss:// URL made of the base URL.
with sync_connect(wss) as ws:
    first = json.loads(ws.recv())
    ws.send(json.dumps(update("sync")))
    said["sync"] = [seen(first), seen(json.loads(ws.recv()))]

async def async_client():
    async with async_connect(wss) as ws:
        first = json.loads(await ws.recv())
        await ws.send(json.dumps(update("async")))
        return [seen(first), seen(json.loads(await ws.recv()))]

said["async"] = asyncio.run(async_client())

# The OpenAI SDK's Realtime client, built the default way: its beta client makes a wss:// URL of the
# base URL, as the Node SDK's does.
client = openai.OpenAI()
beta = getattr(client, "beta", None)
realtime = getattr(beta, "realtime", None) or client.realtime
with realtime.connect(model="gpt-realtime") as conn:
    first = json.loads(conn.recv_bytes())
    conn.send(update("sdk"))
    said["sdk"] = [seen(first), seen(json.loads(conn.recv_bytes()))]
print(json.dumps(said))
`,
    );
    const before = provider.handshakes.length;
    const { code, out } = await shadowlapRun([...PYTHON!, 'agent.py'], cwd);
    expect(code, out).toBe(0);
    expect(said(out)).toEqual({
      sync: ['session.created', 'session.updated:sync'],
      async: ['session.created', 'session.updated:async'],
      sdk: ['session.created', 'session.updated:sdk'],
    });
    const handshakes = provider.handshakes.slice(before);
    expect(handshakes.map((h) => h.url)).toEqual(Array(3).fill('/v1/realtime?model=gpt-realtime'));
    expect(handshakes[2].headers.authorization).toBe('Bearer sk-test');
    expect(handshakes.flatMap((h) => Object.keys(h.headers).filter((k) => k.startsWith('x-shadowlap')))).toEqual([]);
    expect(out).toContain('3 WebSocket connections went to the provider live and were not recorded: openai /v1/realtime (3)');
    expect(out).not.toContain('bypassed shadowlap');
  }, 120_000);
});
