import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { storeApiRequest, Store } from '@shadowlap/engine';
import { cliSpawner, startDashboard, type Dashboard } from '../src/index.js';
import { OVERRIDE_INLINE, OVERRIDE_LIMIT } from '../src/routes/forks.js';
import type { JobView } from '../src/views.js';

/**
 * Edit this result and fork, from the inspector: the edited result arrives as an upload, untrusted,
 * and the server checks it (UTF-8, its size, JSON for a tool's result) and that the call is one the
 * fork menu overrides, then builds the fork menu's own `shadowlap replay --override` from it: the
 * result inline while it stays short enough to keep on the fork's record, else the uploaded file.
 */

const FAKE = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
let project = '';
let store: Store;
let dash: Dashboard;
let ro: Dashboard;
let runId = '';
let live = '';
const spawned: string[][] = [];

const api = (d: Dashboard, path: string, init: RequestInit = {}) => fetch(`${d.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': d.token, ...(typeof init.body === 'string' && !(init.headers as Record<string, string> | undefined)?.['x-filename'] ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string>) } });
const post = (d: Dashboard, path: string, body: unknown) => api(d, path, { method: 'POST', body: JSON.stringify(body) });
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

/** Uploads what the editor sends, as the page does. */
async function upload(body: string | Uint8Array, name = 'result-2.json'): Promise<string> {
  const res = await api(dash, 'uploads', { method: 'POST', body, headers: { 'x-filename': encodeURIComponent(name), 'content-type': 'application/octet-stream' } });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { uploadId: string }).uploadId;
}

/** Starts the fork and hands back the command line the server built. */
async function forked(body: Record<string, unknown>): Promise<string[]> {
  const before = spawned.length;
  const res = await post(dash, 'jobs', { kind: 'override', ...body });
  expect(res.status, await res.clone().text()).toBe(202);
  const job = (await res.json()) as JobView;
  expect(job.title).toBe('Forking');
  for (let i = 0; i < 200 && spawned.length === before; i++) await new Promise((r) => setTimeout(r, 10));
  for (let i = 0; i < 200; i++) {
    if (((await (await api(dash, `jobs/${job.id}`)).json()) as JobView).done) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return spawned[spawned.length - 1]!;
}

/** A run of a person's ask (a recorded user input), a tool call and a model call. */
function addRun(status: 'completed' | 'running'): string {
  // A recording in progress has just recorded its calls: one its recorder left long ago was interrupted.
  const t = status === 'running' ? Date.now() : 1_000;
  const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: project }, codeVersion: null, startedAt: t });
  const tool = (callNo: number, name: string, args: unknown, result: unknown, meta: Record<string, unknown> = {}) => {
    const identity = { kind: 'tool' as const, name, fingerprint: `fp${callNo}`, occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo, ...identity, origin: 'live', effect: 'read', requestRef: store.putJson({ args }), meta, at: t + callNo });
    store.appendCallEnd(identity, { runId: run.runId, callNo, attempt: 0, responseRef: store.putJson({ result }), outcome: 'ok', meta: {}, at: t + callNo });
  };
  tool(1, 'user_input', { prompt: 'How can I help?' }, { text: 'Refund order A-1042, please.' }, { input: true });
  tool(2, 'lookup_order', { order_id: 'A-1042' }, { order_id: 'A-1042', amount: 240 });
  const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'fp3', occurrence: 1 };
  store.appendCallStart({ runId: run.runId, callNo: 3, ...identity, origin: 'live', effect: null, requestRef: storeApiRequest(store, { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }), meta: { provider: 'anthropic' }, at: 3 });
  store.appendCallEnd(identity, { runId: run.runId, callNo: 3, attempt: 0, responseRef: store.putJson({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' }), outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'application/json' }, provider: 'anthropic' }, at: 4 });
  if (status === 'completed') store.endRun(run.runId, 'completed', 5_000);
  return run.runId;
}

beforeAll(async () => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-edit-fork-')));
  store = Store.open(':memory:');
  runId = addRun('completed');
  live = addRun('running');
  const spawner = cliSpawner({ command: [process.execPath, FAKE], cwd: tmpdir() });
  const common = { store, dbPath: ':memory:', project: { path: project } };
  dash = await startDashboard({ ...common, spawnCli: (args, o) => (spawned.push(args), spawner(['text-only'], o)) });
  ro = await startDashboard({ ...common, readOnly: true });
});

afterAll(async () => {
  await dash.close();
  await ro.close();
  store.close();
  rmSync(project, { recursive: true, force: true });
});

describe('Edit and fork', () => {
  it('forks with a tool’s result as edited, built as the fork menu builds its override', async () => {
    const uploadId = await upload('{\n  "order_id": "A-1042",\n  "amount": 40\n}');
    expect(await forked({ runId, callNo: 2, uploadId })).toEqual(['replay', runId, '--override', '2={"order_id":"A-1042","amount":40}']);
    // A result written as text goes as one JSON string.
    expect(await forked({ runId, callNo: 2, uploadId: await upload('"no such order"') })).toEqual(['replay', runId, '--override', '2="no such order"']);
  });

  it('hands a result too long to keep on the fork’s record to the CLI as the uploaded file', async () => {
    const long = JSON.stringify({ text: 'x'.repeat(OVERRIDE_INLINE) });
    const uploadId = await upload(long);
    const args = await forked({ runId, callNo: 2, uploadId });
    expect(args.slice(0, 3)).toEqual(['replay', runId, '--override']);
    expect(args[3]).toBe(`2=@.shadowlap/uploads/${uploadId}-result-2.json`);
  });

  it('answers a person differently, keeping the shape their answer was recorded in', async () => {
    const uploadId = await upload('Cancel the order instead.', 'answer-1.txt');
    expect(await forked({ runId, callNo: 1, uploadId })).toEqual(['replay', runId, '--override', '1={"text":"Cancel the order instead."}']);
  });

  it('refuses what isn’t JSON, isn’t text or is too large, and a call --override doesn’t change', async () => {
    const refused = async (body: Record<string, unknown>, status = 400) => {
      const res = await post(dash, 'jobs', { kind: 'override', ...body });
      expect(res.status, JSON.stringify(body)).toBe(status);
      return errorOf(res);
    };
    expect(await refused({ runId, callNo: 2, uploadId: await upload('{"amount": 40,}') })).toMatch(/^the edited result is not JSON: /);
    expect(await refused({ runId, callNo: 2, uploadId: await upload(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])) })).toBe('the edited result is not UTF-8 text');
    expect(await refused({ runId, callNo: 2, uploadId: await upload(`"${'x'.repeat(OVERRIDE_LIMIT)}"`) }, 413)).toMatch(/^the edited result is [\d,]+ bytes: at most 2,097,152$/);
    expect(await refused({ runId, callNo: 3, uploadId: await upload('{}') })).toBe("#3 is a model call: shadowlap replay --override changes a tool's result or what a person answered, nothing else");
    expect(await refused({ runId, callNo: 2, uploadId: 'nope' })).toMatch(/^uploadId: upload the edited result first/);
    expect(await refused({ runId, callNo: 9, uploadId: await upload('{}') })).toBe(`no call #9 in run ${runId}`);
    expect(await refused({ runId, callNo: 2.5, uploadId: await upload('{}') })).toMatch(/^callNo: /);
    expect(await refused({ runId: '01NOSUCHRUN000000000000000', callNo: 2, uploadId: await upload('{}') })).toBe('runId: name the run to fork');
    // A run still recording forks once it has ended, as the fork menu says.
    expect(await refused({ runId: live, callNo: 2, uploadId: await upload('{}') }, 409)).toBe(`${live.slice(0, 10)} is still recording: fork it once it has ended`);
    // An upload is used once.
    const once = await upload('{"amount": 40}');
    await forked({ runId, callNo: 2, uploadId: once });
    expect(await refused({ runId, callNo: 2, uploadId: once })).toMatch(/^uploadId: /);
  });

  it('changes nothing on a read-only dashboard', async () => {
    const res = await post(ro, 'jobs', { kind: 'override', runId, callNo: 2, uploadId: 'x' });
    expect(res.status).toBe(403);
  });
});
