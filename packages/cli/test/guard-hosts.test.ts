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
 * connects to the address a name resolved to, and the guard remembers the name.
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
import os, time, urllib.request
try:
    urllib.request.urlopen(os.environ['TARGET'], timeout=5).read()
except OSError:
    pass
time.sleep(0.2)
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
});
