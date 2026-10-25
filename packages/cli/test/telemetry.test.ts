import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Telemetry, detectCi, isDisabledByEnv, type TelemetryBatch } from '../src/telemetry.js';

const dir = () => mkdtempSync(join(tmpdir(), 'fp-telemetry-'));
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ HOME: '/nonexistent', ...extra });

function fakeFetch(): { fetch: typeof fetch; batches: TelemetryBatch[]; urls: string[] } {
  const batches: TelemetryBatch[] = [];
  const urls: string[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(url instanceof Request ? url.url : String(url));
    batches.push(JSON.parse(init?.body as string) as TelemetryBatch);
    return new Response('{}', { status: 202 });
  };
  return { fetch: fetchImpl, batches, urls };
}

describe('telemetry', () => {
  it('is off with SHADOWLAP_TELEMETRY=0 or DO_NOT_TRACK=1 and records nothing', async () => {
    expect(isDisabledByEnv({ SHADOWLAP_TELEMETRY: '0' })).toBe(true);
    expect(isDisabledByEnv({ DO_NOT_TRACK: '1' })).toBe(true);
    expect(isDisabledByEnv({})).toBe(false);
    const f = fakeFetch();
    const t = new Telemetry({ version: '0.0.0', env: env({ SHADOWLAP_TELEMETRY: '0' }), dir: dir(), fetchImpl: f.fetch });
    expect(t.enabled).toBe(false);
    expect(t.record({ type: 'run' })).toBeNull();
    expect(await t.flush()).toBe(false);
    expect(f.batches).toEqual([]);
  });

  it('sends nothing and shows no notice unless a collector is configured', async () => {
    const f = fakeFetch();
    const notices: string[] = [];
    const t = new Telemetry({ version: '0.1.0', env: env(), dir: dir(), notice: (l) => notices.push(l), fetchImpl: f.fetch });
    expect(t.enabled).toBe(false);
    expect(t.record({ type: 'run' })).toBeNull();
    expect(await t.flush()).toBe(false);
    expect(f.urls).toEqual([]);
    expect(notices).toEqual([]);
    expect(new Telemetry({ version: '0.1.0', env: env({ SHADOWLAP_TELEMETRY_URL: 'http://collector.test/v1/events' }), dir: dir(), notice: () => {}, fetchImpl: f.fetch }).enabled).toBe(true);
  });

  it('persists an install id, shows the notice once, and sends allowlisted fields only', async () => {
    const d = dir();
    const notices: string[] = [];
    const f = fakeFetch();
    const t1 = new Telemetry({ version: '0.1.0', env: env(), dir: d, url: 'http://collector.test/v1/events', notice: (l) => notices.push(l), fetchImpl: f.fetch });
    expect(t1.enabled).toBe(true);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('SHADOWLAP_TELEMETRY=0');
    const t2 = new Telemetry({ version: '0.1.0', env: env(), dir: d, url: 'http://collector.test/v1/events', notice: (l) => notices.push(l), fetchImpl: f.fetch });
    expect(notices).toHaveLength(1); // once
    expect(t2.installId).toBe(t1.installId);
    expect(JSON.parse(readFileSync(join(d, 'telemetry.json'), 'utf8')).installId).toBe(t1.installId);

    const ev = t2.record({ type: 'replay', calls: 30, replayed: 28, live: 2, blocked: 1, divergence: 'request_changed', tokensNotRespent: 12000, providers: ['anthropic', 'anthropic'], sdks: ['typescript'], durationMs: 900, exitCode: 0 })!;
    expect(Object.keys(ev).sort()).toEqual(['arch', 'at', 'blocked', 'calls', 'ci', 'divergence', 'durationMs', 'exitCode', 'live', 'node', 'os', 'overridden', 'providers', 'replayed', 'sdks', 'stubbed', 'tokensNotRespent', 'type', 'version']);
    expect(ev.providers).toEqual(['anthropic']);
    expect(ev.ci).toBeNull();
    expect(await t2.flush()).toBe(true);
    expect(f.urls).toEqual(['http://collector.test/v1/events']);
    expect(f.batches[0].installId).toBe(t1.installId);
    expect(f.batches[0].events).toHaveLength(1);
    expect(JSON.stringify(f.batches[0])).not.toMatch(/nonexistent|Users|home/);
    expect(await t2.flush()).toBe(false); // buffer drained
  });

  it('never throws on a dead collector and respects the timeout', async () => {
    const t = new Telemetry({ version: '0.0.0', env: env(), dir: dir(), url: 'http://127.0.0.1:9/v1/events', notice: () => {}, timeoutMs: 500 });
    t.record({ type: 'run' });
    const started = Date.now();
    expect(await t.flush()).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('derives a stable id in CI from the repository id, never its name', () => {
    expect(detectCi({ GITHUB_ACTIONS: 'true' })).toBe('github');
    expect(detectCi({ CI: '1' })).toBe('other');
    const a = new Telemetry({ version: '0', env: env({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY_ID: '12345', GITHUB_REPOSITORY: 'acme/secret-repo' }), dir: dir(), url: 'http://c/v1/events', notice: () => {} });
    const b = new Telemetry({ version: '0', env: env({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY_ID: '12345' }), dir: dir(), url: 'http://c/v1/events', notice: () => {} });
    expect(a.installId).toBe(b.installId);
    expect(a.installId).toMatch(/^ci-[0-9a-f]{32}$/);
    expect(a.installId).not.toContain('acme');
  });
});
