import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { proof, proxyKeys, runOf as guardRunOf } from '../guard/node-proxies.mjs';
import { guardEnv } from '../src/index.js';
import { startMcpListener, type SidecarTarget } from '../src/mcp.js';
import { PROOF_PATH, proofOf, proxyFolder, registerProxy, runOf } from '../src/mcp-proxies.js';
import { pythonCommand } from '../../../testing/python-with.mjs';
import { startFakeMcpHttpServer, type FakeMcpHttpServer } from './fake-mcp-http-server.js';

/**
 * A `shadowlap mcp --listen` records the tool calls of the agents it serves, so their network guard
 * lets them reach it. It registers its address and a key, owner-only, in the home folder while it
 * runs, and the guard of every agent a Shadowlap command starts reads the folder when the agent
 * connects: it lets the connection through, `shadowlap test`'s block included, with no warning that
 * it bypasses Shadowlap, once what answers there proves it holds that key. A proxy started on its own
 * lets every agent through, one started under a command only that command's. A registration that is
 * stale, not this user's alone, anything but a proxy on this machine, or one whose process id another
 * process has lets nothing through.
 */

const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const GUARD_DIR = fileURLToPath(new URL('../guard/', import.meta.url));
const PYTHON = pythonCommand();
const POSIX = process.platform !== 'win32';
/** A process id no process has: past what macOS gives, and near the top of Linux's default range. */
const GONE = 2 ** 22 - 9;
/** The key a registration of these tests holds, and another. */
const KEY = 'a1'.repeat(16);
const OTHER = 'b2'.repeat(16);
/** A run, as a command names it, as a registration names it, and another run. */
const TARGET: SidecarTarget = { url: 'http://127.0.0.1:41000/EXAMPLEtoken', runId: '01M67AAAAAAAAAAAAAAAAAAAAA' };
const RUN = runOf(TARGET);
const ELSEWHERE = runOf({ ...TARGET, runId: '01M67BBBBBBBBBBBBBBBBBBBBB' });

/** What the Node guard, and the Python one where there is Python, find in `folder` for each `[target, run]`: the keys of the proxies to ask for a proof. */
function found(folder: string, queries: Array<[string, string]>): { node: string[][]; python: string[][] | null } {
  const program = ['import json, sys', 'sys.path.insert(0, sys.argv[1])', 'import _shadowlap_proxies as p', 'print(json.dumps([p.proxy_keys(sys.argv[2], run, [target]) for target, run in json.loads(sys.argv[3])]))'].join('\n');
  return {
    node: queries.map(([target, run]) => proxyKeys(folder, run, target)),
    python: PYTHON ? (JSON.parse(execFileSync(PYTHON, ['-c', program, GUARD_DIR, folder, JSON.stringify(queries)], { encoding: 'utf8' })) as string[][]) : null,
  };
}

/** Expects both guards to find `keys` for each `[target, run]` in `folder`. */
function expectFound(folder: string, queries: Array<[string, string]>, keys: string[][]): void {
  const got = found(folder, queries);
  expect(got.node).toEqual(keys);
  if (got.python) expect(got.python).toEqual(keys);
}

describe('the MCP proxies a command lets its agents reach', () => {
  let home: string;
  const folder = () => join(home, '.shadowlap', 'mcp');
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'sl-proxies-')));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('finds a running proxy of this user by its address, and localhost at its port, until it stops', () => {
    const registered = registerProxy({ host: '127.0.0.1', port: 8931 }, { key: KEY, run: null, home });
    expect(registered.file).toBe(join(folder(), `${process.pid}.json`));
    expect(proxyFolder({ home })).toBe(folder());
    expectFound(folder(), [['127.0.0.1:8931', RUN], ['localhost:8931', RUN], ['127.0.0.1:8932', RUN], ['10.0.0.5:8931', RUN]], [[KEY], [KEY], [], []]);
    registered.unregister();
    expectFound(folder(), [['127.0.0.1:8931', RUN]], [[]]);
    expect(readdirSync(folder())).toEqual([]);
  });

  it("finds one recording each session's own run for every agent, and one recording a command's run for that run's agents alone", () => {
    const anyRun = registerProxy({ host: '127.0.0.1', port: 8931 }, { key: KEY, run: null, home });
    expectFound(folder(), [['127.0.0.1:8931', RUN], ['127.0.0.1:8931', ELSEWHERE]], [[KEY], [KEY]]);
    anyRun.unregister();
    const oneRun = registerProxy({ host: '127.0.0.1', port: 8931 }, { key: KEY, run: TARGET, home });
    expectFound(folder(), [['127.0.0.1:8931', RUN], ['127.0.0.1:8931', ELSEWHERE]], [[KEY], []]);
    oneRun.unregister();
    // The guard names its run as the command does: from SHADOWLAP_URL, with or without its slash, and SHADOWLAP_RUN_ID.
    expect(guardRunOf(`${TARGET.url}/`, TARGET.runId)).toBe(RUN);
    if (PYTHON) expect(execFileSync(PYTHON, ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import _shadowlap_proxies as p; print(p.run_of(sys.argv[2], sys.argv[3]))', GUARD_DIR, TARGET.url, TARGET.runId], { encoding: 'utf8' }).trim()).toBe(RUN);
  });

  it('finds nothing for a registration whose proxy is gone, or that names another process or a host off this machine', () => {
    mkdirSync(folder(), { recursive: true, mode: 0o700 });
    const write = (pid: number, body: object) => writeFileSync(join(folder(), `${pid}.json`), JSON.stringify({ v: 1, key: KEY, run: null, ...body }), { mode: 0o600 });
    write(GONE, { pid: GONE, host: '127.0.0.1', port: 8001 });
    write(process.pid, { pid: process.pid, host: '10.0.0.5', port: 8002 });
    write(process.ppid, { pid: GONE, host: '127.0.0.1', port: 8003 });
    expectFound(folder(), [['127.0.0.1:8001', RUN], ['10.0.0.5:8002', RUN], ['localhost:8002', RUN], ['127.0.0.1:8003', RUN]], [[], [], [], []]);
  });

  it.skipIf(!POSIX)("finds nothing for a registration that isn't this user's alone: one others can read, a link, or in a folder others can read", () => {
    mkdirSync(folder(), { recursive: true, mode: 0o700 });
    const body = (port: number) => JSON.stringify({ v: 1, pid: process.pid, host: '127.0.0.1', port, key: KEY, run: null });
    writeFileSync(join(folder(), `${process.pid}.json`), body(8004), { mode: 0o644 });
    chmodSync(join(folder(), `${process.pid}.json`), 0o644);
    const elsewhere = join(home, 'elsewhere.json');
    writeFileSync(elsewhere, body(8005), { mode: 0o600 });
    symlinkSync(elsewhere, join(folder(), `${process.ppid}.json`));
    expectFound(folder(), [['127.0.0.1:8004', RUN], ['127.0.0.1:8005', RUN]], [[], []]);
    // Its own, in a folder others can read: refused all the same.
    rmSync(folder(), { recursive: true, force: true });
    mkdirSync(folder(), { recursive: true });
    chmodSync(folder(), 0o755);
    writeFileSync(join(folder(), `${process.pid}.json`), body(8006), { mode: 0o600 });
    expectFound(folder(), [['127.0.0.1:8006', RUN]], [[]]);
  });

  /**
   * The registrations the review crafted that it found refused, each refused by both guards still:
   * every field but the one crafted is a running proxy's, at 127.0.0.1:9001. The ones it found let
   * through are a process that isn't the proxy (no proof answers: below), a hard link to a file of
   * this user's, a process of another user's (EPERM counts as running), and a `.shadowlap` others can
   * read, or a link: the folder's own `mcp` is what holds to the rules.
   */
  it.skipIf(!POSIX)('finds nothing for any registration the review crafted', () => {
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const live = sleeper.pid!;
    const body = (o: object) => JSON.stringify({ v: 1, pid: live, host: '127.0.0.1', port: 9001, key: KEY, run: null, ...o });
    const put = (dir: string, name: string, text: string, mode = 0o600) => {
      writeFileSync(join(dir, name), text, { mode });
      chmodSync(join(dir, name), mode);
    };
    type Case = [string, (dir: string, home: string) => void];
    const cases: Case[] = [
      ['a process that has ended', (d) => put(d, `${GONE}.json`, body({ pid: GONE }))],
      ['a name and a pid that differ', (d) => put(d, `${process.pid}.json`, body({}))],
      ...[0o644, 0o640, 0o602].map((mode): Case => [`a file of mode ${mode.toString(8)}`, (d) => put(d, `${live}.json`, body({}), mode)]),
      ['a link to a good file', (d, h) => (put(h, 'good.json', body({})), symlinkSync(join(h, 'good.json'), join(d, `${live}.json`)))],
      ['a folder named as a registration', (d) => mkdirSync(join(d, `${live}.json`))],
      ['a pipe named as a registration', (d) => execFileSync('mkfifo', [join(d, `${live}.json`)])],
      ...['10.0.0.5', '0.0.0.0', 'example.com', '127.0.0.1.nip.io', 'localhost.example.com', '127.256.0.1', '0x7f.1', '2130706433', '127.1', '::ffff:127.0.0.1', '127.0.0.1,evil.com', ' 127.0.0.1', '::'].map((host): Case => [`the host ${JSON.stringify(host)}`, (d) => put(d, `${live}.json`, body({ host }))]),
      ...[0, 65536, '9001', 9001.5, -1].map((port): Case => [`the port ${JSON.stringify(port)}`, (d) => put(d, `${live}.json`, body({ port }))]),
      ['version 2', (d) => put(d, `${live}.json`, body({ v: 2 }))],
      ['no key', (d) => put(d, `${live}.json`, body({ key: undefined }))],
      ['a key that is not 32 hex digits', (d) => put(d, `${live}.json`, body({ key: 'A1'.repeat(16) }))],
      ['another run', (d) => put(d, `${live}.json`, body({ run: ELSEWHERE }))],
      ['a run that is not a string', (d) => put(d, `${live}.json`, body({ run: 7 }))],
      ['no JSON', (d) => put(d, `${live}.json`, 'nope')],
    ];
    const folders: Case[] = [
      ['the mcp folder of mode 755', (h) => (mkdirSync(join(h, '.shadowlap', 'mcp'), { recursive: true }), chmodSync(join(h, '.shadowlap', 'mcp'), 0o755), put(join(h, '.shadowlap', 'mcp'), `${live}.json`, body({})))],
      ['the mcp folder a link to a good one', (h) => {
        mkdirSync(join(h, 'real'), { mode: 0o700 });
        put(join(h, 'real'), `${live}.json`, body({}));
        mkdirSync(join(h, '.shadowlap'), { mode: 0o700 });
        symlinkSync(join(h, 'real'), join(h, '.shadowlap', 'mcp'));
      }],
    ];
    try {
      for (const [what, setup] of [...cases.map(([w, s]): Case => [w, (h) => (mkdirSync(folder(), { recursive: true, mode: 0o700 }), s(folder(), h))]), ...folders]) {
        rmSync(home, { recursive: true, force: true });
        mkdirSync(home, { mode: 0o700 });
        setup(home, home);
        const got = found(folder(), [['127.0.0.1:9001', RUN]]);
        expect(got.node, what).toEqual([[]]);
        if (got.python) expect(got.python, what).toEqual([[]]);
      }
      // The control: the same registration, whole, is found.
      rmSync(home, { recursive: true, force: true });
      mkdirSync(folder(), { recursive: true, mode: 0o700 });
      put(folder(), `${live}.json`, body({}));
      expectFound(folder(), [['127.0.0.1:9001', RUN]], [[KEY]]);
    } finally {
      sleeper.kill();
    }
  });
});

describe("a proxy's proof", () => {
  it('is its answer to a challenge with the key it holds alone; nothing else at the address is one, and an address nothing listens at is told apart', async () => {
    const listener = await startMcpListener({ host: '127.0.0.1', port: 0, url: 'http://127.0.0.1:9/mcp', sidecar: () => null, proofKey: KEY });
    const plain = createServer((_req, res) => res.end(OTHER));
    await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r));
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const nowhere = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    try {
      const at = Number(new URL(listener.url).port);
      const other = (plain.address() as AddressInfo).port;
      /** What the Node guard, and the Python one where there is Python, make of what answers at `port` for `keys`. */
      const answer = async (port: number, keys: string[]) => {
        const program = ['import json, socket, sys', 'sys.path.insert(0, sys.argv[1])', 'import _shadowlap_proxies as p', 'print(json.dumps(p.proof(lambda a: socket.create_connection(a, timeout=p.CONNECT_SECONDS), "127.0.0.1", int(sys.argv[2]), json.loads(sys.argv[3]))))'].join('\n');
        const python = PYTHON ? (JSON.parse((await promisify(execFile)(PYTHON, ['-c', program, GUARD_DIR, String(port), JSON.stringify(keys)], { encoding: 'utf8' })).stdout) as string) : null;
        return { node: await proof((o) => connect(o), '127.0.0.1', port, keys), python };
      };
      const both = (what: string) => ({ node: what, python: PYTHON ? what : null });
      expect(await answer(at, [KEY])).toEqual(both('proven'));
      expect(await answer(at, [OTHER, KEY])).toEqual(both('proven'));
      expect(await answer(at, [OTHER])).toEqual(both('unproven'));
      expect(await answer(other, [KEY, OTHER])).toEqual(both('unproven'));
      expect(await answer(nowhere, [KEY])).toEqual(both('nothing'));
      // The proof is an HMAC of the challenge under the key, and a challenge is 32 to 128 hex digits.
      const challenge = 'c3'.repeat(16);
      const res = await fetch(`${listener.url.replace('/mcp', PROOF_PATH)}?challenge=${challenge}`);
      expect([res.status, await res.text()]).toEqual([200, proofOf(KEY, challenge)]);
      expect((await fetch(`${listener.url.replace('/mcp', PROOF_PATH)}?challenge=xyz`)).status).toBe(400);
    } finally {
      await listener.close();
      await new Promise<void>((r) => plain.close(() => r()));
    }
  });
});

describe("a proxy's address, under the network guard", () => {
  let store: Store;
  let sidecar: Sidecar;
  let proxy: Server;
  let port: number;
  let home: string;
  const run = promisify(execFile);
  const folder = () => join(home, '.shadowlap', 'mcp');

  beforeAll(async () => {
    store = Store.open(':memory:');
    sidecar = await Sidecar.start({ store });
    // Stands in for the proxy: what matters is that it proves it holds KEY, and that the guard lets the agent reach it.
    proxy = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      res.end(url.pathname === PROOF_PATH ? proofOf(KEY, url.searchParams.get('challenge') ?? '') : 'reached');
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    port = (proxy.address() as AddressInfo).port;
    home = realpathSync(mkdtempSync(join(tmpdir(), 'sl-proxies-guard-')));
  });
  afterAll(async () => {
    await sidecar.close();
    await new Promise<void>((r) => proxy.close(() => r()));
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  const NODE = `try { console.log(await (await fetch(process.env.TARGET)).text()); } catch (err) { console.log(String(err.cause?.code ?? err)); }`;
  const PY = `
import os, urllib.request
try:
    print(urllib.request.urlopen(os.environ['TARGET'], timeout=5).read().decode())
except OSError as err:
    print('refused', err)
`;

  /**
   * What a Node agent, and a Python one where there is Python, got from the proxy (or `target`) under
   * block, and what the run says bypassed Shadowlap; `register` first registers the proxy as the test
   * needs, for the run the agents belong to.
   */
  async function reach(register: (run: SidecarTarget) => void, target = `http://127.0.0.1:${port}/`): Promise<{ node: string; python: string | null; unguarded: unknown[] }> {
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
    const env = { ...process.env, ...sidecar.envFor(rec.runId), ...guardEnv('block'), TARGET: target, SHADOWLAP_MCP_REGISTRY: folder() };
    register({ url: sidecar.envFor(rec.runId).SHADOWLAP_URL, runId: rec.runId });
    const node = (await run(process.execPath, ['--input-type=module', '-e', NODE], { env })).stdout.trim();
    const python = PYTHON ? (await run(PYTHON, ['-c', PY], { env })).stdout.trim() : null;
    const { unguarded } = sidecar.endRun(rec.runId, 'completed');
    return { node, python, unguarded };
  }

  /** What the agents got when the guard refused them both. */
  const refused = () => ({ node: 'ESHADOWLAP', python: PYTHON ? (expect.stringMatching(/^refused .*shadowlap: blocked an outbound connection to 127\.0\.0\.1:\d+/) as unknown) : null, unguarded: [{ target: `127.0.0.1:${port}`, count: PYTHON ? 2 : 1, action: 'blocked' }] });

  it('lets a Node or Python agent reach a running proxy under block, as no bypass, and nothing once it is stale', async () => {
    let registered: ReturnType<typeof registerProxy> | null = null;
    expect(await reach(() => (registered = registerProxy({ host: '127.0.0.1', port }, { key: KEY, run: null, home })))).toEqual({ node: 'reached', python: PYTHON ? 'reached' : null, unguarded: [] });
    registered!.unregister();
    // Left by a proxy that was killed: its process is gone.
    writeFileSync(join(folder(), `${GONE}.json`), JSON.stringify({ v: 1, pid: GONE, host: '127.0.0.1', port, key: KEY, run: null }), { mode: 0o600 });
    expect(await reach(() => {})).toEqual(refused());
    rmSync(join(folder(), `${GONE}.json`));
  }, 60_000);

  it('lets an agent through to a proxy recording its own run, and none recording another', async () => {
    let registered: ReturnType<typeof registerProxy> | null = null;
    expect(await reach((own) => (registered = registerProxy({ host: '127.0.0.1', port }, { key: KEY, run: own, home })))).toEqual({ node: 'reached', python: PYTHON ? 'reached' : null, unguarded: [] });
    registered!.unregister();
    expect(await reach((own) => (registered = registerProxy({ host: '127.0.0.1', port }, { key: KEY, run: { ...own, runId: 'another-run' }, home })))).toEqual(refused());
    registered!.unregister();
  }, 60_000);

  it('lets nothing through for a registration whose process id another process has, which no proof answers', async () => {
    // As a proxy that was killed leaves it once its id is given again: this test's process has it, and what answers at its port proves another key.
    let registered: ReturnType<typeof registerProxy> | null = null;
    expect(await reach(() => (registered = registerProxy({ host: '127.0.0.1', port }, { key: OTHER, run: null, home })))).toEqual(refused());
    registered!.unregister();
  }, 60_000);

  it('leaves a connection to a registered address nothing listens at to fail as it would, as when localhost names two addresses', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const nowhere = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    let registered: ReturnType<typeof registerProxy> | null = null;
    const got = await reach(() => (registered = registerProxy({ host: '127.0.0.1', port: nowhere }, { key: KEY, run: null, home })), `http://127.0.0.1:${nowhere}/`);
    registered!.unregister();
    expect(got).toEqual({ node: 'ECONNREFUSED', python: PYTHON ? expect.stringMatching(/^refused .*(Connection refused|actively refused)/) as unknown : null, unguarded: [] });
  }, 60_000);
});

/** An agent's MCP client over Streamable HTTP, its endpoint its first argument: a session, a read and a write, printing what each got. */
const CLIENT = `const endpoint = process.argv[2];
let session = null, version = null, id = 0;
const headers = () => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}), ...(version ? { 'mcp-protocol-version': version } : {}) });
async function request(method, params) {
  const res = await fetch(endpoint, { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) }) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) session = sid;
  const text = await res.text();
  if (!(res.headers.get('content-type') ?? '').startsWith('text/event-stream')) return JSON.parse(text);
  const data = text.split(/\\r?\\n\\r?\\n/).map((b) => b.split(/\\r?\\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\\n')).filter(Boolean);
  return JSON.parse(data.at(-1));
}
const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent', version: '1' } });
version = init.result.protocolVersion;
await fetch(endpoint, { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
await request('tools/list');
const read = await request('tools/call', { name: 'read_note', arguments: { id: 1 } });
const sent = await request('tools/call', { name: 'send_note', arguments: { to: 'y' } });
console.log(JSON.stringify({ read: read.result.content[0].text, sent: sent.result.content[0].text }));
`;

/**
 * A folder for the commands of a test, with a home folder of its own (HOME, and on Windows
 * USERPROFILE: proxies register there, and every command reads it), a project, and CLIENT in
 * client.mjs; `shadowlap` runs the CLI in the project.
 */
function sandbox(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const home = join(dir, 'home');
  const cwd = join(dir, 'project');
  mkdirSync(home);
  mkdirSync(cwd);
  const client = join(dir, 'client.mjs');
  writeFileSync(client, CLIENT);
  const env = (extra: Record<string, string>) => ({ ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_GUARD: undefined, SHADOWLAP_URL: undefined, SHADOWLAP_RUN_ID: undefined, ...extra });
  const shadowlap = (args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; out: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, '--db', join(cwd, 'store.db'), ...args], { cwd, env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      child.on('exit', (code) => resolve({ code, out }));
    });
  return { dir, home, cwd, client, env, shadowlap, remove: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) };
}

/**
 * As the review found it: an HTTP MCP client recorded through a proxy started on its own, packed,
 * then tested, whose `block` refused the agent's connection to the proxy itself.
 */
describe('shadowlap mcp --listen started on its own, beside run, pack and test', () => {
  let server: FakeMcpHttpServer;
  let box: ReturnType<typeof sandbox>;
  let home: string;
  let cwd: string;
  let client: string;
  let proxy: ChildProcess | null = null;

  beforeAll(async () => {
    server = await startFakeMcpHttpServer();
    box = sandbox('sl-listen-guard-');
    ({ home, cwd, client } = box);
  });
  afterAll(async () => {
    proxy?.kill('SIGKILL');
    await server.close();
    box.remove();
  });

  const env = () => box.env({});
  const shadowlap = (args: string[]) => box.shadowlap(args);

  it("records through it with no warning that it bypasses Shadowlap, and its golden passes under test's block", async () => {
    const started = spawn(process.execPath, [CLI, 'mcp', '--url', server.url, '--listen', '127.0.0.1:0'], { cwd, env: env(), stdio: ['ignore', 'ignore', 'pipe'] });
    proxy = started;
    let said = '';
    const endpoint = await new Promise<string>((resolve, reject) => {
      started.stderr.on('data', (chunk: Buffer) => {
        said += chunk.toString();
        const m = /serving \S+ at (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(said);
        if (m) resolve(m[1]);
      });
      started.once('exit', (code) => reject(new Error(`exited ${code}: ${said}`)));
    });
    expect(readdirSync(join(home, '.shadowlap', 'mcp'))).toEqual([`${started.pid}.json`]);

    const rec = await shadowlap(['run', '--', process.execPath, client, endpoint]);
    expect(rec.code, rec.out).toBe(0);
    expect(rec.out).toContain('{"read":"read_note:{\\"id\\":1}:1","sent":"send_note:{\\"to\\":\\"y\\"}:2"}');
    // The guard's warning, and the summary's list of what bypassed Shadowlap: neither names the proxy.
    expect(rec.out).not.toMatch(/outbound connection|bypassed Shadowlap/);
    expect(server.calls.map((c) => c.name)).toEqual(['read_note', 'send_note']);
    const runId = /recording run (\w{26})/.exec(rec.out)![1];

    expect((await shadowlap(['pack', runId, 'goldens/g'])).code).toBe(0);
    const test = await shadowlap(['test', 'goldens/g']);
    expect(test.code, test.out).toBe(0);
    expect(test.out).toMatch(/1 passed, 0 failed/);
    expect(test.out).not.toMatch(/outbound connection|bypassed Shadowlap|blocked/);
    // The recording answered both calls: the server saw neither again.
    expect(server.calls).toHaveLength(2);

    // Stopped, it takes its registration with it.
    const code = new Promise<number | null>((resolve) => started.once('exit', resolve));
    started.kill('SIGTERM');
    expect(await code).toBe(143);
    proxy = null;
    expect(readdirSync(join(home, '.shadowlap', 'mcp'))).toEqual([]);
  }, 120_000);
});

/**
 * As the review found it: a proxy the agent's own command starts, under the run it records into,
 * after the agent's guard loaded. Its guard lets the agent through when it connects, without a
 * warning, and `shadowlap test`'s block passes.
 */
describe("shadowlap mcp --listen started by the agent's own command", () => {
  let server: FakeMcpHttpServer;
  let box: ReturnType<typeof sandbox>;
  let agent: string;

  beforeAll(async () => {
    server = await startFakeMcpHttpServer();
    box = sandbox('sl-listen-own-');
    // The agent: it starts the proxy, then its MCP client in this same process, then stops the proxy.
    agent = join(box.dir, 'agent.mjs');
    writeFileSync(
      agent,
      `import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const [cli, server, client] = process.argv.slice(2);
const proxy = spawn(process.execPath, [cli, 'mcp', '--url', server, '--listen', '127.0.0.1:0'], { stdio: ['ignore', 'ignore', 'pipe'] });
let said = '';
process.argv[2] = await new Promise((resolve, reject) => {
  proxy.stderr.on('data', (d) => {
    said += d;
    const m = /serving \\S+ at (http:\\/\\/127\\.0\\.0\\.1:\\d+\\/mcp)/.exec(said);
    if (m) resolve(m[1]);
  });
  proxy.once('exit', (code) => reject(new Error('the proxy exited ' + code + ': ' + said)));
});
const stopped = new Promise((resolve) => proxy.once('exit', resolve));
try {
  await import(pathToFileURL(client).href);
} finally {
  proxy.kill('SIGTERM');
  await stopped;
}
`,
    );
  });
  afterAll(async () => {
    await server.close();
    box.remove();
  });

  it("records through it with no warning that it bypasses Shadowlap, and its golden passes under test's block", async () => {
    const command = ['--', process.execPath, agent, CLI, server.url, box.client];
    const rec = await box.shadowlap(['run', ...command]);
    expect(rec.code, rec.out).toBe(0);
    expect(rec.out).toContain('{"read":"read_note:{\\"id\\":1}:1","sent":"send_note:{\\"to\\":\\"y\\"}:2"}');
    expect(rec.out).toMatch(/Recorded \w+: 2 calls \(0 api, 2 tool\)/);
    expect(rec.out).not.toMatch(/outbound connection|bypassed Shadowlap/);
    const runId = /recording run (\w{26})/.exec(rec.out)![1];

    expect((await box.shadowlap(['pack', runId, 'goldens/g'])).code).toBe(0);
    const test = await box.shadowlap(['test', 'goldens/g']);
    expect(test.code, test.out).toBe(0);
    expect(test.out).toMatch(/1 passed, 0 failed/);
    expect(test.out).not.toMatch(/outbound connection|bypassed Shadowlap|blocked/);
    expect(server.calls).toHaveLength(2);
    // Each proxy, stopped, took its registration with it.
    expect(readdirSync(join(box.home, '.shadowlap', 'mcp'))).toEqual([]);
  }, 120_000);
});

/**
 * A registration a proxy left when it was killed, whose process id another process has since: the
 * port it names lets nothing through, whatever listens there now.
 */
describe('a registration whose process id another process has', () => {
  let box: ReturnType<typeof sandbox>;
  let target: Server;
  let paths: string[];
  let sleeper: ChildProcess;

  beforeAll(async () => {
    box = sandbox('sl-listen-reused-');
    paths = [];
    target = createServer((req, res) => {
      paths.push(req.url ?? '');
      res.end('reached');
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
    // Complete in every field a proxy writes, its process running: only what holds the port, and the id, are another's.
    const folder = join(box.home, '.shadowlap', 'mcp');
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(join(folder, `${sleeper.pid}.json`), `${JSON.stringify({ v: 1, pid: sleeper.pid, host: '127.0.0.1', port: (target.address() as AddressInfo).port, key: 'a1'.repeat(16), run: null })}\n`, { mode: 0o600 });
    writeFileSync(join(box.cwd, 'agent.mjs'), `try { console.log(await (await fetch(process.env.TARGET)).text()); } catch (err) { console.log(String(err.cause?.code ?? err)); }\n`);
  });
  afterAll(async () => {
    sleeper.kill();
    await new Promise<void>((r) => target.close(() => r()));
    box.remove();
  });

  it('is warned of under run, and refused under block before any request of the agent leaves', async () => {
    const env = { TARGET: `http://127.0.0.1:${(target.address() as AddressInfo).port}/agent` };
    const rec = await box.shadowlap(['run', '--', process.execPath, 'agent.mjs'], env);
    expect(rec.code, rec.out).toBe(0);
    expect(rec.out).toMatch(/warning: an outbound connection to 127\.0\.0\.1:\d+ bypasses Shadowlap/);
    expect(paths.filter((p) => p === '/agent')).toHaveLength(1);
    const runId = /recording run (\w{26})/.exec(rec.out)![1];

    const replay = await box.shadowlap(['replay', runId, '--guard', 'block'], env);
    expect(replay.out).toContain('ESHADOWLAP');
    expect(paths.filter((p) => p === '/agent')).toHaveLength(1);
  }, 120_000);
});
