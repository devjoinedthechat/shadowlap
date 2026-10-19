import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { defaultDbPath, loadConfig } from '../src/config.js';
import { formatDoctor, pythonCheck, runDoctor } from '../src/doctor.js';

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

describe('the python check', () => {
  it('names the command that starts Python, and says so when only python3 does', () => {
    const only = (versions: Record<string, string>) => pythonCheck((command) => versions[command] ?? null);
    expect(only({ python3: 'Python 3.14.7' })).toEqual({ found: true, detail: 'Python 3.14.7 on PATH as python3 (Python SDK and guard usable); there is no python, so start agents with python3 agent.py' });
    expect(only({ python: 'Python 3.12.1' }).detail).toBe('Python 3.12.1 on PATH as python (Python SDK and guard usable); there is no python3, so start agents with python agent.py');
    expect(only({ python3: 'Python 3.12.1', python: 'Python 3.12.1' }).detail).toBe('Python 3.12.1 on PATH as python3 and python (Python SDK and guard usable)');
    expect(only({ python3: 'Python 3.13.0', python: 'Python 2.7.18' }).detail).toBe('Python 3.13.0 as python3 and Python 2.7.18 as python on PATH (Python SDK and guard usable)');
    expect(only({})).toEqual({ found: false, detail: 'no python3 or python on PATH' });
  });
});

describe('a judge check whose model retires', () => {
  it('is named with its date, its page and what to ask instead', async () => {
    const { parseTests } = await import('../src/checks.js');
    const { judgeRetirements } = await import('../src/doctor.js');
    const judge = (model: string) => ({ name: 'explains', question: 'Does the reply say why?', model });
    const entries = parseTests({ 'goldens/a': { expect: { judge: [judge('claude-sonnet-4-5-20250929')] } }, 'goldens/b': { expect: { when: [{ if: { tool: 'x' }, then: { judge: [judge('anthropic:claude-sonnet-4-5-20250929')] } }] } }, 'goldens/c': { expect: { judge: [judge('claude-sonnet-5-5')] } } });
    const checks = judgeRetirements(entries, Date.UTC(2026, 9, 19));
    // A judge under a when is held too, named by its provider or not; one on a current model says nothing.
    expect(checks.map((c) => c.detail)).toEqual([
      'judge "explains" in tests["goldens/a"]: claude-sonnet-4-5-20250929 retires on the Claude API on November 30, 2026, in 42 days; Anthropic recommends claude-sonnet-5-5',
      'judge "explains" in tests["goldens/b"]: claude-sonnet-4-5-20250929 retires on the Claude API on November 30, 2026, in 42 days; Anthropic recommends claude-sonnet-5-5',
    ]);
    expect(checks[0]).toMatchObject({ name: 'judge model', verdict: 'warn', fix: 'Give it another model, such as claude-sonnet-5-5, then record its verdicts again: shadowlap test goldens/a --update. Source: https://platform.claude.com/docs/en/about-claude/model-deprecations' });
  });
});
