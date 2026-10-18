import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasRecordedCommand, Store, withoutCommand } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { envLines } from '../src/commands/testing.js';

/**
 * `shadowlap serve` records a process the person starts, so it never knows its command. Its run has
 * none, as a capture has none: a replay asks for the command after --, rather than trying to run a
 * placeholder and keeping a failed run with no calls.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

const AGENT = `const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model: 'small-model', max_tokens: 64, messages: [{ role: 'user', content: 'Hello.' }] }),
});
console.log((await res.json()).content[0].text);
`;

let mock: MockServer;
let project: string;
const env = () => ({ ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off' });

function run(cmd: string, args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: project, env: { ...env(), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
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
const shadowlap = (args: string[]) => run(process.execPath, [CLI, ...args]);

beforeAll(async () => {
  mock = await startMockAnthropic({ script: () => ({ message: message([text('Hi.')]) }) });
  project = mkdtempSync(join(tmpdir(), 'sl-serve-'));
  writeFileSync(join(project, 'agent.mjs'), AGENT);
});
afterAll(async () => {
  await mock.close();
  rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('the environment serve prints', () => {
  it('is export lines for a POSIX shell, and PowerShell on Windows', () => {
    const vars = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4100/t/abc/anthropic', SHADOWLAP_RUN: "it's" };
    expect(envLines(vars, 'darwin')).toBe("export ANTHROPIC_BASE_URL=http://127.0.0.1:4100/t/abc/anthropic\nexport SHADOWLAP_RUN=it's");
    expect(envLines(vars, 'win32')).toBe("$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:4100/t/abc/anthropic'\n$env:SHADOWLAP_RUN = 'it''s'");
  });
});

// Windows has no SIGTERM a process can catch, so serve can't end its run there.
describe.skipIf(process.platform === 'win32')('a run recorded through shadowlap serve', () => {
  let runId = '';
  beforeAll(async () => {
    const serve = spawn(process.execPath, [CLI, 'serve'], { cwd: project, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    serve.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    serve.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const exited = new Promise<number | null>((resolve) => serve.on('close', resolve));
    for (let i = 0; i < 400 && !stderr.includes('Ctrl-C'); i++) await new Promise((r) => setTimeout(r, 25));
    runId = /recording run (\w{26})/.exec(stderr)![1]!;
    const vars = Object.fromEntries(stdout.trim().split('\n').map((l) => /^export ([^=]+)=(.*)$/.exec(l)!.slice(1, 3) as [string, string]));
    const agent = await run(process.execPath, ['agent.mjs'], vars);
    expect(agent.code, agent.out).toBe(0);
    serve.kill('SIGTERM');
    expect(await exited, stderr).toBe(0);
  });

  it('has no command, so ls says so', async () => {
    const ls = await shadowlap(['ls', '--json']);
    expect(JSON.parse(ls.stdout)).toEqual([expect.objectContaining({ runId, hasCommand: false, calls: 1 })]);
  });

  it('asks for the command after -- on replay, and keeps no failed run', async () => {
    const r = await shadowlap(['replay', runId]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(`${runId.slice(0, 10)} was recorded through shadowlap serve, which records what was sent but not what sent it, so it has no command to re-run. Give yours after --`);
    expect(r.out).not.toContain('failed to start');
    const ls = await shadowlap(['ls', '--json']);
    expect(JSON.parse(ls.stdout)).toHaveLength(1);
    const own = await shadowlap(['replay', runId, '--', process.execPath, 'agent.mjs']);
    expect(own.code, own.out).toBe(0);
    expect(own.out).toContain('✓ Replay clean: 1/1 calls replayed');
  });
});

describe('a run serve recorded, before this one too', () => {
  it('counts as having no command, as its placeholder says', () => {
    const store = Store.open(':memory:');
    const old = store.createRun({ mode: 'record', command: { argv: ['<external>'], cwd: '/' } });
    expect(hasRecordedCommand(old)).toBe(false);
    expect(hasRecordedCommand({ command: { argv: ['<external>', 'x'] } })).toBe(true);
    store.close();
  });
});

describe('a run a test recorded without a command', () => {
  it('has none to run again: replay asks for one after --, ls says so, and nothing tries to start the placeholder', async () => {
    // As the recordings host stores a Vitest, node:test or Python recording that gave no command.
    const db = join(project, 'tests.db');
    const store = Store.open(db);
    const recorded = store.createRun({ mode: 'record', command: { argv: ['<test>', 'refunds a delivered order'], cwd: project } });
    store.endRun(recorded.runId, 'completed');
    store.close();
    expect(hasRecordedCommand(recorded)).toBe(false);
    expect(withoutCommand(recorded)).toBe('was recorded by a test run');
    const ls = await shadowlap(['--db', db, 'ls', '--json']);
    expect(JSON.parse(ls.stdout)).toEqual([expect.objectContaining({ runId: recorded.runId, hasCommand: false })]);
    const r = await shadowlap(['--db', db, 'replay', recorded.runId]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(`${recorded.runId.slice(0, 10)} was recorded by a test run, which records what was sent but not what sent it, so it has no command to re-run. Give yours after --`);
    expect(r.out).not.toContain('<test>');
  });
});
