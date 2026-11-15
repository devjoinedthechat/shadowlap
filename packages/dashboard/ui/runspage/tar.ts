/**
 * A ustar archive written in the browser: how Import capture… sends a pack's folder as one upload,
 * so all of it arrives or none does, in one of the server's upload slots (src/pack-archive.ts reads
 * it). The archive is a Blob of each entry's header, its file and the zeros that round the file up
 * to a block, then two blocks of zeros: no file is copied into one buffer. Regular files and folders
 * only, each named relative to the pack (`run.json`, `blobs/`, `blobs/<hash>`), owned by nobody,
 * readable by the owner alone. No DOM here: the tests import it.
 */

export const TAR_BLOCK = 512;

export interface TarEntry {
  /** Its name in the archive, printable ASCII of at most 100 characters; a folder's ends in `/`. */
  name: string;
  /** The file, or null for a folder. */
  data: Blob | null;
  /** When it last changed, in milliseconds; the epoch when unknown. */
  mtime?: number;
}

/** What the archive of these entries takes, in bytes: a header each, each file rounded up to a block, and the two blocks that end it. */
export function tarBytes(sizes: ReadonlyArray<number | null>): number {
  return sizes.reduce<number>((n, s) => n + TAR_BLOCK + (s === null ? 0 : Math.ceil(s / TAR_BLOCK) * TAR_BLOCK), 2 * TAR_BLOCK);
}

/** A number in a header field `width` bytes wide: octal digits, zero-padded, then a NUL. */
const octal = (n: number, width: number): string => `${Math.floor(n).toString(8).padStart(width - 1, '0')}\0`;

/** One entry's header block, its checksum the unsigned sum of its bytes with the checksum's own as spaces. */
function header(e: TarEntry): Uint8Array<ArrayBuffer> {
  if (!/^[\x21-\x7e]{1,100}$/.test(e.name)) throw new Error(`a tar entry's name is printable ASCII of at most 100 characters: ${e.name}`);
  const h = new Uint8Array(TAR_BLOCK);
  const put = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) h[at + i] = text.charCodeAt(i);
  };
  put(0, e.name);
  put(100, e.data ? '0000600\0' : '0000700\0');
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(e.data?.size ?? 0, 12));
  put(136, octal((e.mtime ?? 0) / 1000, 12));
  put(148, ' '.repeat(8));
  put(156, e.data ? '0' : '5');
  put(257, 'ustar\0');
  put(263, '00');
  put(148, `${h.reduce((n, b) => n + b, 0).toString(8).padStart(6, '0')}\0 `);
  return h;
}

/** The archive of `entries`, in their order. */
export function tarBlob(entries: readonly TarEntry[]): Blob {
  const parts: Array<Blob | Uint8Array<ArrayBuffer>> = [];
  for (const e of entries) {
    parts.push(header(e));
    if (!e.data) continue;
    parts.push(e.data);
    const pad = (TAR_BLOCK - (e.data.size % TAR_BLOCK)) % TAR_BLOCK;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(2 * TAR_BLOCK));
  return new Blob(parts, { type: 'application/x-tar' });
}
