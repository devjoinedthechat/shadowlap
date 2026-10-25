import { execFile } from 'node:child_process';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { guardEnv } from '../src/index.js';
import { pythonWith } from './python-with.js';

/**
 * The network guard on the paths beyond a socket's connect(): UDP datagrams in Node (dgram) and in
 * Python (sendto, sendmsg, asyncio's datagram endpoints), asyncio's selector loop and the proactor
 * loop Windows uses by default, and uvloop. Each is reported under warn and refused under block,
 * where nothing reaches the target; a DNS query is left alone.
 */

const run = promisify(execFile);
const PYTHON = pythonWith();
const UVLOOP = pythonWith('uvloop');

let store: Store;
let sidecar: Sidecar;
let tcp: Server;
let tcpPort: number;
let tcpHits = 0;
let udp: UdpSocket;
let udpPort: number;
let datagrams = 0;

beforeAll(async () => {
  store = Store.open(':memory:');
  sidecar = await Sidecar.start({ store });
  tcp = createServer((s) => {
    tcpHits++;
    s.end();
  });
  await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', () => r()));
  tcpPort = (tcp.address() as AddressInfo).port;
  udp = createSocket('udp4');
  udp.on('message', () => datagrams++);
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()));
  udpPort = udp.address().port;
});
afterAll(async () => {
  await sidecar.close();
  await new Promise<void>((r) => tcp.close(() => r()));
  udp.close();
  store.close();
});

const settle = () => new Promise((r) => setTimeout(r, 200));

/** Runs a script under the guard in `mode` in a run of its own, and returns what it printed and what the run lists as bypassing. */
async function guarded(argv: string[], mode: 'warn' | 'block', extra: Record<string, string> = {}) {
  const r = sidecar.startRun({ mode: 'record', command: { argv, cwd: '.' } });
  const { stdout, stderr } = await run(argv[0], argv.slice(1), { env: { ...process.env, ...sidecar.envFor(r.runId), ...guardEnv(mode), TCP_PORT: String(tcpPort), UDP_PORT: String(udpPort), ...extra } });
  await settle();
  const { unguarded } = sidecar.endRun(r.runId, 'completed');
  return { out: JSON.parse(stdout.trim().split('\n').at(-1)!) as Record<string, string>, stderr, unguarded };
}

const NODE_UDP = `
import dgram from 'node:dgram';
const port = Number(process.env.UDP_PORT);
const out = {};
const sock = dgram.createSocket('udp4');
const send = (p, label) => new Promise((resolve) => sock.send(Buffer.from('x'), p, '127.0.0.1', (err) => resolve((out[label] = err ? 'error:' + err.code : 'sent'))));
await send(port, 'first');
await send(port, 'second');
await send(port, 'third');
// A DNS query: nothing listens on port 53 here, and the datagram leaves all the same.
await send(53, 'dns');
const connected = dgram.createSocket('udp4');
await new Promise((resolve) => connected.connect(port, '127.0.0.1', (err) => resolve((out.connect = err ? 'error:' + err.code : 'connected'))));
sock.close();
try { connected.close(); } catch {}
console.log(JSON.stringify(out));
`;

describe('UDP, in Node', () => {
  it('lets datagrams through under warn and lists the target once', async () => {
    const before = datagrams;
    const r = await guarded([process.execPath, '--input-type=module', '-e', NODE_UDP], 'warn');
    expect(r.out).toEqual({ first: 'sent', second: 'sent', third: 'sent', dns: 'sent', connect: 'connected' });
    expect(datagrams - before).toBe(3);
    expect(r.stderr.match(/a UDP datagram to 127\.0\.0\.1:\d+ bypasses Shadowlap/g)).toHaveLength(1);
    expect(r.unguarded).toEqual([{ target: `udp://127.0.0.1:${udpPort}`, count: 1, action: 'warned' }]);
  });

  it('refuses them under block, sends and connects alike, and leaves a DNS query alone', async () => {
    const before = datagrams;
    const r = await guarded([process.execPath, '--input-type=module', '-e', NODE_UDP], 'block');
    expect(r.out).toEqual({ first: 'error:ESHADOWLAP', second: 'error:ESHADOWLAP', third: 'error:ESHADOWLAP', dns: 'sent', connect: 'error:ESHADOWLAP' });
    expect(datagrams - before).toBe(0);
    expect(r.unguarded).toEqual([{ target: `udp://127.0.0.1:${udpPort}`, count: 1, action: 'blocked' }]);
  });
});

const PY_ASYNC = `
import asyncio, errno, json, os, socket
tcp, udp = int(os.environ["TCP_PORT"]), int(os.environ["UDP_PORT"])
out = {}

def outcome(fn):
    try:
        fn()
        return "ok"
    except OSError as e:
        return "error:%s" % errno.errorcode.get(e.errno, e.errno)

async def main():
    try:
        r, w = await asyncio.open_connection("127.0.0.1", tcp)
        out["open_connection"] = "ok"
        w.close()
    except OSError as e:
        out["open_connection"] = "error:%s" % errno.errorcode.get(e.errno, e.errno)
    loop = asyncio.get_running_loop()
    try:
        t, _ = await loop.create_datagram_endpoint(asyncio.DatagramProtocol, remote_addr=("127.0.0.1", udp))
        out["datagram_endpoint"] = "ok"
        t.sendto(b"x")
        t.close()
    except OSError as e:
        out["datagram_endpoint"] = "error:%s" % errno.errorcode.get(e.errno, e.errno)
    # A transport hands a failed send to its protocol, as error_received.
    class Errors(asyncio.DatagramProtocol):
        def __init__(self):
            self.errors = []
        def error_received(self, exc):
            self.errors.append(exc)
    t, p = await loop.create_datagram_endpoint(Errors, local_addr=("127.0.0.1", 0))
    t.sendto(b"x", ("127.0.0.1", udp))
    out["transport_sendto"] = "error:%s" % errno.errorcode.get(p.errors[0].errno, p.errors[0].errno) if p.errors else "ok"
    t.close()
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setblocking(False)
    try:
        await loop.sock_sendto(s, b"x", ("127.0.0.1", udp)) if hasattr(loop, "sock_sendto") else s.sendto(b"x", ("127.0.0.1", udp))
        out["sock_sendto"] = "ok"
    except OSError as e:
        out["sock_sendto"] = "error:%s" % errno.errorcode.get(e.errno, e.errno)
    except NotImplementedError:  # uvloop has none of its own
        out["sock_sendto"] = "not implemented"
    out["sendto"] = outcome(lambda: s.sendto(b"x", ("127.0.0.1", udp)))
    out["sendto_flags"] = outcome(lambda: s.sendto(b"x", 0, ("127.0.0.1", udp)))
    if hasattr(s, "sendmsg"):
        out["sendmsg"] = outcome(lambda: s.sendmsg([b"x"], [], 0, ("127.0.0.1", udp)))
    out["dns"] = outcome(lambda: s.sendto(b"x", ("127.0.0.1", 53)))
    out["getaddrinfo"] = outcome(lambda: socket.getaddrinfo("localhost", 80))
    s.close()

if os.environ.get("LOOP") == "uvloop":
    import uvloop
    out["loop"] = "uvloop"
    uvloop.run(main())
else:
    asyncio.run(main())
print(json.dumps(out))
`;

describe.skipIf(!PYTHON)('UDP and asyncio, in Python', () => {
  it('refuses a connection opened through asyncio and every datagram under block, leaving DNS alone', async () => {
    const [hits, before] = [tcpHits, datagrams];
    const r = await guarded([...PYTHON!, '-c', PY_ASYNC], 'block');
    expect(r.out).toMatchObject({ open_connection: 'error:EPERM', datagram_endpoint: 'error:EPERM', transport_sendto: 'error:EPERM', sock_sendto: 'error:EPERM', sendto: 'error:EPERM', sendto_flags: 'error:EPERM', dns: 'ok', getaddrinfo: 'ok' });
    if ('sendmsg' in r.out) expect(r.out.sendmsg).toBe('error:EPERM');
    expect(tcpHits - hits).toBe(0);
    expect(datagrams - before).toBe(0);
    expect(r.unguarded).toEqual(expect.arrayContaining([{ target: `127.0.0.1:${tcpPort}`, count: 1, action: 'blocked' }, { target: `udp://127.0.0.1:${udpPort}`, count: 1, action: 'blocked' }]));
  });

  it('lets them through under warn, listing a UDP target once however many datagrams went', async () => {
    const before = datagrams;
    const r = await guarded([...PYTHON!, '-c', PY_ASYNC], 'warn');
    expect(r.out).toMatchObject({ open_connection: 'ok', datagram_endpoint: 'ok', transport_sendto: 'ok', sock_sendto: 'ok', sendto: 'ok', dns: 'ok' });
    await settle();
    expect(datagrams - before).toBeGreaterThanOrEqual(5);
    expect(r.unguarded.find((u) => u.target === `udp://127.0.0.1:${udpPort}`)).toEqual({ target: `udp://127.0.0.1:${udpPort}`, count: 1, action: 'warned' });
    expect(r.stderr.match(/a UDP datagram to 127\.0\.0\.1:\d+ bypasses Shadowlap/g)).toHaveLength(1);
  });

  // The proactor loop is Windows' default and connects through overlapped I/O, past socket.connect():
  // here it runs on a stand-in for the Windows proactor, which records what it was asked to do.
  it("refuses a connection and a datagram on asyncio's proactor loop before the proactor sees them", async () => {
    const script = `
import asyncio, errno, json, socket
import asyncio.proactor_events as pe

class Proactor:
    def __init__(self):
        self.asked = []
    def set_loop(self, loop):
        self.loop = loop
    def connect(self, sock, address):
        self.asked.append(["connect", address[1]])
        done = self.loop.create_future()
        done.set_result(None)
        return done
    def sendto(self, sock, data, flags=0, addr=None):
        self.asked.append(["sendto", addr[1]])
        done = self.loop.create_future()
        done.set_result(len(data))
        return done
    def recv(self, *args, **kwargs):
        return self.loop.create_future()
    def close(self):
        pass

def drive(coro):
    try:
        coro.send(None)
    except StopIteration:
        return "ok"
    except OSError as e:
        return "error:%s" % errno.errorcode.get(e.errno, e.errno)
    return "pending"

import os
proactor = Proactor()
loop = pe.BaseProactorEventLoop(proactor)
tcp, udp = int(os.environ["TCP_PORT"]), int(os.environ["UDP_PORT"])
out = {"connect": drive(loop.sock_connect(socket.socket(), ("127.0.0.1", tcp)))}
if hasattr(loop, "sock_sendto"):
    out["sock_sendto"] = drive(loop.sock_sendto(socket.socket(socket.AF_INET, socket.SOCK_DGRAM), b"x", ("127.0.0.1", udp)))
out["asked"] = proactor.asked
loop.close()
print(json.dumps(out))
`;
    const blocked = await guarded([...PYTHON!, '-c', script], 'block');
    expect(blocked.out.connect).toBe('error:EPERM');
    if ('sock_sendto' in blocked.out) expect(blocked.out.sock_sendto).toBe('error:EPERM');
    expect(blocked.out.asked).toEqual([]);
    expect(blocked.unguarded.find((u) => u.target === `127.0.0.1:${tcpPort}`)).toMatchObject({ action: 'blocked' });
    const warned = await guarded([...PYTHON!, '-c', script], 'warn');
    expect(warned.out.connect).toBe('ok');
    expect(warned.out.asked).toContainEqual(['connect', tcpPort]);
    expect(warned.unguarded.find((u) => u.target === `127.0.0.1:${tcpPort}`)).toMatchObject({ action: 'warned', count: 1 });
  });
});

describe.skipIf(!UVLOOP)('uvloop, in Python', () => {
  it('refuses its connections and datagrams under block, through the import hook', async () => {
    const [hits, before] = [tcpHits, datagrams];
    const r = await guarded([...UVLOOP!, '-c', PY_ASYNC], 'block', { LOOP: 'uvloop' });
    // uvloop's process may run under uv: its env reaches the Python it starts.
    expect(r.out).toMatchObject({ loop: 'uvloop', open_connection: 'error:EPERM', datagram_endpoint: 'error:EPERM', transport_sendto: 'error:EPERM', sock_sendto: 'error:EPERM', dns: 'ok' });
    expect(tcpHits - hits).toBe(0);
    expect(datagrams - before).toBe(0);
    expect(r.unguarded).toEqual(expect.arrayContaining([{ target: `127.0.0.1:${tcpPort}`, count: 1, action: 'blocked' }]));
  });

  it('lets them through under warn and lists each target once', async () => {
    const r = await guarded([...UVLOOP!, '-c', PY_ASYNC], 'warn', { LOOP: 'uvloop' });
    expect(r.out).toMatchObject({ loop: 'uvloop', open_connection: 'ok', datagram_endpoint: 'ok', transport_sendto: 'ok' });
    expect(r.unguarded.find((u) => u.target === `127.0.0.1:${tcpPort}`)).toEqual({ target: `127.0.0.1:${tcpPort}`, count: 1, action: 'warned' });
    expect(r.unguarded.find((u) => u.target === `udp://127.0.0.1:${udpPort}`)).toEqual({ target: `udp://127.0.0.1:${udpPort}`, count: 1, action: 'warned' });
  });
});
