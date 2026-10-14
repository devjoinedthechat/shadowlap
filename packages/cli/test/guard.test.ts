import { execFile, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { guardEnv } from '../src/index.js';

/**
 * The network guard, in real child processes: a Node script and a Python script each try to reach
 * an "external" server (a second local listener) while running under the guard. The sidecar is
 * reachable; the external target is reported, or refused under block.
 */

const run = promisify(execFile);
const GUARD_DIR = fileURLToPath(new URL('../guard/', import.meta.url));

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
let externalUrl: string;
let externalHits = 0;

beforeAll(async () => {
  store = Store.open(':memory:');
  sidecar = await Sidecar.start({ store });
  external = createServer((_req, res) => {
    externalHits++;
    res.end('external');
  });
  await new Promise<void>((r) => external.listen(0, '127.0.0.1', r));
  externalUrl = `http://127.0.0.1:${(external.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await sidecar.close();
  await new Promise<void>((r) => external.close(() => r()));
  store.close();
});

const NODE_SCRIPT = `
  const [target, sidecarUrl] = [process.env.TARGET, process.env.SHADOWLAP_URL];
  const r = await fetch(sidecarUrl + '/v1/health');            // the sidecar is always allowed
  const sidecarOk = r.ok;
  let externalResult;
  try { externalResult = await (await fetch(target)).text(); } catch (e) { externalResult = 'error:' + (e.cause?.code ?? e.code ?? e.message); }
  await new Promise((r) => setTimeout(r, 150));                 // let the report leave
  console.log(JSON.stringify({ sidecarOk, externalResult }));
`;

const PY_SCRIPT = `
import json, os, time, urllib.request
sidecar_ok = urllib.request.urlopen(os.environ['SHADOWLAP_URL'] + '/v1/health', timeout=5).status == 200
try:
    external = urllib.request.urlopen(os.environ['TARGET'], timeout=5).read().decode()
except OSError as e:
    external = 'error:' + str(e).split('(')[0].strip()
time.sleep(0.2)
print(json.dumps({'sidecarOk': sidecar_ok, 'externalResult': external}))
`;

describe('network guard', () => {
  it('builds the preload environment for Node and Python', () => {
    const env = guardEnv('warn', { NODE_OPTIONS: '--max-old-space-size=512', PYTHONPATH: '/x' });
    expect(env.SHADOWLAP_GUARD).toBe('warn');
    expect(env.NODE_OPTIONS).toMatch(/^--max-old-space-size=512 --import=file:.*node-preload\.mjs$/);
    const first = env.PYTHONPATH!.split(process.platform === 'win32' ? ';' : ':')[0]!;
    expect(first.replace(/[\\/]$/, '')).toBe(GUARD_DIR.replace(/[\\/]$/, ''));
    expect(env.PYTHONPATH!.endsWith('/x')).toBe(true);
    // The guard can be off; capture still loads, with the providers' hosts and configured upstreams.
    const off = guardEnv('off', {}, { openai: 'http://127.0.0.1:11434', anthropic: 'offline' });
    expect(off.SHADOWLAP_GUARD).toBe('off');
    const capture = JSON.parse(off.SHADOWLAP_CAPTURE!) as { routes: Array<[string, string]>; hosts: Record<string, string> };
    expect(capture.routes.map((r) => r[1])).toEqual(['anthropic', 'openai', 'gemini', 'azure', 'vertex', 'bedrock']);
    expect(capture.hosts).toEqual({ '127.0.0.1:11434': 'openai' });
    expect(guardEnv('warn', { SHADOWLAP_CAPTURE: 'off' }).SHADOWLAP_CAPTURE).toBe('off');
  });
});

describe('network guard, node', () => {
  it('warn: the external call goes through, is reported, and the summary names it', async () => {
    const parent = sidecar.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
    sidecar.endRun(parent.runId, 'completed');
    const replay = sidecar.startRun({ mode: 'replay', parentRunId: parent.runId, command: { argv: ['x'], cwd: '.' } });
    const before = externalHits;
    const { stdout, stderr } = await run(process.execPath, ['--input-type=module', '-e', NODE_SCRIPT], {
      env: { ...process.env, ...sidecar.envFor(replay.runId), ...guardEnv('warn'), TARGET: externalUrl },
    });
    const out = JSON.parse(stdout.trim()) as { sidecarOk: boolean; externalResult: string };
    expect(out.sidecarOk).toBe(true);
    expect(out.externalResult).toBe('external');
    expect(externalHits).toBe(before + 1);
    expect(stderr).toContain('bypasses Shadowlap');
    const { summary, unguarded } = sidecar.endRun(replay.runId, 'completed');
    expect(unguarded).toEqual([{ target: externalUrl.replace('http://', ''), count: 1, action: 'warned' }]);
    expect(summary.warnings[0]).toMatch(/bypassed Shadowlap during the replay/);
  });

  it('block: the external call is refused before any bytes leave', async () => {
    const parent = sidecar.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
    sidecar.endRun(parent.runId, 'completed');
    const replay = sidecar.startRun({ mode: 'replay', parentRunId: parent.runId, command: { argv: ['x'], cwd: '.' } });
    const before = externalHits;
    const { stdout, stderr } = await run(process.execPath, ['--input-type=module', '-e', NODE_SCRIPT], {
      env: { ...process.env, ...sidecar.envFor(replay.runId), ...guardEnv('block'), TARGET: externalUrl },
    });
    const out = JSON.parse(stdout.trim()) as { sidecarOk: boolean; externalResult: string };
    expect(out.sidecarOk).toBe(true);
    expect(out.externalResult).toBe('error:ESHADOWLAP');
    expect(externalHits).toBe(before);
    expect(stderr).toContain('blocked an outbound connection');
    const { unguarded } = sidecar.endRun(replay.runId, 'completed');
    expect(unguarded[0]).toMatchObject({ action: 'blocked', count: 1 });
  });

  it('off: nothing is intercepted', async () => {
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
    const { stderr } = await run(process.execPath, ['--input-type=module', '-e', NODE_SCRIPT], { env: { ...process.env, ...sidecar.envFor(rec.runId), ...guardEnv('off'), TARGET: externalUrl } });
    expect(stderr).not.toContain('shadowlap');
    expect(sidecar.endRun(rec.runId, 'completed').unguarded).toEqual([]);
  });
});

describe.skipIf(!PYTHON)('network guard, python', () => {
  it('warn and block behave as in Node', async () => {
    const parent = sidecar.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
    sidecar.endRun(parent.runId, 'completed');

    const warnRun = sidecar.startRun({ mode: 'replay', parentRunId: parent.runId, command: { argv: ['x'], cwd: '.' } });
    let before = externalHits;
    let r = await run(PYTHON!, ['-c', PY_SCRIPT], { env: { ...process.env, ...sidecar.envFor(warnRun.runId), ...guardEnv('warn'), TARGET: externalUrl } });
    let out = JSON.parse(r.stdout.trim()) as { sidecarOk: boolean; externalResult: string };
    expect(out).toEqual({ sidecarOk: true, externalResult: 'external' });
    expect(externalHits).toBe(before + 1);
    expect(r.stderr).toContain('bypasses Shadowlap');
    expect(sidecar.endRun(warnRun.runId, 'completed').unguarded).toEqual([{ target: externalUrl.replace('http://', ''), count: 1, action: 'warned' }]);

    const blockRun = sidecar.startRun({ mode: 'replay', parentRunId: parent.runId, command: { argv: ['x'], cwd: '.' } });
    before = externalHits;
    r = await run(PYTHON!, ['-c', PY_SCRIPT], { env: { ...process.env, ...sidecar.envFor(blockRun.runId), ...guardEnv('block'), TARGET: externalUrl } });
    out = JSON.parse(r.stdout.trim()) as { sidecarOk: boolean; externalResult: string };
    expect(out.sidecarOk).toBe(true);
    expect(out.externalResult).toMatch(/^error:/);
    expect(externalHits).toBe(before);
    expect(sidecar.endRun(blockRun.runId, 'completed').unguarded[0]).toMatchObject({ action: 'blocked' });
  });
});
