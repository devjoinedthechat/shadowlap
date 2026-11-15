import type { FactWords } from '../actions.js';
import { clip, plural, shortId } from '../format.js';
import { quoteArg } from '../job-title.js';
import { BLOB_NAME, manifestProblem, PACK_LIMITS, PACK_REFUSALS, packFileLimit } from '../../../engine/src/pack-manifest.js';
import { tarBlob, tarBytes } from './tar.js';

/**
 * Import capture… → Pack: a pack's folder, picked or dropped, read in the browser before anything is
 * sent. Which of its files go (those `shadowlap unpack` reads), which it would refuse, in its words,
 * and what run.json says the pack holds; then the archive that carries them up as one upload
 * (tar.ts). This is a preview: the server checks the archive, and the CLI the pack. No DOM here:
 * the tests import it.
 */

/** A file of the folder picked, by its path from the folder's parent (`support-refund/blobs/3f…`), as a picker or a drop names it. */
export interface FolderFile {
  path: string;
  bytes: number;
}

/** A file of the folder picked, with what it holds. */
export interface PackFile extends FolderFile {
  data: Blob;
}

export interface PickedPack<F extends FolderFile = PackFile> {
  /** The pack's name: the folder picked, which `unpack` records as where its runs came from. Null without one folder. */
  name: string | null;
  /** What goes up, each by its name in the pack: `run.json`, `calls.jsonl`, then `blobs/<hash>`. */
  files: Array<{ entry: string; file: F }>;
  error: string | null;
}

/** The most files a pick is read for: a pack holds tens, and a folder of thousands was picked by mistake. */
export const MAX_FOLDER_FILES = 10_000;

/** A pick of more files than that. */
export const TOO_MANY_FILES = `This folder holds more than ${MAX_FOLDER_FILES.toLocaleString('en-US')} files: pick the folder shadowlap pack wrote.`;

/** Where a file goes in the archive, or null for one `unpack` never reads (`.gitattributes`, a README, `.DS_Store`). */
const entryOf = (rest: readonly string[]): string | null => (rest.length === 1 && (rest[0] === 'run.json' || rest[0] === 'calls.jsonl')) || (rest.length === 2 && rest[0] === 'blobs') ? rest.join('/') : null;

/** run.json, calls.jsonl, then the blobs by name: the archive's order. */
const order = (entry: string): string => (entry === 'run.json' ? '0' : entry === 'calls.jsonl' ? '1' : `2${entry}`);

/** A folder picked without a run.json at its top: the packs in its folders, if any, else not a pack, in unpack's words. */
function notAPack(name: string, within: ReadonlyArray<{ rest: readonly string[] }>): string {
  const packs = [...new Set(within.filter((p) => p.rest.length > 1 && p.rest.at(-1) === 'run.json').map((p) => p.rest.slice(0, -1).join('/')))];
  if (packs.length === 1) return `${name} holds a pack in ${packs[0]!}: pick that folder.`;
  return packs.length ? `${name} holds ${packs.length} packs, each in a folder of its own: pick one of them.` : PACK_REFUSALS.noManifest(name);
}

/** A file in `blobs/` that `unpack` would refuse, in its words: a folder there, a file there of a name no blob has, or a file named `blobs`. */
function blobProblem(name: string, rest: readonly string[]): string | null {
  if (rest[0] !== 'blobs') return null;
  if (rest.length === 1) return PACK_REFUSALS.blobsNotFolder(name);
  if (!BLOB_NAME.test(rest[1]!)) return PACK_REFUSALS.unexpectedBlob(name, rest[1]!);
  return rest.length > 2 ? PACK_REFUSALS.notRegular(`blobs/${rest[1]!}`) : null;
}

/** A pack larger than the dashboard takes: what to do instead, as a file's note says it. */
function tooLarge(name: string, bytes: number, limit: number | null): string | null {
  if (limit === null || bytes <= limit) return null;
  const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;
  return `This pack is ${mb(bytes)}, more than the dashboard takes (${mb(limit)}): import it in a terminal with shadowlap unpack ${quoteArg(name)}.`;
}

/**
 * What the dialog makes of a folder picked: its name, the files that go up and why it can't, as
 * `unpack` would refuse it or as the upload limit does. One folder, with `run.json` at its top (a
 * folder of packs says how many); only `run.json`, `calls.jsonl` and `blobs/<hash>` go, the rest
 * left out, but a `blobs/` that holds anything else is refused.
 */
export function pickedPack<F extends FolderFile>(picked: readonly F[], limit: number | null): PickedPack<F> {
  const none = (error: string, name: string | null = null): PickedPack<F> => ({ name, files: [], error });
  if (picked.length > MAX_FOLDER_FILES) return none(TOO_MANY_FILES);
  const parts = picked.map((file) => ({ file, at: file.path.split('/').filter(Boolean) }));
  const tops = new Set(parts.map((p) => (p.at.length > 1 ? p.at[0]! : '')));
  if (tops.size !== 1 || tops.has('')) return none(parts.some((p) => p.at.join('/') === 'run.json') ? 'Pick the pack’s folder, not the files in it: the folder’s name is the pack’s.' : 'Pick one folder: the one shadowlap pack wrote.');
  const name = [...tops][0]!;
  const within = parts.map((p) => ({ file: p.file, rest: p.at.slice(1) }));
  if (!within.some((p) => p.rest.join('/') === 'run.json')) return none(notAPack(name, within), name);
  const refused = within.map((p) => blobProblem(name, p.rest)).find(Boolean);
  if (refused) return none(refused, name);
  const files = within.flatMap((p) => {
    const entry = entryOf(p.rest);
    return entry ? [{ entry, file: p.file }] : [];
  });
  files.sort((a, b) => (order(a.entry) < order(b.entry) ? -1 : 1));
  const over = files.find((f) => f.file.bytes > packFileLimit(f.entry));
  if (over) return none(PACK_REFUSALS.tooLarge(over.entry, over.file.bytes, packFileLimit(over.entry)), name);
  const blobs = files.some((f) => f.entry.startsWith('blobs/'));
  const error = tooLarge(name, tarBytes([...files.map((f) => f.file.bytes), ...(blobs ? [null] : [])]), limit);
  return error ? none(error, name) : { name, files, error: null };
}

/** The archive a pack goes up as: run.json, calls.jsonl, then the folder blobs/ and each blob, named as in the pack. */
export function packArchive(files: ReadonlyArray<{ entry: string; file: PackFile }>): Blob {
  const blob = (f: { entry: string }) => f.entry.startsWith('blobs/');
  const entry = (f: { entry: string; file: PackFile }) => ({ name: f.entry, data: f.file.data, mtime: f.file.data instanceof File ? f.file.data.lastModified : 0 });
  return tarBlob([...files.filter((f) => !blob(f)).map(entry), ...(files.some(blob) ? [{ name: 'blobs/', data: null }] : []), ...files.filter(blob).map(entry)]);
}

/** What run.json says a pack holds: how many runs and calls, and its own run, the last it lists. */
export interface PackPreview {
  runs: number;
  calls: number;
  run: { id: string; argv: string[] } | null;
}

/** How many lines a file holds: calls.jsonl's, a call each. */
export function countLines(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) if (b === 10) n++;
  return bytes.length && bytes[bytes.length - 1] !== 10 ? n + 1 : n;
}

/** run.json read: what it says the pack holds, or why `unpack` would refuse it, in its words. */
export function packPreview(name: string, manifest: string, calls: number): { preview: PackPreview | null; error: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    return { preview: null, error: PACK_REFUSALS.notJson(name) };
  }
  const problem = manifestProblem(parsed, name);
  if (problem) return { preview: null, error: problem };
  const runs = (parsed as { runs: unknown[] }).runs;
  const own = runs.at(-1) as { runId?: unknown; command?: { argv?: unknown } } | null;
  const argv = own?.command?.argv;
  const run = typeof own?.runId === 'string' ? { id: own.runId, argv: Array.isArray(argv) ? argv.filter((a): a is string => typeof a === 'string') : [] } : null;
  return { preview: { runs: runs.length, calls, run }, error: null };
}

/** Reads the preview from the files picked: run.json, no more of it than `unpack` takes, and calls.jsonl's lines. */
export async function readPackPreview(name: string, files: ReadonlyArray<{ entry: string; file: PackFile }>): Promise<{ preview: PackPreview | null; error: string | null }> {
  const manifest = files.find((f) => f.entry === 'run.json');
  const calls = files.find((f) => f.entry === 'calls.jsonl');
  try {
    const text = await manifest!.file.data.slice(0, PACK_LIMITS.manifestBytes).text();
    return packPreview(name, text, calls ? countLines(new Uint8Array(await calls.file.data.arrayBuffer())) : 0);
  } catch {
    return { preview: null, error: `${name}: its files can’t be read here any more: pick the folder again.` };
  }
}

const PACK_ON_REPLAY: FactWords = { label: 'On replay', value: 'asks first', quiet: 'its command came from whoever made the pack' };

/** A command as the Run row shows it: quoted as typed, kept short, and never cut into code by a backtick. */
const shownCommand = (argv: readonly string[]): string => {
  const line = clip(argv.map(quoteArg).join(' '), 120);
  return line.includes('`') ? line : `\`${line}\``;
};

/** What Import capture… says of a pack: its amber line where it takes no files, its rows once run.json is read, and the command. */
export function packWords(pack: { name: string | null; preview: PackPreview | null } | null, uploads: boolean): { line: string | null; rows: FactWords[]; command: string } {
  const p = pack?.preview;
  return {
    line: uploads ? null : 'This dashboard takes no files: start it in your project with shadowlap dashboard, or import in a terminal with shadowlap unpack',
    rows: [
      ...(p ? [{ label: 'Holds', value: `${plural(p.runs, 'run')}, ${plural(p.calls, 'call')}`, ...(p.runs > 1 ? { quiet: 'its own run last, after those it came from' } : {}) }] : []),
      ...(p?.run ? [{ label: 'Run', value: `\`${shortId(p.run.id)}\``, quiet: shownCommand(p.run.argv) }] : []),
      PACK_ON_REPLAY,
    ],
    command: `shadowlap unpack ${pack?.name ? quoteArg(pack.name) : '<folder>'}`,
  };
}
