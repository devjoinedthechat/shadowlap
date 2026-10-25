import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fingerprintApi, Store } from '@shadowlap/engine';
import { message, text } from '@shadowlap-testing/mock-anthropic';
import { cpuOnce, times } from '../../engine/test/timing.js';
import { clockMarks, servesClock } from '../src/fingerprint-cache.js';
import { Sidecar } from '../src/server.js';

/**
 * Replay start reads fingerprints from the cache instead of reading and hashing every recorded
 * request again: a replay of a 1,000-call recording starts on a small part of the work it takes
 * without the cache. An entry is served only where the replay's dates mask its request exactly as
 * they did when it was made.
 */

const DAY = 86_400_000;
const command = { argv: ['agent'], cwd: '/' };

let upstream: Server;
let url: string;
beforeAll(async () => {
  // Answers every model call at once, whatever it asks.
  const reply = JSON.stringify(message([text('ok')]));
  upstream = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(reply);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sl-fpcache-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** An agent's n-th request: a dated system prompt, tools, and the last 40 turns of a growing conversation. */
function request(n: number, today: string): unknown {
  const turns = Array.from({ length: Math.min(n, 40) }, (_, i) => {
    const k = n - Math.min(n, 40) + i;
    return { role: k % 2 ? 'assistant' : 'user', content: `turn ${k}: ${'the customer asks about order A-1042 and its refund, '.repeat(6)}` };
  });
  return {
    model: 'claude-opus-5',
    max_tokens: 256,
    system: `You are a support agent. Today is ${today}. Policy revised 2024-03-01. ${'Be brief and cite the policy. '.repeat(40)}`,
    tools: Array.from({ length: 8 }, (_, i) => ({ name: `tool_${i}`, description: `Tool ${i}. ${'Looks up records by id. '.repeat(12)}`, input_schema: { type: 'object', properties: { id: { type: 'string' } } } })),
    messages: [...turns, { role: 'user', content: `step ${n}` }],
  };
}

async function ask(sidecar: Sidecar, runId: string, body: unknown): Promise<void> {
  const res = await fetch(`${sidecar.envFor(runId).ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  await res.arrayBuffer();
}

describe('replay start', () => {
  it('starts a 1,000-call replay from the fingerprints the recording cached, without reading its requests again', async () => {
    const path = join(dir, 'thousand.db');
    const store = Store.open(path);
    const logs: string[] = [];
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: url }, log: (l) => logs.push(l) });
    try {
      const today = day(Date.now());
      const rec = sidecar.startRun({ mode: 'record', command });
      for (let n = 1; n <= 1_000; n++) await ask(sidecar, rec.runId, request(n, today));
      sidecar.endRun(rec.runId, 'completed');

      // The CPU the start takes: what this machine does for it, which a busy machine doesn't stretch
      // as it stretches the time it takes.
      const timed = () => {
        const { out: run, ms } = cpuOnce(() => sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command }));
        sidecar.endRun(run.runId, 'completed');
        return ms;
      };
      // The first replay after the recording: every fingerprint is in the cache already.
      logs.length = 0;
      const cached = timed();
      expect(logs.join('\n')).toMatch(/re-fingerprinting 1000 calls under the current normalizers \(1000 from the cache\)/);

      // Without the cache, every request is read and hashed again; that fills the cache back up.
      const other = new DatabaseSync(path);
      other.exec('DELETE FROM fingerprint_cache');
      other.close();
      logs.length = 0;
      const uncached = timed();
      expect(logs.join('\n')).toMatch(/\(0 from the cache\)/);
      // Held against the start without the cache, never a number of milliseconds: from the cache it
      // takes about a twentieth of the CPU (measured: 35 ms against 680 ms).
      expect(cached, `from the cache the start took ${times(cached, uncached)} the start without it`).toBeLessThan(uncached / 4);
      logs.length = 0;
      timed();
      expect(logs.join('\n')).toMatch(/\(1000 from the cache\)/);

      // And the replay still matches every call.
      const run = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command });
      for (let n = 1; n <= 1_000; n += 250) await ask(sidecar, run.runId, request(n, today));
      const ended = sidecar.endRun(run.runId, 'completed');
      expect(ended.summary.byOrigin.replayed).toBe(4);
      expect(ended.summary.byOrigin.live).toBe(0);
    } finally {
      await sidecar.close();
      store.close();
    }
  }, 120_000);

  it("works a call's fingerprint out again when the replay's date masks its request differently", async () => {
    // Recorded five days ago, its request naming a date five days after that: today, which the
    // recording's own clock left as it was and the replay's masks.
    const now = Date.now();
    const today = day(now);
    const store = Store.open(join(dir, 'dated.db'));
    const logs: string[] = [];
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: url }, log: (l) => logs.push(l) });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now - 5 * DAY);
    let parent: string;
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      parent = rec.runId;
      await ask(sidecar, rec.runId, { model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: `Ship it on ${today}.` }] });
      await ask(sidecar, rec.runId, { model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: 'No date here.' }] });
      sidecar.endRun(rec.runId, 'completed');
    } finally {
      clock.mockRestore();
    }
    try {
      logs.length = 0;
      const run = sidecar.startRun({ mode: 'replay', parentRunId: parent, command });
      // The dated call's entry no longer holds; the other one does.
      expect(logs.join('\n')).toMatch(/re-fingerprinting 2 calls under the current normalizers \(1 from the cache\)/);
      await ask(sidecar, run.runId, { model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: `Ship it on ${today}.` }] });
      await ask(sidecar, run.runId, { model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: 'No date here.' }] });
      const ended = sidecar.endRun(run.runId, 'completed');
      expect(ended.summary.divergence).toBeNull();
      expect(ended.summary.byOrigin.replayed).toBe(2);
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('reads the dates in a call\'s query as its fingerprint does, decoded, so a replay that masks them again works it out again', async () => {
    // A datetime the agent sends in the query, as URLSearchParams and httpx encode it (':' as %3A):
    // five days after the recording, so the recording left it as it was, and today, so the replay masks it.
    const now = Date.now();
    const since = new URLSearchParams({ since: `${day(now)}T09:00:00Z` }).toString();
    expect(since).toContain('%3A');
    const store = Store.open(join(dir, 'dated-query.db'));
    const logs: string[] = [];
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: url }, log: (l) => logs.push(l) });
    const asked = async (runId: string) => {
      const res = await fetch(`${sidecar.envFor(runId).ANTHROPIC_BASE_URL}/v1/messages?${since}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: 'Orders since then?' }] }),
      });
      await res.arrayBuffer();
    };
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now - 5 * DAY);
    let parent: string;
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      parent = rec.runId;
      await asked(rec.runId);
      sidecar.endRun(rec.runId, 'completed');
    } finally {
      clock.mockRestore();
    }
    try {
      logs.length = 0;
      const run = sidecar.startRun({ mode: 'replay', parentRunId: parent, command });
      // The entry holds the datetime unmasked, which this replay masks: worked out again.
      expect(logs.join('\n')).toMatch(/re-fingerprinting 1 call under the current normalizers \(0 from the cache\)/);
      await asked(run.runId);
      const ended = sidecar.endRun(run.runId, 'completed');
      expect(ended.summary.divergence).toBeNull();
      expect(ended.summary.byOrigin.replayed).toBe(1);
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});

describe('the cache in the store', () => {
  it('keeps the entries of requests still recorded, and gc drops those of requests it deletes', async () => {
    const path = join(dir, 'gc.db');
    const store = Store.open(path);
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: url } });
    const entries = () => {
      const db = new DatabaseSync(path);
      const n = Number(db.prepare('SELECT COUNT(*) AS n FROM fingerprint_cache').get()?.n);
      db.close();
      return n;
    };
    try {
      const kept = sidecar.startRun({ mode: 'record', command });
      await ask(sidecar, kept.runId, request(1, 'a day'));
      sidecar.endRun(kept.runId, 'completed');
      const gone = sidecar.startRun({ mode: 'record', command });
      await ask(sidecar, gone.runId, request(2, 'another day'));
      await ask(sidecar, gone.runId, request(3, 'another day'));
      sidecar.endRun(gone.runId, 'completed');
      expect(entries()).toBe(3);
      store.deleteRun(gone.runId);
      expect(store.gcBlobs().removed).toBeGreaterThan(0);
      expect(entries()).toBe(1);
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});

describe('a cached fingerprint', () => {
  it('is served only where the request would mask to the same fingerprint, on a grid of dates and starts', () => {
    // Values around a recording's start: dates, datetimes (36 h window) whose date (60 h window) is
    // read on its own when the datetime is left, and epoch values in seconds and milliseconds.
    const recorded = Date.UTC(2026, 9, 1, 12);
    const offsets = [-80, -61, -59, -37, -35, -12, 0, 12, 35, 37, 47, 59, 61, 80, 120].map((h) => h * 3_600_000);
    const values = offsets.flatMap((o) => {
      const t = recorded + o;
      const iso = new Date(t).toISOString();
      return [iso.slice(0, 10), `${iso.slice(0, 10)} ${iso.slice(11, 16)}`, iso, Math.floor(t / 1000), t];
    });
    const fingerprint = (body: unknown, clock: readonly number[]) => fingerprintApi({ method: 'POST', path: '/v1/messages', headers: {}, body }, [], [], clock).fingerprint;
    let served = 0;
    let refused = 0;
    let checked = 0;
    for (let i = 0; i < values.length; i++) {
      for (let j = i; j < Math.min(values.length, i + 3); j++) {
        const body = { system: `Today is ${String(values[i])}.`, messages: [{ role: 'user', content: `due ${String(values[j])}` }], at: values[j] };
        // Made by the recording itself, or by a replay of a recording made two days before it.
        for (const then of [[recorded], [recorded - 2 * DAY, recorded]]) {
          const marks = clockMarks([body], then);
          const cachedFingerprint = fingerprint(body, then);
          // A replay of it at every hour from four days before to six days after.
          for (let h = -96; h <= 144; h += 1) {
            const replay = [recorded, recorded + h * 3_600_000];
            checked++;
            if (!servesClock(marks, replay)) {
              refused++;
              continue;
            }
            served++;
            expect(fingerprint(body, replay), `${JSON.stringify(body)} made under ${then.length} start(s), replayed at ${h} h`).toBe(cachedFingerprint);
          }
        }
      }
    }
    // Most replays take the cache; those whose start masks the request differently don't.
    expect(served).toBeGreaterThan(checked / 2);
    expect(refused).toBeGreaterThan(0);
  });

  it('holds for any replay when its request holds no date at all', () => {
    const body = { messages: [{ role: 'user', content: 'hello' }], max_tokens: 1234 };
    const marks = clockMarks([body], [Date.UTC(2026, 0, 1)]);
    expect(marks).toEqual([]);
    for (const at of [Date.UTC(2020, 0, 1), Date.UTC(2026, 0, 2), Date.UTC(2030, 5, 5)]) expect(servesClock(marks, [Date.UTC(2026, 0, 1), at])).toBe(true);
  });
});
