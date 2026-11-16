import { useCallback, useRef, useState, type DragEvent } from 'react';
import { DialogFacts, type DialogFactRows } from '../components/DialogFacts.js';
import { Icon } from '../components/Icon.js';
import { plural } from '../format.js';
import { walkDropped, type DroppedEntry } from './drop-walk.js';
import { MAX_FOLDER_FILES, pickedPack, readPackPreview, TOO_MANY_FILES, type PackFile, type PackPreview, type PickedPack } from './pack-folder.js';

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- React's own interface, which an attribute joins by augmenting it, type parameter and all
  interface InputHTMLAttributes<T> {
    /** The folder picker every browser has under this name: each file it picks is named by its path in the folder (`webkitRelativePath`). */
    webkitdirectory?: string | undefined;
  }
}

/** A pack picked: what pack-folder.ts makes of the folder, and run.json's preview once it is read. */
export interface PackPicked extends PickedPack {
  preview: PackPreview | null;
  /** run.json is still being read. */
  reading: boolean;
}

/**
 * The pack picked, and what picks one: the files of a folder, or null for one too large to read. The
 * newest pick wins: reading an earlier one's run.json may end after it.
 */
export function usePickedPack(limit: number | null): [PackPicked | null, (files: PackFile[] | null) => void] {
  const [pack, setPack] = useState<PackPicked | null>(null);
  const picking = useRef(0);
  const pick = useCallback(
    (files: PackFile[] | null) => {
      const n = ++picking.current;
      const picked = files ? pickedPack(files, limit) : { name: null, files: [], error: TOO_MANY_FILES };
      setPack({ ...picked, preview: null, reading: !picked.error });
      if (picked.error) return;
      void readPackPreview(picked.name!, picked.files).then((read) => {
        if (n === picking.current) setPack({ ...picked, ...read, reading: false });
      });
    },
    [limit],
  );
  return [pack, pick];
}

/** A file the folder picker chose, by its path in the folder. */
const chosen = (f: File): PackFile => ({ path: f.webkitRelativePath || f.name, bytes: f.size, data: f });

/** What a drop holds, as entries to walk: taken while the drop lasts, as a browser hands them only then. Null without any (a browser that has none, a drop of text). */
function dropEntries(data: DataTransfer): DroppedEntry[] | null {
  const items = Array.from(data.items ?? []);
  const entries = items.map((i) => (i.kind === 'file' ? i.webkitGetAsEntry() : null)).filter((e): e is FileSystemEntry => !!e);
  return entries.length ? entries : null;
}

/**
 * A pack's folder: the drop zone, which takes a folder dropped or picked (keyboard and screen readers
 * reach the picker as the File source's), the folder picked with how many of its files go, why it
 * can't be imported, and what it holds.
 */
export function PackPane({ pack, pick, rows }: { pack: PackPicked | null; pick: (files: PackFile[] | null) => void; rows: DialogFactRows }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // The newest folder picked or dropped: a large drop's walk may end after a pick made since, and must not replace it.
  const latest = useRef(0);
  const choose = (files: PackFile[] | null) => {
    ++latest.current;
    pick(files);
  };
  const drop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setOver(false);
    const entries = dropEntries(e.dataTransfer);
    if (!entries) return choose(Array.from(e.dataTransfer.files ?? []).map(chosen));
    const n = ++latest.current;
    // A file the browser can no longer read (moved since the drop) leaves the pick as it was.
    walkDropped(entries, MAX_FOLDER_FILES).then(
      (files) => void (n === latest.current && pick(files && files.map((f) => ({ path: f.path, bytes: f.file.size, data: f.file })))),
      () => undefined,
    );
  };
  return (
    <div className="impbody">
      <label
        className={`drop${over ? ' over' : ''}${pack && !pack.error ? ' has' : ''}`}
        tabIndex={0}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            input.current?.click();
          }
        }}
      >
        <input ref={input} type="file" webkitdirectory="" hidden onChange={(e) => (e.target.files?.length ? choose(Array.from(e.target.files).map(chosen)) : undefined)} />
        <Icon name="import" />
        <b>Drop a pack folder here</b>
        <span>or click to choose · the folder shadowlap pack wrote</span>
      </label>
      {pack?.error ? <p className="fieldnote err">{pack.error}</p> : null}
      {pack && !pack.error ? (
        <div className="capfile">
          <Icon name="folder" />
          <span className="capnames">
            <code>{pack.name}</code>
          </span>
          <small>{plural(pack.files.length, 'file')}</small>
        </div>
      ) : null}
      <DialogFacts rows={rows} />
    </div>
  );
}
