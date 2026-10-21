import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, lutimesSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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
/**
 * A process id no process has: past macOS's ids, at the very top of Linux's, and no multiple of
 * four, as every Windows one is. One that ran and ended can be given to another process at once on
 * Windows, which would make its lock a running holder's.
 */
const GONE = 2 ** 22 - 7;

/** This machine, as a lock taken here names it: its host name and, on Linux, its boot (in `start`) and process id namespace. */
const HERE = ((): { host: string; ns?: string; start?: string } => {
  const where = mkdtempSync(join(tmpdir(), 'sl-lock-here-'));
  try {
    const held = takeLock(join(where, 'here.lock'), { wait: 0, busy });
    const r = JSON.parse(readFileSync(held.path, 'utf8')) as { host: string; ns?: string; start?: string };
    releaseLock(held);
    return { host: r.host, ...(r.ns ? { ns: r.ns } : {}), ...(r.start ? { start: r.start } : {}) };
  } finally {
    rmSync(where, { recursive: true, force: true });
  }
})();
/** A record as a process on this machine writes it, with `fields` in place of its own. */
const record = (fields: Record<string, unknown>) => JSON.stringify({ v: 2, ...HERE, born: Date.now(), token: Math.random().toString(16).slice(2), at: new Date().toISOString(), ...fields });
/** On Linux, when a process started at clock tick `ticks` of this boot, as a record says it; nothing elsewhere. */
const startedAt = (ticks: number) => (HERE.start ? { start: `${HERE.start.slice(0, HERE.start.lastIndexOf(':'))}:${ticks}` } : {});

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
    // A process runs under the id the lock names, but it started after the holder did (on Linux, at
    // another clock tick of this boot): the holder is gone.
    const other = await running();
    writeFileSync(lock, record({ pid: other.pid, born: Date.now() - 60_000, ...startedAt(1) }));
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
      ['another machine’s', record({ pid: GONE, host: 'another-machine', start: 'another-boot:1' })],
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
    for (const text of [JSON.stringify({ pid: GONE, host: hostname(), token: 'crashed' }), String(GONE), record({ pid: GONE })]) {
      writeFileSync(lock, text);
      releaseLock(take());
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  it('never takes over by its age a lock held for minutes whose holder it can’t check, and at once one whose holder died here', () => {
    // A repair's: held while candidates are verified, far longer than LOCK_STALE_MS.
    const long = (wait = 0) => takeLock(lock, { wait, busy, ageOut: false });
    const cases: Array<[string, string]> = [
      ['another machine’s', record({ pid: GONE, host: 'another-machine', start: 'another-boot:1' })],
      ['a container’s with process ids of its own', record({ pid: GONE, ns: 'pid:[1]' })],
      ['one that doesn’t say who holds it', ''],
      ['an earlier Shadowlap’s held by a running process', JSON.stringify({ pid: process.pid, host: hostname(), token: 'earlier' })],
    ];
    for (const [what, text] of cases) {
      writeFileSync(lock, text);
      age(lock);
      expect(() => long(50), what).toThrow('busy');
      expect(readFileSync(lock, 'utf8'), what).toBe(text);
      // A lock held for a moment, in its place, is taken over by now.
      releaseLock(take());
      expect(readdirSync(dir), what).toEqual([]);
    }
    // Its holder died on this machine: taken over at once, as any lock is.
    writeFileSync(lock, record({ pid: GONE }));
    releaseLock(long());
    expect(readdirSync(dir)).toEqual([]);
  });

  it('goes by its age when it can’t tell a running holder from a process given its id since, as on Windows, unless the lock is held for minutes', async () => {
    const other = await running();
    // No note of when its holder started, as where that can't be read: whatever has the id may be the holder.
    const text = record({ pid: other.pid, born: null, start: null });
    writeFileSync(lock, text);
    // Fresh: its holder's, most likely.
    expect(() => take(50)).toThrow('busy');
    age(lock);
    // Held for minutes, as a repair's: it waits.
    expect(() => takeLock(lock, { wait: 50, busy, ageOut: false })).toThrow('busy');
    expect(readFileSync(lock, 'utf8')).toBe(text);
    // Held for a moment: taken over once nobody has changed it for LOCK_STALE_MS.
    releaseLock(take());
    expect(readdirSync(dir)).toEqual([]);
  });

  it('tells this machine on Linux by its boot and process id namespace, whatever the host name, and elsewhere by its host name', () => {
    // Another boot, or another process id namespace (a container with process ids of its own, sharing
    // the folder), under this host name: no process here has its id, which says nothing of its holder.
    for (const [what, text] of [
      ['another boot', record({ pid: GONE, start: 'another-boot:1' })],
      ['another namespace', record({ pid: GONE, ns: 'pid:[1]' })],
    ]) {
      writeFileSync(lock, text!);
      expect(() => take(50), what).toThrow('busy');
      age(lock);
      releaseLock(take());
      expect(readdirSync(dir), what).toEqual([]);
    }
    // Another host name, with this boot and namespace on Linux: one DHCP gave this machine since, or a
    // container's own that shares this machine's process ids. On Linux it is checked as this machine's,
    // and elsewhere it is another machine's.
    writeFileSync(lock, record({ pid: GONE, host: 'renamed' }));
    if (!HERE.start) {
      expect(() => take(50)).toThrow('busy');
      age(lock);
    }
    releaseLock(take());
    expect(readdirSync(dir)).toEqual([]);
  });

  it('removes a stale lock only under its guard, and takes over a guard whose breaker died', () => {
    // A breaker that runs (this process, standing in for another) holds the guard: the stale lock is left to it.
    writeFileSync(lock, record({ pid: GONE }));
    writeFileSync(`${lock}.break`, record({ pid: process.pid }));
    expect(() => take(100)).toThrow('busy');
    expect(existsSync(lock)).toBe(true);
    // The breaker died holding it: its guard is taken over under the guard's own guard, then the lock.
    writeFileSync(`${lock}.break`, record({ pid: GONE }));
    withLockFile(lock, { wait: 0, busy }, () => expect(readdirSync(dir)).toEqual(['list.json.lock']));
    expect(readdirSync(dir)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('never follows a link planted at the lock’s name, and removes the link alone', () => {
    const target = join(dir, 'elsewhere.txt');
    writeFileSync(target, record({ pid: GONE }));
    symlinkSync(target, lock);
    // Not a lock Shadowlap wrote, whatever it points at: it goes by its own age.
    expect(() => take(50)).toThrow('busy');
    lutimesSync(lock, (Date.now() - 60_000) / 1000, (Date.now() - 60_000) / 1000);
    releaseLock(take());
    expect(readdirSync(dir)).toEqual(['elsewhere.txt']);
  });
});
