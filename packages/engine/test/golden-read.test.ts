import type * as fs from 'node:fs';
import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { packRun, unpackRun } from '../src/pack.js';
import { PackError } from '../src/pack-schema.js';
import { Store } from '../src/store.js';
import { readGolden } from '../src/tasks.js';
import { DONE, ESCALATE, LOOKUP, POLICY, recordRun } from './training-fixtures.js';

/**
 * A golden's pack is someone else's data, read before anything runs: its files are read as unpack
 * reads them, never through a link swapped in after a check, and every rule it carries, a divergence
 * hint's suggested normalizer among them, is read as the config's rules are.
 */

// Stands in for a file swapped for a link between the check and the read: lstat, asked about
// `lying.path`, says the regular file at `lying.was` is there, as it was a moment before the swap.
let lying: { path: string; was: string } | null = null;
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const lstatSync = ((path: fs.PathLike, options?: fs.StatSyncOptions) => (lying !== null && String(path) === lying.path ? Object.assign(real.statSync(lying.was, options)!, { isSymbolicLink: () => false, isFile: () => true }) : real.lstatSync(path, options))) as typeof real.lstatSync;
  return { ...real, lstatSync };
});

/** The folders each test made, removed after it. */
const roots: string[] = [];
afterEach(() => {
  lying = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function golden(): { root: string; dir: string; store: Store } {
  const root = mkdtempSync(join(tmpdir(), 'sl-golden-read-'));
  roots.push(root);
  const store = Store.open(':memory:');
  const { run } = recordRun(store, [LOOKUP, POLICY, ESCALATE, DONE]);
  const dir = join(root, 'goldens', 'escalate');
  packRun(store, run.runId, dir);
  return { root, dir, store };
}

describe('a golden’s pack', () => {
  it('is never read through a link swapped in after its run.json was checked', () => {
    const { root, dir, store } = golden();
    try {
      // Someone else's file, put where the pack's run.json was once lstat had looked.
      const outside = join(root, 'outside.json');
      writeFileSync(outside, readFileSync(join(dir, 'run.json')));
      renameSync(join(dir, 'run.json'), join(root, 'moved.json'));
      symlinkSync(outside, join(dir, 'run.json'));
      // Where the system opens a file without following a link (O_NOFOLLOW), the open itself refuses
      // the link. Windows has none: the file opened is held to the one checked, and is another.
      if (process.platform === 'win32') {
        lying = { path: join(dir, 'run.json'), was: join(root, 'moved.json') };
        expect(() => readGolden(dir, 'goldens/escalate')).toThrow(/run\.json was replaced while it was read/);
      } else {
        lying = { path: join(dir, 'run.json'), was: join(dir, 'run.json') };
        expect(() => readGolden(dir, 'goldens/escalate')).toThrow(/run\.json is a symbolic link; packs contain only regular files/);
      }
    } finally {
      store.close();
    }
  });

  it('refuses a divergence hint’s suggested normalizer that the config would refuse', () => {
    for (const [normalizer, why] of [
      [{ pattern: '/(a+)+$/', replace: '<X>' }, /hints\[0\]\.normalizer\.pattern: \/\(a\+\)\+\$\/: matching it could take too long/],
      [{ pattern: '/[a-z]*[a-z]*!/', replace: '<X>' }, /hints\[0\]\.normalizer\.pattern: .*matching it could take too long/],
      [{ path: '$.messages', replace: '<X>\u001b[2J' }, /hints\[0\]\.normalizer\.replace: contains control characters/],
      [{ path: 'messages', replace: '<X>' }, /hints\[0\]\.normalizer\.path: path must start with "\$"/],
      [{ kind: 'shell', pattern: 'uuid', replace: '<X>' }, /hints\[0\]\.normalizer\.kind/],
      [{ name: 'x\u001b]8;;http://example.com\u0007', pattern: 'uuid', replace: '<X>' }, /hints\[0\]\.normalizer\.name: contains control characters/],
      [{ pattern: 'uuid' }, /hints\[0\]\.normalizer\.replace: must be a string/],
      ['--pattern', /hints\[0\]\.normalizer: must be an object/],
    ] as const) {
      const { dir, store } = golden();
      try {
        const manifest = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { runs: Array<Record<string, unknown>> };
        manifest.runs.at(-1)!.divergence = { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, hints: [{ message: 'a value changes between runs', normalizer }] };
        writeFileSync(join(dir, 'run.json'), JSON.stringify(manifest));
        expect(() => readGolden(dir, 'goldens/escalate'), JSON.stringify(normalizer)).toThrow(why);
        const into = Store.open(':memory:');
        try {
          expect(() => unpackRun(into, dir), JSON.stringify(normalizer)).toThrow(PackError);
          expect(into.allRuns()).toHaveLength(0);
        } finally {
          into.close();
        }
      } finally {
        store.close();
      }
    }
  });

  it('keeps a hint whose normalizer is one the config would take', () => {
    const { dir, store } = golden();
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { runs: Array<Record<string, unknown>> };
      const normalizer = { kind: 'api', name: 'POST /v1/messages', path: '$.metadata.user_id', pattern: 'uuid', replace: '<ID>' };
      manifest.runs.at(-1)!.divergence = { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, hints: [{ message: 'a value changes between runs', normalizer }] };
      writeFileSync(join(dir, 'run.json'), JSON.stringify(manifest));
      expect(readGolden(dir, 'goldens/escalate').run.divergence?.hints?.[0]?.normalizer).toEqual(normalizer);
    } finally {
      store.close();
    }
  });
});
