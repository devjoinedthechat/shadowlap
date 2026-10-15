import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { sha256 } from './ids.js';
import { loadApiRequest, manifestRefs } from './manifest.js';
import { PACK_LIMITS, PackError, callRefs, validateCall, validateRun } from './pack-schema.js';
import { redactRun } from './redact.js';
import { Store } from './store.js';
import type { CallRecord, Normalizer, RunRecord } from './types.js';

/**
 * Portable recordings: a directory with `run.json`, `calls.jsonl` and one
 * uncompressed file per blob under `blobs/`. Stable names and one file per blob keep it
 * git-friendly, so a recording can be committed as a CI golden or shared.
 */

export const PACK_FORMAT = 'shadowlap-pack';
export const PACK_VERSION = 1;

interface PackManifest {
  format: typeof PACK_FORMAT;
  version: typeof PACK_VERSION;
  createdAt: number;
  /** Root first; the packed run last. */
  runs: RunRecord[];
}

export interface PackOptions {
  /** Include the run's ancestors so a fork stays readable on its own. */
  lineage?: boolean;
  /** Redaction rules applied to every request and response written to the pack. */
  redact?: Normalizer[];
  /**
   * Keep who made each run (`meta.author`, often an email). A pack is made to be committed or
   * shared, so it leaves the author out unless asked.
   */
  keepAuthor?: boolean;
}

/** The run as a pack carries it: without its author, unless the caller keeps it. */
function forPack(run: RunRecord, keepAuthor: boolean): RunRecord {
  if (keepAuthor || run.meta?.author === undefined) return run;
  const { author: _author, ...meta } = run.meta;
  return { ...run, meta };
}

export interface PackResult {
  dir: string;
  runs: string[];
  calls: number;
  blobs: number;
  redacted: boolean;
}

function blobRefs(call: CallRecord): string[] {
  const refs: string[] = [];
  if (call.requestRef) refs.push(call.requestRef);
  if (call.end?.responseRef) refs.push(call.end.responseRef);
  for (const a of call.attempts) if (a.responseRef) refs.push(a.responseRef);
  return refs;
}

/** Follows request manifests to the blobs they reference. */
function manifestChildren(store: Store, hash: string): string[] {
  const m = store.getJson<{ v?: number; kind?: string; system?: string | null; tools?: string | null; messages?: string[]; blob?: string }>(hash);
  if (!m || typeof m !== 'object' || m.v !== 1) return [];
  if (m.kind === 'chunked') return [m.system, m.tools, ...(m.messages ?? [])].filter((h): h is string => typeof h === 'string');
  if (m.kind === 'whole' && m.blob) return [m.blob];
  return [];
}

export function packRun(source: Store, runId: string, dir: string, opts: PackOptions = {}): PackResult {
  const target = source.getRun(runId);
  if (!target) throw new Error(`unknown run ${runId}`);
  let runs: RunRecord[] = [target];
  if (opts.lineage) {
    let cursor = target;
    while (cursor.parentRunId) {
      const parent = source.getRun(cursor.parentRunId);
      if (!parent) break;
      runs.unshift(parent);
      cursor = parent;
    }
  }

  // Redaction works on a scratch copy; the source store is never modified.
  let store = source;
  const redacted = (opts.redact?.length ?? 0) > 0;
  if (redacted) {
    store = Store.open(':memory:');
    runs = runs.map((r) => redactRun(source, r.runId, opts.redact!, store));
  }

  mkdirSync(join(dir, 'blobs'), { recursive: true });
  const lines: string[] = [];
  const blobs = new Set<string>();
  for (const run of runs) {
    for (const call of store.getCalls(run.runId)) {
      lines.push(JSON.stringify(call));
      for (const ref of blobRefs(call)) {
        blobs.add(ref);
        if (call.kind === 'api' && ref === call.requestRef) for (const child of manifestChildren(store, ref)) blobs.add(child);
      }
    }
  }
  for (const hash of blobs) {
    const bytes = store.getBlob(hash);
    if (!bytes) throw new Error(`missing blob ${hash}`);
    writeFileSync(join(dir, 'blobs', hash), bytes);
  }
  const manifest: PackManifest = { format: PACK_FORMAT, version: PACK_VERSION, createdAt: Date.now(), runs: runs.map((r) => forPack(r, opts.keepAuthor === true)) };
  writeFileSync(join(dir, 'run.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(dir, 'calls.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''));
  if (store !== source) store.close();
  return { dir, runs: runs.map((r) => r.runId), calls: lines.length, blobs: blobs.size, redacted };
}

export interface UnpackResult {
  imported: string[];
  skipped: string[];
  /** The command each imported run would execute on replay. */
  commands: Array<{ runId: string; argv: string[] }>;
}

/** A pack file, read only if it is a regular file (never a symlink) within the size limit. */
function readPackFile(path: string, limit: number, what: string): Buffer {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new PackError(`${what} is a symbolic link; packs contain only regular files`);
  if (!st.isFile()) throw new PackError(`${what} is not a regular file`);
  if (st.size > limit) throw new PackError(`${what} is ${st.size} bytes, over the ${limit}-byte limit`);
  return readFileSync(path);
}

/**
 * Imports a pack. A pack is untrusted input: every record is validated before anything is written,
 * blobs are verified against their hash, and every blob a call needs must be present. Runs that
 * already exist are skipped. Imported runs are marked, because replaying them runs a command that
 * someone else recorded.
 */
export function unpackRun(store: Store, dir: string): UnpackResult {
  const root = resolve(dir);
  const manifestPath = join(root, 'run.json');
  if (!existsSync(manifestPath)) throw new PackError(`${dir} is not a Shadowlap pack (no run.json)`);
  let manifest: Partial<PackManifest>;
  try {
    manifest = JSON.parse(readPackFile(manifestPath, PACK_LIMITS.manifestBytes, 'run.json').toString('utf8')) as Partial<PackManifest>;
  } catch (err) {
    if (err instanceof PackError) throw err;
    throw new PackError(`${dir}: run.json is not valid JSON`);
  }
  if (manifest.format !== PACK_FORMAT) throw new PackError(`${dir}: unexpected format ${String(manifest.format)}`);
  if (manifest.version !== PACK_VERSION) throw new PackError(`${dir}: pack version ${String(manifest.version)} is not supported (this build reads ${PACK_VERSION})`);
  if (!Array.isArray(manifest.runs) || manifest.runs.length === 0 || manifest.runs.length > PACK_LIMITS.runs) throw new PackError(`${dir}: run.json must list between 1 and ${PACK_LIMITS.runs} runs`);
  const runs = manifest.runs.map((r, i) => validateRun(r, `run.json runs[${i}]`));
  const runIds = new Set(runs.map((r) => r.runId));
  if (runIds.size !== runs.length) throw new PackError(`${dir}: run.json lists a run twice`);

  const calls: CallRecord[] = [];
  const callsPath = join(root, 'calls.jsonl');
  if (existsSync(callsPath)) {
    const lines = readPackFile(callsPath, PACK_LIMITS.callsBytes, 'calls.jsonl').toString('utf8').split('\n');
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new PackError(`calls.jsonl line ${i + 1}: not valid JSON`);
      }
      const call = validateCall(parsed, `calls.jsonl line ${i + 1}`);
      if (!runIds.has(call.runId)) throw new PackError(`calls.jsonl line ${i + 1}: run ${call.runId} is not in run.json`);
      calls.push(call);
      if (calls.length > PACK_LIMITS.calls) throw new PackError(`calls.jsonl has more than ${PACK_LIMITS.calls} calls`);
    });
  }
  const seen = new Set<string>();
  for (const c of calls) {
    const key = `${c.runId}:${c.callNo}`;
    if (seen.has(key)) throw new PackError(`calls.jsonl: call #${c.callNo} of run ${c.runId} appears twice`);
    seen.add(key);
  }

  const blobDir = join(root, 'blobs');
  const blobs: Array<{ name: string; bytes: Buffer }> = [];
  if (existsSync(blobDir)) {
    const st = lstatSync(blobDir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new PackError(`${dir}: blobs must be a directory`);
    let total = 0;
    for (const name of readdirSync(blobDir)) {
      if (!/^[0-9a-f]{64}$/.test(name)) throw new PackError(`${dir}: unexpected file blobs/${name}`);
      const bytes = readPackFile(join(blobDir, name), PACK_LIMITS.blobBytes, `blobs/${name}`);
      total += bytes.length;
      if (total > PACK_LIMITS.totalBytes) throw new PackError(`${dir}: blobs exceed ${PACK_LIMITS.totalBytes} bytes in total`);
      if (sha256(bytes) !== name) throw new PackError(`${dir}: blobs/${name} does not match its hash`);
      blobs.push({ name, bytes });
    }
  }

  const imported: string[] = [];
  const skipped: string[] = [];
  const commands: UnpackResult['commands'] = [];
  const from = basename(root);
  // One time for everything one unpack brings in, so the runs of a pack read as one import.
  const at = Date.now();
  store.transaction(() => {
    for (const b of blobs) store.putBlob(b.bytes);
    // Every blob a call needs must now exist, including the parts of a chunked request.
    for (const c of calls) {
      for (const h of callRefs(c)) if (!store.getBlob(h)) throw new PackError(`calls.jsonl: call #${c.callNo} of run ${c.runId} needs blob ${h}, which the pack does not contain`);
      if (c.kind === 'api' && c.requestRef) {
        for (const h of manifestRefs(store, c.requestRef)) if (!store.getBlob(h)) throw new PackError(`calls.jsonl: the request of call #${c.callNo} needs blob ${h}, which the pack does not contain`);
        try {
          loadApiRequest(store, c.requestRef);
        } catch (err) {
          throw new PackError(`calls.jsonl: the request of call #${c.callNo} cannot be read: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    for (const run of runs) {
      if (store.getRun(run.runId)) {
        skipped.push(run.runId);
        continue;
      }
      // Whatever the pack claims, the run is marked as imported here.
      const { imported: _claimed, commandFromImport: _also, ...rest } = run.meta ?? {};
      store.importRun({ ...run, meta: { ...rest, imported: { at, from } } });
      for (const call of calls.filter((c) => c.runId === run.runId)) {
        const { end, attempts, ...start } = call;
        store.appendCallStart(start);
        const identity = { kind: call.kind, name: call.name, fingerprint: call.fingerprint, occurrence: call.occurrence };
        for (const a of attempts) store.appendCallEnd(identity, a);
        if (end) store.appendCallEnd(identity, end);
      }
      imported.push(run.runId);
      commands.push({ runId: run.runId, argv: run.command.argv });
    }
  });
  return { imported, skipped, commands };
}

/** Whether replaying this run would execute a command that came from an imported pack. */
export function commandIsImported(run: RunRecord): boolean {
  return Boolean(run.meta?.imported || run.meta?.commandFromImport);
}

/**
 * What a run built from a capture carries instead of a command. A HAR or a gateway capture says
 * what was sent, not what sent it, so there is nothing to re-run — but a pack needs at least one
 * argument, and such a run must survive `pack`. This is deliberately not runnable.
 */
export const NO_COMMAND = '<no-recorded-command>';

/**
 * Whether the run knows how to start its agent. Replaying one that does not needs the agent's own
 * command supplied; the replay that results records everything, so it has a command of its own.
 */
export function hasRecordedCommand(run: RunRecord): boolean {
  const argv = run.command.argv;
  return argv.length > 0 && !(argv.length === 1 && argv[0] === NO_COMMAND);
}
