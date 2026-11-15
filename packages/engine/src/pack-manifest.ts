/**
 * What a pack's folder and its run.json must be, in the words `unpack` refuses one with: read by
 * `unpackRun`, by the dashboard's server as it unpacks a pack's archive, and by its Import capture…
 * dialog, which reads a pack's folder in the browser before anything is sent. No imports: the
 * dashboard's pages bundle it as it is.
 */

export const PACK_FORMAT = 'shadowlap-pack';
export const PACK_VERSION = 1;

export const PACK_LIMITS = {
  /** Largest single blob. */
  blobBytes: 256 * 1024 * 1024,
  /** All blobs together. */
  totalBytes: 4 * 1024 * 1024 * 1024,
  manifestBytes: 16 * 1024 * 1024,
  callsBytes: 1024 * 1024 * 1024,
  runs: 10_000,
  calls: 1_000_000,
  argv: 256,
  stringBytes: 16 * 1024,
};

/** A blob's file name in a pack's `blobs/`: its SHA-256, in lowercase hex. */
export const BLOB_NAME = /^[0-9a-f]{64}$/;

/** Each refusal of a pack's folder or files, as `unpack` says it (`dir`: the folder as it was named). */
export const PACK_REFUSALS = {
  noManifest: (dir: string) => `${dir} is not a shadowlap pack (no run.json)`,
  notJson: (dir: string) => `${dir}: run.json is not valid JSON`,
  blobsNotFolder: (dir: string) => `${dir}: blobs must be a directory`,
  unexpectedBlob: (dir: string, name: string) => `${dir}: unexpected file blobs/${name}`,
  tooLarge: (what: string, bytes: number, limit: number) => `${what} is ${bytes} bytes, over the ${limit}-byte limit`,
  link: (what: string) => `${what} is a symbolic link; packs contain only regular files`,
  notRegular: (what: string) => `${what} is not a regular file`,
};

/** The most a pack's file may hold, by its name in the pack (`run.json`, `calls.jsonl`, `blobs/<hash>`). */
export function packFileLimit(name: string): number {
  return name === 'run.json' ? PACK_LIMITS.manifestBytes : name === 'calls.jsonl' ? PACK_LIMITS.callsBytes : PACK_LIMITS.blobBytes;
}

/**
 * Why a pack's run.json, parsed, is not one this build reads: another format, another version, or no
 * list of 1 to `PACK_LIMITS.runs` runs. Null when it is one; each run is validated after.
 */
export function manifestProblem(manifest: unknown, dir: string): string | null {
  const m: { format?: unknown; version?: unknown; runs?: unknown } = typeof manifest === 'object' && manifest !== null ? manifest : {};
  if (m.format !== PACK_FORMAT) return `${dir}: unexpected format ${String(m.format)}`;
  if (m.version !== PACK_VERSION) return `${dir}: pack version ${String(m.version)} is not supported (this build reads ${PACK_VERSION})`;
  if (!Array.isArray(m.runs) || m.runs.length === 0 || m.runs.length > PACK_LIMITS.runs) return `${dir}: run.json must list between 1 and ${PACK_LIMITS.runs} runs`;
  return null;
}
