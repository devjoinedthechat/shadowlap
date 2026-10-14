import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCollector, type Collector } from '@shadowlap/collector';
import { Telemetry } from '../src/telemetry.js';

/** The CLI's telemetry client against the real collector: what a run sends is what the dashboard counts. */
let collector: Collector;
let dir: string;
beforeAll(async () => {
  collector = await startCollector({ db: ':memory:', port: 0, host: '127.0.0.1', log: () => {} });
  dir = mkdtempSync(join(tmpdir(), 'fp-telemetry-'));
});
afterAll(async () => {
  await collector.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('telemetry client → collector', () => {
  it('delivers a batch the collector accepts and aggregates', async () => {
    const t = new Telemetry({ version: '0.1.0', env: { HOME: dir }, dir, url: `${collector.url}/v1/events`, notice: () => {} });
    expect(t.enabled).toBe(true);
    expect(t.record({ type: 'run', calls: 30, live: 30, providers: ['anthropic'], sdks: ['typescript'], durationMs: 1200, exitCode: 0 })).not.toBeNull();
    expect(t.record({ type: 'replay', calls: 30, replayed: 30, providers: ['anthropic'], sdks: ['typescript'], tokensNotRespent: 12_000, durationMs: 300, exitCode: 0 })).not.toBeNull();
    await t.flush();
    const stats = (await (await fetch(`${collector.url}/v1/stats`)).json()) as { installs: { total: number }; replays: { total: number; clean: number }; tokensNotRespent: number; providers: Record<string, number> };
    expect(stats.installs.total).toBe(1);
    expect(stats.replays).toMatchObject({ total: 1, clean: 1 });
    expect(stats.tokensNotRespent).toBe(12_000);
    expect(stats.providers.anthropic).toBeGreaterThan(0);
    // The dashboard renders without scripts and shows the same number.
    const html = await (await fetch(collector.url)).text();
    expect(html).toContain('12');
    expect(html).not.toContain('<script');
  });

  it('maps values outside the collector allowlist instead of losing the batch', async () => {
    const t = new Telemetry({ version: '0.1.0', env: { HOME: dir }, dir, url: `${collector.url}/v1/events`, notice: () => {} });
    const ev = t.record({ type: 'run', providers: ['anthropic', 'cohere'], sdks: ['mcp', 'typescript', 'ruby'] })!;
    expect(ev.providers).toEqual(['anthropic']);
    expect(ev.sdks).toEqual(['mcp', 'other', 'typescript']);
    expect(await t.flush()).toBe(true);
  });

  it('never throws or hangs when the collector is unreachable', async () => {
    const t = new Telemetry({ version: '0.1.0', env: { HOME: dir }, dir, url: 'http://127.0.0.1:1/v1/events', notice: () => {}, timeoutMs: 300 });
    t.record({ type: 'ui' });
    const started = Date.now();
    expect(await t.flush()).toBe(false); // not delivered, but no throw
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
