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

  it('fails a replay that stops before its recording did, though every call it made matched, and keeps it', async () => {
    const rec = (await api<{ runId: string }>('start', { recording: 'recs/early', slot: 'w' })).body;
    await tool('lookup_order', 'read', { order_id: 'A-1042' }, { status: 'delivered' });
    await ask('refund A-1042');
    await tool('send_refund', 'write', { order_id: 'A-1042' }, { ok: true });
    await ask('done?');
    expect((await api<RecordingResult>('end', { runId: rec.runId, passed: true })).body).toMatchObject({ ok: true, saved: true });

    // The test makes only the lookup, and still passes: the refund and the last model turn never happen.
    const replay = (await api<{ runId: string }>('start', { recording: 'recs/early', slot: 'w', mode: 'none' })).body;
    expect(await tool('lookup_order', 'read', { order_id: 'A-1042' }, { status: 'delivered' })).toBe('replayed');
    const result = (await api<RecordingResult>('end', { runId: replay.runId, passed: true })).body;
    expect(result).toMatchObject({ ok: false, mode: 'replay', calls: 1, replayed: 1, message: 'ended early at call 2 (api POST /v1/messages): 1 of 4 recorded calls replayed' });
    expect(result.report).toContain('✗ Ended early at call 2: 1 of 4 recorded calls replayed');
    expect(result.report).toContain('3 recorded calls not reached: #2 POST /v1/messages, #3 send_refund, #4 POST /v1/messages');
    expect(result.report).toContain('record the test again with SHADOWLAP_RECORD=all');
    // Kept for inspection, with where it stopped on the run itself.
    expect(store.getRun(replay.runId)?.divergence).toMatchObject({ type: 'ended_early', callNo: 2, recorded: 4 });
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
