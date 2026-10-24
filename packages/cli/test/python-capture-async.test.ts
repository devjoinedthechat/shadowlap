import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { message, startMockAnthropic, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { agentEnv, guardEnv } from '../src/run-agent.js';
import { pythonWith } from './python-with.js';

/**
 * In-process capture in Python agents on aiohttp (LiteLLM's async transport, aiobotocore, the SDKs'
 * aiohttp backends) and websockets: a model call through aiohttp is recorded, past a proxy the
 * environment names; a signed Bedrock call through aiobotocore still verifies upstream; a replay's
 * injected failure is the error aiohttp raises for the real thing; and a wss:// URL for the sidecar
 * connects as ws://, from websockets, aiohttp and the OpenAI SDK's Realtime client.
 */

const run = promisify(execFile);
const AIOHTTP = pythonWith('aiohttp');
const AIOBOTOCORE = pythonWith('aiobotocore');
const WEBSOCKETS = pythonWith('websockets', 'aiohttp', 'openai');

interface CloudMock {
  url: string;
  stats: { signaturesOk: number; signatureFailures: string[] };
  close(): Promise<void>;
}
const CLOUD_MOCK = pathToFileURL(fileURLToPath(new URL('../../../testing/frameworks/cloud-mock.mjs', import.meta.url))).href;

let store: Store;
let mock: MockServer;
beforeAll(async () => {
  store = Store.open(':memory:');
  mock = await startMockAnthropic({ script: () => ({ message: message([{ type: 'text', text: 'from the model' }]) }), eventDelayMs: () => 0 });
});
afterAll(async () => {
  await mock.close();
  store.close();
});

const lastLine = (stdout: string) => JSON.parse(stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;

describe.skipIf(!AIOHTTP)('aiohttp, captured', () => {
  it('records a model call to a provider host and one a base URL points at the sidecar, past the proxy HTTP_PROXY names', async () => {
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
    try {
      const r = sidecar.startRun({ mode: 'record', command: { argv: ['python'], cwd: '.' } });
      // A proxy that can't be reached: a call sent through it would fail.
      const env = { ...agentEnv(sidecar, r.runId, 'warn', { anthropic: mock.url }), MOCK: mock.url, HTTP_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9' };
      const script = `
import aiohttp, asyncio, json, os
async def main():
    body = {"model": "claude-sonnet-5", "max_tokens": 16, "messages": [{"role": "user", "content": "hello"}]}
    headers = {"anthropic-version": "2023-06-01", "x-api-key": "sk-test"}
    out = {}
    async with aiohttp.ClientSession(trust_env=True) as session:
        async with session.post(os.environ["MOCK"] + "/v1/messages", json=body, headers=headers) as res:
            out["captured"] = [res.status, (await res.json())["content"][0]["text"]]
        async with session.post(os.environ["ANTHROPIC_BASE_URL"] + "/v1/messages", json=body, headers=headers) as res:
            out["based"] = [res.status, (await res.json())["content"][0]["text"]]
    print(json.dumps(out))
asyncio.run(main())
`;
      const { stdout } = await run(AIOHTTP![0]!, [...AIOHTTP!.slice(1), '-c', script], { env });
      expect(lastLine(stdout)).toEqual({ captured: [200, 'from the model'], based: [200, 'from the model'] });
      const calls = store.getCalls(r.runId).filter((c) => c.kind === 'api');
      expect(calls.map((c) => c.name)).toEqual(['POST /v1/messages', 'POST /v1/messages']);
      sidecar.endRun(r.runId, 'completed');
    } finally {
      await sidecar.close();
    }
  });

  it("raises aiohttp's own timeout and reset for a failure a replay injects", async () => {
    // Stands in for the sidecar, naming the failure a replay's --fail-at injects on an HTTP service.
    const fake = createServer((req, res) => {
      req.resume();
      const asked = req.headers['x-shadowlap-failures'] === 'raise';
      const kind = req.url!.endsWith('/slow') ? 'timeout' : 'error';
      res.writeHead(504, asked ? { 'x-shadowlap-injected': kind, 'x-shadowlap-injected-message': encodeURIComponent('the service went away') } : {}).end();
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', () => resolve()));
    try {
      const env = { ...process.env, ...guardEnv('off', {}), SHADOWLAP_CAPTURE: JSON.stringify({ routes: [], hosts: {}, http: [['^svc\\.internal$', null]] }), SHADOWLAP_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/t/token`, SHADOWLAP_RUN_ID: 'R1' };
      const script = `
import aiohttp, asyncio, json
async def main():
    out = {}
    async with aiohttp.ClientSession() as session:
        for path in ("slow", "broken"):
            try:
                async with session.get("http://svc.internal/" + path) as res:
                    out[path] = res.status
            except aiohttp.ServerTimeoutError as e:
                out[path] = ["ServerTimeoutError", isinstance(e, asyncio.TimeoutError)]
            except aiohttp.ClientOSError as e:
                out[path] = ["ClientOSError", e.errno == 54 or e.errno == 104, str(e)]
    print(json.dumps(out))
asyncio.run(main())
`;
      const { stdout } = await run(AIOHTTP![0]!, [...AIOHTTP!.slice(1), '-c', script], { env });
      const out = lastLine(stdout);
      expect(out.slow).toEqual(['ServerTimeoutError', true]);
      expect(out.broken).toEqual(['ClientOSError', true, expect.stringContaining('the service went away')]);
    } finally {
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    }
  });
});

describe.skipIf(!AIOBOTOCORE)('aiobotocore, captured', () => {
  it('records a signed Bedrock call, whose signature still verifies at the host it was signed for', async () => {
    const { startCloudMock, AWS } = (await import(CLOUD_MOCK)) as { startCloudMock: () => Promise<CloudMock>; AWS: { accessKeyId: string; secretAccessKey: string; region: string } };
    const cloud = await startCloudMock();
    const sidecar = await Sidecar.start({ store, upstreams: { bedrock: cloud.url } });
    try {
      const r = sidecar.startRun({ mode: 'record', command: { argv: ['python'], cwd: '.' } });
      const env = { ...agentEnv(sidecar, r.runId, 'warn', { bedrock: cloud.url }), AWS_ACCESS_KEY_ID: AWS.accessKeyId, AWS_SECRET_ACCESS_KEY: AWS.secretAccessKey, AWS_DEFAULT_REGION: AWS.region };
      const script = `
import asyncio, json
from aiobotocore.session import get_session
async def main():
    async with get_session().create_client("bedrock-runtime", region_name="${AWS.region}") as client:
        res = await client.invoke_model(modelId="anthropic.claude-sonnet", body=json.dumps({"anthropic_version": "bedrock-2023-05-31", "max_tokens": 16, "messages": [{"role": "user", "content": "hello"}]}))
        print(json.dumps({"text": json.loads(await res["body"].read())["content"][0]["text"]}))
asyncio.run(main())
`;
      const { stdout } = await run(AIOBOTOCORE![0]!, [...AIOBOTOCORE!.slice(1), '-c', script], { env });
      expect(lastLine(stdout)).toEqual({ text: 'echo: hello' });
      expect(cloud.stats.signatureFailures).toEqual([]);
      expect(cloud.stats.signaturesOk).toBe(1);
      const calls = store.getCalls(r.runId).filter((c) => c.kind === 'api');
      expect(calls.map((c) => [c.meta.provider, c.name])).toEqual([['bedrock', 'POST /model/anthropic.claude-sonnet/invoke']]);
      sidecar.endRun(r.runId, 'completed');
    } finally {
      await sidecar.close();
      await cloud.close();
    }
  });
});

describe.skipIf(!WEBSOCKETS)('a WebSocket for the sidecar, from Python', () => {
  let server: Server;
  let base: string;
  const upgrades: string[] = [];
  const sockets = new Set<Duplex>();
  beforeAll(async () => {
    // Stands in for the sidecar, which speaks plain HTTP: it completes each handshake, then closes.
    server = createServer();
    server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
      sockets.add(socket);
      upgrades.push(req.url!);
      const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
      socket.end(Buffer.from([0x88, 0x00]));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/t/token`;
  });
  afterAll(() => {
    for (const s of sockets) s.destroy();
    server.closeAllConnections();
    return new Promise<void>((r) => server.close(() => r()));
  });

  it("connects as ws:// from websockets' clients, aiohttp and the OpenAI SDK's Realtime client", async () => {
    const env = { ...process.env, ...guardEnv('warn', {}), SHADOWLAP_URL: base, SHADOWLAP_RUN_ID: 'R1', OPENAI_API_KEY: 'sk-test' };
    const wss = base.replace(/^http:/, 'wss:');
    const script = `
import aiohttp, asyncio, json, openai, os
from websockets.sync.client import connect as sync_connect
from websockets.asyncio.client import connect as async_connect
out = {}
def attempt(label, fn):
    try:
        fn()
        out[label] = "open"
    except Exception as e:
        out[label] = "%s: %s" % (type(e).__name__, e)
def sync_client():
    with sync_connect("${wss}/openai/v1/realtime?model=s1"):
        pass
attempt("sync", sync_client)
async def async_client():
    async with async_connect("${wss}/openai/v1/realtime?model=a1"):
        pass
attempt("async", lambda: asyncio.run(async_client()))
async def aiohttp_client():
    async with aiohttp.ClientSession() as session:
        async with session.ws_connect("${wss}/openai/v1/realtime?model=h1"):
            pass
attempt("aiohttp", lambda: asyncio.run(aiohttp_client()))
def realtime():
    client = openai.OpenAI(base_url=os.environ["SHADOWLAP_URL"] + "/openai/v1")
    with client.beta.realtime.connect(model="r1"):
        pass
attempt("realtime", realtime)
print(json.dumps(out))
`;
    const { stdout } = await run(WEBSOCKETS![0]!, [...WEBSOCKETS!.slice(1), '-c', script], { env });
    const out = lastLine(stdout);
    expect(out).toMatchObject({ sync: 'open', async: 'open', aiohttp: 'open' });
    expect(out.realtime === 'open' || String(out.realtime).startsWith('ConnectionClosed'), String(out.realtime)).toBe(true);
    expect(upgrades).toEqual(expect.arrayContaining(['/t/token/openai/v1/realtime?model=s1', '/t/token/openai/v1/realtime?model=a1', '/t/token/openai/v1/realtime?model=h1', '/t/token/openai/v1/realtime?model=r1']));
  });
});
