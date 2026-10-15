import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { defaultDbPath, loadConfig } from '../src/config.js';
import { formatDoctor, runDoctor } from '../src/doctor.js';

const guardDir = fileURLToPath(new URL('../guard/', import.meta.url));
const plain = { green: (s: string) => s, yellow: (s: string) => s, red: (s: string) => s, dim: (s: string) => s };
let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('shadowlap doctor', () => {
  it('reports a healthy setup', () => {
    dir = mkdtempSync(join(tmpdir(), 'fp-doctor-'));
    const checks = runDoctor({ cwd: dir, env: {}, version: '0.1.0', guardDir, python: () => 'Python 3.12.1' });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName.node?.verdict).toBe('ok');
    expect(byName.sqlite?.verdict).toBe('ok');
    expect(byName['network guard']?.verdict).toBe('ok');
    expect(byName.python?.detail).toContain('3.12.1');
    expect(byName.store?.detail).toContain('not created yet');
    expect(byName.config?.detail).toContain('defaults');
    expect(byName.telemetry?.detail).toContain('on');
    expect(checks.every((c) => c.verdict === 'ok')).toBe(true);
    expect(formatDoctor(checks, plain)).toContain('everything looks fine');
  });

  it('flags old Node, a broken config, a stale active run and leaked agent environment', () => {
    dir = mkdtempSync(join(tmpdir(), 'fp-doctor-'));
    mkdirSync(join(dir, '.shadowlap'));
    writeFileSync(join(dir, 'shadowlap.config.json'), '{ "prices": { "m": { "input": "x" } } }');
    writeFileSync(join(dir, '.shadowlap', 'active.json'), JSON.stringify({ url: 'http://127.0.0.1:1/t', runId: '01STALE', pid: 2 ** 22 - 1 }));
    writeFileSync(join(dir, '.shadowlap', 'repair-journal.json'), JSON.stringify({ pid: 2 ** 22 - 1, files: [{ path: join(dir, 'agent.mjs'), original: '', patched: '' }] }));
    const store = Store.open(join(dir, '.shadowlap', 'shadowlap.db'));
    // A run its process left running two days ago, and one this process is recording: only the first is a problem.
    store.importRun({ runId: '01ABANDONED000000000000000', parentRunId: null, mode: 'record', status: 'running', divergence: null, command: { argv: ['x'], cwd: dir }, codeVersion: null, startedAt: Date.now() - 2 * 86_400_000, endedAt: null });
    store.createRun({ mode: 'record', command: { argv: ['x'], cwd: dir } });
    store.close();
    const checks = runDoctor({
      cwd: dir,
      env: { SHADOWLAP_GUARD: 'warn', NODE_OPTIONS: '--import=file:///x/guard/node-guard.mjs', SHADOWLAP_TELEMETRY: '0' },
      version: '0.1.0',
      nodeVersion: 'v20.11.0',
      guardDir: join(dir, 'nope'),
      python: () => null,
    });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName.node).toMatchObject({ verdict: 'fail' });
    expect(byName.node?.fix).toMatch(/Node ≥ 22\.13/);
    expect(byName['network guard']?.verdict).toBe('fail');
    expect(byName.python?.verdict).toBe('warn');
    expect(byName.SHADOWLAP_GUARD?.verdict).toBe('warn');
    expect(byName.config?.verdict).toBe('fail');
    expect(byName.config?.detail).toMatch(/prices\["m"\]/);
    expect(byName['active run']?.verdict).toBe('warn');
    expect(byName.repair).toMatchObject({ verdict: 'warn', detail: expect.stringContaining('agent.mjs') });
    expect(byName['runs still marked running']).toMatchObject({ verdict: 'warn', detail: '01ABANDONE', fix: expect.stringContaining('shadowlap gc marks them interrupted') });
    expect(byName.store?.detail).toMatch(/2 runs/);
    expect(byName.NODE_OPTIONS?.verdict).toBe('warn');
    expect(byName.telemetry?.detail).toContain('off');
    const text = formatDoctor(checks, plain);
    expect(text).toMatch(/\d problems?/);
    expect(text).toContain('✗ node');
  });

});
