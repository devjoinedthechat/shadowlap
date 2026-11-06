import type * as fs from 'node:fs';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileAtomic } from '../src/projects/files.js';

/**
 * A small file kept for this machine (the project list, Spending, the goldens' checks seen), replaced
 * in one step (projects/files.ts): a write that fails anywhere leaves the old file as it was, and
 * nothing beside it.
 */

/**
 * The call armed to fail next: a write that stops halfway, as on a full disk, which Node says only by
 * how much it wrote; or a flush or rename that fails with its code, as a disk that drops a write
 * (EIO), or Windows refusing to replace a file another program has open (EPERM).
 */
let armed: { call: 'writeSync' } | { call: 'fsyncSync' | 'renameSync'; code: string } | null = null;
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const take = (call: string) => {
    const a = armed;
    if (a?.call !== call) return null;
    armed = null;
    return a;
  };
  const fail = (call: string) => {
    const a = take(call);
    if (a && 'code' in a) throw Object.assign(new Error(`${a.code}: armed to fail, ${call}`), { code: a.code });
  };
  const half = (data: Uint8Array | string) => {
    const bytes = typeof data === 'string' ? Buffer.from(data) : data;
    return bytes.subarray(0, bytes.length >> 1);
  };
  return {
    ...real,
    writeSync: ((fd: number, data: Uint8Array | string, ...rest: unknown[]) => (take('writeSync') ? real.writeSync(fd, half(data)) : (real.writeSync as (...args: unknown[]) => number)(fd, data, ...rest))) as typeof real.writeSync,
    fsyncSync: (fd: number) => {
      fail('fsyncSync');
      real.fsyncSync(fd);
    },
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      fail('renameSync');
      real.renameSync(from, to);
    },
  };
});
afterEach(() => {
  armed = null;
});

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const OLD = `${JSON.stringify({ version: 1, projects: [] }, null, 2)}\n`;
// A name with more bytes than characters, as a folder's often has.
const NEW = `${JSON.stringify({ version: 1, projects: [{ path: '/Users/zoë/agent-ü' }] }, null, 2)}\n`;

describe('a small file kept for this machine, replaced in one step', () => {
  it.each([
    ['stops short, as on a full disk', { call: 'writeSync' }, /could not be written whole/],
    ["can't be flushed", { call: 'fsyncSync', code: 'EIO' }, /EIO/],
    ["can't replace the file, as Windows refuses while another program has it open", { call: 'renameSync', code: 'EPERM' }, /EPERM/],
  ] as const)('leaves the old file as it was, and nothing beside it, when the write %s', (_, fail, error) => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-files-'));
    dirs.push(dir);
    const file = join(dir, 'projects.json');
    writeFileAtomic(file, OLD);
    armed = fail;
    expect(() => writeFileAtomic(file, NEW)).toThrow(error);
    expect(armed).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe(OLD);
    expect(readdirSync(dir)).toEqual(['projects.json']);
    // The next write, whole.
    writeFileAtomic(file, NEW);
    expect(readFileSync(file, 'utf8')).toBe(NEW);
    expect(readdirSync(dir)).toEqual(['projects.json']);
  });
});
