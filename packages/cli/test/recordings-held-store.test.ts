import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { RecordingHost, type RecordedCalls, type RecordingResult } from '../src/recordings.js';

/**
 * A test that lists its calls, or ends its recording, while another process holds the store (the
 * dashboard, gc, another recording) is answered once its rows are written, waiting on the store
 * writer's timer and never on the thread every other test's answers stream on. Here the store is let
 * go by a timer of this process, which a wait on the thread would hold up past the writer's deadline.
 */
const dir = mkdtempSync(join(tmpdir(), 'sl-recordings-held-'));
const holders: ChildProcess[] = [];
afterAll(() => {
  for (const h of holders) h.kill();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** Another process holding the store's write lock until it is told to let go (20 s at most). */
async function holdStore(path: string): Promise<{ release: () => Promise<void> }> {
  const child = spawn(process.execPath, ['-e', `const db = new (require('node:sqlite').DatabaseSync)(process.env.DB); db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked\\n'); const done = () => { db.exec('COMMIT'); db.close(); process.exit(0); }; process.stdin.once('data', done); setTimeout(done, 20000);`], { env: { ...process.env, DB: path }, stdio: ['pipe', 'pipe', 'ignore'] });
  holders.push(child);
  await new Promise<void>((resolve) => child.stdout.on('data', (chunk: Buffer) => chunk.toString('utf8').includes('locked') && resolve()));
  return {
    release: async () => {
      if (child.exitCode !== null) return;
      child.stdin.end('let go\n');
      await once(child, 'exit');
    },
  };
}

async function post<T>(url: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

describe('a recording a test ends while another process holds the store', () => {
  it('lists its calls and is packed once its rows are written, without holding the thread', async () => {
    const path = join(dir, 'store.db');
    const root = join(dir, 'project');
    const store = Store.open(path);
    const host = new RecordingHost(store, root, { codeVersion: null, redact: [] });
    const sidecar = await Sidecar.start({ store, upstreams: {}, api: host.api });
    host.attach(sidecar);
    const api = <T>(route: string, body: unknown) => post<T>(`${sidecar.url}/v1/recordings/${route}`, body);
    try {
      const rec = (await api<{ runId: string; mode: string }>('start', { recording: 'recs/held', slot: 'w' })).body;
      expect(rec.mode).toBe('record');
      const lock = await holdStore(path);
      // Two tool calls with the store held: answered at once, their rows waiting their turn.
      const base = sidecar.envForSlot('w').SHADOWLAP_URL;
      for (const order of ['A-1', 'A-2']) {
        const r = (await post<{ origin: string; callNo: number }>(`${base}/v1/calls/resolve`, { kind: 'tool', name: 'lookup_order', effect: 'read', args: { order }, implHash: 'h' })).body;
        expect(r.origin).toBe('live');
        await post(`${base}/v1/calls/${r.callNo}/complete`, { outcome: 'ok', result: { order, status: 'delivered' }, latencyMs: 1 });
      }
      // Let go by this process's timer: it runs only while nothing waits on the thread.
      const letGo = new Promise<void>((resolve) => setTimeout(() => void lock.release().then(resolve), 400));
      const listed = await api<RecordedCalls>('calls', { runId: rec.runId });
      expect(listed.body.calls.map((c) => c.args)).toEqual([{ order: 'A-1' }, { order: 'A-2' }]);
      await letGo;

      // Ended with the store held again: packed once its rows, and its end, are written.
      const again = await holdStore(path);
      const r = (await post<{ origin: string; callNo: number }>(`${base}/v1/calls/resolve`, { kind: 'tool', name: 'lookup_order', effect: 'read', args: { order: 'A-3' }, implHash: 'h' })).body;
      await post(`${base}/v1/calls/${r.callNo}/complete`, { outcome: 'ok', result: { order: 'A-3', status: 'lost' }, latencyMs: 1 });
      setTimeout(() => void again.release(), 400);
      const ended = await api<RecordingResult>('end', { runId: rec.runId, passed: true });
      expect(ended.body).toMatchObject({ ok: true, mode: 'record', saved: true, calls: 3 });
      expect(readFileSync(join(root, 'recs/held/calls.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3);
    } finally {
      await sidecar.close();
      store.close();
    }
  }, 60_000);
});
