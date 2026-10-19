import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activeRunFile, clearActiveRun, markActiveRun } from '../src/active-run.js';

let dir: string;
const children: ChildProcessWithoutNullStreams[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sl-active-'));
});
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

const run = (name: string) => ({ url: `http://127.0.0.1:1/${name}`, runId: `run-${name}`, pid: process.pid });
const named = () => (JSON.parse(readFileSync(activeRunFile(dir), 'utf8')) as { runId: string }).runId;
const MODULE = new URL('../dist/active-run.js', import.meta.url).href;

/** A process running `code` with the built module, and the next line it prints. */
function start(code: string): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  return child;
}
const said = (child: ChildProcessWithoutNullStreams, line: string) =>
  new Promise<void>((resolve, reject) => {
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()).includes(`${line}\n`) && resolve());
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('exit', (c) => reject(new Error(`exited with ${c} before saying ${line}: ${err}`)));
  });
const exited = (child: ChildProcessWithoutNullStreams) => new Promise<number | null>((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.once('exit', (c) => resolve(c))));

describe('the active-run file', () => {
  it('names the run that started last, and a run that ends removes it only while it names that run', () => {
    markActiveRun(dir, run('a'));
    markActiveRun(dir, run('b'));
    expect(named()).toBe('run-b');
    clearActiveRun(dir, 'run-a');
    expect(named()).toBe('run-b');
    if (process.platform !== 'win32') expect(statSync(activeRunFile(dir)).mode & 0o777).toBe(0o600);
    clearActiveRun(dir, 'run-b');
    expect(existsSync(activeRunFile(dir))).toBe(false);
    // Neither its lock nor a temporary file is left.
    expect(readdirSync(join(dir, '.shadowlap'))).toEqual([]);
  });

  it('never loses the file of a run that starts while another one is ending', async () => {
    markActiveRun(dir, run('a'));
    // Run a ends, and stops right before it removes the file it has just found naming it.
    const ending = start(`
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const file = ${JSON.stringify(activeRunFile(dir))};
      const realRm = fs.rmSync, realRead = fs.readSync, one = Buffer.alloc(1), nap = new Int32Array(new SharedArrayBuffer(4));
      fs.rmSync = function (path, ...rest) {
        if (path === file) {
          fs.writeSync(1, 'removing\\n');
          for (;;) {
            try { if (realRead(0, one, 0, 1, null) === 1) break; } catch (err) { if (err.code !== 'EAGAIN') throw err; }
            Atomics.wait(nap, 0, 0, 5);
          }
        }
        return realRm.call(this, path, ...rest);
      };
      syncBuiltinESMExports();
      const { clearActiveRun } = await import(${JSON.stringify(MODULE)});
      clearActiveRun(${JSON.stringify(dir)}, 'run-a');`);
    await said(ending, 'removing');
    // Run b starts meanwhile: it waits for run a to be done with the file, then writes its own.
    const starting = start(`
      const { markActiveRun } = await import(${JSON.stringify(MODULE)});
      process.stdout.write('starting\\n');
      markActiveRun(${JSON.stringify(dir)}, ${JSON.stringify(run('b'))}, 10000);`);
    await said(starting, 'starting');
    await new Promise((resolve) => setTimeout(resolve, 300));
    ending.stdin.write('g');
    expect(await exited(ending)).toBe(0);
    expect(await exited(starting)).toBe(0);
    expect(named()).toBe('run-b');
  });
});
