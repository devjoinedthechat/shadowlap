import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '../src/server.js';

/**
 * A run that starts or ends while another process holds the store (the dashboard, gc, another
 * recording): neither waits on the thread the agents' answers stream on, so another run's stream
 * goes on as it came; the run's record, its calls and its end are written in order once the store is
 * free. A read of the run in this process finds what was said of it even before then.
 */

const command = { argv: ['agent'], cwd: '/' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sl-runlock-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const servers: Server[] = [];
const holders: ChildProcess[] = [];
afterEach(async () => {
  for (const h of holders.splice(0)) h.kill();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** Another process holding the store's write lock: until it is told to let go, or `ms` at most. */
async function holdLock(path: string, ms: number): Promise<{ release: () => Promise<void> }> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(process.env.DB);
       db.exec('BEGIN IMMEDIATE');
       process.stdout.write('locked\\n');
       const done = () => { db.exec('COMMIT'); db.close(); process.stdout.write('released\\n'); process.exit(0); };
       process.stdin.once('data', done);
       setTimeout(done, Number(process.env.HOLD_MS));`,
    ],
    { env: { ...process.env, DB: path, HOLD_MS: String(ms) }, stdio: ['pipe', 'pipe', 'ignore'] },
  );
  holders.push(child);
  const said = (word: string) =>
    new Promise<void>((resolve) => {
      const seen = (chunk: Buffer) => {
        if (!chunk.toString('utf8').includes(word)) return;
        child.stdout.off('data', seen);
        resolve();
      };
      child.stdout.on('data', seen);
    });
  await said('locked');
  return {
    release: async () => {
      const released = child.exitCode === null ? said('released') : Promise.resolve();
      child.stdin.end('let go\n');
      await released;
      if (child.exitCode === null) await once(child, 'exit');
    },
  };
}

/** An OpenAI-shaped stream of `n` chunks, one every `ms`. */
async function streamingUpstream(n: number, ms: number): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let sent = 0;
      const timer = setInterval(() => {
        res.write(`data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"${sent}"}}]}\n\n`);
        if (++sent === n) {
          clearInterval(timer);
          res.end('data: [DONE]\n\n');
        }
      }, ms);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A streamed model call for `runId`, and the longest wait between two of its chunks. */
async function streamed(sidecar: Sidecar, runId: string): Promise<{ longestGap: number; chunks: number }> {
  const res = await fetch(`${sidecar.envFor(runId).OPENAI_BASE_URL}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer k' }, body: JSON.stringify({ model: 'gpt-5', stream: true, messages: [{ role: 'user', content: 'count' }] }) });
  const reader = res.body!.getReader();
  let last = performance.now();
  let longestGap = 0;
  let chunks = 0;
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
    const now = performance.now();
    longestGap = Math.max(longestGap, now - last);
    last = now;
    chunks++;
  }
  return { longestGap, chunks };
}

/** A clock read through the SDKs' resolution API, as `now()` makes one. */
async function clockRead(sidecar: Sidecar, runId: string): Promise<number> {
  const res = await fetch(`${sidecar.url}/r/${runId}/v1/calls/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'clock', name: 'now', label: '' }) });
  return ((await res.json()) as { result: number }).result;
}

/** The store as another process reads it, beside the lock (WAL lets a reader through). */
function readBeside(path: string) {
  const db = new DatabaseSync(path);
  const run = (runId: string) => db.prepare(`SELECT status, ended_at, meta FROM runs WHERE run_id = ?`).get(runId) as { status: string; ended_at: number | null; meta: string | null } | undefined;
  const calls = (runId: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM call_events WHERE run_id = ?`).get(runId) as { n: number }).n);
  return { run, calls, close: () => db.close() };
}

describe('a run that starts or ends while another process holds the store', () => {
  it("holds no other run's stream up, and is written in order once the store is free", async () => {
    const path = join(dir, 'held.db');
    const store = Store.open(path);
    const upstream = await streamingUpstream(30, 50);
    const sidecar = await Sidecar.start({ store, upstreams: { openai: upstream } });
    const beside = readBeside(path);
    try {
      const a = sidecar.startRun({ mode: 'record', command });
      const b = sidecar.startRun({ mode: 'record', command });
      await clockRead(sidecar, b.runId);
      expect(beside.calls(b.runId)).toBe(2);

      const lock = await holdLock(path, 4_000);
      const stream = streamed(sidecar, a.runId);
      await sleep(150);
      // A run starts, and another ends, with the store held: each takes one short try at the lock.
      let t = performance.now();
      const c = sidecar.startRun({ mode: 'record', command, meta: { author: 'dana@example.com' } });
      const startMs = performance.now() - t;
      t = performance.now();
      const ended = sidecar.endRun(b.runId, 'completed');
      const endMs = performance.now() - t;
      expect(startMs).toBeLessThan(300);
      expect(endMs).toBeLessThan(300);
      // The ended run reads as it ended, and as its calls were.
      expect(ended.run).toMatchObject({ runId: b.runId, status: 'completed' });
      expect(ended.summary.total).toBe(1);
      // Its new run's calls are answered meanwhile, as any agent's are.
      expect(typeof (await clockRead(sidecar, c.runId))).toBe('number');
      await sleep(800);
      // Nothing of it reached the store yet.
      expect(beside.run(c.runId)).toBeUndefined();
      expect(beside.run(b.runId)?.status).toBe('running');

      await lock.release();
      await sidecar.settled();
      // Written in order once the store was free: the start with what it was given to keep, its call, the other's end.
      const written = beside.run(c.runId)!;
      expect(JSON.parse(written.meta!)).toMatchObject({ author: 'dana@example.com' });
      expect(beside.calls(c.runId)).toBe(2);
      expect(beside.run(b.runId)).toMatchObject({ status: 'completed', ended_at: ended.run.endedAt });
      // The stream went on while the store was held: one chunk every 50 ms, never one long wait.
      const { longestGap, chunks } = await stream;
      expect(chunks).toBeGreaterThanOrEqual(30);
      expect(longestGap).toBeLessThan(500);
      sidecar.endRun(a.runId, 'completed');
      sidecar.endRun(c.runId, 'completed');
    } finally {
      beside.close();
      await sidecar.close();
      store.close();
    }
  }, 30_000);

  it('is found by a read of it in this process before the store is free, which waits for its writes', async () => {
    const path = join(dir, 'read-your-writes.db');
    const store = Store.open(path);
    const sidecar = await Sidecar.start({ store });
    try {
      await holdLock(path, 600);
      const run = sidecar.startRun({ mode: 'record', command });
      // Stamped as a command stamps a run it starts: through the store, which makes the run's start first.
      store.updateRunMeta(run.runId, { author: 'eli@example.com' });
      expect(store.getRun(run.runId)).toMatchObject({ runId: run.runId, status: 'running', meta: { author: 'eli@example.com' } });
      await clockRead(sidecar, run.runId);
      const ended = sidecar.endRun(run.runId, 'completed');
      expect(ended.summary.total).toBe(1);
      expect(store.getCalls(run.runId)).toHaveLength(1);
      expect(store.getRun(run.runId)).toMatchObject({ status: 'completed' });
    } finally {
      await sidecar.close();
      store.close();
    }
  }, 30_000);

  it('a replay of a run this process just recorded reads it whole, its queued writes made first', async () => {
    const path = join(dir, 'replay-queued.db');
    const store = Store.open(path);
    const sidecar = await Sidecar.start({ store });
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      const recorded = await clockRead(sidecar, rec.runId);
      await holdLock(path, 600);
      // Its end is queued behind the lock; the replay's start reads it and its calls, waiting for them.
      sidecar.endRun(rec.runId, 'completed');
      const replay = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command });
      expect(await clockRead(sidecar, replay.runId)).toBe(recorded);
      expect(sidecar.endRun(replay.runId, 'completed').summary).toMatchObject({ divergence: null, byOrigin: { replayed: 1 } });
    } finally {
      await sidecar.close();
      store.close();
    }
  }, 30_000);
});
