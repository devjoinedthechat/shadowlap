import { constants } from 'node:fs';
import { mkdir, open, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { PACK_REFUSALS, packFileLimit } from '@shadowlap/engine';

/**
 * A pack's archive, as Import capture… sends a pack's folder (ui/runspage/tar.ts), unpacked into a
 * folder of its own for `shadowlap unpack` to read. This is where the file system is guarded; the
 * CLI checks what the pack holds. The archive came from a browser, so it is untrusted: it may hold
 * only `run.json`, `calls.jsonl`, the folder `blobs/` and `blobs/<hash>`, each a regular file once,
 * within the engine's limits, under intact headers, then its end and nothing but zeros after. Any
 * other archive is refused whole, in words the dialog shows, and leaves nothing on disk.
 */

export class PackArchiveError extends Error {}

const BLOCK = 512;
/** The files a pack's archive may hold: those `unpack` reads. */
const FILE = /^(run\.json|calls\.jsonl|blobs\/[0-9a-f]{64})$/;
/** The one folder it may hold. */
const FOLDER = 'blobs/';
/** How much of a file is copied at a time. */
const CHUNK = 1024 * 1024;

/** What each entry type a pack never holds is, as a refusal names it: everything but a file or a folder. */
const NOT_FILES: Readonly<Record<string, (what: string) => string>> = {
  '1': (what) => `${what} is a hard link; packs contain only regular files`,
  '2': PACK_REFUSALS.link,
};

/** A name from an archive as a message shows it: no control characters, and not too long to read. */
const shown = (name: string): string => {
  const safe = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
  return safe.length > 120 ? `${safe.slice(0, 120)}…` : safe;
};

interface Header {
  name: string;
  size: number;
  type: string;
}

/** A field of text: up to its first NUL, the rest NULs, or null when anything follows the NUL. */
function text(b: Buffer, at: number, width: number): string | null {
  const field = b.subarray(at, at + width);
  const end = field.indexOf(0);
  if (end >= 0 && field.subarray(end).some((x) => x !== 0)) return null;
  return field.subarray(0, end < 0 ? width : end).toString('utf8');
}

/** A field of octal digits, padded with spaces or NULs; null for anything else (base-256 among it). */
function number(b: Buffer, at: number, width: number): number | null {
  const digits = b.subarray(at, at + width).toString('latin1').replace(/^[ \0]+|[ \0]+$/g, '');
  return /^[0-7]{1,12}$/.test(digits) ? Number.parseInt(digits, 8) : null;
}

/** Whether a header's checksum holds: the unsigned sum of its bytes, its checksum's own counted as spaces. */
function checksumHolds(b: Buffer): boolean {
  const stored = number(b, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : b[i]!;
  return stored === sum;
}

/** A header read and checked, or why the archive is refused. */
function readHeader(b: Buffer, n: number, pack: string): Header {
  const damaged = (why: string) => new PackArchiveError(`${pack}.tar is damaged: ${why}`);
  if (!checksumHolds(b)) throw damaged(`the header of entry ${n} doesn’t match its checksum`);
  const own = text(b, 0, 100);
  const prefix = text(b, 345, 155);
  if (own === null || prefix === null) throw new PackArchiveError(`${pack}: entry ${n}’s name holds a NUL`);
  // A ustar name is its prefix and its name, joined: one that needs a prefix is no pack's.
  const name = prefix ? `${prefix}/${own}` : own;
  const size = number(b, 124, 12);
  if (size === null) throw damaged(`entry ${n}’s size is not a number`);
  const type = String.fromCharCode(b[156]!);
  return { name, size, type: type === '\0' ? '0' : type };
}

/** Refuses an entry a pack never holds: by its type, its name, a second of its name, or its size. */
function checkEntry(h: Header, seen: Set<string>, pack: string): void {
  const what = shown(h.name);
  if (h.type !== '0' && h.type !== '5') throw new PackArchiveError((NOT_FILES[h.type] ?? PACK_REFUSALS.notRegular)(what));
  if (h.type === '5') {
    if (h.name !== FOLDER) throw new PackArchiveError(`${pack}: unexpected folder ${what}`);
    if (h.size !== 0) throw new PackArchiveError(`${pack}.tar is damaged: the folder ${what} has a size`);
  } else if (!FILE.test(h.name)) {
    throw new PackArchiveError(h.name.startsWith(FOLDER) ? PACK_REFUSALS.unexpectedBlob(pack, shown(h.name.slice(FOLDER.length))) : `${pack}: unexpected file ${what}`);
  }
  if (seen.has(h.name)) throw new PackArchiveError(`${pack}.tar holds ${what} twice`);
  seen.add(h.name);
  const limit = packFileLimit(h.name);
  if (h.size > limit) throw new PackArchiveError(PACK_REFUSALS.tooLarge(what, h.size, limit));
}

/** Reads exactly `length` bytes at `at`, or fewer only where the archive ends. */
async function readAt(fh: FileHandle, into: Buffer, at: number, length = into.length): Promise<number> {
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(into, got, length - got, at + got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return got;
}

/** Writes `size` bytes of the archive from `at` into a file made new, never through a link: 0600, refused if anything is there. */
async function copyOut(fh: FileHandle, at: number, size: number, path: string): Promise<void> {
  const out = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | ((constants.O_NOFOLLOW as number | undefined) ?? 0), 0o600);
  try {
    const chunk = Buffer.alloc(Math.min(CHUNK, Math.max(size, 1)));
    for (let done = 0; done < size; ) {
      const n = await readAt(fh, chunk, at + done, Math.min(chunk.length, size - done));
      if (!n) throw new PackArchiveError('the archive changed while it was read');
      await out.write(chunk, 0, n);
      done += n;
    }
  } finally {
    await out.close();
  }
}

/** Whether every byte from `at` to the archive's end is a zero: tar pads its end with them. */
async function zerosFrom(fh: FileHandle, at: number, end: number): Promise<boolean> {
  const chunk = Buffer.alloc(Math.min(CHUNK, Math.max(end - at, 1)));
  for (let pos = at; pos < end; ) {
    const n = await readAt(fh, chunk, pos, Math.min(chunk.length, end - pos));
    if (!n) break;
    if (chunk.subarray(0, n).some((x) => x !== 0)) return false;
    pos += n;
  }
  return true;
}

/** Walks the archive, writing each entry under `into` (made already), and returns how many files it wrote. */
async function extractInto(fh: FileHandle, into: string, pack: string): Promise<number> {
  const end = (await fh.stat()).size;
  const cut = () => new PackArchiveError(`${pack}.tar was cut off`);
  const block = Buffer.alloc(BLOCK);
  const seen = new Set<string>();
  let blobs = false;
  let files = 0;
  for (let at = 0, n = 1; ; n++) {
    if ((await readAt(fh, block, at)) < BLOCK) throw cut();
    if (block.every((x) => x === 0)) {
      // The end is two blocks of zeros, then nothing but zeros: a record's padding, never more data.
      if ((await readAt(fh, block, at + BLOCK)) < BLOCK || block.some((x) => x !== 0)) throw cut();
      if (!(await zerosFrom(fh, at + 2 * BLOCK, end))) throw new PackArchiveError(`${pack}.tar has data after its end`);
      return files;
    }
    const h = readHeader(block, n, pack);
    checkEntry(h, seen, pack);
    at += BLOCK;
    if (at + h.size > end) throw cut();
    if (h.name.startsWith(FOLDER) && !blobs) {
      await mkdir(join(into, 'blobs'), { mode: 0o700 });
      blobs = true;
    }
    if (h.type === '0') {
      await copyOut(fh, at, h.size, join(into, h.name));
      files++;
    }
    at += Math.ceil(h.size / BLOCK) * BLOCK;
  }
}

/**
 * Unpacks the pack's archive at `archive` into `into`, a folder made here, readable by the owner
 * alone; `pack` is the pack's name, as refusals say it. A refused archive leaves no folder behind.
 */
export async function extractPack(archive: string, into: string, pack: string): Promise<{ files: number }> {
  const fh = await open(archive, constants.O_RDONLY | ((constants.O_NOFOLLOW as number | undefined) ?? 0));
  try {
    await mkdir(into, { mode: 0o700 });
    try {
      return { files: await extractInto(fh, into, pack) };
    } catch (err) {
      await rm(into, { recursive: true, force: true });
      throw err;
    }
  } finally {
    await fh.close();
  }
}
