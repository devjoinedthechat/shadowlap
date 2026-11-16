import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PACK_LIMITS, Store, unpackRun } from '@shadowlap/engine';
import { walkDropped, type DroppedEntry } from '../ui/runspage/drop-walk.js';
import { importWords } from '../ui/runspage/imports.js';
import { countLines, MAX_FOLDER_FILES, packArchive, packPreview, packWords, pickedPack, readPackPreview, TOO_MANY_FILES, type FolderFile } from '../ui/runspage/pack-folder.js';
import { tarBytes } from '../ui/runspage/tar.js';
import { folderFiles, writePack } from './pack-fixture.js';

/**
 * Import capture… → Pack, before anything is sent: which of a folder's files go up, which `unpack`
 * would refuse (in its own words, which the engine's unpackRun is held to here), what run.json says
 * the pack holds, and a dropped folder walked as Chromium hands it over, at most 100 entries a batch.
 */

const MB = 1024 * 1024;
const HEX = (c: string) => c.repeat(64);
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const pack = (name = 'support-refund') => {
  const p = writePack(name);
  dirs.push(join(p.dir, '..'));
  return p;
};
/** What the engine's unpack says of the folder at `dir`, named by its full path as it names it. */
function unpackSays(dir: string): string {
  const store = Store.open(':memory:');
  try {
    unpackRun(store, dir);
    return 'imported';
  } catch (err) {
    return (err as Error).message;
  } finally {
    store.close();
  }
}
const sized = (path: string, bytes = 10): FolderFile => ({ path, bytes });

describe('a pack’s folder picked', () => {
  it('sends run.json, calls.jsonl and the blobs of a pack the engine wrote, and leaves out what unpack never reads', () => {
    const { dir } = pack();
    writeFileSync(join(dir, '.DS_Store'), 'x');
    mkdirSync(join(dir, 'notes'));
    writeFileSync(join(dir, 'notes', 'why.md'), 'kept as a golden for the refund flow');
    const files = folderFiles(dir);
    expect(files.map((f) => f.path)).toContain('support-refund/.gitattributes');
    const picked = pickedPack(files, 64 * MB);
    const blobs = readdirSync(join(dir, 'blobs')).sort();
    expect(picked.error).toBeNull();
    expect(picked.name).toBe('support-refund');
    expect(picked.files.map((f) => f.entry)).toEqual(['run.json', 'calls.jsonl', ...blobs.map((b) => `blobs/${b}`)]);
    expect(blobs.length).toBeGreaterThan(1);
    // The archive is the size the limit was held to.
    expect(packArchive(picked.files).size).toBe(tarBytes([...picked.files.map((f) => f.file.bytes), null]));
  });

  it('says how many packs a folder of packs holds, and to pick one; a folder of none is no pack, in unpack’s words', () => {
    const one = pack('refund');
    const two = writePack('escalation', join(one.dir, '..'));
    const goldens = (packs: string[]) => packs.flatMap((dir) => folderFiles(dir).map((f) => ({ ...f, path: `goldens/${f.path}` })));
    expect(pickedPack(goldens([one.dir, two.dir]), null)).toMatchObject({ name: 'goldens', files: [], error: 'goldens holds 2 packs, each in a folder of its own: pick one of them.' });
    expect(pickedPack(goldens([one.dir]), null).error).toBe('goldens holds a pack in refund: pick that folder.');
    const notes = join(one.dir, '..', 'notes');
    mkdirSync(notes);
    writeFileSync(join(notes, 'why.md'), 'nothing to import');
    expect(pickedPack(folderFiles(notes), null)).toMatchObject({ name: 'notes', error: 'notes is not a shadowlap pack (no run.json)' });
    expect(unpackSays(notes)).toBe(`${notes} is not a shadowlap pack (no run.json)`);
  });

  it('refuses what unpack would refuse in blobs/, in its words: another name, a folder, deeper folders', () => {
    for (const [extra, said] of [
      [['blobs', 'readme.txt'], (dir: string) => `${dir}: unexpected file blobs/readme.txt`],
      [['blobs', 'sub', 'x'], (dir: string) => `${dir}: unexpected file blobs/sub`],
      [['blobs', HEX('a'), 'x'], () => `blobs/${HEX('a')} is not a regular file`],
    ] as const) {
      const { dir } = pack();
      mkdirSync(join(dir, ...extra.slice(0, -1)), { recursive: true });
      writeFileSync(join(dir, ...extra), 'x');
      expect(pickedPack(folderFiles(dir), null), extra.join('/')).toMatchObject({ name: 'support-refund', files: [], error: said('support-refund') });
      expect(unpackSays(dir), extra.join('/')).toBe(said(dir));
    }
    // A file named blobs, where the folder would be.
    expect(pickedPack([sized('p/run.json'), sized('p/blobs')], null).error).toBe('p: blobs must be a directory');
  });

  it('takes one folder, not the files in it nor several', () => {
    expect(pickedPack([sized('run.json'), sized('calls.jsonl'), sized(`blobs/${HEX('a')}`)], null).error).toBe('Pick the pack’s folder, not the files in it: the folder’s name is the pack’s.');
    expect(pickedPack([sized('a/run.json'), sized('b/run.json')], null).error).toBe('Pick one folder: the one shadowlap pack wrote.');
    expect(pickedPack([], null).error).toBe('Pick one folder: the one shadowlap pack wrote.');
    expect(pickedPack(Array.from({ length: MAX_FOLDER_FILES + 1 }, (_, i) => sized(`home/f${i}`)), null).error).toBe(TOO_MANY_FILES);
  });

  it('says a pack too large for the dashboard is unpacked in a terminal, its folder quoted; and refuses a file over unpack’s own limit', () => {
    const big = [sized('support refund/run.json', 2000), sized('support refund/calls.jsonl', 30 * MB), sized(`support refund/blobs/${HEX('b')}`, 50 * MB)];
    expect(pickedPack(big, 64 * MB)).toMatchObject({ name: 'support refund', files: [], error: "This pack is 80 MB, more than the dashboard takes (64 MB): import it in a terminal with shadowlap unpack 'support refund'." });
    // Without a limit (a dashboard that takes no files) it isn't too large: the dialog's own line says what it takes.
    expect(pickedPack(big, null).error).toBeNull();
    expect(pickedPack([sized('p/run.json', PACK_LIMITS.manifestBytes + 1)], null).error).toBe(`run.json is ${PACK_LIMITS.manifestBytes + 1} bytes, over the ${PACK_LIMITS.manifestBytes}-byte limit`);
  });
});

describe('what run.json says a pack holds', () => {
  it('counts the runs and calls of a pack the engine wrote, and names its own run, the last', async () => {
    const { dir, runIds } = pack();
    const picked = pickedPack(folderFiles(dir), null);
    const read = await readPackPreview('support-refund', picked.files);
    expect(read).toEqual({ preview: { runs: 2, calls: 2, run: { id: runIds[1], argv: ['node', 'agent.js', '--task', 'triage inbox'] } }, error: null });
    const words = packWords({ name: 'support-refund', ...read }, true);
    expect(words).toEqual({
      line: null,
      rows: [
        { label: 'Holds', value: '2 runs, 2 calls', quiet: 'its own run last, after those it came from' },
        { label: 'Run', value: `\`${runIds[1].slice(0, 10)}\``, quiet: "`node agent.js --task 'triage inbox'`" },
        { label: 'On replay', value: 'asks first', quiet: 'its command came from whoever made the pack' },
      ],
      command: 'shadowlap unpack support-refund',
    });
    // The dialog's words for the Pack source are these.
    expect(importWords({ source: 'pack', picked: null, pack: { name: 'support refund', preview: null }, id: '', host: '', project: '', keys: null, defaults: null, uploads: false })).toEqual({
      line: 'This dashboard takes no files: start it in your project with shadowlap dashboard, or import in a terminal with shadowlap unpack',
      rows: [{ label: 'On replay', value: 'asks first', quiet: 'its command came from whoever made the pack' }],
      command: "shadowlap unpack 'support refund'",
    });
    expect(packWords(null, true).command).toBe('shadowlap unpack <folder>');
  });

  it('refuses a run.json that is no pack this build reads, in unpack’s words', () => {
    const { dir } = pack();
    const manifest = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as Record<string, unknown>;
    for (const [m, said] of [
      [{ ...manifest, format: 'some-other-pack' }, 'support-refund: unexpected format some-other-pack'],
      [{ ...manifest, version: 2 }, 'support-refund: pack version 2 is not supported (this build reads 1)'],
      [{ ...manifest, runs: [] }, 'support-refund: run.json must list between 1 and 10000 runs'],
      [null, 'support-refund: unexpected format undefined'],
    ] as const) {
      expect(packPreview('support-refund', JSON.stringify(m), 0), said).toEqual({ preview: null, error: said });
      writeFileSync(join(dir, 'run.json'), JSON.stringify(m));
      expect(unpackSays(dir)).toBe(said.replace('support-refund', dir));
    }
    expect(packPreview('support-refund', '{"format":', 0)).toEqual({ preview: null, error: 'support-refund: run.json is not valid JSON' });
  });

  it('counts a call a line, the last one ended or not', () => {
    const lines = (s: string) => countLines(new TextEncoder().encode(s));
    expect([lines(''), lines('{}\n'), lines('{}\n{}\n'), lines('{}\n{}')]).toEqual([0, 1, 2, 2]);
  });
});

describe('a folder dropped', () => {
  /** A file's entry as Chromium hands it over. */
  const file = (path: string): DroppedEntry => ({ isFile: true, isDirectory: false, fullPath: `/${path}`, file: (ok: (f: File) => void) => ok(new File([path], path.split('/').pop()!)) }) as DroppedEntry;
  /** A folder's entry, whose reader hands out at most 100 entries a call, then an empty batch. */
  const folder = (path: string, children: DroppedEntry[], calls: number[] = []): DroppedEntry =>
    ({
      isFile: false,
      isDirectory: true,
      fullPath: `/${path}`,
      createReader: () => {
        let at = 0;
        return {
          readEntries: (ok: (batch: DroppedEntry[]) => void) => {
            calls.push(at);
            const batch = children.slice(at, at + 100);
            at += batch.length;
            setTimeout(() => ok(batch), 0);
          },
        };
      },
    }) as DroppedEntry;

  it('reads every file of a pack’s folder, its blobs/ in batches of 100 until an empty one', async () => {
    const reads: number[] = [];
    const blobs = Array.from({ length: 250 }, (_, i) => file(`support-refund/blobs/${i.toString(16).padStart(64, '0')}`));
    const dropped = folder('support-refund', [file('support-refund/run.json'), file('support-refund/calls.jsonl'), folder('support-refund/blobs', blobs, reads)]);
    const files = await walkDropped([dropped], MAX_FOLDER_FILES);
    expect(files).toHaveLength(252);
    expect(reads).toEqual([0, 100, 200, 250]);
    expect(files!.slice(0, 3).map((f) => f.path)).toEqual(['support-refund/run.json', 'support-refund/calls.jsonl', `support-refund/blobs/${'0'.repeat(64)}`]);
    expect(await files![0].file.text()).toBe('support-refund/run.json');
    // What the dialog makes of it: the pack, every blob going up.
    expect(pickedPack(files!.map((f) => ({ path: f.path, bytes: f.file.size })), null)).toMatchObject({ name: 'support-refund', error: null });
  });

  it('stops reading a drop that holds more than it reads', async () => {
    const many = folder('home', Array.from({ length: 30 }, (_, i) => file(`home/f${i}`)));
    expect(await walkDropped([many], 20)).toBeNull();
  });
});
