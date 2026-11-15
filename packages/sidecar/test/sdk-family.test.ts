import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { tool } from '@shadowlap/sdk';
import { Sidecar } from '../src/index.js';
import { pythonCommand } from '../../../testing/python-with.mjs';

/**
 * Which SDK made a run's tool calls, as `endRun` reports it for telemetry (`sdks`): read from the
 * `x-shadowlap-sdk` header both SDKs send on every call, so the Node SDK, which sends no user agent,
 * counts as TypeScript and not as "other".
 */

const PY_SDK = fileURLToPath(new URL('../../../sdks/python', import.meta.url));

const PYTHON = pythonCommand();

let store: Store;
let sidecar: Sidecar;
beforeAll(async () => {
  store = Store.open(':memory:');
  sidecar = await Sidecar.start({ store });
});
afterAll(async () => {
  await sidecar.close();
  store.close();
});

/** A tool call as a client that names itself only by these headers makes it. */
const resolve = (runId: string, headers: Record<string, string>) =>
  fetch(`${sidecar.url}/v1/calls/resolve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shadowlap-run': runId, ...headers }, body: JSON.stringify({ kind: 'tool', name: 'lookup', effect: 'read', args: { id: 1 } }) });

describe("a run's SDKs", () => {
  it('count the Node SDK as TypeScript, by the header it sends', async () => {
    const lookup = tool('lookup', { effect: 'read' }, async ({ id }: { id: number }) => ({ id }));
    const run = sidecar.startRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: '.' } });
    const saved = { url: process.env.SHADOWLAP_URL, run: process.env.SHADOWLAP_RUN_ID };
    Object.assign(process.env, { SHADOWLAP_URL: sidecar.url, SHADOWLAP_RUN_ID: run.runId });
    try {
      expect(await lookup({ id: 1 })).toEqual({ id: 1 });
    } finally {
      for (const [k, v] of [['SHADOWLAP_URL', saved.url], ['SHADOWLAP_RUN_ID', saved.run]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(sidecar.endRun(run.runId, 'completed').sdks).toEqual(['typescript']);
  });

  it.skipIf(!PYTHON)('count the Python SDK as Python', async () => {
    const run = sidecar.startRun({ mode: 'record', command: { argv: ['python', 'agent.py'], cwd: '.' } });
    const code = ['import sys', `sys.path.insert(0, ${JSON.stringify(PY_SDK)})`, 'from shadowlap import tool', '@tool(effect="read")', 'def lookup(id: int) -> dict:', '    return {"id": id}', 'lookup(1)'].join('\n');
    await promisify(execFile)(PYTHON!, ['-c', code], { env: { ...process.env, ...sidecar.envFor(run.runId) }, encoding: 'utf8' });
    expect(sidecar.endRun(run.runId, 'completed').sdks).toEqual(['python']);
  });

  it('go by the header over the user agent, and by the user agent without one', async () => {
    const sdksOf = async (headers: Record<string, string>) => {
      const run = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
      expect((await resolve(run.runId, headers)).status).toBe(200);
      return sidecar.endRun(run.runId, 'completed').sdks;
    };
    expect(await sdksOf({ 'x-shadowlap-sdk': 'node/0.1.0', 'user-agent': 'python-requests/2.32' })).toEqual(['typescript']);
    expect(await sdksOf({ 'x-shadowlap-sdk': 'python/0.1.0', 'user-agent': 'node' })).toEqual(['python']);
    // The MCP proxy names itself in its user agent; a client that says nothing shadowlap knows is another.
    expect(await sdksOf({ 'user-agent': 'shadowlap-mcp' })).toEqual(['mcp']);
    expect(await sdksOf({ 'x-shadowlap-sdk': 'not a version', 'user-agent': 'curl/8.7.1' })).toEqual(['other']);
  });
});
