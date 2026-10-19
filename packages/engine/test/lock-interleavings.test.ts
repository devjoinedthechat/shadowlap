import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG_FILE } from '../src/config-file.js';

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
 * of the writers killed at a random step (holding the lock, breaking one, writing the config).
 */

/** The built engine, as a URL its writers import. */
const ENGINE = new URL('../dist/index.js', import.meta.url).href;
const WRITERS = 5;
/** A schedule that takes more steps than this has stopped making progress. */
const MAX_STEPS = 40_000;
/** Windows starts processes and passes bytes through pipes several times slower. */
const TIMEOUT = process.platform === 'win32' ? 300_000 : 180_000;

/** The engine with node:fs wrapped, adding `$.field<i>` to the config once per 'n' it reads. */
function writerScript(dir: string, i: number): string {
  return `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const DIR = ${JSON.stringify(dir)};
    const realWrite = fs.writeSync, realRead = fs.readSync, realWait = Atomics.wait;
    const nap = new Int32Array(new SharedArrayBuffer(4));
    const one = Buffer.alloc(1);
    const say = (line) => realWrite(1, line + '\\n');
    // The next byte from the test: 'g' for one step, 'n' for a new edit; anything else, or none, ends the process.
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
    const fds = new Set();
    for (const name of ['openSync', 'closeSync', 'readSync', 'writeSync', 'fstatSync', 'fsyncSync', 'fchmodSync', 'ftruncateSync', 'readFileSync', 'writeFileSync', 'appendFileSync', 'statSync', 'lstatSync', 'existsSync', 'accessSync', 'realpathSync', 'renameSync', 'linkSync', 'symlinkSync', 'readlinkSync', 'unlinkSync', 'rmSync', 'mkdirSync', 'rmdirSync', 'readdirSync', 'utimesSync', 'chmodSync', 'copyFileSync']) {
      const real = fs[name];
      if (typeof real !== 'function') continue;
      fs[name] = function (...args) {
        const [a, b] = args;
        const watched = typeof a === 'number' ? fds.has(a) : inDir(a) || inDir(b);
        if (watched) step([name, typeof a === 'number' ? 'fd' : a, inDir(b) ? b : null]);
        const out = real.apply(this, args);
        if (watched && name === 'openSync') fds.add(out);
        if (watched && name === 'closeSync') fds.delete(a);
        return out;
      };
    }
    // A pause between two tries is a step too: a process waiting for the lock costs a step, not time.
    Atomics.wait = (array, index, value, ms) => (array === nap ? realWait(array, index, value, ms) : (step(['pause', null, null]), 'timed-out'));
    syncBuiltinESMExports();
    const { addRule } = await import(${JSON.stringify(ENGINE)});
    say('R');
    while (next() === 'n') {
      try {
        addRule(DIR, 'normalize', { path: '$.field${i}', replace: '<F${i}>' }, { wait: 600000 });
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

type Scenario = 'crashed writer' | 'crashed writer and breaker' | 'no stale lock' | 'writer killed';

class Harness {
  readonly dir = mkdtempSync(join(tmpdir(), 'sl-lock-steps-'));
  readonly config = join(this.dir, CONFIG_FILE);
  readonly writers: Writer[] = [];
  private wake: (() => void) | null = null;
  /** A process id no process has: that of one that ran and ended. */
  readonly gone = spawnSync(process.execPath, ['-e', '']).pid!;

  async start(): Promise<void> {
    for (let i = 0; i < WRITERS; i++) this.writers.push(this.spawn(i));
    await this.until(() => this.writers.every((w) => w.ready || w.exited));
    const failed = this.writers.find((w) => w.exited);
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

  private async until(condition: () => boolean, ms = 60_000): Promise<void> {
    const deadline = Date.now() + ms;
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

  /** One interleaving: the folder set up for `scenario`, then every step picked by `seed`. Returns what went wrong. */
  async run(scenario: Scenario, seed: number): Promise<string[]> {
    for (const name of readdirSync(this.dir)) rmSync(join(this.dir, name), { recursive: true, force: true });
    const crashed = JSON.stringify({ pid: this.gone, host: hostname(), token: 'crashed' });
    if (scenario === 'crashed writer' || scenario === 'writer killed') writeFileSync(`${this.config}.lock`, crashed);
    if (scenario === 'crashed writer and breaker') {
      const record = (token: string) => JSON.stringify({ v: 2, pid: this.gone, host: hostname(), born: Date.now() - 1000, token, at: new Date().toISOString() });
      writeFileSync(`${this.config}.lock`, record('crashed-writer'));
      writeFileSync(`${this.config}.lock.break`, record('crashed-breaker'));
    }
    const pick = random(seed);
    // Within the first steps, where the crashed writer's lock is being broken and taken.
    const killAt = scenario === 'writer killed' ? 1 + Math.floor(pick() * 150) : -1;
    let killed: Writer | null = null;
    for (const w of this.writers) {
      w.at = null;
      w.done = null;
      w.proc.stdin.write('n');
    }
    const problems: string[] = [];
    const trace: string[] = [];
    /** The steps that led to the first problem, which is where the story is. */
    let story: string[] | null = null;
    const editing = new Set<number>();
    for (let n = 0; ; n++) {
      await this.until(() => this.writers.every((w) => w.at !== null || w.done !== null || w.exited));
      const waiting = this.writers.filter((w) => w.at !== null && !w.exited);
      if (!waiting.length) break;
      if (n > MAX_STEPS) {
        problems.push(`no progress after ${MAX_STEPS} steps`);
        break;
      }
      const w = waiting[Math.floor(pick() * waiting.length)]!;
      const [op, a, b] = w.at!;
      if (n === killAt) {
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
      if (op === 'renameSync' && b === this.config) editing.delete(w.i);
      w.at = null;
      w.proc.stdin.write('g');
    }
    const survivors = this.writers.filter((w) => w !== killed);
    for (const w of survivors) if (w.done !== 'ok') problems.push(`writer #${w.i}'s edit failed: ${w.done ?? `exited (${w.stderr.trim()})`}`);
    let fields: string[] = [];
    try {
      fields = ((JSON.parse(readFileSync(this.config, 'utf8')) as { normalize?: Array<{ path: string }> }).normalize ?? []).map((r) => r.path);
    } catch (err) {
      problems.push(`the config can't be read: ${(err as Error).message}`);
    }
    for (const w of survivors) if (!fields.includes(`$.field${w.i}`)) problems.push(`writer #${w.i}'s rule was lost`);
    // A killed writer may leave its temporary files (named with its process id), never a lock.
    const left = readdirSync(this.dir).filter((name) => name !== CONFIG_FILE && !(killed && name.includes(`.${killed.proc.pid}.`) && name.endsWith('.tmp')));
    if (left.length) problems.push(`left beside the config: ${left.join(', ')}`);
    if (killed) this.writers[killed.i] = this.spawn(killed.i);
    if (killed) await this.until(() => this.writers[killed!.i]!.ready);
    const steps = (story ?? trace.slice(-60)).map((line) => line.split(this.dir).join('<dir>'));
    return problems.length ? [`${scenario}, seed ${seed}: ${problems.join('; ')}\n    steps:\n    ${steps.join('\n    ')}`] : [];
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
  }, 60_000);
  afterAll(() => harness?.stop());

  it('keeps one writer at a time and every edit, with a crashed writer’s lock in the way', async () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 60; seed++) problems.push(...(await harness.run('crashed writer', seed)));
    for (let seed = 1; seed <= 20; seed++) problems.push(...(await harness.run('no stale lock', seed)));
    expect(problems).toEqual([]);
  }, TIMEOUT);

  it('recovers from a writer or a breaker that died at any step, and still keeps one writer at a time', async () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 20; seed++) problems.push(...(await harness.run('crashed writer and breaker', seed)));
    for (let seed = 1; seed <= 40; seed++) problems.push(...(await harness.run('writer killed', seed)));
    expect(problems).toEqual([]);
  }, TIMEOUT);
});
