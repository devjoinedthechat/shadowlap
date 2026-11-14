import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { storeApiRequest, Store } from '@shadowlap/engine';
import { runOffers } from '../src/run-offers.js';
import { startDashboard, type Dashboard } from '../src/index.js';

/**
 * Run blame's settings, as the run page offers them and the blame job takes them: the agent to
 * search (`--scope`, where the run's model calls name several), request fields set from each probed
 * call on (`--set`, temperature=1 suggested for a run recorded at temperature 0), another model to
 * rescue with (`--model`), and the check, shown and edited, or emptied for the exit code alone.
 */

let store: Store;
let project: string;
let dash: Dashboard | null = null;
const spawned: string[][] = [];
beforeEach(() => {
  store = Store.open(':memory:');
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-blame-settings-')));
  spawned.length = 0;
});
afterEach(async () => {
  await dash?.close();
  dash = null;
  store.close();
  rmSync(project, { recursive: true, force: true });
});

/** A failed recording of model calls, each made in `scopes[i]` (none for null), the first sent with `body`'s settings. */
function failedRun(scopes: Array<string | null>, body: Record<string, unknown> = {}): string {
  const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: '/work' }, startedAt: 1_000 });
  scopes.forEach((scope, i) => {
    const callNo = i + 1;
    const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: `fp${callNo}`, occurrence: 1 };
    const request = { model: 'claude-sonnet-5', messages: [{ role: 'user', content: `turn ${callNo}` }], ...(i === 0 ? body : {}) };
    store.appendCallStart({ runId: run.runId, callNo, ...identity, origin: 'live', effect: null, requestRef: storeApiRequest(store, request), meta: { provider: 'anthropic', ...(scope ? { scope } : {}) }, at: 1 });
    store.appendCallEnd(identity, { runId: run.runId, callNo, attempt: 0, responseRef: store.putJson({ type: 'message', content: [{ type: 'text', text: 'ok' }] }), outcome: 'ok', meta: { status: 200, provider: 'anthropic' }, at: 2 });
  });
  store.endRun(run.runId, 'failed', 5_000);
  return run.runId;
}

async function start(): Promise<Dashboard> {
  dash = await startDashboard({
    store,
    version: '0.1.0',
    project: { path: project },
    spawnCli: (args, options) => {
      spawned.push(args);
      return spawn(process.execPath, ['-e', ''], { stdio: options?.events ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] });
    },
  });
  return dash;
}
const job = (body: Record<string, unknown>) => fetch(`${dash!.url}/api/jobs`, { method: 'POST', body: JSON.stringify(body), headers: { 'x-shadowlap-token': dash!.token, 'content-type': 'application/json' } });
async function started(body: Record<string, unknown>): Promise<string[]> {
  const res = await job(body);
  expect(res.status, await res.clone().text()).toBe(202);
  const { id } = (await res.json()) as { id: string };
  for (let i = 0; i < 200; i++) {
    const view = (await (await fetch(`${dash!.url}/api/jobs/${id}`, { headers: { 'x-shadowlap-token': dash!.token } })).json()) as { done: boolean };
    if (view.done) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return spawned.at(-1)!;
}
async function refused(body: Record<string, unknown>): Promise<string> {
  const res = await job(body);
  expect(res.status).toBe(400);
  return ((await res.json()) as { error: string }).error;
}

describe('Run blame’s settings', () => {
  it('are offered for a run’s page: its agents where it has several, and temperature=1 where it was recorded at temperature 0', () => {
    const two = failedRun(['support/agent', 'support/user', 'support/agent']);
    expect(runOffers(store, two, { redact: [], config: null })!.blame).toMatchObject({ from: 'exit', scopes: ['support/agent', 'support/user'] });
    expect(runOffers(store, two, { redact: [], config: null })!.blame).not.toHaveProperty('temperature0');
    const cold = failedRun([null, null], { temperature: 0 });
    expect(runOffers(store, cold, { redact: [], config: null })!.blame).toMatchObject({ temperature0: true });
    expect(runOffers(store, cold, { redact: [], config: null })!.blame).not.toHaveProperty('scopes');
    // Gemini keeps it in generationConfig.
    expect(runOffers(store, failedRun([null], { generationConfig: { temperature: 0 } }), { redact: [], config: null })!.blame).toMatchObject({ temperature0: true });
    expect(runOffers(store, failedRun([null], { temperature: 0.7 }), { redact: [], config: null })!.blame).not.toHaveProperty('temperature0');
  });

  it('run blame with the agent, the request fields and the model asked, refusing what the CLI would before anything runs', async () => {
    const run = failedRun(['support/agent', 'support/user']);
    await start();
    expect(await started({ kind: 'blame', runId: run, expect: null, scope: 'support/agent', set: ['temperature=1', 'max_tokens=2048'], model: 'claude-opus-5-5' })).toEqual(['blame', run, '--scope', 'support/agent', '--set', 'temperature=1', '--set', 'max_tokens=2048', '--model', 'claude-opus-5-5']);
    // The check given emptied: the exit code alone, as before.
    expect(await started({ kind: 'blame', runId: run, expect: null })).toEqual(['blame', run]);
    expect(await refused({ kind: 'blame', runId: run, scope: 'support/judge' })).toBe(`${run.slice(0, 10)} made no model calls in scope support/judge (its scopes: support/agent, support/user)`);
    expect(await refused({ kind: 'blame', runId: run, set: ['temperature'] })).toBe('--set expects <key>=<value>, such as temperature=1, got "temperature"');
    expect(await refused({ kind: 'blame', runId: run, set: ['model=x'], model: 'claude-opus-5-5' })).toBe('--model and --set model=… both set the model; use one');
    expect(await refused({ kind: 'blame', runId: run, model: '--upload-pack=x' })).toBe('name the model to blame with, such as claude-opus-5-5');
    expect(spawned).toHaveLength(2);
  });
});
