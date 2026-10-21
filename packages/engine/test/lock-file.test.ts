import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, lutimesSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCK_STALE_MS, releaseLock, takeLock, withLockFile } from '../src/lock-file.js';

let dir: string;
let lock: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sl-lock-'));
  lock = join(dir, 'list.json.lock');
});
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

const busy = () => new Error('busy');
const take = (wait = 0) => takeLock(lock, { wait, busy });
/** Sets a file's times back, as if nobody had touched it for a minute. */
const age = (path: string) => utimesSync(path, (Date.now() - 60_000) / 1000, (Date.now() - 60_000) / 1000);
/** A process id no process has: one that ran and ended. */
const gone = () => spawnSync(process.execPath, ['-e', '']).pid!;
const record = (fields: Record<string, unknown>) => JSON.stringify({ v: 2, host: hostname(), born: Date.now(), token: Math.random().toString(16).slice(2), at: new Date().toISOString(), ...fields });

/** A process that runs until the test ends, and its id once it has started. */
async function running(code = 'setInterval(() => {}, 1000); process.stdout.write("up\\n")'): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (d: Buffer) => d.toString().includes('up') && resolve());
    child.on('exit', (c) => reject(new Error(`exited with ${c}`)));
  });
  return child;
}

const ended = (child: ChildProcess) => new Promise<void>((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', () => resolve())));

describe('takeLock', () => {
  it('writes its record whole, leaves nothing else behind, and removes only its own', () => {
    const held = take();
    const r = JSON.parse(readFileSync(lock, 'utf8')) as Record<string, unknown>;
    expect(r).toMatchObject({ v: 2, pid: process.pid, host: hostname(), born: expect.any(Number), tid: 0, token: expect.stringMatching(/^[0-9a-f]{24}$/) });
    expect(readdirSync(dir)).toEqual(['list.json.lock']);
    // Held by this process: a second take waits for it, as one from another process would.
    expect(() => take(50)).toThrow('busy');
    releaseLock(held);
    expect(readdirSync(dir)).toEqual([]);

    // A lock someone else holds now is theirs to remove.
    const again = take();
    writeFileSync(lock, record({ pid: process.pid, token: 'theirs' }));
    releaseLock(again);
    expect(readFileSync(lock, 'utf8')).toContain('"theirs"');
  });

  it('takes over at once a lock this thread failed to remove', () => {
    const held = take();
    const own = readFileSync(lock, 'utf8');
    releaseLock(held);
    // As if removing it had failed: the record is this thread's, and the thread holds no lock it names.
    writeFileSync(lock, own);
    releaseLock(take());
    expect(readdirSync(dir)).toEqual([]);
  });

  it('never takes over a lock whose holder runs on this machine, however old the lock', async () => {
    const holder = await running(`
      const { takeLock } = await import(${JSON.stringify(new URL('../dist/lock-file.js', import.meta.url).href)});
      takeLock(${JSON.stringify(lock)}, { wait: 0, busy: () => new Error('busy') });
      setInterval(() => {}, 1000);
      process.stdout.write('up\\n');`);
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toMatchObject({ pid: holder.pid });
    // A minute untouched, far past LOCK_STALE_MS: an edit that takes that long is still an edit.
    age(lock);
    const started = Date.now();
    expect(() => take(300)).toThrow('busy');
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toMatchObject({ pid: holder.pid });

    // Its process ended without removing it: taken over at once.
    holder.kill('SIGKILL');
    await ended(holder);
    const at = Date.now();
    releaseLock(take(5000));
    expect(Date.now() - at).toBeLessThan(1000);
    expect(readdirSync(dir)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('takes over a lock whose holder’s process id was given to another process', async () => {
    // A process runs under the id the lock names, but it started after the holder did: the holder is gone.
    const other = await running();
    writeFileSync(lock, record({ pid: other.pid, born: Date.now() - 60_000, start: 'another-boot:1' }));
    age(lock);
    releaseLock(take());
    expect(readdirSync(dir)).toEqual([]);
  });

  it.skipIf(process.platform === 'linux' || process.platform === 'win32')('never takes over a running holder’s lock because the clock was set back as it started (macOS)', async () => {
    const holder = await running();
    // `ps` gives the second it started in. Its own note of when it started, read from a clock set back
    // a moment as it started, is just before that.
    const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(holder.pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } });
    const started = Date.parse(`${ps.stdout.trim()} UTC`);
    expect(started).toBeGreaterThan(0);
    writeFileSync(lock, record({ pid: holder.pid, born: started - 1 }));
    age(lock);
    expect(() => take(300)).toThrow('busy');
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toMatchObject({ pid: holder.pid });
  });

  it('takes over a lock it can’t check only once nobody has changed it for LOCK_STALE_MS', () => {
    expect(LOCK_STALE_MS).toBe(10_000);
    const cases: Array<[string, string]> = [
      ['another machine’s', record({ pid: gone(), host: 'another-machine' })],
      ['one that doesn’t say who holds it', ''],
      ['an earlier shadowlap.config.json lock held by a running process', JSON.stringify({ pid: process.pid, host: hostname(), token: 'earlier' })],
      ['an earlier project list lock held by a running process', String(process.pid)],
    ];
    for (const [what, text] of cases) {
      writeFileSync(lock, text);
      expect(() => take(50), what).toThrow('busy');
      age(lock);
      releaseLock(take());
      expect(readdirSync(dir), what).toEqual([]);
    }
    // An earlier lock whose process is gone, from this machine: at once.
    for (const text of [JSON.stringify({ pid: gone(), host: hostname(), token: 'crashed' }), String(gone()), record({ pid: gone() })]) {
      writeFileSync(lock, text);
      releaseLock(take());
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  it('counts a lock from another process id namespace, another container sharing the folder, as another machine’s', () => {
    // Its process id is no process here, but this machine's process table can't say: it is another's.
    writeFileSync(lock, record({ pid: gone(), ns: 'pid:[1]' }));
    let namespaces = false;
    try {
      namespaces = process.platform === 'linux' && readlinkSync('/proc/self/ns/pid') !== 'pid:[1]';
    } catch {
      // no namespaces to tell apart: the record's is ignored
    }
    if (namespaces) {
      expect(() => take(50)).toThrow('busy');
      age(lock);
    }
    releaseLock(take());
    expect(readdirSync(dir)).toEqual([]);
  });

  it('removes a stale lock only under its guard, and takes over a guard whose breaker died', () => {
    // A breaker that runs (this process, standing in for another) holds the guard: the stale lock is left to it.
    writeFileSync(lock, record({ pid: gone() }));
    writeFileSync(`${lock}.break`, record({ pid: process.pid }));
    expect(() => take(100)).toThrow('busy');
    expect(existsSync(lock)).toBe(true);
    // The breaker died holding it: its guard is taken over under the guard's own guard, then the lock.
    writeFileSync(`${lock}.break`, record({ pid: gone() }));
    withLockFile(lock, { wait: 0, busy }, () => expect(readdirSync(dir)).toEqual(['list.json.lock']));
    expect(readdirSync(dir)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('never follows a link planted at the lock’s name, and removes the link alone', () => {
    const target = join(dir, 'elsewhere.txt');
    writeFileSync(target, record({ pid: gone() }));
    symlinkSync(target, lock);
    // Not a lock Shadowlap wrote, whatever it points at: it goes by its own age.
    expect(() => take(50)).toThrow('busy');
    lutimesSync(lock, (Date.now() - 60_000) / 1000, (Date.now() - 60_000) / 1000);
    releaseLock(take());
    expect(readdirSync(dir)).toEqual(['elsewhere.txt']);
  });
});
