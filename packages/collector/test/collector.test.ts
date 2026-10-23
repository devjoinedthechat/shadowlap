import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CollectorStore, startCollector, validateBatch, type Collector, type ValidEvent } from '../src/index.js';
import { PROVIDERS, SDKS } from '../src/schema.js';
import { KNOWN_PROVIDERS, KNOWN_SDKS } from '../../cli/src/telemetry.js';

const NOW = Date.now();
const event = (over: Record<string, unknown> = {}) => ({
  type: 'replay',
  at: NOW,
  version: '0.1.0',
  os: 'darwin',
  arch: 'arm64',
  node: '22.18.0',
  ci: null,
  providers: ['anthropic'],
  sdks: ['typescript'],
  calls: 30,
  replayed: 30,
  live: 0,
  blocked: 0,
  stubbed: 0,
  overridden: 0,
  divergence: null,
  tokensNotRespent: 12000,
  durationMs: 800,
  exitCode: 0,
  ...over,
});
const batch = (events: unknown[], installId = '123e4567-e89b-12d3-a456-426614174000') => ({ v: 1, installId, sentAt: NOW, events });

describe('validateBatch', () => {
  it('allows exactly the values the CLI client sends', () => {
    expect([...SDKS].sort()).toEqual([...KNOWN_SDKS].sort());
    expect([...PROVIDERS].sort()).toEqual([...KNOWN_PROVIDERS].sort());
  });
  it('accepts a well-formed batch', () => {
    expect(validateBatch(batch([event()])).events[0]!.type).toBe('replay');
  });
  it('rejects unknown fields, free text and out-of-range values', () => {
    expect(() => validateBatch(batch([event({ prompt: 'secret' })]))).toThrow(/unexpected field "prompt"/);
    expect(() => validateBatch({ ...batch([event()]), path: '/home/x' })).toThrow(/unexpected field "path"/);
    expect(() => validateBatch(batch([event({ os: 'my-laptop' })]))).toThrow(/os must be one of/);
    expect(() => validateBatch(batch([event({ providers: ['cohere'] })]))).toThrow(/providers must be one of/);
    expect(() => validateBatch(batch([event({ version: 'v1 (custom build)' })]))).toThrow(/version/);
    expect(() => validateBatch(batch([event({ calls: -1 })]))).toThrow(/calls/);
    expect(() => validateBatch(batch([event({ divergence: 'because the prompt said secret' })]))).toThrow(/divergence must be one of/);
    expect(() => validateBatch(batch([event()], 'acme/repo'))).toThrow(/installId/);
    expect(() => validateBatch(batch([]))).toThrow(/events must hold/);
    expect(() => validateBatch(batch(Array(51).fill(event())))).toThrow(/events must hold/);
  });

  it('refuses a time more than a day ahead of the collector\'s clock, or before 2025', () => {
    const DAY = 86_400_000;
    // A client's clock may run a little fast.
    expect(validateBatch(batch([event({ at: NOW + DAY - 60_000 })]), NOW).events).toHaveLength(1);
    for (const at of [NOW + DAY + 60_000, NOW + 365 * DAY, Date.UTC(2099, 11, 31)]) expect(() => validateBatch(batch([event({ at })]), NOW), String(at)).toThrow(/at must not be more than a day ahead/);
    for (const at of [Date.UTC(2023, 11, 31), Date.UTC(2024, 5, 1), 0]) expect(() => validateBatch(batch([event({ at })]), NOW), String(at)).toThrow(/at must not be before 2025/);
    expect(() => validateBatch({ ...batch([event()]), sentAt: NOW + 2 * DAY }, NOW)).toThrow(/sentAt must not be more than a day ahead/);
    expect(() => validateBatch(batch([event({ at: NOW + 0.5 })]), NOW)).toThrow(/at must be a millisecond timestamp/);
  });
});

describe('the store', () => {
  it('drops events an unchecked collector took with a time it refuses, so they count for nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-collector-'));
    try {
      const db = join(dir, 'collector.db');
      const before = new CollectorStore(db);
      // As a collector that took any time up to 2100 stored them.
      before.ingest({ v: 1, installId: '123e4567-e89b-12d3-a456-426614174000', sentAt: NOW, events: [event(), event({ at: Date.UTC(2099, 0, 1), tokensNotRespent: 10 ** 12 }), event({ at: Date.UTC(2024, 0, 2) })] as ValidEvent[] });
      before.close();
      const after = new CollectorStore(db);
      const stats = after.stats(NOW);
      expect(stats.events.total).toBe(1);
      expect(stats.events.last7d).toBe(1);
      expect(stats.tokensNotRespent).toBe(12000);
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dashboard', () => {
  it('shows an empty state, then the numbers, and refreshes cached aggregates when a batch arrives', async () => {
    const c = await startCollector({ db: ':memory:', rateLimitPerMinute: 100, statsCacheMs: 60_000 });
    try {
      const empty = await (await fetch(`${c.url}/`)).text();
      expect(empty).toContain('No events yet');
      expect(empty).toContain(`SHADOWLAP_TELEMETRY_URL=${c.url}/v1/events`);
      const DAY = 86_400_000;
      const events = [
        event({ at: NOW - 1000, os: 'linux', ci: 'github', sdks: ['mcp'] }),
        event({ at: NOW - 2000, divergence: 'new_call', replayed: 5, live: 25 }),
        event({ at: NOW - 9 * DAY }), // the previous 7-day window
        event({ type: 'run', at: NOW - 3000, replayed: 0, live: 30 }),
      ];
      expect((await fetch(`${c.url}/v1/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch(events)) })).status).toBe(202);
      // Cached for a minute, but ingesting invalidated it.
      const stats = (await (await fetch(`${c.url}/v1/stats`)).json()) as { installs: { active7d: number; active7dPrev: number }; replays: { last30d: number; clean30d: number }; callsReplayed: number; os: Record<string, number>; ciSystems: Record<string, number>; sdks: Record<string, number>; weekly: Array<{ week: string; activeDevelopers: number; replays: number }>; daily: Array<{ clean: number; forked: number }> };
      expect(stats.installs).toMatchObject({ active7d: 1, active7dPrev: 1 });
      expect(stats.replays).toMatchObject({ last30d: 3, clean30d: 2 });
      expect(stats.callsReplayed).toBe(65);
      expect(stats.os).toEqual({ darwin: 1, linux: 1 });
      expect(stats.ciSystems).toEqual({ github: 1 });
      expect(stats.sdks.mcp).toBe(1);
      expect(stats.weekly).toHaveLength(12);
      expect(new Date(`${stats.weekly[0]!.week}T00:00:00Z`).getUTCDay()).toBe(1); // Mondays
      expect(stats.weekly.at(-1)!.activeDevelopers).toBe(1);
      expect(stats.weekly.reduce((n, w) => n + w.replays, 0)).toBe(3);
      expect(stats.daily.reduce((n, d) => n + d.clean, 0)).toBe(2);
      expect(stats.daily.reduce((n, d) => n + d.forked, 0)).toBe(1);
      const html = await (await fetch(`${c.url}/`)).text();
      expect(html).not.toContain('No events yet');
      expect(html).toContain('flat vs previous 7 days');
      expect(html).toContain('MCP proxy');
      expect(html).toContain('GitHub Actions');
      expect(html).toContain('new call');
      expect((await fetch(`${c.url}/v1/stats`)).headers.get('access-control-allow-origin')).toBe('*');
    } finally {
      await c.close();
    }
  });
});

describe('collector server', () => {
  let c: Collector;
  beforeAll(async () => {
    c = await startCollector({ db: ':memory:', rateLimitPerMinute: 100 });
  });
  afterAll(() => c.close());

  const post = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) => fetch(`${c.url}/v1/events`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('ingests valid batches and rejects invalid ones with the reason', async () => {
    expect((await post(batch([event(), event({ type: 'run', replayed: 0, live: 30 })]))).status).toBe(202);
    const bad = await post(batch([event({ hostname: 'x' })]));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/unexpected field "hostname"/);
    expect((await post('{not json')).status).toBe(400);
    expect((await post(batch([event()]), { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post('x'.repeat(70_000))).status).toBe(413);
    // A time from years ahead is refused with the reason, and counts for nothing.
    const ahead = await post(batch([event({ at: Date.UTC(2099, 0, 1) })]));
    expect(ahead.status).toBe(400);
    expect(((await ahead.json()) as { error: string }).error).toMatch(/at must not be more than a day ahead/);
  });

  it('serves aggregate stats and a dashboard without any raw data', async () => {
    await post(batch([event({ ci: 'github', divergence: 'request_changed', replayed: 10, live: 20 })], 'ci-' + 'a'.repeat(32)));
    const stats = (await (await fetch(`${c.url}/v1/stats`)).json()) as { installs: { total: number; active7d: number; ci: number }; replays: { total: number; clean: number; forked: number; divergenceByType: Record<string, number> }; tokensNotRespent: number; providers: Record<string, number> };
    expect(stats.installs.total).toBe(2);
    expect(stats.installs.active7d).toBe(2);
    expect(stats.installs.ci).toBe(1);
    expect(stats.replays).toMatchObject({ total: 2, clean: 1, forked: 1, divergenceByType: { request_changed: 1 } });
    expect(stats.tokensNotRespent).toBe(36000);
    expect(stats.providers).toEqual({ anthropic: 3 });
    const res = await fetch(`${c.url}/`);
    const html = await res.text();
    expect(html).toContain('Weekly active developers');
    expect(html).not.toContain('<script');
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    expect(res.headers.get('content-security-policy')).not.toMatch(/script-src/);
    expect(html).not.toContain('No events yet');
    expect((await fetch(`${c.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${c.url}/nope`)).status).toBe(404);
  });
});
