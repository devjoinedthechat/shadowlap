import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';

/**
 * An agent that stops before its recording did, and still exits 0, is no clean replay: every request
 * it sent matched, but the calls it never made (the last model turn, a write) are as much a change.
 * `test` fails its golden, `replay --strict` exits 1, and bisect counts the commit as bad.
 *
 * The agent makes as many model calls as steps.txt says; it was recorded making three.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

const AGENT = `import { readFileSync } from 'node:fs';
const steps = Number(readFileSync(new URL('./steps.txt', import.meta.url), 'utf8').trim());
for (let i = 1; i <= steps; i++) {
  const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'small-model', max_tokens: 64, messages: [{ role: 'user', content: 'Step ' + i + '.' }] }),
  });
  if (!res.ok) {
    console.error(await res.text());
    process.exit(1);
  }
  await res.json();
}
console.log('done after ' + steps + ' steps');
`;

let mock: MockServer;
let project: string;
const rev: Record<string, string> = {};
let recordedRun = '';

const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
function commit(name: string, files: Record<string, string>): void {
  for (const [f, content] of Object.entries(files)) writeFileSync(join(project, f), content);
  sh('git', ['add', '.']);
  sh('git', ['-c', 'user.name=Test', 'commit', '-q', '-m', name]);
  rev[name] = sh('git', ['rev-parse', '--short', 'HEAD']);
}

function shadowlap(args: string[]): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: project, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out, stdout }));
  });
}

/** Runs `body` with steps.txt saying `steps` in the working tree, then puts it back as committed. */
async function withSteps<T>(steps: number, body: () => Promise<T>): Promise<T> {
  writeFileSync(join(project, 'steps.txt'), `${steps}\n`);
  try {
    return await body();
  } finally {
    sh('git', ['checkout', '--', 'steps.txt']);
  }
}

beforeAll(async () => {
  mock = await startMockAnthropic({ script: () => ({ message: message([text('Noted.')]) }) });
  project = mkdtempSync(join(tmpdir(), 'sl-ended-early-'));
  sh('git', ['init', '-q', '-b', 'main']);
  sh('git', ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(project, '.gitignore'), '.shadowlap/\nreport.json\nsummary.json\n');
  commit('Start the step agent', { 'agent.mjs': AGENT, 'steps.txt': '3\n', 'README.md': 'Step agent\n' });
  const recorded = await shadowlap(['run', '--', process.execPath, 'agent.mjs']);
  expect(recorded.code, recorded.out).toBe(0);
  recordedRun = /recording run (\w{26})/.exec(recorded.out)![1]!;
  const packed = await shadowlap(['pack', recordedRun, 'goldens/steps']);
  expect(packed.code, packed.out).toBe(0);
  sh('git', ['add', '.']);
  sh('git', ['-c', 'user.name=Test', 'commit', '-q', '-m', 'Add the golden']);
  commit('Describe the agent', { 'README.md': 'Step agent: three model calls.\n' });
  commit('Stop after one step', { 'steps.txt': '1\n' });
  commit('Mention the steps', { 'README.md': 'Step agent: model calls as steps.txt says.\n' });
});
afterAll(async () => {
  await mock.close();
  rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('a replay that ends before its recording did', () => {
  it('bisect counts the commit where the agent stops early as bad', async () => {
    const r = await shadowlap(['bisect', 'goldens/steps', '--good', rev['Start the step agent']]);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain(`first bad commit ${rev['Stop after one step']} · Stop after one step`);
    expect(r.out).toContain('ended early at call 2 (api POST /v1/messages): 1 of 3 recorded calls replayed');
  });

  it('test passes the golden while the agent makes every recorded call, counting them out of the recording', async () => {
    const r = await withSteps(3, () => shadowlap(['test', 'goldens/steps']));
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('✓ steps: 3/3 replayed');
  });

  it('test fails a golden whose agent stops early and exits 0, and says so in the JSON report', async () => {
    const r = await shadowlap(['test', 'goldens/steps', '--json', 'report.json']);
    expect(r.code, r.out).toBe(1);
    expect(r.stdout).toContain('✗ steps: ended early at call 2 (api POST /v1/messages): 1 of 3 recorded calls replayed');
    expect(r.stdout).toContain('✗ Ended early at call 2: 1 of 3 recorded calls replayed');
    expect(r.stdout).toContain('2 recorded calls not reached: #2 POST /v1/messages, #3 POST /v1/messages');
    expect(r.stdout).toContain('0 passed, 1 failed');
    const report = JSON.parse(readFileSync(join(project, 'report.json'), 'utf8'));
    expect(report.results[0]).toMatchObject({ ok: false, failure: 'diverged', message: 'ended early at call 2 (api POST /v1/messages): 1 of 3 recorded calls replayed', divergence: { type: 'ended_early', callNo: 2, kind: 'api', name: 'POST /v1/messages', recorded: 3 } });
  });

  it('replay prints it as ended early, and --strict exits 1', async () => {
    const plain = await shadowlap(['replay', recordedRun, '--summary-json', 'summary.json']);
    expect(plain.code, plain.out).toBe(0);
    expect(plain.out).toContain('✗ Ended early at call 2: 1 of 3 recorded calls replayed');
    expect(plain.out).not.toContain('Replay clean');
    const { summary } = JSON.parse(readFileSync(join(project, 'summary.json'), 'utf8'));
    expect(summary.divergence).toMatchObject({ type: 'ended_early', callNo: 2, kind: 'api', replayedBefore: 1, recorded: 3, counterpart: { runId: recordedRun, callNo: 2 } });
    const strict = await shadowlap(['replay', recordedRun, '--strict']);
    expect(strict.code, strict.out).toBe(1);
    const clean = await withSteps(3, () => shadowlap(['replay', recordedRun, '--strict']));
    expect(clean.code, clean.out).toBe(0);
    expect(clean.out).toContain('✓ Replay clean: 3/3 calls replayed');
  });

  it('keeps it on the run: ls, ls --json and show never call it a clean replay', async () => {
    const replayed = await shadowlap(['replay', recordedRun]);
    const runId = /replaying run (\w{26})/.exec(replayed.out)![1];
    const ls = await shadowlap(['ls']);
    const line = ls.stdout.split('\n').find((l) => l.startsWith(runId.slice(0, 10)))!;
    expect(line).toContain('ended early @2');
    expect(line).not.toContain('clean replay');
    const json = await shadowlap(['ls', '--json']);
    expect(JSON.parse(json.stdout).find((r: { runId: string }) => r.runId === runId)).toMatchObject({ mode: 'replay', status: 'completed', forkedAt: { callNo: 2, type: 'ended_early', kind: 'api', name: 'POST /v1/messages' }, calls: 1 });
    const show = await shadowlap(['show', runId]);
    expect(show.stdout).toContain('✗ Ended early at call 2 (api POST /v1/messages): 1 of 3 recorded calls replayed');
  });

  it('replay --repeat says which attempts ended early, and --strict exits 1 on them', async () => {
    const r = await shadowlap(['replay', recordedRun, '--repeat', '2', '--strict']);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('none forked · 2 of 2 ended early, at call 2');
  });
});
