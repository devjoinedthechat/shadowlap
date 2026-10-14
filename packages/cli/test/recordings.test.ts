import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { RecordingHost, type RecordedCalls, type RecordingResult } from '../src/recordings.js';

/** The recordings API behind the pytest and Vitest plugins, driven the way their clients drive it. */
let mock: MockServer;
let store: Store;
let sidecar: Sidecar;
let root: string;

beforeAll(async () => {
  mock = await startMockAnthropic({ script: (ctx) => ({ message: message([text(`turn ${ctx.assistantTurns}`)]) }) });
  store = Store.open(':memory:');
  root = mkdtempSync(join(tmpdir(), 'fp-recordings-'));
  const host = new RecordingHost(store, root, { codeVersion: null, redact: [] });
  sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url }, api: host.api });
  host.attach(sidecar);
});
afterAll(async () => {
  await sidecar.close();
  await mock.close();
  store.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function post<T>(url: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

/** What the SDK's tool() does: resolve, then run and complete unless the call was served or fenced. */
async function tool(name: string, effect: 'read' | 'write', args: unknown, result: unknown): Promise<string> {
  const base = sidecar.envForSlot('w').SHADOWLAP_URL!;
  const r = (await post<{ origin: string; callNo: number }>(`${base}/v1/calls/resolve`, { kind: 'tool', name, effect, args, implHash: 'h' })).body;
  if (r.origin === 'live') await post(`${base}/v1/calls/${r.callNo}/complete`, { outcome: 'ok', result, latencyMs: 1 });
  return r.origin;
}
const ask = (content: string) => post(`${sidecar.envForSlot('w').ANTHROPIC_BASE_URL}/v1/messages`, { model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content }] });
const api = <T>(path: string, body: unknown) => post<T>(`${sidecar.url}/v1/recordings/${path}`, body);

describe('recorded calls for tests', () => {
  it('lists the calls a test made so far and its last answer, while recording and while replaying', async () => {
    const rec = (await api<{ runId: string; mode: string }>('start', { recording: 'recs/refund', slot: 'w' })).body;
    expect(rec.mode).toBe('record');
    await tool('lookup_order', 'read', { order_id: 'A-1042' }, { status: 'delivered' });
    await ask('refund A-1042');
    let seen = (await api<RecordedCalls>('calls', { runId: rec.runId })).body;
    expect(seen.calls).toEqual([
      { callNo: 1, kind: 'tool', name: 'lookup_order', origin: 'live', outcome: 'ok', args: { order_id: 'A-1042' }, result: { status: 'delivered' } },
      { callNo: 2, kind: 'api', name: 'POST /v1/messages', origin: 'live', outcome: 'ok', model: 'claude-opus-5' },
    ]);
    expect(seen.answer).toBe('turn 0');
    expect((await api<RecordingResult>('end', { runId: rec.runId, passed: true })).body).toMatchObject({ ok: true, saved: true });

    // The replay forks at the changed lookup; the write after it is blocked, and shows as such.
    const replay = (await api<{ runId: string; mode: string }>('start', { recording: 'recs/refund', slot: 'w', mode: 'none' })).body;
    expect(replay.mode).toBe('replay');
    expect(await tool('lookup_order', 'read', { order_id: 'B-7' }, { status: 'lost' })).toBe('live');
    expect(await tool('send_email', 'write', { to: 'customer@example.com' }, null)).toBe('blocked');
    seen = (await api<RecordedCalls>('calls', { runId: replay.runId })).body;
    expect(seen.calls.map((c) => [c.name, c.origin, c.outcome])).toEqual([
      ['lookup_order', 'live', 'ok'],
      ['send_email', 'blocked', 'error'],
    ]);
    expect(seen.answer).toBeNull();
    expect((await api<RecordingResult>('end', { runId: replay.runId, passed: true })).body).toMatchObject({ ok: false });
    expect((await api('calls', { runId: replay.runId })).status).toBe(404);
  });
});

describe('shadowlap serve --recordings', () => {
  it('prints where the capture modules are, and they are there', async () => {
    const cli = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
    const child = spawn(process.execPath, [cli, 'serve', '--recordings'], { cwd: root, env: { ...process.env, SHADOWLAP_TELEMETRY: '0' }, stdio: ['pipe', 'pipe', 'inherit'] });
    const line = await new Promise<string>((resolve) => {
      let out = '';
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString();
        if (out.includes('\n')) resolve(out.slice(0, out.indexOf('\n')));
      });
    });
    const info = JSON.parse(line) as { capture: { node: string; python: string } };
    expect(existsSync(info.capture.node), info.capture.node).toBe(true);
    expect(existsSync(join(info.capture.python, '_shadowlap_capture.py')), info.capture.python).toBe(true);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.stdin.end();
    await exited;
  });
});
