import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, linkSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, rmSync, unlinkSync, writeSync, type BigIntStats } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { threadId } from 'node:worker_threads';
import { processAlive } from './liveness.js';

/**
 * A lock file, so that one process at a time does what two must never do at once: change
 * shadowlap.config.json (the CLI and the dashboard's Settings), the dashboard's project list,
 * `.shadowlap/active.json` or the agent registry, or try a repair's candidates in a working tree and
 * hand its fix over. A lock left by a process that died is taken over without anyone's help, and a
 * lock whose process still runs never is.
 *
 * Taking it. The taker writes its record (process id, machine, when its process started, and a
 * token no other lock has) to a file of its own, then links that file to the lock's name. A link
 * fails when the name exists, so one taker gets the lock, and nobody ever reads a lock half
 * written. The holder removes the lock when it is done, if its own record is still the one there.
 *
 * Stale locks. A lock is stale when its holder is gone, which this machine can tell for certain of a
 * holder whose process it can ask about: one in the same table of process ids. On Linux that is the
 * same boot of the same kernel and the same process id namespace, whatever the host name (containers
 * can share one, and DHCP can change it); elsewhere, the same host name. Such a holder is gone when
 * no process has its id, or when the process that has it started after the holder did (the id was
 * given to another process since). A process that is gone can't come back to remove its lock, so a
 * lock found stale stays where it is until another process removes it.
 *
 * A lock this machine can't check that way goes by its age: one written on another machine, or in a
 * container with process ids of its own, that shares the folder, and one that doesn't say who holds
 * it. A lock held for a moment, as all are but a repair's, is stale once nobody has changed it for
 * LOCK_STALE_MS. A lock held for minutes, a repair's, takes `ageOut: false` and never goes stale that
 * way: it waits for its holder to remove it, or for someone to delete it. So two repairs in a folder
 * shared with a container or another machine are kept apart too, as far as the folder's file system
 * creates a file only when its name is free (local disks, NFS and SMB do), and a repair that died
 * over there leaves a lock to delete by hand. An earlier Shadowlap's lock names its process but not
 * when it started: it is stale once that process is gone from a machine with its host name, or by
 * its age.
 *
 * Taking over. Only a process holding `<lock>.break`, a lock taken the same way, removes a stale
 * lock, and only after reading the lock again and finding the very one it judged: the same file
 * with the same record. From there to its removal the lock can't change: its holder is gone, every
 * other breaker waits for `<lock>.break`, and a taker can't link over a name that exists. So what
 * is removed is the lock judged stale, never one taken since.
 *
 * Why two processes never hold the lock at once, in any order of their steps. A holder's lock stays
 * at the name from the link that took it until the holder removes it, unless a breaker removes it.
 * A breaker judges first and reads again after, and a lock that is removed never comes back (its
 * token is new), so the lock it finds again was there, unchanged, when it saw the holder gone: that
 * holder died holding it. A holder this machine can check is never seen gone while it runs: its id
 * is taken, by itself, and it started before it wrote its record. So a holder's lock is never removed
 * but by the holder, which is also why its own check before removing it is enough. `<lock>.break` is
 * safe by the same argument, with `<lock>.break.break` to take over one whose breaker died; a level
 * below is only needed after a process died at the level above, and the last level is waited for,
 * never broken.
 *
 * The one assumption is on the locks judged by their age: a holder on another machine or in another
 * container, or an earlier Shadowlap's, that keeps one longer than LOCK_STALE_MS loses it. No
 * Shadowlap edit takes nearly that long, and a repair's lock, the one held for minutes, is never
 * judged so. On a file system without hard links (FAT) a lock is created in place and its record
 * written after, so a taker stopped for longer than that between the two loses it too.
 *
 * Taking over has a limit, which costs waiting, never a second holder: Windows can't tell when a
 * process started without PowerShell, so there a lock whose holder died, and whose id was given to
 * a process that still runs, waits for that process to end or for someone to delete the lock.
 */

/** How long a lock whose holder can't be checked stays someone's: no Shadowlap edit takes nearly this long. */
export const LOCK_STALE_MS = 10_000;

/** `<lock>.break`, `<lock>.break.break` and one more: guards a stale lock is removed under. The last is never broken. */
const GUARDS = 3;
/** A record is a few hundred bytes; a file planted at a lock's name is never read whole. */
const RECORD_MAX = 4096;
/** Tries in a row without a pause: a lock released or broken just now is taken again at once. */
const QUICK_TRIES = 64;

export interface LockOptions {
  /** How long to wait while another process holds the lock, in milliseconds; 0 tries once. */
  wait: number;
  /** What is thrown when another process still holds the lock after `wait`. */
  busy: () => Error;
  /** The lock file's permissions: 0o644 unless given. */
  mode?: number;
  /**
   * Whether a lock whose holder this machine can't check (see the header) is stale once nobody has
   * changed it for LOCK_STALE_MS: true unless given, for a lock held a moment. A lock held for
   * longer than that, as a repair's is, passes false: one it can't check waits until it is deleted.
   */
  ageOut?: boolean;
}

/** A lock this process holds: its path, and the record it wrote there. */
export interface HeldLock {
  readonly path: string;
  readonly record: string;
}

/** Takes the lock file at `path`, waiting up to `options.wait` for a holder that runs; throws `options.busy()` after that. */
export function takeLock(path: string, options: LockOptions): HeldLock {
  const held = take(path, Math.max(0, options.wait), options.mode ?? 0o644, options.ageOut ?? true, 0);
  if (!held) throw options.busy();
  return held;
}

/** Removes the lock, if it is still this one: a lock that isn't is someone else's to remove. */
export function releaseLock(held: HeldLock): void {
  holding.delete(held.record);
  for (let tries = 1; ; tries++) {
    try {
      if (inspect(held.path)?.content === held.record) unlinkSync(held.path);
      return;
    } catch (err) {
      // Windows: a scanner can keep a file just written open for a moment. A lock left all the same
      // is taken over by this thread's next take (see `holding`), and by anyone once the process ends.
      if (tries >= 5 || !['EBUSY', 'EPERM', 'EACCES'].includes(code(err) ?? '')) return;
      pause(20);
    }
  }
}

/** Runs `fn` holding the lock file at `path`. */
export function withLockFile<T>(path: string, options: LockOptions, fn: () => T): T {
  const held = takeLock(path, options);
  try {
    return fn();
  } finally {
    releaseLock(held);
  }
}

// ---- taking and breaking ----

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const code = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code;

/** The records of the locks this thread holds. One of its own records that isn't among them is a lock it failed to remove. */
const holding = new Set<string>();

/** The lock, or null when a holder that runs (or a lock that can't be checked, while it is fresh) still has it after `wait`. */
function take(path: string, wait: number, mode: number, ageOut: boolean, level: number): HeldLock | null {
  const record = newRecord();
  const deadline = Date.now() + wait;
  for (let quick = 0; ; ) {
    if (create(path, record, mode)) {
      holding.add(record);
      return { path, record };
    }
    const seen = inspect(path);
    // Released since the link failed, or stale and removed now: try again at once.
    if (quick < QUICK_TRIES && (!seen || (stale(seen, ageOut) && breakStale(path, seen, mode, level)))) {
      quick++;
      continue;
    }
    if (Date.now() >= deadline) return null;
    pause(10 + Math.floor(Math.random() * 15));
    quick = 0;
  }
}

/** Creates the lock with its record in it; false when the name is taken. */
function create(path: string, record: string, mode: number): boolean {
  const own = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  writeNew(own, record, mode);
  try {
    linkSync(own, path);
    return true;
  } catch (err) {
    if (code(err) === 'EEXIST') return false;
    // No hard links here (FAT, some network shares; each system says so with its own error): a real
    // problem, such as a folder that can't be written, shows again when the lock is created in place.
    return createInPlace(path, record, mode);
  } finally {
    try {
      rmSync(own, { force: true });
    } catch {
      // held open by another program (Windows): a crash would have left it as well, harmlessly
    }
  }
}

/** Where hard links can't be made: created in place, then written (see the assumption above). */
function createInPlace(path: string, record: string, mode: number): boolean {
  try {
    writeNew(path, record, mode);
    return true;
  } catch (err) {
    if (code(err) === 'EEXIST') return false;
    throw err;
  }
}

/** Creates `path`, which must not exist, holding `text`; removes it again when the text can't be written whole. */
function writeNew(path: string, text: string, mode: number): void {
  const fd = openSync(path, 'wx', mode);
  const bytes = Buffer.from(text, 'utf8');
  let whole = false;
  try {
    whole = writeSync(fd, bytes) === bytes.length;
  } finally {
    closeSync(fd);
    if (!whole) rmSync(path, { force: true });
  }
  if (!whole) throw new Error(`${path}: the lock's record could not be written`);
}

/**
 * Removes the stale lock `seen` under `<lock>.break` (see the argument above), when it is still the
 * one at `path`. True when there is something new to try: the lock removed, or gone or replaced
 * since it was judged. False when nothing changed: the guard is held by a process that runs, or the
 * lock can't be removed.
 */
function breakStale(path: string, seen: Seen, mode: number, level: number): boolean {
  if (level >= GUARDS) return false;
  // A guard is held for a few file operations, as a brief lock is, and goes by the same rules.
  const guard = take(`${path}.break`, 0, mode, true, level + 1);
  if (!guard) return false;
  try {
    const now = inspect(path);
    if (!now || !same(now, seen)) return true;
    unlinkSync(path);
    return true;
  } catch (err) {
    return code(err) === 'ENOENT';
  } finally {
    releaseLock(guard);
  }
}

// ---- reading and judging a lock ----

interface Seen {
  content: string;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  mtimeMs: number;
}

const seenAs = (st: BigIntStats, content: string): Seen => ({ content, dev: st.dev, ino: st.ino, mtimeNs: st.mtimeNs, mtimeMs: Number(st.mtimeMs) });

/** The same file with the same record: an identical lock judges identically, so the one judged stale is still stale. */
const same = (a: Seen, b: Seen): boolean => a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.content === b.content;

/** Opened without following a link, and without waiting on a pipe planted at the name. */
const READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** What is at the lock's name now: its record and which file it is, read from one open file. Null when nothing is. */
function inspect(path: string): Seen | null {
  let fd: number;
  try {
    fd = openSync(path, READ);
  } catch (err) {
    if (code(err) === 'ENOENT') return null;
    // A link, a folder, a file this user can't read: no lock Shadowlap wrote, so known by its age only.
    try {
      return seenAs(lstatSync(path, { bigint: true }), '');
    } catch (again) {
      if (code(again) === 'ENOENT') return null;
      throw again;
    }
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    let content = '';
    if (st.isFile()) {
      const buf = Buffer.alloc(RECORD_MAX);
      content = buf.toString('utf8', 0, readSync(fd, buf, 0, RECORD_MAX, 0));
    }
    return seenAs(st, content);
  } finally {
    closeSync(fd);
  }
}

/** A lock's record as this version writes it. */
interface Record2 {
  v: 2;
  pid: number;
  host: string;
  /** The process id namespace, on Linux: two containers can share a host name and a folder, not their process ids. */
  ns: string | null;
  /** On Linux: the boot and the clock tick the process started at, from /proc. */
  start: string | null;
  /** When the process started, in milliseconds since 1970, as the process itself measured it. */
  born: number | null;
  /** The thread that took it, in its process: 0 for the main one. */
  tid: number | null;
  token: string;
}

/** An earlier Shadowlap's record: a process id, and the machine when it says (shadowlap.config.json's said, the project list's didn't). */
interface Record1 {
  v: 1;
  pid: number;
  host: string | null;
}

const isPid = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

function parseRecord(text: string): Record2 | Record1 | null {
  const t = text.trim();
  if (/^\d{1,10}$/.test(t)) return isPid(Number(t)) ? { v: 1, pid: Number(t), host: null } : null;
  let o: unknown;
  try {
    o = JSON.parse(t);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null) return null;
  const r = o as { [key: string]: unknown };
  if (!isPid(r.pid) || typeof r.host !== 'string') return null;
  if (r.v !== 2 || typeof r.token !== 'string') return { v: 1, pid: r.pid, host: r.host };
  return {
    v: 2,
    pid: r.pid,
    host: r.host,
    ns: typeof r.ns === 'string' ? r.ns : null,
    start: typeof r.start === 'string' ? r.start : null,
    born: typeof r.born === 'number' && Number.isFinite(r.born) ? r.born : null,
    tid: typeof r.tid === 'number' ? r.tid : null,
    token: r.token,
  };
}

/** Whether the lock's holder is gone (see the header): for certain when this machine can check it, by its age otherwise. */
function stale(seen: Seen, ageOut: boolean, now: number = Date.now()): boolean {
  const old = now - seen.mtimeMs > LOCK_STALE_MS;
  // What a lock this machine can't check goes by: its age, unless it is held for longer than that.
  const aged = ageOut && old;
  const r = parseRecord(seen.content);
  if (!r) return aged;
  if (r.v === 1) return ((r.host === null || r.host === hostname()) && !processAlive(r.pid)) || aged;
  if (!here(r)) return aged;
  // This process: another of its threads may hold it; this thread knows whether it does.
  if (r.pid === process.pid) return r.tid === threadId && !holding.has(seen.content);
  if (!processAlive(r.pid)) return true;
  // Its id is taken. Asked only of a lock held this long: the answer costs a `ps` on macOS.
  return old && idReused(r);
}

/**
 * Whether the record's holder ran where this process can ask about it, in the same table of process
 * ids: on Linux the same boot (which its `start` carries) and the same process id namespace, whatever
 * the host name; elsewhere the same host name. So a record written on Linux is never this machine's
 * elsewhere, and one written elsewhere never is on Linux.
 */
function here(r: Record2): boolean {
  const s = me();
  const at = r.start === null ? -1 : r.start.lastIndexOf(':');
  const boot = at > 0 ? r.start!.slice(0, at) : null;
  if (s.boot !== null || boot !== null) return boot === s.boot && r.ns === s.ns;
  return r.host === hostname() && r.ns === s.ns;
}

/** Holders of locks seen running lately, by token: asked again after a second, not on every try. */
const running = new Map<string, number>();

/** Whether the process that has the holder's id now started after the holder did. False when that can't be told (Windows). */
function idReused(r: Record2): boolean {
  const asked = running.get(r.token);
  if (asked !== undefined && Date.now() - asked < 1000) return false;
  let reused = false;
  if (process.platform === 'linux') {
    const now = linuxStart(r.pid);
    reused = r.start !== null && now !== null && now !== r.start;
  } else if (process.platform !== 'win32' && r.born !== null) {
    // `ps` gives the second a process started in, never later than when it began to run: the holder
    // itself never shows as starting after its own `born`, and a second's margin keeps it so should
    // the clock be set back a little while it starts. An id given again within that second is not
    // told, and its lock waits for the process that has the id now.
    const started = psStart(r.pid);
    reused = started !== null && started > r.born + 1000;
  }
  if (!reused) {
    if (running.size > 100) running.clear();
    running.set(r.token, Date.now());
  }
  return reused;
}

// ---- this process ----

interface Self {
  /** On Linux: this boot of the kernel. */
  boot: string | null;
  ns: string | null;
  start: string | null;
  born: number;
}

let self: Self | null = null;

function me(): Self {
  if (!self) {
    const boot = linuxBoot();
    self = { boot, ns: pidNamespace(), start: boot ? linuxStart(process.pid) : null, born: Math.floor(performance.timeOrigin) };
  }
  return self;
}

function newRecord(): string {
  const s = me();
  return JSON.stringify({ v: 2, pid: process.pid, host: hostname(), ...(s.ns ? { ns: s.ns } : {}), ...(s.start ? { start: s.start } : {}), born: s.born, tid: threadId, token: randomBytes(12).toString('hex'), at: new Date().toISOString() });
}

function pidNamespace(): string | null {
  if (process.platform !== 'linux') return null;
  try {
    return readlinkSync('/proc/self/ns/pid');
  } catch {
    return null;
  }
}

let bootId: string | null | undefined;

/** This boot of the kernel, on Linux, read once; null elsewhere, and without /proc. */
function linuxBoot(): string | null {
  if (bootId === undefined) {
    bootId = null;
    if (process.platform === 'linux') {
      try {
        bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
      } catch {
        // no /proc: this machine is told by its host name
      }
    }
  }
  return bootId;
}

/** When a Linux process started: the boot, and the clock tick since it (field 22 of /proc/<pid>/stat, after the command name, which can hold spaces and parentheses). */
function linuxStart(pid: number): string | null {
  const boot = linuxBoot();
  if (!boot) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return ticks && /^\d+$/.test(ticks) ? `${boot}:${ticks}` : null;
  } catch {
    return null;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** When a process started, to the second, from `ps` (macOS and the BSDs); null when it can't be told. */
function psStart(pid: number): number | null {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, timeout: 5000, windowsHide: true });
  const m = /^\s*[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(r.status === 0 && typeof r.stdout === 'string' ? r.stdout : '');
  const month = m ? MONTHS.indexOf(m[1]!) : -1;
  return m && month >= 0 ? Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) : null;
}
