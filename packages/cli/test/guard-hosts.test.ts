import { execFile, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { guardEnv } from '../src/index.js';

/**
 * What the network guard saw bypass Shadowlap is kept on the run, by host name: a Python agent
 * connects to the address a name resolved to, and the guard remembers the name. The Python agents
 * here exit right after their last connection: the guard's reports reach the sidecar before they
 * are gone.
 */

const run = promisify(execFile);

function python(): string | null {
  for (const cmd of ['python3', 'python']) {
    try {
      if (/Python 3\.(9|[1-9]\d)/.test(execFileSync(cmd, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString())) return cmd;
    } catch {
      // next
    }
  }
  return null;
}
const PYTHON = python();

let store: Store;
let sidecar: Sidecar;
let external: Server;
let port: number;

beforeAll(async () => {
  store = Store.open(':memory:');
  sidecar = await Sidecar.start({ store });
  external = createServer((_req, res) => res.end('external'));
  await new Promise<void>((r) => external.listen(0, '127.0.0.1', r));
  port = (external.address() as AddressInfo).port;
});
afterAll(async () => {
  await sidecar.close();
  await new Promise<void>((r) => external.close(() => r()));
  store.close();
});

const NODE_SCRIPT = `
  try { await (await fetch(process.env.TARGET)).text(); } catch {}
  await new Promise((r) => setTimeout(r, 150));
`;

const PY_SCRIPT = `
import os, urllib.request
try:
    urllib.request.urlopen(os.environ['TARGET'], timeout=5).read()
except OSError:
    pass
`;

describe('hosts that were not recorded', () => {
  it('are kept on the run when it ends (Node)', async () => {
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
    await run(process.execPath, ['--input-type=module', '-e', NODE_SCRIPT], { env: { ...process.env, ...sidecar.envFor(rec.runId), ...guardEnv('warn'), TARGET: `http://127.0.0.1:${port}/` } });
    const { unguarded } = sidecar.endRun(rec.runId, 'completed');
    expect(unguarded).toEqual([{ target: `127.0.0.1:${port}`, count: 1, action: 'warned' }]);
    expect(store.getRun(rec.runId)!.meta?.notRecorded).toEqual({ hosts: unguarded, tools: [] });
    // A run that reached nothing outside keeps no list.
    const quiet = sidecar.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
    sidecar.endRun(quiet.runId, 'completed');
    expect(store.getRun(quiet.runId)!.meta?.notRecorded).toBeUndefined();
  });

  it.skipIf(!PYTHON)('name the host a Python agent reached, not the address it resolved to', async () => {
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
    await run(PYTHON!, ['-c', PY_SCRIPT], { env: { ...process.env, ...sidecar.envFor(rec.runId), ...guardEnv('warn'), TARGET: `http://localhost:${port}/` } });
    sidecar.endRun(rec.runId, 'completed');
    const hosts = store.getRun(rec.runId)!.meta?.notRecorded?.hosts ?? [];
    expect(hosts.map((h) => h.target)).toEqual([`localhost:${port}`]);

    // An allowed name now matches in Python too.
    const allowed = sidecar.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
    await run(PYTHON!, ['-c', PY_SCRIPT], { env: { ...process.env, ...sidecar.envFor(allowed.runId), ...guardEnv('warn'), TARGET: `http://localhost:${port}/`, SHADOWLAP_GUARD_ALLOW: `localhost:${port}` } });
    expect(sidecar.endRun(allowed.runId, 'completed').unguarded).toEqual([]);
  });

  /**
   * Two hosts behind one address, as behind a CDN: a resolver under the guard's sends both names
   * to 127.0.0.1. Allowing one of them must not let the other through.
   */
  const SHARED = `
import os, socket, urllib.request
import sitecustomize as guard
real = guard._orig_getaddrinfo
def resolve(host, *args, **kwargs):
    return real('127.0.0.1' if host in ('allowed.partner.test', 'payments.example.test') else host, *args, **kwargs)
guard._orig_getaddrinfo = resolve
port = int(os.environ['PORT'])
def outcome(fn):
    try:
        fn()
        return 'reached'
    except OSError as e:
        return 'refused' if 'shadowlap' in str(e) else 'failed: %s' % e
def get(name):
    return outcome(lambda: urllib.request.urlopen('http://%s:%s/' % (name, port), timeout=5).read())
def pooled():
    # A client that resolved payments earlier connects to its address after the allowed host resolved.
    address = socket.getaddrinfo('payments.example.test', port)[0][4][0]
    socket.getaddrinfo('allowed.partner.test', port)
    return outcome(lambda: socket.create_connection((address, port), timeout=5).close())
print(get('allowed.partner.test'), get('payments.example.test'), get('allowed.partner.test'), pooled())
`;

  it.skipIf(!PYTHON)('let an allowed name through only while no other name shares its address', async () => {
    const env = (runId: string, mode: 'warn' | 'block') => ({ ...process.env, ...sidecar.envFor(runId), ...guardEnv(mode), PORT: String(port), SHADOWLAP_GUARD_ALLOW: `allowed.partner.test:${port}` });
    const shared = `127.0.0.1:${port} (allowed.partner.test, payments.example.test)`;

    const blocked = sidecar.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
    const out = await run(PYTHON!, ['-c', SHARED], { env: env(blocked.runId, 'block') });
    // The allowed host alone gets through; once the other resolved to the same address, neither
    // does, whichever name resolved last.
    expect(out.stdout.trim()).toBe('reached refused refused refused');
    expect(out.stderr).toContain(`blocked an outbound connection to ${shared}`);
    expect(out.stderr).toContain(`SHADOWLAP_GUARD_ALLOW=127.0.0.1:${port}`);
    expect(sidecar.endRun(blocked.runId, 'completed').unguarded).toEqual([{ target: shared, count: 3, action: 'blocked' }]);

    // Warned, every connection goes through, and the run keeps the address under both names.
    const warned = sidecar.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
    const loose = await run(PYTHON!, ['-c', SHARED], { env: env(warned.runId, 'warn') });
    expect(loose.stdout.trim()).toBe('reached reached reached reached');
    sidecar.endRun(warned.runId, 'completed');
    expect(store.getRun(warned.runId)!.meta?.notRecorded?.hosts).toEqual([{ target: shared, count: 3, action: 'warned' }]);
  });
});
