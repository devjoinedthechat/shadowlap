/**
 * A folder dropped on the page, walked: the entries `DataTransferItem.webkitGetAsEntry()` hands a
 * drop, each folder read until its reader returns an empty batch, since Chromium returns at most 100
 * a call. Only the parts of FileSystemEntry it reads, so the tests hand it fakes. No DOM here.
 */

export interface DroppedEntry {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  /** Its path from where it was dropped: `/support-refund/blobs/3f…`. */
  readonly fullPath: string;
}

/** A dropped file's entry (FileSystemFileEntry). */
interface DroppedFile extends DroppedEntry {
  file(ok: (file: File) => void, fail?: (err: unknown) => void): void;
}

/** A dropped folder's entry (FileSystemDirectoryEntry). */
interface DroppedFolder extends DroppedEntry {
  createReader(): { readEntries(ok: (batch: DroppedEntry[]) => void, fail?: (err: unknown) => void): void };
}

/**
 * Every file under the entries dropped, each by its path from where it was dropped
 * (`support-refund/run.json`), or null once the drop holds more than `max` entries: a folder that
 * large was dropped by mistake, and nothing reads the rest of it.
 */
export async function walkDropped(entries: readonly DroppedEntry[], max: number): Promise<Array<{ path: string; file: File }> | null> {
  const files: Array<{ path: string; file: File }> = [];
  const queue = [...entries];
  let seen = queue.length;
  while (queue.length) {
    const entry = queue.shift()!;
    if (entry.isFile) {
      const file = await new Promise<File>((ok, fail) => (entry as DroppedFile).file(ok, fail));
      files.push({ path: entry.fullPath.replace(/^\/+/, ''), file });
    } else if (entry.isDirectory) {
      const reader = (entry as DroppedFolder).createReader();
      for (;;) {
        const batch = await new Promise<DroppedEntry[]>((ok, fail) => reader.readEntries(ok, fail));
        if (!batch.length) break;
        seen += batch.length;
        if (seen > max) return null;
        queue.push(...batch);
      }
    }
  }
  return files;
}
