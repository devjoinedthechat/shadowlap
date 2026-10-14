import { spawn } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { startMockAnthropic, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from '@shadowlap-testing/reference-agent';

/**
 * The CLI as a process, when the agent does not end well: a crash mid-run, an interrupt, a
 * command that does not exist. The recording must survive, the run must be marked, the store
 * must be left consistent, and a replay of the partial recording must work.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('../../../testing/reference-agent/dist/main.js', import.meta.url));

interface Outcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  out: string;
}

let mock: MockServer;
let cwd: string;
let db: string;
let env: NodeJS.ProcessEnv;

function shadowlap(args: string[], extra: NodeJS.ProcessEnv = {}, opts: { interruptAfterMs?: number } = {}): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    if (opts.interruptAfterMs) setTimeout(() => child.kill('SIGINT'), opts.interruptAfterMs);
    child.on('exit', (code, signal) => resolve({ code, signal, out }));
  });
}

/** Opens, reads and closes: an open handle keeps the file locked on Windows. */
function runCount(): number {
  const store = Store.open(db);
  try {
    return store.allRuns().length;
  } finally {
    store.close();
  }
}

beforeAll(async () => {
  mock = await startMockAnthropic({ script: referenceScript });
  cwd = mkdtempSync(join(tmpdir(), 'fp-lifecycle-'));
  db = join(cwd, 'store.db');
  env = { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_GUARD: 'off' };
});
afterAll(async () => {
  await mock.close();
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('shadowlap run when the agent does not end well', () => {
  it('keeps the recording of an agent that crashes, marks the run failed, and replays it past the end', async () => {
    const crashed = await shadowlap(['run', '--', process.execPath, AGENT], { AGENT_FAIL_AFTER_CALL: '5' });
    expect(crashed.code).toBe(1);
    expect(crashed.out).toContain('agent crashed after model call 5');
    expect(crashed.out).toMatch(/Recorded \S+: \d+ calls \(5 api/);
    const store = Store.open(db);
    const run = store.allRuns()[0]!;
    expect(run.status).toBe('failed');
    expect(store.getCalls(run.runId).filter((c) => c.kind === 'api')).toHaveLength(5);
    store.close();

    // The same agent without the crash: the recorded prefix replays, then it continues live.
    const replay = await shadowlap(['replay', run.runId]);
    expect(replay.code).toBe(0);
    expect(replay.out).toMatch(/Forked at call \d+/);
    expect(replay.out).toContain('beyond the recording: the agent made more calls than were recorded');
    expect(replay.out).toContain('1 write blocked'); // the email at the end still does not go out
    const store2 = Store.open(db);
    const child = store2.allRuns().find((r) => r.parentRunId === run.runId)!;
    expect(child.status).toBe('completed');
    expect(child.divergence?.type).toBe('beyond_recording');
    expect(store2.getCalls(child.runId).filter((c) => c.kind === 'api')).toHaveLength(11);
    expect(store2.getCalls(child.runId).filter((c) => c.origin === 'replayed').length).toBeGreaterThan(5);
    store2.close();
  });

  it('repeats a fork, concurrently, with every attempt in its own run', async () => {
    const recorded = await shadowlap(['run', '--', process.execPath, AGENT]);
    const parentId = /recording run (\w{26})/.exec(recorded.out)![1]!;
    const r = await shadowlap(['replay', parentId, '--repeat', '3', '--concurrency', '3'], { AGENT_SYSTEM_SUFFIX: 'Be brief.' });
    expect(r.code).toBe(0);
    expect(r.out.match(/── attempt \d of 3 · run \w{26} ──/g)).toHaveLength(3);
    expect(r.out).toContain(`⑂ 3 attempts from ${parentId.slice(0, 10)}, each forked at call 3`);
    expect(r.out).toContain('every attempt took the same path');
    expect(r.out).toMatch(/send_email\s+3 of 3\s+3 \(3 blocked\)/);
    expect(r.out).toContain('Final model responses: the same in every attempt');
    const store = Store.open(db);
    const children = store.allRuns().filter((x) => x.parentRunId === parentId);
    // Each attempt's model calls landed in its own run, even though they ran at the same time.
    expect(children).toHaveLength(3);
    for (const child of children) {
      expect(child.divergence?.callNo).toBe(3);
      expect(store.getCalls(child.runId).filter((c) => c.kind === 'api')).toHaveLength(11);
    }
    // Marked as attempts of one invocation, for the dashboard.
    expect(new Set(children.map((c) => c.meta?.repeat?.group)).size).toBe(1);
    expect(children.map((c) => c.meta?.repeat?.attempt).sort()).toEqual([1, 2, 3]);
    store.close();

    const strict = await shadowlap(['replay', parentId, '--repeat', '2', '--strict'], { AGENT_SYSTEM_SUFFIX: 'Be brief.' });
    expect(strict.code).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('marks an interrupted run crashed and leaves no run "running"', async () => {
    const before = runCount();
    const r = await shadowlap(['run', '--', process.execPath, AGENT], { AGENT_PAUSE_MS: '400' }, { interruptAfterMs: 1500 });
    expect(r.code).toBe(128);
    expect(r.out).toMatch(/Recorded \S+: \d+ calls/);
    const store = Store.open(db);
    const runs = store.allRuns();
    expect(runs).toHaveLength(before + 1);
    const run = runs[0]!;
    expect(run.status).toBe('crashed');
    expect(run.endedAt).not.toBeNull();
    expect(runs.some((x) => x.status === 'running')).toBe(false);
    const calls = store.getCalls(run.runId);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThan(30);
    store.close();
    // The doctor sees a clean store.
    const doctor = await shadowlap(['doctor']);
    expect(doctor.code).toBe(0);
    expect(doctor.out).not.toContain('still marked running');
  });

  it('fails clearly when the command cannot be started, without a stray run', async () => {
    const before = runCount();
    const r = await shadowlap(['run', '--', 'definitely-not-a-command-xyz']);
    expect(r.code).toBe(127);
    expect(r.out).toContain('failed to start definitely-not-a-command-xyz');
    const store = Store.open(db);
    const runs = store.allRuns();
    // The run exists (it was started before the spawn failed) but is closed, not left running.
    expect(runs).toHaveLength(before + 1);
    expect(runs[0]!.status).not.toBe('running');
    store.close();
  });

  it.skipIf(process.platform === 'win32')('writes the active-run file for its owner only, never through a planted link', async () => {
    const victim = join(cwd, 'victim.txt');
    writeFileSync(victim, 'untouched');
    mkdirSync(join(cwd, '.shadowlap'), { recursive: true });
    symlinkSync(victim, join(cwd, '.shadowlap', 'active.json'));
    const probe = `const fs=require('fs');const f='.shadowlap/active.json';const s=fs.lstatSync(f);console.log('link='+s.isSymbolicLink()+' mode='+(s.mode&0o777).toString(8))`;
    const out = await shadowlap(['run', '--', process.execPath, '-e', probe]);
    expect(out.out).toContain('link=false mode=600');
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    expect(existsSync(join(cwd, '.shadowlap', 'active.json'))).toBe(false);
    expect(lstatSync(victim).isFile()).toBe(true);
    expect(statSync(db).mode & 0o777).toBe(0o600);
  });

  it('asks before replaying a command that came from an imported pack', async () => {
    // A pack whose recorded command would write a marker file: the stand-in for anything harmful.
    const pack = mkdtempSync(join(tmpdir(), 'fp-hostile-pack-'));
    cpSync(fileURLToPath(new URL('../../../testing/golden/reference-agent', import.meta.url)), pack, { recursive: true });
    const marker = join(cwd, 'pwned.txt');
    const manifest = JSON.parse(readFileSync(join(pack, 'run.json'), 'utf8')) as { runs: Array<{ runId: string; command: { argv: string[] } }> };
    manifest.runs[0]!.command.argv = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`];
    writeFileSync(join(pack, 'run.json'), JSON.stringify(manifest));
    const runId = manifest.runs[0]!.runId;

    const unpacked = await shadowlap(['unpack', pack]);
    expect(unpacked.code).toBe(0);
    expect(unpacked.out).toContain('command:');
    expect(unpacked.out).toContain('Replaying an imported run executes the command it was recorded with');

    // No terminal to ask: refuse, and say how to proceed.
    const refused = await shadowlap(['replay', runId]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('was imported from a pack');
    expect(refused.out).toContain('--yes');
    expect(existsSync(marker)).toBe(false);

    // Your own command runs without asking.
    const own = await shadowlap(['replay', runId, '--', process.execPath, '-e', '0']);
    expect(own.out).not.toContain('was imported from a pack');
    expect(existsSync(marker)).toBe(false);

    // Explicit consent runs the recorded command, and the replay it creates carries the mark.
    const consented = await shadowlap(['replay', runId, '--yes']);
    expect(consented.out).not.toContain('was imported from a pack');
    expect(existsSync(marker)).toBe(true);
    const store = Store.open(db);
    const child = store.allRuns().find((r) => r.parentRunId === runId && r.meta?.commandFromImport);
    store.close();
    expect(child).toBeDefined();
    const again = await shadowlap(['replay', child!.runId]);
    expect(again.code).toBe(1);
    expect(again.out).toContain('was imported from a pack');
    rmSync(pack, { recursive: true, force: true });
  });
});
