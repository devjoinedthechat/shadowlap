import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Store, type DivergenceReport } from '@shadowlap/engine';
import { divergenceCause } from '../src/golden-test.js';
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
const git = (args: string[]) => execFileSync('git', args, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
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
    // One golden: a link to its replay, as Add normalizer and re-run opens it, then Tests beside it.
    expect(r.events.filter((e) => e.type === 'link')).toEqual([
      { type: 'link', label: 'Open the passing run', href: `#/run/${replayId}` },
      { type: 'link', label: 'Tests', href: '#/tests', secondary: true },
    ]);
    const report = JSON.parse(readFileSync(join(work, 'report.json'), 'utf8')) as Record<string, unknown> & { results: Array<Record<string, unknown>> };
    expect(report).toMatchObject({ session: session!.sessionId, revision: session!.revision, passed: 1, failed: 0 });
    expect(report.results[0]).toMatchObject({ golden: 'goldens/reference-agent', ok: true, failure: null, runId: replayId, runs: [{ runId: replayId, ok: true }], goldenRunId: goldenRunId(), expect: null, updated: null });
  });

  it('records why a golden failed, with the divergence as the CLI printed it', async () => {
    await shadowlap(['test', 'goldens/reference-agent', '--cwd', ROOT]);
    const r = await shadowlap(['test', 'goldens/reference-agent', '--cwd', ROOT], { AGENT_SYSTEM_SUFFIX: 'Be brief.' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('If the change was intended, update it: shadowlap test goldens/reference-agent --update');
    const s = store();
    expect(s.listTestSessions().map((x) => [x.passed, x.failed])).toEqual([[0, 1], [1, 0]]);
    const [failed] = s.listTestResults({ golden: 'goldens/reference-agent' });
    expect(failed).toMatchObject({ ok: false, failure: 'diverged', reason: 'diverged at call 3 (api POST /v1/messages)', data: { divergence: { callNo: 3, kind: 'api', name: 'POST /v1/messages' } } });
    expect(failed!.data!.divergence!.text).toContain('✗ Diverged at call 3 (api POST /v1/messages)');
    // A prompt change: no value that changes every run, judged on the whole diff.
    expect(failed!.data!.divergence).toMatchObject({ entries: 1, volatile: { values: [], explainsAll: false } });
    expect(failed!.data!.divergence!.text).toContain('Be brief.');
    expect(r.events.filter((e) => e.type === 'run')).toEqual([{ type: 'run', runId: failed!.runId, role: 'failing' }]);
    expect(r.events.find((e) => e.type === 'link')).toEqual({ type: 'link', label: 'Open the run', href: `#/run/${failed!.runId}` });
    s.close();
  });

  it('ends a dashboard job over several goldens on Tests, with the replay of each that failed beside it', async () => {
    cpSync(GOLDEN, join(work, 'goldens', 'no-email'), { recursive: true });
    // The same recording, with a check its agent breaks: it sends the email the check rules out.
    writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/no-email': { expect: { tools: { send_email: 0 } } } } }));
    const r = await shadowlap(['test', 'goldens/*', '--cwd', ROOT]);
    expect(r.code, r.out).toBe(1);
    const s = store();
    const failed = s.listTestResults({ golden: 'goldens/no-email' })[0]!;
    expect(failed).toMatchObject({ ok: false, failure: 'check' });
    expect(r.events.filter((e) => e.type === 'link')).toEqual([
      { type: 'link', label: 'Open no-email’s run', href: `#/run/${failed.runId}`, secondary: true },
      { type: 'link', label: 'Tests', href: '#/tests' },
    ]);
    s.close();
  });

  it('keeps what the agent printed last when it exits with an error, for the Tests screen', async () => {
    const r = await shadowlap(['test', 'goldens/reference-agent', '--cwd', ROOT], { AGENT_FAIL_AFTER_CALL: '5' });
    expect(r.code).toBe(1);
    const s = store();
    const [failed] = s.listTestResults({ golden: 'goldens/reference-agent' });
    expect(failed).toMatchObject({ ok: false, failure: 'exit', reason: 'the agent exited with code 1' });
    expect(failed!.data!.output).toContain('agent crashed after model call 5');
    expect(failed!.data!.output!.split('\n').length).toBeLessThanOrEqual(20);
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

  it('prunes the older replays of a golden that may fork, which went live, and still writes the reports', async () => {
    writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/reference-agent': { fork: true, expect: { tools: { send_email: 1 } } } } }));
    // The prompt changed, so each replay forks at call 3 and runs live from there (the mock answers).
    const env = { AGENT_SYSTEM_SUFFIX: 'Be brief.' };
    const first = await shadowlap(['test', 'goldens/reference-agent', '--cwd', ROOT], env);
    expect(first.code, first.out).toBe(0);
    expect(first.out).toMatch(/✓ reference-agent: forked at call 3/);
    const second = await shadowlap(['test', 'goldens/reference-agent', '--cwd', ROOT, '--json', 'report.json', '--junit', 'junit.xml'], env);
    expect(second.code, second.out).toBe(0);
    expect(second.out).not.toContain('not pruned');
    const s = store();
    const kept = s.allRuns().filter((r) => r.meta?.test?.golden === 'goldens/reference-agent');
    expect(kept.map((r) => r.runId)).toEqual([/replaying run (\w{26})/.exec(second.out)![1]]);
    expect(s.getCalls(kept[0]!.runId).some((c) => c.origin === 'live')).toBe(true);
    s.close();
    expect(JSON.parse(readFileSync(join(work, 'report.json'), 'utf8'))).toMatchObject({ passed: 1, failed: 0 });
    expect(existsSync(join(work, 'junit.xml'))).toBe(true);
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

describe('ids in a divergence', () => {
  // One model call with metadata: a request id made anew on every run when asked, and a customer's id.
  const AGENT = `import { randomBytes } from 'node:crypto';
const metadata = { customer_id: process.env.CUSTOMER ?? 'A-1042' };
if (process.env.WITH_REQUEST_ID) metadata.request_id = 'req_' + randomBytes(6).toString('hex');
const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 32, metadata, messages: [{ role: 'user', content: 'triage' }] }) });
if (!res.ok) process.exit(1);
console.log(JSON.stringify((await res.json()).content));
`;

  async function golden(env: NodeJS.ProcessEnv = {}): Promise<void> {
    writeFileSync(join(work, 'agent.mjs'), AGENT);
    const recorded = await shadowlap(['run', '--', process.execPath, 'agent.mjs'], env);
    expect(recorded.code, recorded.out).toBe(0);
    expect((await shadowlap(['pack', /recording run (\w{26})/.exec(recorded.out)![1]!, 'goldens/ids'])).code).toBe(0);
  }

  it('names the normalizer for a request id made anew on every run, which is the whole advice', async () => {
    await golden({ WITH_REQUEST_ID: '1' });
    const r = await shadowlap(['test', 'goldens/ids'], { WITH_REQUEST_ID: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('~ $.metadata.request_id');
    expect(r.out).toContain('hint: $.metadata.request_id looks like a generated id, made anew on every run; to ignore it in matching, add a normalizer');
    const command = "shadowlap normalize add --kind api --path '$.metadata.request_id' --replace '<ID>'";
    expect(r.out).toContain(command);
    // The normalizer is the fix, so no update is offered.
    expect(r.out).not.toContain('If the change was intended');
    const s = store();
    expect(s.listTestResults({ golden: 'goldens/ids' })[0]!.data!.divergence).toMatchObject({ volatile: { explainsAll: true, values: [{ path: '$.metadata.request_id', certain: true }] }, hints: [{ normalizer: { path: '$.metadata.request_id', replace: '<ID>' } }] });
    s.close();
    // As printed, it fixes it.
    expect((await shadowlap(command.split(' ').slice(1).map((a) => a.replace(/^'|'$/g, '')))).code).toBe(0);
    expect((await shadowlap(['test', 'goldens/ids'], { WITH_REQUEST_ID: '1' })).code).toBe(0);
  });

  it('names a divergence by its first change the rules in force leave, as test and bisect say it', () => {
    const d: DivergenceReport = { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2, diff: [{ path: '$.metadata.user_id', op: 'changed', before: '3f2a8c1e-1b2c-4d5e-8f90-0a1b2c3d4e5f', after: '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' }, { path: '$.system', op: 'changed', before: 'Escalate.', after: 'Refund.' }] };
    expect(divergenceCause(d, [{ kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' }])).toBe('$.system');
    expect(divergenceCause(d, [])).toBe('$.metadata.user_id');
    expect(divergenceCause({ ...d, type: 'new_call' }, [])).toBeNull();
  });

  it('gives no hint for a value a rule in the config masks, and keeps the change that made it diverge', async () => {
    // A UUID made anew on every run, which a rule masks, and a prompt that changed: the report lists both.
    writeFileSync(
      join(work, 'agent.mjs'),
      `import { randomUUID } from 'node:crypto';
const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 32, metadata: { user_id: randomUUID() }, system: process.env.PROMPT ?? 'Escalate refunds above the limit.', messages: [{ role: 'user', content: 'triage' }] }) });
if (!res.ok) process.exit(1);
console.log(JSON.stringify((await res.json()).content));
`,
    );
    const recorded = await shadowlap(['run', '--', process.execPath, 'agent.mjs']);
    expect(recorded.code, recorded.out).toBe(0);
    expect((await shadowlap(['pack', /recording run (\w{26})/.exec(recorded.out)![1]!, 'goldens/prompt'])).code).toBe(0);
    writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ normalize: [{ kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' }] }));
    const r = await shadowlap(['test', 'goldens/prompt'], { PROMPT: 'Refund whatever is asked.' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('~ $.system');
    // The masked UUID is listed, as the request carried it, but no hint asks for the rule the config has.
    expect(r.out).toContain('~ $.metadata.user_id');
    expect(r.out).not.toContain('hint: this looks like a UUID');
    const s = store();
    const result = s.listTestResults({ golden: 'goldens/prompt' })[0]!;
    const divergence = result.data!.divergence!;
    // The replay's own record has none either, so its page offers no rule the config has.
    const replay = s.getRun(result.runId!)!;
    s.close();
    expect(divergence.cause).toBe('$.system');
    expect(divergence.hints ?? []).toEqual([]);
    expect(replay.divergence?.diff?.map((e) => e.path)).toEqual(['$.metadata.user_id', '$.system']);
    expect(replay.divergence?.hints).toBeUndefined();
  });

  it('says a changed customer id may be a real change, and offers the update as well as the normalizer', async () => {
    await golden();
    const r = await shadowlap(['test', 'goldens/ids'], { CUSTOMER: 'A-1043' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('hint: $.metadata.customer_id is an id, and a changed id may be a real change (another customer, another order); only if this one is made anew on every run, add a normalizer');
    expect(r.out).toContain("shadowlap normalize add --kind api --path '$.metadata.customer_id' --replace '<ID>'");
    expect(r.out).toContain('If the change was intended, update it: shadowlap test goldens/ids --update');
    const u = await shadowlap(['test', 'goldens/ids', '--update'], { CUSTOMER: 'A-1043' });
    expect(u.out).toContain('! $.metadata.customer_id is an id that changed, which may be a real change (the agent acting on another customer or order): the update records the new one.');
    expect(u.out).toContain('replaced goldens/ids in the working tree');
    expect(u.code, u.out).toBe(0);
  });
});

// Signals to a process group, and an agent that must be gone afterwards: POSIX only.
describe.skipIf(process.platform === 'win32')('a test session a signal stops', () => {
  // One model call, then, replaying as "slow" with SLOW_MS set, a long wait. It writes its pid first.
  const AGENT = `import { writeFileSync } from 'node:fs';
const tag = process.argv[2];
writeFileSync(tag + '.pid', String(process.pid));
const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 32, metadata: { user_id: 'u-1' }, messages: [{ role: 'user', content: 'triage ' + tag }] }) });
if (!res.ok) process.exit(1);
console.log(JSON.stringify((await res.json()).content));
if (tag === 'slow' && process.env.SLOW_MS) await new Promise((r) => setTimeout(r, Number(process.env.SLOW_MS)));
`;

  async function goldens(): Promise<void> {
    rmSync(join(work, 'goldens'), { recursive: true, force: true });
    writeFileSync(join(work, 'agent.mjs'), AGENT);
    for (const [name, tag] of [['a-first', 'fast'], ['b-slow', 'slow'], ['c-last', 'fast']] as const) {
      const recorded = await shadowlap(['run', '--', process.execPath, 'agent.mjs', tag]);
      expect(recorded.code, recorded.out).toBe(0);
      expect((await shadowlap(['pack', /recording run (\w{26})/.exec(recorded.out)![1]!, `goldens/${name}`])).code).toBe(0);
    }
    rmSync(join(work, 'slow.pid'), { force: true });
  }

  /** `test goldens/*` with the slow golden waiting, stopped by `signal` once its agent is waiting: to the CLI's whole process group as a terminal's Ctrl-C is, or to the CLI alone as a job runner stops it. */
  function interrupted(signal: NodeJS.Signals, to: 'group' | 'process'): Promise<Result & { agentPid: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, 'test', 'goldens/*', '--json', 'report.json'], {
        cwd: work,
        env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_GUARD: 'off', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_EVENTS_FD: '3', SLOW_MS: '20000' },
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        detached: to === 'group',
      });
      let out = '';
      let events = '';
      let agentPid = 0;
      child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
      (child.stdio[3] as NodeJS.ReadableStream).on('data', (d: Buffer) => (events += d.toString()));
      const started = Date.now();
      const poll = setInterval(() => {
        // The slow golden's agent has started; a moment later its call is replayed and it waits.
        if (out.includes('for goldens/b-slow') && existsSync(join(work, 'slow.pid'))) {
          agentPid = Number(readFileSync(join(work, 'slow.pid'), 'utf8'));
          if (!agentPid) return;
          clearInterval(poll);
          setTimeout(() => (to === 'group' ? process.kill(-child.pid!, signal) : child.kill(signal)), 1000);
        } else if (Date.now() - started > 20_000) {
          clearInterval(poll);
          child.kill('SIGKILL');
          reject(new Error(`the slow golden never started:\n${out}`));
        }
      }, 50);
      child.on('close', (code, sig) => resolve({ code: code ?? (sig ? 128 : 1), out, events: events.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>), agentPid }));
    });
  }

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  for (const [signal, to, code] of [['SIGINT', 'group', 130], ['SIGTERM', 'process', 143]] as const) {
    it(`ends the session with the goldens that finished when ${signal} reaches the ${to === 'group' ? 'terminal\'s process group' : 'CLI alone'}, and leaves nothing running`, async () => {
      await goldens();
      const r = await interrupted(signal, to);
      expect(r.code, r.out).toBe(code);
      expect(r.out).toContain('✓ a-first:');
      expect(r.out).toContain('[shadowlap] interrupted: stopping goldens/b-slow, no golden after it runs');
      expect(r.out).toContain('⏹ goldens/b-slow: interrupted, so it has no result this time');
      expect(r.out).toContain('1 passed, 0 failed, 2 not run: interrupted');
      expect(r.out).not.toContain('c-last:');
      // The agent the signal cut short is gone, and so is nothing else it started.
      expect(alive(r.agentPid), 'the slow golden\'s agent').toBe(false);

      const s = store();
      const [session] = s.listTestSessions();
      expect(session).toMatchObject({ passed: 1, failed: 0, interrupted: true });
      expect(session!.endedAt).not.toBeNull();
      // Only the golden that finished has a result; no run is left recording.
      expect(s.listTestResults({ sessionId: session!.sessionId }).map((x) => [x.golden, x.ok])).toEqual([['goldens/a-first', true]]);
      expect(s.allRuns().filter((x) => x.status === 'running')).toEqual([]);
      const cut = s.allRuns().find((x) => x.meta?.test?.golden === 'goldens/b-slow')!;
      expect(cut).toMatchObject({ status: 'crashed', meta: { test: { golden: 'goldens/b-slow', session: session!.sessionId } } });
      expect(s.listEvents({ kinds: ['test.session'] })[0]).toMatchObject({ ref: session!.sessionId, data: { passed: 1, failed: 0, goldens: 1, interrupted: true, notRun: 2 } });
      s.close();
      expect(JSON.parse(readFileSync(join(work, 'report.json'), 'utf8'))).toMatchObject({ session: session!.sessionId, passed: 1, failed: 0, interrupted: true });
      // The job saw the replay that finished, never one for the golden that was cut short.
      expect(r.events.filter((e) => e.type === 'run').map((e) => e.role)).toEqual(['passing']);

      // The next session runs every golden, and the replay that was cut short goes.
      const next = await shadowlap(['test', 'goldens/*']);
      expect(next.code, next.out).toBe(0);
      const after = store();
      expect(after.getRun(cut.runId)).toBeNull();
      expect(after.listTestSessions()[0]).toMatchObject({ passed: 3, failed: 0, interrupted: false });
      after.close();
    });
  }
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

  it('applies the rules of the pack as it is now, when the run was packed again with more', async () => {
    const scratch = { path: '$.system', pattern: '/agent-[A-Za-z0-9]+/', replace: 'agent-X' };
    const masks = [{ kind: 'api', ...scratch }, { kind: 'tool', name: 'save_report', ...scratch, path: '$.args.path' }];
    const userId = { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' };
    writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ normalize: masks, redact: [userId] }));
    const recorded = await shadowlap(['run', '--', process.execPath, VOLATILE]);
    const runId = /recording run (\w{26})/.exec(recorded.out)![1]!;
    expect((await shadowlap(['pack', runId, 'goldens/repacked'])).code).toBe(0);
    // Another store imports the pack with its one rule.
    expect((await shadowlap(['--db', 'other.db', 'test', 'goldens/repacked'])).code).toBe(0);
    // The masks move from normalize to redact, and the run is packed again with all three rules.
    writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ normalize: [], redact: [userId, ...masks] }));
    rmSync(join(work, 'goldens', 'repacked'), { recursive: true });
    expect((await shadowlap(['pack', runId, 'goldens/repacked'])).out).toContain('with 3 redaction rules');
    const again = await shadowlap(['--db', 'other.db', 'test', 'goldens/repacked']);
    expect(again.code, again.out).toBe(0);
    expect((await shadowlap(['--db', ':memory:', 'test', 'goldens/repacked'])).code).toBe(0);
  });
});

describe('shadowlap test --update', () => {
  it('re-records a diverged golden live with writes stubbed, replaces it, and the next replay is clean', async () => {
    const outbox = join(work, 'outbox.jsonl');
    const before = goldenRunId();
    // The golden's folder holds more than the pack: a committed note, and a file nobody committed.
    const folder = join(work, 'goldens', 'reference-agent');
    writeFileSync(join(folder, 'NOTES.md'), 'Why this run is the golden.\n');
    git(['init', '-q']);
    git(['add', 'goldens']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'Add the golden']);
    writeFileSync(join(folder, 'expect.json'), '{"tools":{"send_email":1}}\n');
    const env = { AGENT_SYSTEM_SUFFIX: 'Be brief.', REFERENCE_AGENT_OUTBOX: outbox };
    const r = await shadowlap(['test', 'goldens/reference-agent', '--cwd', ROOT, '--update', '--json', 'report.json'], env);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('✗ reference-agent: diverged at call 3');
    expect(r.out).toContain('↻ updating goldens/reference-agent: re-recording live, writes stubbed');
    expect(r.out).toMatch(/re-recorded as run \w{10}: 30 calls, as before · \$\S+ live · 11 upstream requests/);
    // As many calls as before, but not the same requests: it says which.
    expect(r.out).toContain('what changed: system prompt changed · call 3 (api POST /v1/messages): ~ $.system\n');
    expect(r.out).toContain('replaced goldens/reference-agent in the working tree; review the change in your pull request');
    expect(r.out).toMatch(/✓ reference-agent: 30\/30 replayed, .* \(updated\)/);
    // The write was stubbed: nothing reached the outbox.
    expect(existsSync(outbox) ? readFileSync(outbox, 'utf8') : '').toBe('');
    // Only the pack's own files changed; the note and the uncommitted file are where they were.
    expect(readFileSync(join(folder, 'NOTES.md'), 'utf8')).toBe('Why this run is the golden.\n');
    expect(readFileSync(join(folder, 'expect.json'), 'utf8')).toBe('{"tools":{"send_email":1}}\n');
    const status = git(['status', '--porcelain', '--untracked-files=all', 'goldens']).split('\n').filter(Boolean);
    expect(status).toContain(' M goldens/reference-agent/run.json');
    expect(status).toContain('?? goldens/reference-agent/expect.json');
    // A golden packed before packs carried their .gitattributes gets one, so no checkout converts its line endings.
    expect(status).toContain('?? goldens/reference-agent/.gitattributes');
    expect(status.filter((l) => !/^( M| D|\?\?) goldens\/reference-agent\/(run\.json|calls\.jsonl|blobs\/[0-9a-f]{64}|expect\.json|\.gitattributes)$/.test(l))).toEqual([]);
    // Nothing is left behind where a pattern such as goldens/* would find it, or in .shadowlap/.
    expect(readdirSync(join(work, 'goldens'))).toEqual(['reference-agent']);
    expect(readdirSync(join(work, '.shadowlap', 'update'))).toEqual([]);

    const after = goldenRunId();
    expect(after).not.toBe(before);
    const s = store();
    expect(s.getCalls(after).find((c) => c.name === 'send_email')!.origin).toBe('stubbed');
    const [result] = s.listTestResults({ golden: 'goldens/reference-agent' });
    expect(result).toMatchObject({ ok: true, goldenRunId: after, data: { updated: { from: before, to: after, calls: 30, changes: ['system prompt changed', 'call 3 (api POST /v1/messages): ~ $.system'] } } });
    expect(s.listEvents({ kinds: ['golden.updated'] })[0]).toMatchObject({ runId: after, ref: 'goldens/reference-agent', data: { previous: before, calls: 30, changes: ['system prompt changed', 'call 3 (api POST /v1/messages): ~ $.system'] } });
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

  it('warns before updating when the request newly carries a field holding a value made anew on every run', async () => {
    // Sends metadata with a fresh user id only when asked to: the golden is recorded without it.
    writeFileSync(
      join(work, 'agent.mjs'),
      `import { randomUUID } from 'node:crypto';
const meta = process.env.WITH_USER_ID ? { metadata: { user_id: randomUUID() } } : {};
const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 32, ...meta, messages: [{ role: 'user', content: 'triage' }] }) });
if (!res.ok) process.exit(1);
console.log(JSON.stringify((await res.json()).content));
`,
    );
    const recorded = await shadowlap(['run', '--', process.execPath, 'agent.mjs']);
    expect(recorded.code, recorded.out).toBe(0);
    expect((await shadowlap(['pack', /recording run (\w{26})/.exec(recorded.out)![1]!, 'goldens/meta'])).code).toBe(0);
    const r = await shadowlap(['test', 'goldens/meta', '--update'], { WITH_USER_ID: '1' });
    expect(r.out).toContain('+ $.metadata');
    expect(r.out).toContain('! $.metadata.user_id is new in the request and looks like a UUID, a value that changes every run: after this update the next run diverges on it, unless a normalizer masks it:');
    expect(r.out).toContain("shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'");
    expect(r.out).toContain('replaced goldens/meta in the working tree');
  });

  it('warns when what diverged is a value the agent makes anew on every run, and names the normalizer', async () => {
    const recorded = await shadowlap(['run', '--', process.execPath, VOLATILE]);
    expect(recorded.code, recorded.out).toBe(0);
    const runId = /recording run (\w{26})/.exec(recorded.out)![1]!;
    expect((await shadowlap(['pack', runId, 'goldens/volatile'])).code).toBe(0);
    // Its scratch directory changes every run too, and isn't a value of a known shape: an update is offered.
    const both = await shadowlap(['test', 'goldens/volatile']);
    expect(both.out).toContain('If the change was intended, update it: shadowlap test goldens/volatile --update');
    // With the directory masked, only the UUID diverges, and the normalizer hint is the whole advice.
    const scratch = { path: '$.system', pattern: '/agent-[A-Za-z0-9]+/', replace: 'agent-X' };
    writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ normalize: [{ kind: 'api', ...scratch }, { kind: 'tool', name: 'save_report', ...scratch, path: '$.args.path' }] }));
    const uuid = await shadowlap(['test', 'goldens/volatile']);
    expect(uuid.out).toContain('hint: this looks like a UUID');
    expect(uuid.out).not.toContain('If the change was intended');
    const r = await shadowlap(['test', 'goldens/volatile', '--update']);
    expect(r.out).toContain('! $.metadata.user_id looks like a UUID, a value that changes every run: updating re-records it, and the next run diverges again. A normalizer fixes it for good:');
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
