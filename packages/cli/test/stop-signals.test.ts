import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { signalExit } from '../src/exit-codes.js';

/**
 * The commands that run until they are stopped wind down on every stop signal alike: Ctrl-C
 * (SIGINT), a supervisor's SIGTERM, and the SIGHUP of a closed terminal. `serve` ends its run, `serve
 * --recordings` and `tasks serve` close what they serve, and `mcp` passes the signal on to its
 * server; each then ends with 128 + the signal's number. Before, a SIGHUP ended them where they
 * stood (a run left recording, an MCP server left running with nobody to stop it), and `mcp` and
 * `serve --recordings` never ended on any signal while their client held its end of their input open.
 */

const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const SIGNALS = ['SIGHUP', 'SIGTERM', 'SIGINT'] as const;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sl-stop-signals-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Started {
  child: ChildProcess;
  cwd: string;
  out: () => string;
  ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** A command started in a folder of its own, its input left open as a terminal's or a client's is. */
function start(name: string, args: string[], env: Record<string, string> = {}): Started {
  const cwd = mkdtempSync(join(dir, `${name}-`));
  const child = spawn(process.execPath, [CLI, '--db', join(cwd, 'store.db'), ...args], {
    cwd,
    env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_HOME: join(cwd, 'home'), SHADOWLAP_URL: '', SHADOWLAP_RUN_ID: '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (out += d.toString()));
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  return { child, cwd, out: () => out, ended };
}

/** Waits until `ok()` holds, or fails after `ms`. */
async function until(ok: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** How a command a signal was sent to ended, or that it hadn't within `ms` (it is killed then). */
async function endedWithin(c: Started, ms: number): Promise<{ code: number | null; signal: NodeJS.Signals | null } | 'still running'> {
  const outcome = await Promise.race([c.ended, sleep(ms).then(() => 'still running' as const)]);
  if (outcome === 'still running') {
    c.child.kill('SIGKILL');
    await c.ended;
  }
  return outcome;
}

describe.skipIf(process.platform === 'win32')('a stop signal', () => {
  it('ends the run shadowlap serve records on a closed terminal (SIGHUP), as on Ctrl-C, with 129', async () => {
    const serve = start('serve', ['serve']);
    await until(() => serve.out().includes('Ctrl-C to end it'), 20_000, 'serve to start recording');
    const runId = /recording run (\w{26})/.exec(serve.out())![1];
    serve.child.kill('SIGHUP');
    expect(await endedWithin(serve, 15_000), serve.out()).toEqual({ code: 129, signal: null });
    const store = Store.open(join(serve.cwd, 'store.db'));
    try {
      expect(store.getRun(runId)?.status).toBe('completed');
    } finally {
      store.close();
    }
  }, 30_000);

  it('closes the server shadowlap tasks serve runs on a closed terminal (SIGHUP), with 129', async () => {
    const served = start('tasks', ['tasks', 'serve'], { SHADOWLAP_TASKS_TOKEN: 'a-token-of-twenty-chars' });
    await until(() => /Serving .* on http:\/\/127\.0\.0\.1:\d+/.test(served.out()), 20_000, 'tasks serve to listen');
    served.child.kill('SIGHUP');
    expect(await endedWithin(served, 15_000), served.out()).toEqual({ code: 129, signal: null });
  }, 30_000);

  for (const signal of SIGNALS) {
    it(`closes what shadowlap serve --recordings serves on ${signal} while its plugin holds its input open`, async () => {
      const serve = start(`recordings-${signal}`, ['serve', '--recordings']);
      await until(() => /"url":"http:\/\/127\.0\.0\.1:\d+/.test(serve.out()), 20_000, 'serve --recordings to print its connection details');
      serve.child.kill(signal);
      expect(await endedWithin(serve, 15_000), serve.out()).toEqual({ code: signalExit(signal), signal: null });
    }, 30_000);

    it(`passes ${signal} on to the MCP server behind shadowlap mcp, which ends, and the proxy with it`, async () => {
      // A server that says when it is up, notes the signal that stops it, and outlives the end of its
      // input, as one busy with a request does: only a signal ends it (or, failing that, 15 s).
      const marker = join(dir, `mcp-server-stopped-by-${signal}`);
      const server = join(dir, `mcp-server-${signal}.mjs`);
      writeFileSync(
        server,
        `import { writeFileSync } from 'node:fs';
for (const s of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(s, () => { writeFileSync(${JSON.stringify(marker)}, s); process.exit(0); });
process.stdin.resume();
process.stdin.on('end', () => {});
setInterval(() => {}, 1000);
setTimeout(() => process.exit(3), 15000);
process.stderr.write('server ready\\n');
`,
      );
      const proxy = start(`mcp-${signal}`, ['mcp', '--', process.execPath, server]);
      await until(() => proxy.out().includes('server ready'), 20_000, 'the MCP server to start');
      proxy.child.kill(signal);
      expect(await endedWithin(proxy, 15_000), proxy.out()).toEqual({ code: signalExit(signal), signal: null });
      expect(existsSync(marker) ? readFileSync(marker, 'utf8') : 'never signalled').toBe(signal);
    }, 30_000);
  }
});

/**
 * A stop signal that comes while the command is busy with synchronous work, as repair is when git
 * removes its worktree after the last verify, waits for the event loop to read it. The command then
 * ends, and its process with it: before, with the command's own status (1 for a repair with no fix),
 * the signal never read. The entry point (runToEnd, which bin/shadowlap.js runs every command with)
 * reads it first, so the process ends with 128 + n.
 */
describe.skipIf(process.platform === 'win32')('a stop signal during the last synchronous work', () => {
  const EXIT_CODES = new URL('../dist/exit-codes.js', import.meta.url).href;

  /** A command that says it is busy, works synchronously for a second, then sets its own status of 1 or throws a failure. */
  async function busy(signal: NodeJS.Signals, opts: { throws: boolean; listens: boolean }): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }> {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { writeSync } from 'node:fs';
const { failedError, runToEnd, watchStopSignals } = await import(${JSON.stringify(EXIT_CODES)});
watchStopSignals();
// A command winding down on a signal of its own, as repair does while it stops its repairer.
if (${opts.listens}) process.on(${JSON.stringify(signal)}, () => {});
runToEnd(async () => {
  writeSync(1, 'busy\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  if (${opts.throws}) throw failedError('no candidate passed');
  process.exitCode = 1;
});`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('close', (code, sig) => resolve({ code, signal: sig })));
    await new Promise<void>((resolve) => child.stdout.on('data', (d: Buffer) => d.toString().includes('busy') && resolve()));
    child.kill(signal);
    return { ...(await ended), out };
  }

  it('ends with the signal, not the status the command set, when it was the last thing to run', async () => {
    // Nothing else listens: the process ends by the signal itself, as a shell reports 128 + n.
    expect(await busy('SIGINT', { throws: false, listens: false })).toEqual({ code: null, signal: 'SIGINT', out: '' });
    // The command listens too, so the status says it: 128 + n.
    expect(await busy('SIGTERM', { throws: false, listens: true })).toEqual({ code: signalExit('SIGTERM'), signal: null, out: '' });
  }, 20_000);

  it('ends with the signal, not the failure the command threw after it', async () => {
    expect((await busy('SIGHUP', { throws: true, listens: false })).signal).toBe('SIGHUP');
    const listened = await busy('SIGINT', { throws: true, listens: true });
    expect(listened.code, listened.out).toBe(signalExit('SIGINT'));
    expect(listened.out).toBe('shadowlap: no candidate passed\n');
  }, 20_000);
});

/**
 * A closed terminal sends SIGHUP and leaves the process with a terminal that is gone: reading the
 * keyboard or drawing the screen then fails (EIO), an error nothing catches. The entry point
 * (endUncaught, its uncaughtException handler) reads the signal first, so the process ends with 129,
 * as `shadowlap ui` does in its window: before, the error came first about half the time under load,
 * and it ended with 2.
 */
describe.skipIf(process.platform === 'win32')('a stop signal that comes with an error nothing caught', () => {
  const EXIT_CODES = new URL('../dist/exit-codes.js', import.meta.url).href;

  /** Sends itself SIGHUP, which waits for the event loop to read it, and throws a closed terminal's EIO before it does. */
  async function hungUp(listens: boolean): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }> {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { endUncaught, watchStopSignals } = await import(${JSON.stringify(EXIT_CODES)});
watchStopSignals();
// A command winding down on a signal of its own, as shadowlap ui does.
if (${listens}) process.on('SIGHUP', () => {});
process.on('uncaughtException', endUncaught);
process.kill(process.pid, 'SIGHUP');
process.nextTick(() => {
  throw Object.assign(new Error('read EIO'), { code: 'EIO', errno: -5, syscall: 'read' });
});
process.nextTick(() => {
  throw new Error('a second error');
});`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('close', (code, sig) => resolve({ code, signal: sig })));
    return { ...(await ended), out };
  }

  it('ends with the signal, not the status of the error, saying the first error alone', async () => {
    expect(await hungUp(true)).toEqual({ code: signalExit('SIGHUP'), signal: null, out: 'shadowlap: read EIO\n' });
    // Nothing else listens: the process ends by the signal itself, as a shell reports 128 + n.
    expect(await hungUp(false)).toEqual({ code: null, signal: 'SIGHUP', out: '' });
  }, 20_000);
});
