import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { startMockAnthropic, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from '@shadowlap-testing/reference-agent';
import { exitStatus, sharedGroup } from '../src/agent-signals.js';
import { testAttempt } from '../src/run-agent.js';

/**
 * Stop signals while the CLI waits on an agent, in real processes: a Ctrl-C reaches the agent once,
 * whether the CLI passes it on (no terminal) or the terminal delivers it (a terminal, which the agent
 * keeps to read from); a closed terminal (SIGHUP) ends the run as interrupted and the agent with it;
 * a second Ctrl-C while a judge is asked ends the run as interrupted before the CLI ends; and an agent
 * left running when the CLI exits first is killed with its group.
 */

const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const AGENT = fileURLToPath(new URL('../../../testing/reference-agent/dist/main.js', import.meta.url));
const POSIX = process.platform !== 'win32';

let dir: string;
let mock: MockServer;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sl-signals-'));
  mock = await startMockAnthropic({ script: referenceScript, eventDelayMs: () => 0 });
});
afterAll(async () => {
  await mock.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_HOME: join(dir, 'home'), SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, ...extra });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

async function until(test: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return test();
}

/** Waits for a line on the child's stdout matching `re`, and returns its match. */
function line(child: ChildProcess, re: RegExp): Promise<RegExpExecArray> {
  let out = '';
  return new Promise((resolve, reject) => {
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const m = re.exec(out);
      if (m) resolve(m);
    });
    child.once('exit', () => reject(new Error(`exited before ${re}: ${out}`)));
  });
}

const exited = (child: ChildProcess) => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

function runStatus(db: string): string[] {
  const store = Store.open(db);
  try {
    return store.allRuns().map((r) => r.status);
  } finally {
    store.close();
  }
}

/** An agent that logs each signal it hears to a file, says it is ready, and ends a moment after its first SIGINT. */
const LOGGING_AGENT = (log: string, extra = '') => `
const fs = require('fs');
let n = 0;
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => {
  fs.appendFileSync(${JSON.stringify(log)}, s + '\\n');
  if (s === 'SIGINT' && ++n === 1) setTimeout(() => process.exit(0), 800);
});
${extra}
console.log('ready ' + process.pid);
setInterval(() => {}, 1000);
`;

describe('what a stop signal comes out as', () => {
  it('reports a signal as a shell does: 128 + its number', () => {
    expect(exitStatus(null, 'SIGINT')).toBe(130);
    expect(exitStatus(null, 'SIGHUP')).toBe(129);
    expect(exitStatus(null, 'SIGTERM')).toBe(143);
    expect(exitStatus(null, 'SIGKILL')).toBe(137);
    expect(exitStatus(0, null)).toBe(0);
    expect(exitStatus(null, null)).toBe(1);
  });

  it("keeps an agent in a dashboard job's group, or in the terminal's when it reads stdin and a standard stream is one", () => {
    expect(sharedGroup(true, {}, (fd) => fd === 0)).toBe('terminal');
    expect(sharedGroup(true, {}, (fd) => fd === 2)).toBe('terminal');
    expect(sharedGroup(true, {}, () => false)).toBeNull();
    expect(sharedGroup(false, {}, () => true)).toBeNull();
    expect(sharedGroup(true, { SHADOWLAP_EVENTS_FD: '3' }, () => false)).toBe('job');
    expect(sharedGroup(false, { SHADOWLAP_EVENTS_FD: '3' }, () => true)).toBe('job');
  });
});

describe.skipIf(!POSIX)('stop signals while the CLI waits on an agent', () => {
  it('passes one Ctrl-C to the agent of run, which hears it once when its whole group was signalled', async () => {
    const db = join(dir, 'ctrl-c.db');
    const log = join(dir, 'ctrl-c.log');
    writeFileSync(join(dir, 'agent-ctrl-c.cjs'), LOGGING_AGENT(log));
    // The CLI leads a group of its own, as a terminal's foreground job does; a Ctrl-C reaches the group.
    const cli = spawn(process.execPath, [CLI, '--db', db, 'run', '--guard', 'off', '--', process.execPath, join(dir, 'agent-ctrl-c.cjs')], { cwd: dir, env: env(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const done = exited(cli);
    await line(cli, /ready (\d+)/);
    process.kill(-cli.pid!, 'SIGINT');
    await done;
    expect(readFileSync(log, 'utf8')).toBe('SIGINT\n');
    expect(runStatus(db)).toEqual(['crashed']);
  });

  it('leaves a Ctrl-C in a terminal to the terminal: the agent shares it, hears it once and can open it', async () => {
    let python: string | null = null;
    for (const cmd of ['python3', 'python']) {
      try {
        execFileSync(cmd, ['-c', 'import pty, select'], { stdio: 'ignore' });
        python = cmd;
        break;
      } catch {
        // next
      }
    }
    if (!python) return;
    const db = join(dir, 'tty.db');
    const log = join(dir, 'tty.log');
    // The agent says whether it can open the terminal it was started from, as a password prompt does.
    const opens = `try { require('fs').closeSync(require('fs').openSync('/dev/tty', 'r+')); console.log('tty:ok'); } catch (e) { console.log('tty:' + e.code); }`;
    writeFileSync(join(dir, 'agent-tty.cjs'), LOGGING_AGENT(log, opens));
    // A pseudo-terminal the CLI runs in, as in a terminal window: Ctrl-C is the byte 0x03 typed there.
    writeFileSync(
      join(dir, 'pty-run.py'),
      `
import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
out, sent, deadline = b'', False, time.time() + 25
while time.time() < deadline:
    if select.select([fd], [], [], 0.1)[0]:
        try:
            data = os.read(fd, 4096)
        except OSError:
            data = b''
        if not data:
            break
        out += data
        if not sent and b'ready' in out:
            os.write(fd, b'\\x03')
            sent = True
os.waitpid(pid, 0)
sys.stdout.write(out.decode('utf-8', 'replace'))
`,
    );
    const out = execFileSync(python, [join(dir, 'pty-run.py'), process.execPath, CLI, '--db', db, 'run', '--guard', 'off', '--', process.execPath, join(dir, 'agent-tty.cjs')], { cwd: dir, env: env(), timeout: 30_000 }).toString();
    expect(out).toContain('tty:ok');
    expect(readFileSync(log, 'utf8')).toBe('SIGINT\n');
    expect(runStatus(db)).toEqual(['crashed']);
  });

  it('ends the run as interrupted on SIGHUP, and kills an agent that ignores it', async () => {
    const db = join(dir, 'hup.db');
    const log = join(dir, 'hup.log');
    writeFileSync(join(dir, 'agent-hup.cjs'), LOGGING_AGENT(log));
    const cli = spawn(process.execPath, [CLI, '--db', db, 'run', '--guard', 'off', '--', process.execPath, join(dir, 'agent-hup.cjs')], { cwd: dir, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    const done = exited(cli);
    const agent = Number((await line(cli, /ready (\d+)/))[1]);
    try {
      process.kill(cli.pid!, 'SIGHUP');
      await done;
      // The agent heard it once, ignored it, and was killed after a moment.
      expect(readFileSync(log, 'utf8')).toBe('SIGHUP\n');
      expect(await until(() => !alive(agent))).toBe(true);
      expect(runStatus(db)).toEqual(['crashed']);
    } finally {
      if (alive(agent)) process.kill(agent, 'SIGKILL');
    }
  });

  it('interrupts a replay of shadowlap test on SIGHUP, and kills its group', async () => {
    const store = Store.open(':memory:');
    const parent = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.cjs'], cwd: dir } });
    store.endRun(parent.runId, 'completed');
    const pidFile = join(dir, 'test-hup.pid');
    const script = `process.on('SIGHUP', () => {}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
    const attempt = testAttempt(store, parent, { cwd: dir, upstreams: {}, extraEnv: {}, writes: 'block', guard: 'off', normalizers: [], prices: undefined, clock: undefined, spec: null, argv: [process.execPath, '-e', script], onSignal: 'return' });
    expect(await until(() => existsSync(pidFile))).toBe(true);
    const agent = Number(readFileSync(pidFile, 'utf8'));
    try {
      process.emit('SIGHUP', 'SIGHUP');
      const a = await attempt;
      expect(a.interrupted).toBe('SIGHUP');
      expect(a.ended.run.status).toBe('crashed');
      expect(a.failure!.message).toBe('the replay was interrupted (SIGHUP)');
      expect(alive(agent)).toBe(false);
    } finally {
      if (alive(agent)) process.kill(agent, 'SIGKILL');
      store.close();
    }
  });

  it('ends a run whose judge is being asked as interrupted on a second Ctrl-C, and ends with the signal', async () => {
    const db = join(dir, 'judge.db');
    // The run's agent has exited and its judge never answers: only a second Ctrl-C ends the wait.
    const script = `
import { runUnderSidecar } from ${JSON.stringify(pathToFileURL(join(DIST, 'run-agent.js')).href)};
await runUnderSidecar({ db: ${JSON.stringify(db)} }, [process.execPath, '-e', ''], (sidecar) => sidecar.startRun({ mode: 'record', command: { argv: ['node'], cwd: process.cwd() } }), 'off', {
  beforeEnd: async () => {
    console.log('judging');
    await new Promise(() => {});
  },
});
`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    const done = exited(child);
    await line(child, /judging/);
    process.kill(child.pid!, 'SIGINT');
    // The first is kept for when the judge is done; the second doesn't wait.
    await new Promise((r) => setTimeout(r, 300));
    expect(runStatus(db)).toEqual(['running']);
    process.kill(child.pid!, 'SIGINT');
    const end = await done;
    expect(end.signal === 'SIGINT' || end.code === 130, JSON.stringify(end)).toBe(true);
    expect(runStatus(db)).toEqual(['crashed']);
  });

  it('kills an agent group when the CLI exits before its agent', async () => {
    const script = `
import { spawn } from 'node:child_process';
import { trackAgent } from ${JSON.stringify(pathToFileURL(join(DIST, 'agent-signals.js')).href)};
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('agent ' + process.pid); setInterval(() => {}, 1000)"], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
trackAgent(child, true);
child.stdout.once('data', (d) => {
  process.stdout.write(d);
  process.exit(3);
});
`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    const done = exited(child);
    const agent = Number((await line(child, /agent (\d+)/))[1]);
    try {
      expect((await done).code).toBe(3);
      expect(await until(() => !alive(agent))).toBe(true);
    } finally {
      if (alive(agent)) process.kill(agent, 'SIGKILL');
    }
  });

  it('leaves no agent of decisions --from-code running after a second Ctrl-C', async () => {
    const db = join(dir, 'decisions.db');
    const rec = spawn(process.execPath, [CLI, '--db', db, 'run', '--guard', 'off', '--', process.execPath, AGENT], { cwd: dir, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let recorded = '';
    rec.stderr!.on('data', (d: Buffer) => (recorded += d.toString()));
    rec.stdout!.on('data', (d: Buffer) => (recorded += d.toString()));
    expect((await exited(rec)).code, recorded).toBe(0);
    const runId = /recording run (\w{26})/.exec(recorded)![1]!;
    // An agent that ignores Ctrl-C and SIGTERM and never sends its first request.
    const pidFile = join(dir, 'stubborn.pid');
    writeFileSync(join(dir, 'stubborn.cjs'), `for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => {}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const cli = spawn(process.execPath, [CLI, '--db', db, 'decisions', runId, '--from-code', '--', process.execPath, join(dir, 'stubborn.cjs')], { cwd: dir, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    const done = exited(cli);
    expect(await until(() => existsSync(pidFile))).toBe(true);
    const agent = Number(readFileSync(pidFile, 'utf8'));
    try {
      process.kill(cli.pid!, 'SIGINT');
      await new Promise((r) => setTimeout(r, 300));
      process.kill(cli.pid!, 'SIGINT');
      const end = await done;
      expect(end.signal === 'SIGINT' || end.code === 130, JSON.stringify(end)).toBe(true);
      expect(await until(() => !alive(agent), 5_000)).toBe(true);
    } finally {
      if (alive(agent)) process.kill(agent, 'SIGKILL');
    }
  });
});
