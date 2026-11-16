import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PACK_LIMITS, Store, unpackRun } from '@shadowlap/engine';
import { extractPack, PackArchiveError } from '../src/pack-archive.js';
import { packName } from '../src/routes/imports.js';
import { packArchive, pickedPack } from '../ui/runspage/pack-folder.js';
import { folderFiles, writePack } from './pack-fixture.js';

/**
 * A pack's archive as the dashboard's server unpacks it before `shadowlap unpack` reads it: the one
 * the dialog writes, of a pack the engine's own `packRun` wrote, comes out byte for byte, and any
 * other is refused whole, leaving nothing but the archive in the upload's folder. The hostile ones
 * are built by hand here: they are what an attacker would send, which the dialog never writes.
 */

const HEX = 'c'.repeat(64);
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** An upload's own folder, as a claim makes it, with the archive in it under its name. */
function uploaded(bytes: Uint8Array, name = 'support-refund'): { folder: string; archive: string; into: string } {
  const folder = mkdtempSync(join(tmpdir(), 'sl-pack-archive-'));
  dirs.push(folder);
  const archive = join(folder, `${name}.tar`);
  writeFileSync(archive, bytes);
  return { folder, archive, into: join(folder, name) };
}

describe('the archive the dialog writes', () => {
  it('unpacks to the pack the engine wrote, byte for byte, which unpack imports under the folder’s name', async () => {
    const { dir, runIds } = writePack();
    dirs.push(join(dir, '..'));
    const picked = pickedPack(folderFiles(dir), null);
    const { folder, archive, into } = uploaded(new Uint8Array(await packArchive(picked.files).arrayBuffer()));
    expect(await extractPack(archive, into, 'support-refund')).toEqual({ files: picked.files.length });
    const blobs = readdirSync(join(dir, 'blobs')).sort();
    expect(readdirSync(into).sort()).toEqual(['blobs', 'calls.jsonl', 'run.json']);
    expect(readdirSync(join(into, 'blobs')).sort()).toEqual(blobs);
    for (const f of ['run.json', 'calls.jsonl', ...blobs.map((b) => join('blobs', b))]) expect(readFileSync(join(into, f)).equals(readFileSync(join(dir, f))), f).toBe(true);
    // Readable by the owner alone: the folder, its blobs and every file.
    if (process.platform !== 'win32') {
      expect([statSync(into).mode & 0o777, statSync(join(into, 'blobs')).mode & 0o777]).toEqual([0o700, 0o700]);
      expect(statSync(join(into, 'run.json')).mode & 0o777).toBe(0o600);
      // An ordinary ustar archive: tar lists it as the server reads it.
      expect(execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim().split('\n')).toEqual(['run.json', 'calls.jsonl', 'blobs/', ...blobs.map((b) => `blobs/${b}`)]);
    }
    const store = Store.open(':memory:');
    try {
      expect(unpackRun(store, into).imported).toEqual(runIds);
      expect(store.getRun(runIds[1])!.meta?.imported?.from).toBe('support-refund');
    } finally {
      store.close();
    }
    expect(readdirSync(folder).sort()).toEqual(['support-refund', 'support-refund.tar']);
  });
});

/** One entry of a hand-built archive: its header, with what each test breaks, and its body rounded to a block. */
function entry(name: string, body: string | Buffer = '', o: { type?: string; prefix?: string | Buffer; size?: number; sizeField?: string; checksum?: number; nameField?: Buffer } = {}): Buffer {
  const data = typeof body === 'string' ? Buffer.from(body) : body;
  const h = Buffer.alloc(512);
  (o.nameField ?? Buffer.from(name)).copy(h, 0);
  h.write('0000600\0', 100, 'latin1');
  h.write('0000000\0', 108, 'latin1');
  h.write('0000000\0', 116, 'latin1');
  h.write(o.sizeField ?? `${(o.size ?? data.length).toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  h.write('00000000000\0', 136, 'latin1');
  h.write(o.type ?? '0', 156, 'latin1');
  h.write('ustar\0' + '00', 257, 'latin1');
  if (o.prefix) (typeof o.prefix === 'string' ? Buffer.from(o.prefix) : o.prefix).copy(h, 345);
  h.write(' '.repeat(8), 148, 'latin1');
  const sum = h.reduce((n, b) => n + b, 0);
  h.write(`${(o.checksum ?? sum).toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const END = Buffer.alloc(1024);
const MANIFEST = entry('run.json', '{"format":"shadowlap-pack"}');

describe('an archive no dialog writes', () => {
  /** Refused whole, in these words, with nothing left but the archive. */
  async function refuses(parts: Buffer[], said: string) {
    const { folder, archive, into } = uploaded(Buffer.concat(parts));
    const err = await extractPack(archive, into, 'support-refund').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, said).toBeInstanceOf(PackArchiveError);
    expect((err as Error).message).toBe(said);
    expect(readdirSync(folder), said).toEqual(['support-refund.tar']);
  }

  it('refuses a header that doesn’t match its checksum', async () => {
    await refuses([MANIFEST, entry('calls.jsonl', '{}\n', { checksum: 1 }), END], 'support-refund.tar is damaged: the header of entry 2 doesn’t match its checksum');
  });

  it('refuses links, devices, FIFOs, and pax and GNU long-name headers: a pack holds regular files', async () => {
    for (const [type, said] of [
      ['1', 'run.json is a hard link; packs contain only regular files'],
      ['2', 'run.json is a symbolic link; packs contain only regular files'],
      ['3', 'run.json is not a regular file'],
      ['4', 'run.json is not a regular file'],
      ['6', 'run.json is not a regular file'],
      ['7', 'run.json is not a regular file'],
      ['x', 'run.json is not a regular file'],
      ['g', 'run.json is not a regular file'],
      ['L', 'run.json is not a regular file'],
      ['K', 'run.json is not a regular file'],
    ] as const) {
      await refuses([entry('run.json', '', { type }), END], said);
    }
    await refuses([MANIFEST, entry('notes/', '', { type: '5' }), END], 'support-refund: unexpected folder notes/');
    await refuses([MANIFEST, entry('blobs/', 'x', { type: '5' }), END], 'support-refund.tar is damaged: the folder blobs/ has a size');
  });

  it('refuses every name but run.json, calls.jsonl, blobs/ and blobs/<hash>', async () => {
    for (const [name, said] of [
      ['/run.json', 'support-refund: unexpected file /run.json'],
      ['../run.json', 'support-refund: unexpected file ../run.json'],
      ['./run.json', 'support-refund: unexpected file ./run.json'],
      ['blobs/../run.json', 'support-refund: unexpected file blobs/../run.json'],
      [`blobs\\${HEX}`, `support-refund: unexpected file blobs\\${HEX}`],
      [`blobs/${HEX.toUpperCase()}`, `support-refund: unexpected file blobs/${HEX.toUpperCase()}`],
      [`blobs/${HEX}/x`, `support-refund: unexpected file blobs/${HEX}/x`],
      ['.gitattributes', 'support-refund: unexpected file .gitattributes'],
      ['run.json\n', 'support-refund: unexpected file run.json?'],
    ] as const) {
      await refuses([entry(name, '{}'), END], said);
    }
    // A NUL inside the name, something after it.
    await refuses([entry('', '{}', { nameField: Buffer.from('run.json\0../../evil') }), END], 'support-refund: entry 1’s name holds a NUL');
    // A ustar prefix makes it another name: `../x/run.json`.
    await refuses([entry('run.json', '{}', { prefix: '../x' }), END], 'support-refund: unexpected file ../x/run.json');
  });

  it('refuses a name twice, a size over unpack’s limit or past the archive’s end, and an archive cut off or with data after its end', async () => {
    await refuses([MANIFEST, MANIFEST, END], 'support-refund.tar holds run.json twice');
    await refuses([entry('run.json', '', { size: PACK_LIMITS.manifestBytes + 1 }), END], `run.json is ${PACK_LIMITS.manifestBytes + 1} bytes, over the ${PACK_LIMITS.manifestBytes}-byte limit`);
    await refuses([entry('run.json', '', { sizeField: '\x80\0\0\0\0\0\0\0\0\0\0\x01' }), END], 'support-refund.tar is damaged: entry 1’s size is not a number');
    await refuses([entry('calls.jsonl', '', { size: 4096 }), END.subarray(0, 512)], 'support-refund.tar was cut off');
    await refuses([MANIFEST], 'support-refund.tar was cut off');
    await refuses([MANIFEST, END.subarray(0, 512)], 'support-refund.tar was cut off');
    await refuses([MANIFEST.subarray(0, 300)], 'support-refund.tar was cut off');
    await refuses([MANIFEST, END, Buffer.from('more')], 'support-refund.tar has data after its end');
  });

  it('takes the zeros a tar pads its end with, and a folder made of blobs/ before or after its blobs', async () => {
    const { into, archive } = uploaded(Buffer.concat([MANIFEST, entry(`blobs/${HEX}`, 'x'), entry('blobs/', '', { type: '5' }), END, Buffer.alloc(9 * 512)]));
    expect(await extractPack(archive, into, 'support-refund')).toEqual({ files: 2 });
    expect(readFileSync(join(into, 'blobs', HEX), 'utf8')).toBe('x');
  });

  it('never writes into a folder that is there already', async () => {
    const { into, archive, folder } = uploaded(Buffer.concat([MANIFEST, END]));
    mkdirSync(into);
    await expect(extractPack(archive, into, 'support-refund')).rejects.toThrow(/EEXIST/);
    expect(readdirSync(folder).sort()).toEqual(['support-refund', 'support-refund.tar']);
    expect(readdirSync(into)).toEqual([]);
  });
});

describe('the pack’s folder name', () => {
  it('keeps the folder picked as it is where every system can make it, and makes a safe one of any other', () => {
    for (const kept of ['support-refund', 'support refund (2)', 'Rückerstattung', 'golden_v2.1', 'A-1103 [replay]']) expect(packName(`${kept}.tar`), kept).toBe(kept);
    // Written apart in the name a browser sends, the accent is one letter here, as the folder shows it.
    expect(packName('Rückerstattung.tar')).toBe('Rückerstattung');
    for (const [sent, safe] of [
      ['..tar', 'pack'],
      ['.hidden.tar', 'hidden'],
      ['trailing..tar', 'trailing'],
      [' spaced .tar', 'spaced'],
      ['CON.tar', 'pack-CON'],
      ['nul.txt.tar', 'pack-nul.txt'],
      ['a:b*c?.tar', 'a_b_c'],
      ['line\nbreak.tar', 'line_break'],
      [`${'x'.repeat(101)}.tar`, 'x'.repeat(100)],
    ] as const) expect(packName(sent), sent).toBe(safe);
  });
});
