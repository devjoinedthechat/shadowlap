import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG_FILE } from '../src/config-file.js';
import { releaseLock, takeLock } from '../src/lock-file.js';

/**
 * Config edits from several processes, run one file operation at a time in an order the test picks.
 *
 * Each process is the built engine with node:fs wrapped: before any call on a path in the test's
 * folder (or on a file it opened there), and before every pause, it prints what it is about to do
 * and waits for a byte on stdin. The test lets one process go at a time, picked by a seeded random
 * sequence, so each seed is one interleaving of the processes' steps, the same every time it runs,
 * and a failure names the seed and the steps that led to it. Between two steps every process is
 * stopped, so nothing depends on how fast the machine is.
 *
 * What is checked: no process reads the config while another has read it and not yet written it
 * back (two writers at once), every edit lands, and nothing is left beside the config. The
 * scenarios: a lock left by a writer that crashed (the case `breakStale` got wrong: two processes
 * that judged the same stale lock, the second moving aside the fresh lock a third had taken since),
 * a crashed writer and a crashed breaker, no stale lock at all, and a crashed writer's lock with one
 * of the writers killed at a random step (holding the lock, breaking one, writing the config). The
 * crashed writer and the killed one run again on a file system without hard links, where every link
 * fails and each lock is created in place, its record written after, and there a writer is also
 * killed between creating a lock or a guard and writing its record.
 *
 * Time passes only when every writer has waited a long while, for a lock only its age frees: one a
 * writer killed between creating it in place and writing its record left empty, or on Windows one
 * whose holder's id another process has. The test then sets such locks back a minute. A lock whose
 * holder died, on this machine and with its record, is taken over at once, so elsewhere a schedule
 * that needs time for anything else has gone wrong.
 */

/** The built engine, as a URL its writers import. */
const ENGINE = new URL('../dist/index.js', import.meta.url).href;
const WRITERS = 5;
/** A schedule that takes more steps than this has stopped making progress. */
const MAX_STEPS = 40_000;
/**
 * The process id of a writer that crashed: no process has it, past macOS's ids, at the very top of
 * Linux's, and no multiple of four, as every Windows one is. Windows gives the id of a process that
 * ended to another soon after, a writer respawned between runs among them, and the crashed writer's
 * lock would then be a running holder's.
 */
const GONE = 2 ** 22 - 7;
/** Steps with no edit landing, after which every writer is waiting for a lock only its age frees, if any. */
const STUCK = 2_000;
/**
 * Writers that keep the test waiting longer than this, to start, to take a step or to exit when
 * killed, have stopped answering: minutes, since on a machine many times busier than its cores a
 * start alone took over one. It is the only limit of time here.
 */
const MAX_SILENCE = 300_000;
/**
 * A test's own time limit: none (vitest's 0). A test takes some 25,000 to 55,000 steps one after
 * another, seconds on an idle machine and many minutes on a busy one, where each step waits its turn
 * for a processor twice; a schedule that goes on is ended by MAX_STEPS, and writers that stop
 * answering by MAX_SILENCE.
 */
const NO_TIME_LIMIT = 0;

/** The engine with node:fs wrapped, adding `$.field<i>` to the config once per 'n' it reads, or per 'f' on a file system without hard links. */
function writerScript(dir: string, i: number): string {
  return `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const DIR = ${JSON.stringify(dir)};
    const realWrite = fs.writeSync, realRead = fs.readSync, realWait = Atomics.wait;
    const nap = new Int32Array(new SharedArrayBuffer(4));
    const one = Buffer.alloc(1);
    const say = (line) => realWrite(1, line + '\\n');
    // The next byte from the test: 'g' for one step, 'n' or 'f' for a new edit; anything else, or none, ends the process.
    const next = () => {
      for (;;) {
        let n;
        try {
          n = realRead(0, one, 0, 1, null);
        } catch (err) {
          if (err.code === 'EAGAIN') { realWait(nap, 0, 0, 1); continue; }
          throw err;
        }
        if (n !== 1) process.exit(0);
        return String.fromCharCode(one[0]);
      }
    };
    const step = (what) => { say('S ' + JSON.stringify(what)); if (next() !== 'g') process.exit(0); };
    const inDir = (p) => typeof p === 'string' && (p === DIR || p.startsWith(DIR + '/') || p.startsWith(DIR + '\\\\'));
    // The files it has open there, by descriptor: a step on one names its path.
    const fds = new Map();
    let links = true;
    for (const name of ['openSync', 'closeSync', 'readSync', 'writeSync', 'fstatSync', 'fsyncSync', 'fchmodSync', 'ftruncateSync', 'readFileSync', 'writeFileSync', 'appendFileSync', 'statSync', 'lstatSync', 'existsSync', 'accessSync', 'realpathSync', 'renameSync', 'linkSync', 'symlinkSync', 'readlinkSync', 'unlinkSync', 'rmSync', 'mkdirSync', 'rmdirSync', 'readdirSync', 'utimesSync', 'chmodSync', 'copyFileSync']) {
      const real = fs[name];
      if (typeof real !== 'function') continue;
      fs[name] = function (...args) {
        const [a, b] = args;
        const watched = typeof a === 'number' ? fds.has(a) : inDir(a) || inDir(b);
        if (watched) step([name, typeof a === 'number' ? fds.get(a) : a, inDir(b) ? b : null]);
        // A file system without hard links (FAT, some network shares) refuses every link.
        if (watched && name === 'linkSync' && !links) throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' });
        const out = real.apply(this, args);
        if (watched && name === 'openSync') fds.set(out, a);
        if (watched && name === 'closeSync') fds.delete(a);
        return out;
      };
    }
    // A pause between two tries is a step too: a process waiting for the lock costs a step, not time.
    Atomics.wait = (array, index, value, ms) => (array === nap ? realWait(array, index, value, ms) : (step(['pause', null, null]), 'timed-out'));
    syncBuiltinESMExports();
    const { addRule } = await import(${JSON.stringify(ENGINE)});
    say('R');
    for (let edit = next(); edit === 'n' || edit === 'f'; edit = next()) {
      links = edit === 'n';
      try {
        // It waits for the lock as many steps as it takes, never a time: MAX_STEPS ends a schedule that goes on.
        addRule(DIR, 'normalize', { path: '$.field${i}', replace: '<F${i}>' }, { wait: Infinity });
        say('D ok');
      } catch (err) {
        say('D ' + String(err && err.message).replace(/\\n/g, ' '));
      }
    }`;
}

interface Writer {
  i: number;
  proc: ChildProcessWithoutNullStreams;
  /** What it is about to do, while it waits to be let go. */
  at: [string, string | null, string | null] | null;
  /** How its edit ended, once it has: `ok` or the error. */
  done: string | null;
  ready: boolean;
  exited: boolean;
  stderr: string;
}

/** A small seeded generator (mulberry32): the same seed, the same choices. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Scenario = 'crashed writer' | 'crashed writer and breaker' | 'no stale lock' | 'writer killed' | 'writer killed creating a lock';

class Harness {
  readonly dir = mkdtempSync(join(tmpdir(), 'sl-lock-steps-'));
  readonly config = join(this.dir, CONFIG_FILE);
  readonly writers: Writer[] = [];
  private wake: (() => void) | null = null;
  /** This machine, as a lock taken here names it: a crashed writer's lock says it ran here. */
  readonly here = ((): Record<string, unknown> => {
    const held = takeLock(join(this.dir, 'here.lock'), { wait: 0, busy: () => new Error('busy') });
    const { host, ns, start } = JSON.parse(readFileSync(held.path, 'utf8')) as Record<string, unknown>;
    releaseLock(held);
    return { host, ns, start };
  })();

  async start(): Promise<void> {
    for (let i = 0; i < WRITERS; i++) this.writers.push(this.spawn(i));
    await this.untilReady(this.writers);
  }

  /** Waits for each of `ws` to be ready to edit; one that exited instead fails the test with what it said. */
  private async untilReady(ws: Writer[]): Promise<void> {
    await this.until(() => ws.every((w) => w.ready || w.exited));
    const failed = ws.find((w) => w.exited);
    if (failed) throw new Error(`a writer did not start: ${failed.stderr}`);
  }

  private spawn(i: number): Writer {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', writerScript(this.dir, i)], { stdio: ['pipe', 'pipe', 'pipe'] });
    const w: Writer = { i, proc, at: null, done: null, ready: false, exited: false, stderr: '' };
    let buffered = '';
    proc.stdout.on('data', (d: Buffer) => {
      buffered += d.toString();
      let nl: number;
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        if (line === 'R') w.ready = true;
        else if (line.startsWith('S ')) w.at = JSON.parse(line.slice(2)) as Writer['at'];
        else if (line.startsWith('D ')) w.done = line.slice(2);
      }
      this.poke();
    });
    proc.stderr.on('data', (d: Buffer) => (w.stderr += d.toString()));
    proc.on('exit', () => {
      w.exited = true;
      this.poke();
    });
    return w;
  }

  private poke(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private async until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + MAX_SILENCE;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`writers stopped answering: ${this.writers.map((w) => `#${w.i} at=${JSON.stringify(w.at)} done=${w.done} exited=${w.exited} ${w.stderr}`).join('; ')}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 200);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  /**
   * Lets time pass for what only time frees: sets back a minute each lock and guard in the folder
   * that says nothing of its holder (left empty by a writer killed while creating it in place) and,
   * on Windows, each whose holder is no running writer. Returns the names it set back, and whether
   * each named a holder.
   */
  private letTimePass(): Array<{ name: string; named: boolean }> {
    const running = new Set(this.writers.filter((w) => !w.exited).map((w) => w.proc.pid));
    const back = (Date.now() - 60_000) / 1000;
    const aged: Array<{ name: string; named: boolean }> = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.startsWith(`${CONFIG_FILE}.lock`)) continue;
      const path = join(this.dir, name);
      let pid: unknown;
      try {
        pid = (JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown }).pid;
      } catch {
        // empty: its writer was killed between creating it and writing its record
      }
      if (typeof pid === 'number' && (running.has(pid) || process.platform !== 'win32')) continue;
      utimesSync(path, back, back);
      aged.push({ name, named: typeof pid === 'number' });
    }
    return aged;
  }

  /**
   * One interleaving: the folder set up for `scenario`, then every step picked by `seed`, with hard
   * links or (`links` false) on a file system without them. Returns what went wrong.
   */
  async run(scenario: Scenario, seed: number, links = true): Promise<string[]> {
    for (const name of readdirSync(this.dir)) rmSync(join(this.dir, name), { recursive: true, force: true });
    const crashed = JSON.stringify({ pid: GONE, host: hostname(), token: 'crashed' });
    if (scenario === 'crashed writer' || scenario.startsWith('writer killed')) writeFileSync(`${this.config}.lock`, crashed);
    if (scenario === 'crashed writer and breaker') {
      const record = (token: string) => JSON.stringify({ v: 2, ...this.here, pid: GONE, born: Date.now() - 1000, token, at: new Date().toISOString() });
      writeFileSync(`${this.config}.lock`, record('crashed-writer'));
      writeFileSync(`${this.config}.lock.break`, record('crashed-breaker'));
    }
    const pick = random(seed);
    // Within the first steps, where the crashed writer's lock is being broken and taken.
    const killAt = scenario === 'writer killed' ? 1 + Math.floor(pick() * 150) : -1;
    // Or the first, second or third time a writer is about to write its record into a lock or a guard
    // it created in place: killed there, it leaves one that says nothing of who holds it.
    let killInPlace = scenario === 'writer killed creating a lock' ? 1 + Math.floor(pick() * 3) : 0;
    let killed: Writer | null = null;
    for (const w of this.writers) {
      w.at = null;
      w.done = null;
      w.proc.stdin.write(links ? 'n' : 'f');
    }
    const problems: string[] = [];
    const trace: string[] = [];
    /** The steps that led to the first problem, which is where the story is. */
    let story: string[] | null = null;
    const editing = new Set<number>();
    /** The step the last edit landed at. */
    let landed = 0;
    /** Whether a lock's record was written into the lock itself: it was created in place. */
    let inPlace = false;
    for (let n = 0; ; n++) {
      await this.until(() => this.writers.every((w) => w.at !== null || w.done !== null || w.exited));
      const waiting = this.writers.filter((w) => w.at !== null && !w.exited);
      if (!waiting.length) break;
      if (n > MAX_STEPS) {
        problems.push(`no progress after ${MAX_STEPS} steps`);
        break;
      }
      if (n - landed > STUCK) {
        const aged = this.letTimePass();
        trace.push(`time passes for ${aged.map((x) => x.name).join(', ') || 'nothing'}`);
        landed = n;
        const unnamed = aged.filter((x) => !x.named).map((x) => x.name);
        if (!aged.length || (links && unnamed.length)) {
          problems.push(aged.length ? `${unnamed.join(', ')} said nothing of its holder, though a lock is written whole and linked to its name` : `no edit landed in ${STUCK} steps, and nothing was left that only time frees`);
          story ??= trace.slice(-60);
          if (!aged.length) break;
        }
      }
      const w = waiting[Math.floor(pick() * waiting.length)];
      const [op, a, b] = w.at!;
      const recordInPlace = op === 'writeSync' && !!a?.startsWith(`${this.config}.lock`);
      if (recordInPlace) inPlace = true;
      if (n === killAt || (recordInPlace && killInPlace > 0 && --killInPlace === 0)) {
        // Killed before this step, wherever it is: holding the lock, breaking one, writing the config.
        trace.push(`#${w.i} killed before ${op} ${a ?? ''} ${b ?? ''}`);
        killed = w;
        editing.delete(w.i);
        w.proc.kill('SIGKILL');
        // Gone only once it is reaped: until then its process id is still taken.
        await this.until(() => w.exited);
        continue;
      }
      trace.push(`#${w.i} ${op} ${a ?? ''} ${b ?? ''}`);
      if (op === 'readFileSync' && a === this.config) {
        if (editing.size) {
          problems.push(`writer #${w.i} read the config while #${[...editing].join(', #')} had read it and not yet written it`);
          story ??= trace.slice(-60);
        }
        editing.add(w.i);
      }
      if (op === 'renameSync' && b === this.config) {
        editing.delete(w.i);
        landed = n;
      }
      w.at = null;
      w.proc.stdin.write('g');
    }
    if (!links && !inPlace) problems.push('no lock was created in place');
    if (scenario === 'writer killed creating a lock' && !killed) problems.push('no writer was killed creating a lock');
    const survivors = this.writers.filter((w) => w !== killed);
    for (const w of survivors) if (w.done !== 'ok') problems.push(`writer #${w.i}'s edit failed: ${w.done ?? `exited (${w.stderr.trim()})`}`);
    let fields: string[] = [];
    try {
      fields = ((JSON.parse(readFileSync(this.config, 'utf8')) as { normalize?: Array<{ path: string }> }).normalize ?? []).map((r) => r.path);
    } catch (err) {
      problems.push(`the config can't be read: ${(err as Error).message}`);
    }
    for (const w of survivors) if (!fields.includes(`$.field${w.i}`)) problems.push(`writer #${w.i}'s rule was lost`);
    // A killed writer may leave its temporary files (named with its process id), and a guard it held
    // or was creating in place, which nothing reads until a stale lock is next broken; never a lock.
    const holder = (name: string): unknown => {
      try {
        return (JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as { pid?: unknown }).pid;
      } catch {
        return null;
      }
    };
    const left = readdirSync(this.dir).filter((name) => {
      if (name === CONFIG_FILE) return false;
      if (!killed) return true;
      if (name.includes(`.${killed.proc.pid}.`) && name.endsWith('.tmp')) return false;
      const pid = name.startsWith(`${CONFIG_FILE}.lock.break`) ? holder(name) : undefined;
      return !(pid === null || pid === killed.proc.pid);
    });
    if (left.length) problems.push(`left beside the config: ${left.join(', ')}`);
    if (killed) {
      const again = this.spawn(killed.i);
      this.writers[killed.i] = again;
      await this.untilReady([again]);
    }
    const steps = (story ?? trace.slice(-60)).map((line) => line.split(this.dir).join('<dir>'));
    return problems.length ? [`${scenario}${links ? '' : ' without hard links'}, seed ${seed}: ${problems.join('; ')}\n    steps:\n    ${steps.join('\n    ')}`] : [];
  }

  stop(): void {
    for (const w of this.writers) w.proc.kill();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

describe('config edits in any order of their steps', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = new Harness();
    await harness.start();
  }, NO_TIME_LIMIT);
  afterAll(() => harness?.stop());

  it('keeps one writer at a time and every edit, with a crashed writer’s lock in the way', async () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 60; seed++) problems.push(...(await harness.run('crashed writer', seed)));
    for (let seed = 1; seed <= 20; seed++) problems.push(...(await harness.run('no stale lock', seed)));
    expect(problems).toEqual([]);
  }, NO_TIME_LIMIT);

  it('recovers from a writer or a breaker that died at any step, and still keeps one writer at a time', async () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 20; seed++) problems.push(...(await harness.run('crashed writer and breaker', seed)));
    for (let seed = 1; seed <= 40; seed++) problems.push(...(await harness.run('writer killed', seed)));
    expect(problems).toEqual([]);
  }, NO_TIME_LIMIT);

  it('keeps one writer at a time on a file system without hard links, where a lock is created in place', async () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 30; seed++) problems.push(...(await harness.run('crashed writer', seed, false)));
    for (let seed = 1; seed <= 30; seed++) problems.push(...(await harness.run('writer killed', seed, false)));
    for (let seed = 1; seed <= 15; seed++) problems.push(...(await harness.run('writer killed creating a lock', seed, false)));
    expect(problems).toEqual([]);
  }, NO_TIME_LIMIT);
});
