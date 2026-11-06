import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type * as fs from 'node:fs';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { LOCK_STALE_MS, releaseLock, takeLock } from '@shadowlap/engine';
import { CHECKS_SEEN_FILE, keepSeenChecks, seenChecks, type SeenChecks } from '../src/checks-seen.js';

/**
 * The goldens' checks as seen (checks-seen.ts): one file in Shadowlap's folder for this machine that
 * every dashboard writes. Each test's writers share a home on purpose, one of the test's own: the
 * race between them is what is tested, as the suite's shared home raced run-outcome.test.ts's
 * dashboard with other files' now and then.
 */

// Each read, open, flush and rename of a file goes as it would, but the next one armed here fails
// once with its code: as a process out of file handles fails it (EMFILE), a disk that drops a write
// (EIO), or Windows refusing to replace a file another program has open (EPERM). One armed with a
// path fails the next call on that path; one without, the next call.
const failing: Array<{ call: string; path?: string; code: string }> = [];
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const fail = (call: string, path: unknown) => {
    const i = failing.findIndex((f) => f.call === call && (f.path === undefined || f.path === String(path)));
    if (i < 0) return;
    const code = failing.splice(i, 1)[0].code;
    throw Object.assign(new Error(`${code}: armed to fail, ${call} '${String(path)}'`), { code });
  };
  return {
    ...real,
    readFileSync: ((path: fs.PathOrFileDescriptor, options?: never) => {
      fail('readFileSync', path);
      return real.readFileSync(path, options);
    }) as typeof real.readFileSync,
    openSync: ((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
      fail('openSync', path);
      return real.openSync(path, flags, mode);
    }) as typeof real.openSync,
    fsyncSync: (fd: number) => {
      fail('fsyncSync', fd);
      real.fsyncSync(fd);
    },
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      fail('renameSync', to);
      real.renameSync(from, to);
    },
  };
});
afterEach(() => {
  failing.length = 0;
});

const T = 1_760_000_000_000;
/** A process id no process has: an earlier Shadowlap's lock that names it was left by a process that is gone. */
const GONE = 2 ** 22 - 7;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function temp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `sl-checks-seen-${name}-`));
  dirs.push(dir);
  return dir;
}

/** A Shadowlap home that the writers a test starts share. */
const home = (): NodeJS.ProcessEnv => ({ SHADOWLAP_HOME: temp('home') });
const fileIn = (env: NodeJS.ProcessEnv) => join(env.SHADOWLAP_HOME!, CHECKS_SEEN_FILE);
const kept = (env: NodeJS.ProcessEnv) => (JSON.parse(readFileSync(fileIn(env), 'utf8')) as { projects: Record<string, Record<string, SeenChecks>> }).projects;
/** A project's one golden, its checks seen with `key`. */
const seen = (key: string, at: number | null = null) => new Map([['goldens/refund', { key, at }]]);

/** A writer of its own, as each dashboard is: the module loaded afresh, with nothing of the file read yet. */
async function writer(): Promise<typeof import('../src/checks-seen.js')> {
  vi.resetModules();
  return import('../src/checks-seen.js');
}

describe('the checks seen, kept by every dashboard on this machine in one file', () => {
  it("keeps both projects of two writers that read the file before either wrote, each keeping its own, and each reads the other's", async () => {
    const env = home();
    const a = await writer();
    const b = await writer();
    // Each has read the file, as a dashboard has once it has judged a run, before either writes.
    expect(a.seenChecks('/work/a', env).size).toBe(0);
    expect(b.seenChecks('/work/b', env).size).toBe(0);
    a.keepSeenChecks('/work/a', seen('k1'), env);
    b.keepSeenChecks('/work/b', seen('k2', T), env);
    expect(Object.keys(kept(env)).sort()).toEqual(['/work/a', '/work/b']);
    // What one timed, the other reads: it sees no golden there first, which would lose the time.
    expect(a.seenChecks('/work/b', env).get('goldens/refund')).toEqual({ key: 'k2', at: T });
    // Each changes its own project's entry alone.
    b.keepSeenChecks('/work/b', seen('k3', T + 1), env);
    a.keepSeenChecks('/work/a', seen('k4', T + 2), env);
    expect(kept(env)).toEqual({ '/work/b': { 'goldens/refund': { key: 'k3', at: T + 1 } }, '/work/a': { 'goldens/refund': { key: 'k4', at: T + 2 } } });
  });

  it('loses none of four processes keeping their own projects at once, in a home they share', async () => {
    const env = home();
    const module = await bundled(temp('bundle'));
    const projects = ['/work/0', '/work/1', '/work/2', '/work/3'];
    const rounds = 20;
    const writers = projects.map((dir) => spawn(process.execPath, ['--input-type=module', '-e', writerCode(module, env.SHADOWLAP_HOME!, dir, rounds)], { stdio: ['pipe', 'pipe', 'pipe'] }));
    // Each has read the file before any writes, then all write at once.
    await Promise.all(writers.map((w) => said(w, 'read')));
    for (const w of writers) w.stdin.end('go\n');
    expect(await Promise.all(writers.map(ended))).toEqual(projects.map(() => 'exited 0'));
    expect(kept(env)).toEqual(Object.fromEntries(projects.map((dir) => [dir, { 'goldens/refund': { key: `k${rounds}`, at: rounds } }])));
  }, 60_000);

  it('never waits for the lock: skips its write while another process holds it, and takes over one left behind', () => {
    const env = home();
    const lock = `${fileIn(env)}.lock`;
    const held = takeLock(lock, { wait: 0, busy: () => new Error('held') });
    try {
      const started = Date.now();
      expect(keepSeenChecks('/work/a', seen('k1'), env)).toBe(false);
      // Tried once: a wait as Spending's, 5 seconds, would show here.
      expect(Date.now() - started).toBeLessThan(2500);
      expect(existsSync(fileIn(env))).toBe(false);
    } finally {
      releaseLock(held);
    }
    // The next request's write.
    expect(keepSeenChecks('/work/a', seen('k1'), env)).toBe(true);
    // Another machine's, in a folder shared with it: skipped until nobody has changed it for LOCK_STALE_MS, then taken over.
    writeFileSync(lock, JSON.stringify({ v: 2, pid: 1, host: 'another-machine', start: 'another-boot:1', born: T, token: 'theirs' }));
    expect(keepSeenChecks('/work/b', seen('k2'), env)).toBe(false);
    const old = (Date.now() - 2 * LOCK_STALE_MS) / 1000;
    utimesSync(lock, old, old);
    expect(keepSeenChecks('/work/b', seen('k2'), env)).toBe(true);
    // An earlier Shadowlap's, whose process is gone: taken over at once.
    writeFileSync(lock, String(GONE));
    expect(keepSeenChecks('/work/c', seen('k3'), env)).toBe(true);
    expect(Object.keys(kept(env))).toEqual(['/work/a', '/work/b', '/work/c']);
    expect(existsSync(lock)).toBe(false);
  });

  it("keeps what it saw for as long as it runs where the folder can't be written", () => {
    const at = temp('file');
    // A file where the folder would be: nothing can be made in it.
    writeFileSync(join(at, 'home'), '');
    const env = { SHADOWLAP_HOME: join(at, 'home') };
    expect(keepSeenChecks('/work/a', seen('k1', T), env)).toBe(true);
    expect(seenChecks('/work/a', env).get('goldens/refund')).toEqual({ key: 'k1', at: T });
  });

  it("never writes over a file it couldn't read under the lock: every other project's entry stays, and a later call writes its own", () => {
    const env = home();
    keepSeenChecks('/work/a', seen('k1', T), env);
    keepSeenChecks('/work/b', seen('k2', T + 1), env);
    const before = kept(env);
    // Read afresh under the lock, as a process out of file handles reads it.
    failing.push({ call: 'readFileSync', path: fileIn(env), code: 'EMFILE' });
    expect(keepSeenChecks('/work/c', seen('k3'), env)).toBe(false);
    expect(failing).toEqual([]);
    expect(kept(env)).toEqual(before);
    // The next request's write.
    expect(keepSeenChecks('/work/c', seen('k3'), env)).toBe(true);
    expect(kept(env)).toEqual({ ...before, '/work/c': { 'goldens/refund': { key: 'k3', at: null } } });
  });

  it('leaves a write that failed to a later call, from making the lock to replacing the file, and nothing beside the file', () => {
    const env = home();
    keepSeenChecks('/work/a', seen('k1', T), env);
    const before = kept(env);
    const fails = [
      // Out of file handles as the lock is made.
      { call: 'openSync', code: 'EMFILE' },
      // A disk that drops the write.
      { call: 'fsyncSync', code: 'EIO' },
      // Windows refusing to replace a file another program has open, in a folder that can be written.
      { call: 'renameSync', path: fileIn(env), code: 'EPERM' },
    ];
    for (const fail of fails) {
      failing.push(fail);
      expect(keepSeenChecks('/work/b', seen('k2', T + 1), env)).toBe(false);
      expect(failing).toEqual([]);
      expect(kept(env)).toEqual(before);
      expect(readdirSync(env.SHADOWLAP_HOME!)).toEqual([CHECKS_SEEN_FILE]);
      // Not kept in this process alone, where no other dashboard would see it.
      expect(seenChecks('/work/b', env).size).toBe(0);
    }
    expect(keepSeenChecks('/work/b', seen('k2', T + 1), env)).toBe(true);
    expect(kept(env)).toEqual({ ...before, '/work/b': { 'goldens/refund': { key: 'k2', at: T + 1 } } });
  });

  it("never writes over a newer Shadowlap's file, keeping what it saw for as long as it runs", () => {
    const env = home();
    const newer = `${JSON.stringify({ format: 2, seen: { '/work/a': 'theirs' } })}\n`;
    writeFileSync(fileIn(env), newer);
    expect(keepSeenChecks('/work/b', seen('k1', T), env)).toBe(true);
    expect(readFileSync(fileIn(env), 'utf8')).toBe(newer);
    // Read as none, but for what this process saw.
    expect(seenChecks('/work/a', env).size).toBe(0);
    expect(seenChecks('/work/b', env).get('goldens/refund')).toEqual({ key: 'k1', at: T });
  });
});

/** checks-seen.ts and the engine's source as one module, for a process of its own to load, as each dashboard does. */
async function bundled(dir: string): Promise<string> {
  const engine = fileURLToPath(new URL('../../engine/src/index.ts', import.meta.url));
  const out = await build({
    entryPoints: [fileURLToPath(new URL('../src/checks-seen.ts', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    plugins: [
      {
        name: 'engine-source',
        setup(b) {
          b.onResolve({ filter: /^@shadowlap\/engine$/ }, () => ({ path: engine }));
        },
      },
    ],
  });
  const file = join(dir, 'checks-seen.mjs');
  writeFileSync(file, out.outputFiles[0].text);
  return file;
}

/** A process keeping project `dir`'s entry `rounds` times, as a dashboard does each change it sees: it reads the file first, then writes once told to go. */
function writerCode(module: string, home: string, dir: string, rounds: number): string {
  return `
    const { keepSeenChecks, seenChecks } = await import(${JSON.stringify(pathToFileURL(module).href)});
    const env = { SHADOWLAP_HOME: ${JSON.stringify(home)} };
    seenChecks(${JSON.stringify(dir)}, env);
    process.stdout.write('read\\n');
    await new Promise((go) => process.stdin.once('data', go));
    const nap = new Int32Array(new SharedArrayBuffer(4));
    for (let n = 1; n <= ${rounds}; n++) {
      const seen = new Map([['goldens/refund', { key: 'k' + n, at: n }]]);
      // Skipped while another writes: written by the next try, as by a dashboard's next request.
      for (let tries = 1; keepSeenChecks(${JSON.stringify(dir)}, seen, env) === false; tries++) {
        if (tries > 10000) throw new Error('never kept');
        Atomics.wait(nap, 0, 0, 1);
      }
    }
  `;
}

/** Once the process has written `word` on its output; a process that ends first fails it, with what it said on its error output. */
function said(child: ChildProcessWithoutNullStreams, word: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()).includes(word) && resolve());
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.once('exit', (code) => reject(new Error(`exited ${code} before saying ${word}: ${err}`)));
  });
}

/** How the process ended, with its error output when that was not by exiting 0. */
function ended(child: ChildProcessWithoutNullStreams): Promise<string> {
  let err = '';
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve(code === 0 ? 'exited 0' : `exited ${code ?? signal}: ${err}`)));
}
