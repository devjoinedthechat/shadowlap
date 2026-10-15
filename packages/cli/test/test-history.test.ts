import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from '@shadowlap-testing/reference-agent';

/**
 * `shadowlap test` keeping its history, and `test --update`, through the CLI. The committed golden of
 * the reference agent (11 model calls, a send_email write) replays offline; the mock plays its model
 * when a golden is re-recorded. AGENT_SYSTEM_SUFFIX changes its system prompt, which is the kind of
 * intended change that makes a golden diverge.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');
const VOLATILE = fileURLToPath(new URL('./volatile-agent.mjs', import.meta.url));
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
    // A prompt change: no value that changes every run, judged on the whole diff.
    expect(failed!.data!.divergence).toMatchObject({ entries: 1, volatile: { values: [], explainsAll: false } });
    expect(failed!.data!.divergence!.text).toContain('Be brief.');
    expect(r.events.filter((e) => e.type === 'run')).toEqual([{ type: 'run', runId: failed!.runId, role: 'failing' }]);
    s.close();
  });

  it('keeps the newest clean replay of each golden, and every one that failed', async () => {
    const replays = () => {
      const s = store();
      const runs = s.allRuns().filter((r) => r.meta?.test?.golden === 'goldens/reference-agent').map((r) => r.runId);
      s.close();
      return runs;
    };
    const idOf = (r: Result) => /replaying run (\w{26})/.exec(r.out)![1]!;
    const first = idOf(await shadowlap(['test', 'goldens/reference-agent', '--cwd', ROOT]));
    const second = idOf(await shadowlap(['test', 'goldens/reference-agent', '--cwd', ROOT]));
    expect(replays()).toEqual([second]);
    // A labelled replay is kept; a failing one is kept, with the newest clean one before it.
    expect((await shadowlap(['label', second, 'baseline'])).code).toBe(0);
    const third = idOf(await shadowlap(['test', 'goldens/reference-agent', '--cwd', ROOT]));
    expect(replays()).toEqual([third, second]);
    const failing = idOf(await shadowlap(['test', 'goldens/reference-agent', '--cwd', ROOT], { AGENT_SYSTEM_SUFFIX: 'Be brief.' }));
    expect(replays()).toEqual([failing, third, second]);
    // The history still has every session's result, with the run it made.
    const s = store();
    expect(s.listTestResults({ golden: 'goldens/reference-agent' }).map((r) => r.runId)).toEqual([failing, third, second, first]);
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

describe('a redacted golden', () => {
  it('replays from the store\'s own copy of its run as it replays from the pack in CI', async () => {
    // The scratch directory is masked for matching; the per-run user id is redacted in the pack, and a
    // redacted pack applies its rules as normalizers when it replays.
    const scratch = { path: '$.system', pattern: '/agent-[A-Za-z0-9]+/', replace: 'agent-X' };
    writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ normalize: [{ kind: 'api', ...scratch }, { kind: 'tool', name: 'save_report', ...scratch, path: '$.args.path' }], redact: [{ kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' }] }));
    const recorded = await shadowlap(['run', '--', process.execPath, VOLATILE]);
    expect(recorded.code, recorded.out).toBe(0);
    const runId = /recording run (\w{26})/.exec(recorded.out)![1]!;
    expect((await shadowlap(['pack', runId, 'goldens/redacted'])).out).toContain('with 1 redaction rule');
    // The store has the run as recorded, with its real user id; the pack has it redacted.
    const local = await shadowlap(['test', 'goldens/redacted']);
    expect(local.code, local.out).toBe(0);
    const ci = await shadowlap(['--db', ':memory:', 'test', 'goldens/redacted']);
    expect(ci.code, ci.out).toBe(0);
  });
});

describe('shadowlap test --update', () => {
  it('re-records a diverged golden live with writes stubbed, replaces it, and the next replay is clean', async () => {
    const outbox = join(work, 'outbox.jsonl');
    const before = goldenRunId();
    const env = { AGENT_SYSTEM_SUFFIX: 'Be brief.', REFERENCE_AGENT_OUTBOX: outbox };
    const r = await shadowlap(['test', 'goldens/reference-agent', '--cwd', ROOT, '--update', '--json', 'report.json'], env);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('✗ reference-agent: diverged at call 3');
    expect(r.out).toContain('↻ updating goldens/reference-agent: re-recording live, writes stubbed');
    expect(r.out).toMatch(/re-recorded as run \w{10}: 30 calls, as before · \$\S+ live · 11 upstream requests/);
    expect(r.out).toContain('replaced goldens/reference-agent in the working tree; review the change in your pull request');
    expect(r.out).toMatch(/✓ reference-agent: 30\/30 replayed, .* \(updated\)/);
    // The write was stubbed: nothing reached the outbox.
    expect(existsSync(outbox) ? readFileSync(outbox, 'utf8') : '').toBe('');

    const after = goldenRunId();
    expect(after).not.toBe(before);
    const s = store();
    expect(s.getCalls(after).find((c) => c.name === 'send_email')!.origin).toBe('stubbed');
    const [result] = s.listTestResults({ golden: 'goldens/reference-agent' });
    expect(result).toMatchObject({ ok: true, goldenRunId: after, data: { updated: { from: before, to: after, calls: 30 } } });
    expect(s.listEvents({ kinds: ['golden.updated'] })[0]).toMatchObject({ runId: after, ref: 'goldens/reference-agent', data: { previous: before, calls: 30 } });
    s.close();
    expect(r.events.filter((e) => e.type === 'run').map((e) => e.role)).toEqual(['new', 'passing']);
    const report = JSON.parse(readFileSync(join(work, 'report.json'), 'utf8')) as { results: Array<Record<string, unknown>> };
    expect(report.results[0]).toMatchObject({ ok: true, updated: { from: before, to: after, calls: 30 } });

    // The updated golden replays offline now, and fails without the change it recorded.
    const hits = mock.requests.length;
    expect((await shadowlap(['test', 'goldens/reference-agent', '--cwd', ROOT], env)).code).toBe(0);
    expect(mock.requests.length).toBe(hits);
    expect((await shadowlap(['test', 'goldens/reference-agent', '--cwd', ROOT])).code).toBe(1);
  });

  it('keeps the old golden when the new recording fails its checks, and leaves failed checks alone', async () => {
    writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/reference-agent': { expect: { tools: { send_email: 0 } } } } }));
    const before = goldenRunId();
    const r = await shadowlap(['test', 'goldens/reference-agent', '--cwd', ROOT, '--update'], { AGENT_SYSTEM_SUFFIX: 'Be brief.' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('✗ send_email called 0 times: called 1 time');
    expect(r.out).toContain('✗ not replaced: check failed: send_email called 0 times, but called 1 time');
    expect(goldenRunId()).toBe(before);

    // A golden that replays clean but fails a check is not updated: the agent needs the fix.
    const clean = await shadowlap(['test', 'goldens/reference-agent', '--cwd', ROOT, '--update']);
    expect(clean.code).toBe(1);
    expect(clean.out).toContain('not updated: only a golden that diverged is re-recorded; a failed check is fixed in the agent, not in its golden');
    expect(goldenRunId()).toBe(before);
  });

  it('warns when what diverged is a value the agent makes anew on every run, and names the normalizer', async () => {
    const recorded = await shadowlap(['run', '--', process.execPath, VOLATILE]);
    expect(recorded.code, recorded.out).toBe(0);
    const runId = /recording run (\w{26})/.exec(recorded.out)![1]!;
    expect((await shadowlap(['pack', runId, 'goldens/volatile'])).code).toBe(0);
    const r = await shadowlap(['test', 'goldens/volatile', '--update']);
    expect(r.out).toContain('! $.metadata.user_id looks like a UUID, a value that changes every run: updating re-records it, and the next run diverges again.');
    expect(r.out).toContain("shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'");
    expect(r.out).toContain('replaced goldens/volatile in the working tree');
    // It was replaced, and it diverges again on its next run, as the warning said.
    expect(r.code).toBe(1);
    const s = store();
    expect(s.listTestResults({ golden: 'goldens/volatile' })[0]).toMatchObject({ ok: false, failure: 'diverged' });
    expect(s.listEvents({ kinds: ['golden.packed'] })[0]).toMatchObject({ runId, ref: 'goldens/volatile' });
    s.close();
  });
});
