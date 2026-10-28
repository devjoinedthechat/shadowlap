import { isObject, ulid, validateCall, validateRun, type CallRecord, type RunRecord } from '@shadowlap/engine';

/**
 * How runs are laid out in the bucket, under the store's folder:
 *
 *   blobs/<sha256>             one per blob, gzipped, written once: shared blobs go up once
 *   runs/<run>/calls.jsonl.gz  the run's calls, as `shadowlap pack` writes them, gzipped
 *   runs/<run>/run.json        the run and its metadata (labels, notes, author…), rewritten when they change
 *   index/<ulid>.json          one per push: what it pushed, for listing without reading every run
 *   shares/<run>-<id>.html     redacted reports behind share links
 *   tests/<ulid>.json          the report of each `shadowlap test --push` session
 *   fixes/<fx-id>.json         a fix with its blames, verdicts and repairs, rewritten as it grows (fix-doc.ts)
 *   pr/<number>/…              what a pull request's CI job wrote, laid out the same way (see pr.ts)
 *
 * Everything but run.json and a fix's document is written once and never changed. A push writes blobs, then calls, then
 * run.json, then its index segment, so whatever a reader finds listed is complete.
 */

export const keys = {
  blob: (hash: string) => `blobs/${hash}`,
  calls: (runId: string) => `runs/${runId}/calls.jsonl.gz`,
  run: (runId: string) => `runs/${runId}/run.json`,
  segment: (id: string) => `index/${id}.json`,
  segments: 'index/',
  share: (runId: string, id: string) => `shares/${runId.toLowerCase()}-${id}.html`,
  tests: (id: string) => `tests/${id}.json`,
  check: (id: string) => `.shadowlap-check/${id}`,
};

export const RUN_FORMAT = 'shadowlap-store-run';
export const INDEX_FORMAT = 'shadowlap-store-index';
export const LAYOUT_VERSION = 1;

/** What a push records about a run in its index segment. */
export interface IndexEntry {
  runId: string;
  parentRunId: string | null;
  mode: RunRecord['mode'];
  status: RunRecord['status'];
  startedAt: number;
  endedAt: number | null;
  /** Who made it: a git email, a user name, or `ci`. */
  author: string | null;
  codeVersion: string | null;
  /** With author `ci`: the CI provider it ran under (github, gitlab…). */
  ci: string | null;
  labels: string[];
  calls: number;
  /** The hash of its synced metadata (labels, notes, results), so a pull knows when they changed. */
  metaHash: string;
  /**
   * For an attempt (`--repeat`, a blame probe, a verify attempt): the run it is filed under, so a
   * machine that hasn't pulled it counts it with its run. Absent from segments older pushes wrote.
   */
  attemptOf?: string | null;
}

export interface IndexSegment {
  format: typeof INDEX_FORMAT;
  version: typeof LAYOUT_VERSION;
  at: number;
  by: string | null;
  runs: IndexEntry[];
}

export interface StoredRunDoc {
  format: typeof RUN_FORMAT;
  version: typeof LAYOUT_VERSION;
  run: RunRecord;
  calls: number;
  pushedAt: number;
  pushedBy: string | null;
}

export class LayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutError';
  }
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} _.:/-]*$/u;
/** C0 and C1 control characters: never part of a name, and able to rewrite a terminal. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** The same, but for text that may run over lines: a tab and a line feed are allowed. */
const CONTROL_BUT_LINES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const KINDS = new Set(['api', 'tool', 'clock', 'random']);
/** Tools a partial recording lists as covered (`tool:<name>`), at most. */
const MAX_COVERED_TOOLS = 1000;
/** A CI provider's name, as ciProvider gives it. */
const CI_NAME = /^[a-z][a-z0-9-]{0,31}$/;

function fail(where: string, what: string): never {
  throw new LayoutError(`${where}: ${what}`);
}

/** One line of text from the bucket (an author, a pusher's name), or null when it isn't one. */
function nameOrNull(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v.length <= max && !CONTROL.test(v) ? v : null;
}

export function newSegmentId(now: number): string {
  return ulid(now);
}

export function isRunId(v: unknown): v is string {
  return typeof v === 'string' && ULID.test(v);
}

/** Every string in a value, its keys included, free of control characters but tabs and line feeds. */
function checkStrings(v: unknown, where: string, depth = 0): void {
  if (typeof v === 'string') {
    if (CONTROL_BUT_LINES.test(v)) fail(where, 'contains control characters');
    return;
  }
  if (v === null || typeof v !== 'object') return;
  if (depth > 32) fail(where, 'is nested too deeply');
  if (Array.isArray(v)) {
    v.forEach((x, i) => checkStrings(x, `${where}[${i}]`, depth + 1));
    return;
  }
  for (const [k, x] of Object.entries(v)) {
    if (CONTROL.test(k)) fail(where, 'has a key with control characters');
    checkStrings(x, `${where}.${k}`, depth + 1);
  }
}

/**
 * A run's metadata from the bucket, beyond what a pack's checks cover (labels, notes, redactions):
 * who made it is one short line, what it covers lists call kinds and tools, its normalizer hash is
 * a hash, and no string anywhere in it can rewrite a terminal. A blame's request fields are data
 * for a model, never shown raw, and are left as they are.
 */
function checkMeta(meta: unknown, where: string): void {
  if (meta === undefined) return;
  if (!isObject(meta)) fail(where, 'must be an object');
  for (const [k, v] of Object.entries(meta)) {
    if (CONTROL.test(k)) fail(where, 'has a key with control characters');
    if (k === 'blame' && isObject(v)) {
      const { fields: _fields, ...rest } = v;
      checkStrings(rest, `${where}.blame`);
    } else {
      checkStrings(v, `${where}.${k}`);
    }
  }
  if (meta.author !== undefined && nameOrNull(meta.author) === null) fail(`${where}.author`, 'must be one line of at most 200 characters');
  if (meta.covers !== undefined) {
    const c = meta.covers;
    // Call kinds, and one tool's calls as `tool:<name>`: the tools whose outputs a trace kept.
    const covered = (k: unknown) => typeof k === 'string' && (KINDS.has(k) || (k.startsWith('tool:') && k.length > 5 && k.length <= 205 && !CONTROL.test(k)));
    if (!Array.isArray(c) || c.length === 0 || c.length > KINDS.size + MAX_COVERED_TOOLS || !c.every(covered) || new Set(c).size !== c.length) {
      fail(`${where}.covers`, `must list call kinds (${[...KINDS].join(', ')}) or tools as tool:<name>`);
    }
  }
  if (meta.normalizersHash !== undefined && (typeof meta.normalizersHash !== 'string' || !HEX64.test(meta.normalizersHash))) fail(`${where}.normalizersHash`, 'must be a SHA-256 hex digest');
  if (meta.ci !== undefined && (typeof meta.ci !== 'string' || !CI_NAME.test(meta.ci))) fail(`${where}.ci`, 'must name a CI provider');
}

/**
 * Checks a run record from the bucket as strictly as a pack's, and its metadata as above. A command
 * line may hold a tab or a line break (python -c '…', node -e '…'), in a pack as here; terminals
 * show it escaped.
 */
export function checkStoredRun(raw: unknown, where: string): RunRecord {
  try {
    validateRun(raw, where);
  } catch (err) {
    throw new LayoutError((err as Error).message);
  }
  checkMeta((raw as Record<string, unknown>).meta, `${where}.meta`);
  return raw as RunRecord;
}

/**
 * Why the store would refuse to give a run back, or null: what a push checks before uploading, with
 * the same rules a pull applies, so nothing goes up that a teammate can't bring down.
 */
export function storeProblem(run: RunRecord, calls: readonly CallRecord[]): string | null {
  try {
    checkStoredRun(run, 'run');
    for (const c of calls) {
      try {
        validateCall(c, `call #${c.callNo}`);
      } catch (err) {
        throw new LayoutError((err as Error).message);
      }
    }
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Reads an index segment, keeping only well-formed entries: the bucket is shared, so nothing in it is trusted. */
export function parseSegment(bytes: Buffer, key: string): IndexSegment {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new LayoutError(`${key} isn't JSON`);
  }
  if (!isObject(raw) || raw.format !== INDEX_FORMAT) throw new LayoutError(`${key} isn't a Shadowlap index segment`);
  if (raw.version !== LAYOUT_VERSION) throw new LayoutError(`${key} is version ${String(raw.version)}; this Shadowlap reads version ${LAYOUT_VERSION}. Update Shadowlap.`);
  const runs: IndexEntry[] = [];
  for (const e of Array.isArray(raw.runs) ? raw.runs.slice(0, 100_000) : []) {
    if (!isObject(e) || !isRunId(e.runId)) continue;
    if (e.parentRunId !== null && e.parentRunId !== undefined && !isRunId(e.parentRunId)) continue;
    if (typeof e.startedAt !== 'number' || typeof e.metaHash !== 'string' || !HEX64.test(e.metaHash)) continue;
    runs.push({
      runId: e.runId,
      parentRunId: (e.parentRunId) ?? null,
      mode: e.mode === 'replay' ? 'replay' : 'record',
      status: (['running', 'completed', 'failed', 'crashed'] as const).find((s) => s === e.status) ?? 'completed',
      startedAt: e.startedAt,
      endedAt: typeof e.endedAt === 'number' ? e.endedAt : null,
      // Shown in terminals and dashboards: one clean line each, or nothing.
      author: nameOrNull(e.author),
      codeVersion: nameOrNull(e.codeVersion, 128),
      ci: typeof e.ci === 'string' && CI_NAME.test(e.ci) ? e.ci : null,
      labels: Array.isArray(e.labels) ? e.labels.filter((l): l is string => typeof l === 'string' && l.length <= 40 && LABEL.test(l)).slice(0, 50) : [],
      calls: typeof e.calls === 'number' && Number.isSafeInteger(e.calls) && e.calls >= 0 ? e.calls : 0,
      metaHash: e.metaHash,
      ...(isRunId(e.attemptOf) ? { attemptOf: e.attemptOf } : {}),
    });
  }
  return { format: INDEX_FORMAT, version: LAYOUT_VERSION, at: typeof raw.at === 'number' ? raw.at : 0, by: nameOrNull(raw.by), runs };
}

/** Reads a run document and checks its run record as strictly as a pack's. */
export function parseRunDoc(bytes: Buffer, runId: string): StoredRunDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new LayoutError(`runs/${runId}/run.json isn't JSON`);
  }
  if (!isObject(raw) || raw.format !== RUN_FORMAT) throw new LayoutError(`runs/${runId}/run.json isn't a Shadowlap run`);
  if (raw.version !== LAYOUT_VERSION) throw new LayoutError(`runs/${runId}/run.json is version ${String(raw.version)}; this Shadowlap reads version ${LAYOUT_VERSION}. Update Shadowlap.`);
  const run = checkStoredRun(raw.run, `runs/${runId}/run.json`);
  if (run.runId !== runId) throw new LayoutError(`runs/${runId}/run.json holds another run (${run.runId})`);
  return {
    format: RUN_FORMAT,
    version: LAYOUT_VERSION,
    run,
    calls: typeof raw.calls === 'number' && Number.isSafeInteger(raw.calls) && raw.calls >= 0 ? raw.calls : 0,
    pushedAt: typeof raw.pushedAt === 'number' ? raw.pushedAt : 0,
    pushedBy: nameOrNull(raw.pushedBy),
  };
}
