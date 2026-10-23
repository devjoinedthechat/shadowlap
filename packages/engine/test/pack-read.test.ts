import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A pack is read from a folder anyone with access to it can change while it is read. Whatever a
 * check of a file found, what is read is the file the check was made on: a symbolic link swapped in
 * between the two is refused, never followed.
 */

/** A path to swap for a symbolic link to `to` the moment it is opened or read by name. */
const swaps = new Map<string, string>();

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const swap = (path: unknown) => {
    const key = typeof path === 'string' ? resolve(path) : null;
    const to = key === null ? undefined : swaps.get(key);
    if (to === undefined) return;
    swaps.delete(key!);
    fs.rmSync(key!);
    fs.symlinkSync(to, key!);
  };
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      swap(args[0]);
      return fs.openSync(...args);
    },
    readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => {
      swap(args[0]);
      return fs.readFileSync(...args);
    }) as typeof fs.readFileSync,
  };
});

const { PackError } = await import('../src/pack-schema.js');
const { readPackFile, unpackRun } = await import('../src/pack.js');
const { Store } = await import('../src/store.js');

const GOLDEN = fileURLToPath(new URL('../../../testing/golden/reference-agent', import.meta.url));
let dirs: string[] = [];
afterEach(() => {
  swaps.clear();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function folder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe.skipIf(process.platform === 'win32')('reading a pack file', () => {
  it('refuses a symbolic link swapped in after the file was checked, and reads nothing through it', () => {
    const pack = folder('sl-pack-swap-');
    cpSync(GOLDEN, pack, { recursive: true });
    // What the link points at: a pack manifest elsewhere, which a read that follows it would take in.
    const elsewhere = join(folder('sl-pack-elsewhere-'), 'run.json');
    writeFileSync(elsewhere, readFileSync(join(pack, 'run.json')));
    swaps.set(resolve(join(pack, 'run.json')), elsewhere);
    const store = Store.open(':memory:');
    try {
      expect(() => unpackRun(store, pack)).toThrow(PackError);
      expect(store.allRuns()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('refuses a link, a folder and a FIFO, and a file over its limit, and reads a file whole', () => {
    const dir = folder('sl-pack-files-');
    const file = join(dir, 'calls.jsonl');
    writeFileSync(file, 'x'.repeat(100));
    expect(readPackFile(file, 100, 'calls.jsonl').toString()).toBe('x'.repeat(100));
    expect(() => readPackFile(file, 99, 'calls.jsonl')).toThrow(/100 bytes, over the 99-byte limit/);
    symlinkSync(file, join(dir, 'link'));
    expect(() => readPackFile(join(dir, 'link'), 1000, 'run.json')).toThrow(/run\.json is a symbolic link/);
    expect(() => readPackFile(dir, 1000, 'blobs/x')).toThrow(/blobs\/x is not a regular file/);
    // A FIFO no one writes to: opened without waiting for a writer, then refused.
    execFileSync('mkfifo', [join(dir, 'fifo')]);
    expect(() => readPackFile(join(dir, 'fifo'), 1000, 'calls.jsonl')).toThrow(/calls\.jsonl is not a regular file/);
  });
});
