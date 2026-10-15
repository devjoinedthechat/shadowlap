import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from '@shadowlap-testing/reference-agent';

/**
 * `shadowlap test` keeping its history, through the CLI. The committed golden of the reference agent
 * (11 model calls, a send_email write) replays offline. AGENT_SYSTEM_SUFFIX changes its system
 * prompt, which is the kind of intended change that makes a golden diverge.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');
const GOLDEN = join(ROOT, 'testing', 'golden', 'reference-agent');

let mock: MockServer;
let work: string;
const dirs: string[] = [];

beforeAll(async () => {
  mock = await startMockAnthropic({ script: (ctx) => ('metadata' in ctx.request ? { message: message([text('triaged')]) } : referenceScript(ctx)) });
});
afterAll(async () => {
  await mock.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'sl-history-'));
  dirs.push(work);
  cpSync(GOLDEN, join(work, 'goldens', 'reference-agent'), { recursive: true });
});

interface Result {
  code: number | null;
  out: string;
  events: Array<Record<string, unknown>>;
}

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: work,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_GUARD: 'off', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_EVENTS_FD: '3', ...env },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let events = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
    (child.stdio[3] as NodeJS.ReadableStream).on('data', (d: Buffer) => (events += d.toString()));
    child.on('close', (code) => resolve({ code, out, events: events.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) }));
  });
}

const store = () => Store.open(join(work, '.shadowlap', 'shadowlap.db'));
const goldenRunId = () => (JSON.parse(readFileSync(join(work, 'goldens', 'reference-agent', 'run.json'), 'utf8')) as { runs: Array<{ runId: string }> }).runs.at(-1)!.runId;

describe('shadowlap test history', () => {
  it('keeps each session in the project\'s store, marks its replays, and names each one for a dashboard job', async () => {
    const r = await shadowlap(['test', 'goldens/*', '--cwd', ROOT, '--json', 'report.json']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('✓ reference-agent: 30/30 replayed');
    expect(r.out).toContain('1 passed, 0 failed · 0 upstream requests');
    const replayId = /replaying run (\w{26}) for goldens\/reference-agent/.exec(r.out)![1]!;

    const s = store();
    const [session] = s.listTestSessions();
    expect(session!.command.slice(0, 3)).toEqual(['shadowlap', 'test', 'goldens/*']);
    expect(session).toMatchObject({ passed: 1, failed: 0, upstreamRequests: 0 });
    expect(session!.revision).toMatch(/^[0-9a-f]{7,}(\+dirty)?$/);
    const [result] = s.listTestResults({ sessionId: session!.sessionId });
    expect(result).toMatchObject({ golden: 'goldens/reference-agent', ok: true, failure: null, runId: replayId, goldenRunId: goldenRunId(), revision: session!.revision, data: { mode: 'replay', calls: { total: 30, replayed: 30, live: 0 }, upstreamRequests: 0 } });
    expect(s.getRun(replayId)!.meta?.test).toEqual({ golden: 'goldens/reference-agent', session: session!.sessionId });
    expect(s.listEvents({ kinds: ['test.session'] })[0]).toMatchObject({ ref: session!.sessionId, data: { passed: 1, failed: 0, goldens: 1, upstreamRequests: 0 } });
    s.close();

    expect(r.events[0]).toEqual({ type: 'run', runId: replayId, role: 'passing' });
    expect(r.events.find((e) => e.type === 'link')).toEqual({ type: 'link', label: 'Tests', href: '#/tests' });
    const report = JSON.parse(readFileSync(join(work, 'report.json'), 'utf8')) as Record<string, unknown> & { results: Array<Record<string, unknown>> };
    expect(report).toMatchObject({ session: session!.sessionId, revision: session!.revision, passed: 1, failed: 0 });
    expect(report.results[0]).toMatchObject({ golden: 'goldens/reference-agent', ok: true, failure: null, runId: replayId, runs: [{ runId: replayId, ok: true }], goldenRunId: goldenRunId(), expect: null, updated: null });
  });

  it('records why a golden failed, with the divergence as the CLI printed it', async () => {
    await shadowlap(['test', 'goldens/reference-agent', '--cwd', ROOT]);
    const r = await shadowlap(['test', 'goldens/reference-agent', '--cwd', ROOT], { AGENT_SYSTEM_SUFFIX: 'Be brief.' });
    expect(r.code).toBe(1);
    const s = store();
    expect(s.listTestSessions().map((x) => [x.passed, x.failed])).toEqual([[0, 1], [1, 0]]);
    const [failed] = s.listTestResults({ golden: 'goldens/reference-agent' });
    expect(failed).toMatchObject({ ok: false, failure: 'diverged', reason: 'diverged at call 3 (api POST /v1/messages)', data: { divergence: { callNo: 3, kind: 'api', name: 'POST /v1/messages' } } });
    expect(failed!.data!.divergence!.text).toContain('✗ Diverged at call 3 (api POST /v1/messages)');
    expect(failed!.data!.divergence!.text).toContain('Be brief.');
    expect(r.events.filter((e) => e.type === 'run')).toEqual([{ type: 'run', runId: failed!.runId, role: 'failing' }]);
    s.close();
  });

  it('keeps nothing with --db :memory:, and refuses a pattern that matches nothing', async () => {
    const r = await shadowlap(['--db', ':memory:', 'test', 'goldens/*', '--cwd', ROOT]);
    expect(r.code, r.out).toBe(0);
    expect(existsSync(join(work, '.shadowlap'))).toBe(false);
    const none = await shadowlap(['test', 'missing/*', '--cwd', ROOT]);
    expect(none.code).toBe(1);
    expect(none.out).toContain('no recordings match missing/*');
  });
});
