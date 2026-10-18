import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pulledRun } from './classify.js';
import { sha256 } from './ids.js';
import { loadApiRequest, manifestRefs } from './manifest.js';
import { PACK_LIMITS, PackError, callRefs, validateCall, validateRun } from './pack-schema.js';
import { redactRun } from './redact.js';
import { Store } from './store.js';
import { safeLine } from './text.js';
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

/**
 * Runs as a copy of them holds them (a pack, an HTML file, a trace): one its recorder left marked
 * running (killed, out of memory: see liveness.ts) was interrupted, as every screen and `ls` say,
 * so it is `crashed`, ended at its last call, as gc ends it; a copy that kept it running would show
 * it recording for good wherever it is opened. Every other run as it is. The store is not changed.
 */
export function asTheyStand<R extends RunRecord>(store: Store, runs: readonly R[]): R[] {
  if (!runs.some((r) => r.status === 'running')) return [...runs];
  const left = new Map(store.recordingRuns().abandoned.map((a) => [a.run.runId, a.lastAt]));
  return runs.map((r) => {
    const lastAt = r.status === 'running' ? left.get(r.runId) : undefined;
    return lastAt === undefined ? r : { ...r, status: 'crashed' as const, endedAt: r.endedAt ?? lastAt };
  });
}

/**
 * A run as a copy brings it into a store (a pack, the team store): no process here records it, so
 * one marked running (a pack edited by hand, or made by another tool) comes in as interrupted,
 * `crashed` and ended at its last call or its start, as gc ends one its recorder left. Kept running,
 * it would read as recording and hold up rm and gc for a day, or for good with a start time ahead.
 * The fields a copy may leave out get their empty value.
 */
export function asImportedRun(run: RunRecord, calls: readonly CallRecord[]): RunRecord {
  const copy: RunRecord = { ...run, parentRunId: run.parentRunId ?? null, codeVersion: run.codeVersion ?? null, endedAt: run.endedAt ?? null, divergence: run.divergence ?? null };
  if (run.status !== 'running') return copy;
  const last = calls.reduce((n, c) => Math.max(n, c.at, c.end?.at ?? 0, ...c.attempts.map((a) => a.at)), run.startedAt);
  return { ...copy, status: 'crashed', endedAt: run.endedAt ?? last };
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

  const lines: string[] = [];
  const blobs = new Set<string>();
  try {
    for (const run of runs) {
      for (const call of store.getCalls(run.runId)) {
        lines.push(JSON.stringify(call));
        for (const ref of blobRefs(call)) {
          blobs.add(ref);
          if (call.kind === 'api' && ref === call.requestRef) for (const child of manifestChildren(store, ref)) blobs.add(child);
        }
      }
    }
    // A run its recorder left goes in as interrupted, never as recording: unpacked, it would read running.
    const manifest: PackManifest = { format: PACK_FORMAT, version: PACK_VERSION, createdAt: Date.now(), runs: asTheyStand(source, runs).map((r) => forPack(r, opts.keepAuthor === true)) };
    writePack(dir, (into) => {
      mkdirSync(join(into, 'blobs'));
      for (const hash of blobs) {
        const bytes = store.getBlob(hash);
        if (!bytes) throw new Error(`missing blob ${hash}`);
        writeFileSync(join(into, 'blobs', hash), bytes);
      }
      writeFileSync(join(into, 'calls.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''));
      writeFileSync(join(into, 'run.json'), JSON.stringify(manifest, null, 2) + '\n');
    });
  } finally {
    if (store !== source) store.close();
  }
  return { dir, runs: runs.map((r) => r.runId), calls: lines.length, blobs: blobs.size, redacted };
}

/** What a pack is made of; run.json last, since a folder is taken for a pack by it. */
const PACK_ENTRIES = ['blobs', 'calls.jsonl', 'run.json'] as const;

const present = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** A rename, or across filesystems (a folder that is a link to another disk) a copy and a removal. */
function move(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Writes a pack into `dir` as a whole. A folder that already holds one (the same golden packed again,
 * the dashboard's export of a run made twice) gets this pack's run.json, calls.jsonl and blobs/ in
 * place of its own: written beside it first, then swapped in, so the folder never holds an earlier
 * pack's blobs (one the redaction rules added since would have masked) and an error leaves the old
 * pack as it was. Anything else in the folder (a README, notes) stays.
 */
function writePack(dir: string, write: (into: string) => void): void {
  const target = resolve(dir);
  mkdirSync(dirname(target), { recursive: true });
  const stage = mkdtempSync(join(dirname(target), `.${basename(target)}.pack-`));
  let keep = false;
  try {
    const fresh = join(stage, 'new');
    mkdirSync(fresh);
    write(fresh);
    if (!existsSync(target)) {
      move(fresh, target);
      return;
    }
    const aside = join(stage, 'old');
    mkdirSync(aside);
    const moved: Array<{ name: string; had: boolean }> = [];
    try {
      for (const name of PACK_ENTRIES) {
        const had = present(join(target, name));
        if (had) move(join(target, name), join(aside, name));
        moved.push({ name, had });
        move(join(fresh, name), join(target, name));
      }
    } catch (err) {
      // The old entries go back, so the folder holds the old pack or the new one, never a mix.
      for (const { name, had } of moved.reverse()) {
        try {
          if (had && !present(join(aside, name))) continue;
          rmSync(join(target, name), { recursive: true, force: true });
          if (had) move(join(aside, name), join(target, name));
        } catch {
          keep = true;
        }
      }
      if (keep) throw new Error(`${(err as Error).message}; the old pack's files are in ${aside}`);
      throw err;
    }
  } finally {
    if (!keep) rmSync(stage, { recursive: true, force: true });
  }
}

export interface UnpackResult {
  imported: string[];
  skipped: string[];
  /** The command each imported run would execute on replay. */
  commands: Array<{ runId: string; argv: string[] }>;
  /**
   * Runs skipped because the store already holds that id, where the store's run is not the pack's
   * recording: its command differs (`command`: the pack's), or its calls do. Nothing about them was
   * changed; whoever replays the pack must not replay the store's run in its place.
   */
  mismatched: RecordingMismatch[];
}

/** How the run a store holds under a pack's run id differs from the pack's. */
export interface RecordingMismatch {
  runId: string;
  /** The pack's command, when the store's run was recorded with another; null when it is the same. */
  command: RunRecord['command'] | null;
  /** The calls differ: other calls, or other requests or responses, the pack's redaction aside. */
  calls: boolean;
}

/**
 * Whether the store's run holds the calls a pack holds under the same id. The pack may hold them
 * redacted with rules the store's copy doesn't carry (the golden packed from the run recorded here):
 * then the store's run is redacted the same way, as `pack` did, and compared with that.
 */
function sameCalls(store: Store, held: RunRecord, packed: RunRecord, packedCalls: readonly CallRecord[]): boolean {
  const ours = store.getCalls(held.runId);
  const theirs = [...packedCalls].sort((a, b) => a.callNo - b.callNo);
  if (ours.length !== theirs.length) return false;
  const identity = (c: CallRecord) => JSON.stringify([c.callNo, c.kind, c.name, c.fingerprint, c.occurrence]);
  if (ours.some((c, i) => identity(c) !== identity(theirs[i]!))) return false;
  const refs = (c: CallRecord) => JSON.stringify(callRefs(c));
  const same = (calls: readonly CallRecord[]) => calls.every((c, i) => refs(c) === refs(theirs[i]!));
  const mine = JSON.stringify(held.meta?.redactions ?? []);
  const rules = packed.meta?.redactions ?? [];
  if (JSON.stringify(rules) === mine) return same(ours);
  // Packed with more rules than this copy carries, after the ones it does.
  const carried = held.meta?.redactions?.length ?? 0;
  if (JSON.stringify(rules.slice(0, carried)) !== mine) return false;
  const scratch = Store.open(':memory:');
  try {
    redactRun(store, held.runId, rules.slice(carried), scratch);
    return same(scratch.getCalls(held.runId));
  } finally {
    scratch.close();
  }
}

/** How the store's run under a pack run's id differs from it, or null when it is that recording. */
function mismatch(store: Store, held: RunRecord, packed: RunRecord, packedCalls: readonly CallRecord[]): RecordingMismatch | null {
  const sameCommand = JSON.stringify(held.command.argv) === JSON.stringify(packed.command.argv) && held.command.cwd === packed.command.cwd;
  const calls = !sameCalls(store, held, packed, packedCalls);
  return sameCommand && !calls ? null : { runId: packed.runId, command: sameCommand ? null : { argv: packed.command.argv, cwd: packed.command.cwd }, calls };
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
 * already exist are skipped, and said to differ (`mismatched`) when the store's run under that id is
 * not the pack's recording. Imported runs are marked, because replaying them runs a command that
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
  const packed = new Map(blobs.map((b) => [b.name, b.bytes]));
  store.transaction(() => {
    const fresh = new Set(runs.filter((r) => !store.getRun(r.runId)).map((r) => r.runId));
    const needed = calls.filter((c) => fresh.has(c.runId));
    // Only the blobs the runs it brings in need: a pack's folder may hold others (an earlier pack
    // written there, a file slipped in), and those never come into the store.
    const bring = (h: string) => {
      const bytes = packed.get(h);
      if (bytes && !store.hasBlob(h)) store.putBlob(bytes);
    };
    for (const c of needed) for (const h of callRefs(c)) bring(h);
    for (const c of needed) if (c.kind === 'api' && c.requestRef) for (const h of manifestRefs(store, c.requestRef)) bring(h);
    // Every blob a call needs must now exist, including the parts of a chunked request.
    for (const c of needed) {
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
      const own = calls.filter((c) => c.runId === run.runId);
      store.importRun({ ...asImportedRun(run, own), meta: { ...rest, imported: { at, from } } });
      for (const call of own) {
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
  // A run skipped because the store holds its id may be another recording: a copy pulled from a pull
  // request's folder, a pack someone sent that reused the id, a golden copied and edited by hand.
  const mismatched: RecordingMismatch[] = [];
  for (const run of runs) {
    if (!skipped.includes(run.runId)) continue;
    const held = store.getRun(run.runId);
    const m = held && mismatch(store, held, run, calls.filter((c) => c.runId === run.runId));
    if (m) mismatched.push(m);
  }
  return { imported, skipped, commands, mismatched };
}

/** Whether replaying this run would execute a command that came from an imported pack, or from the team store. */
export function commandIsImported(run: RunRecord): boolean {
  return Boolean(run.meta?.imported || run.meta?.commandFromImport);
}

/**
 * Where an imported run's command came from, as the question before replaying it says:
 * "the team store" for a run pulled from it (a teammate's or CI's recording), else "an imported pack".
 */
export function importedCommandSource(run: Pick<RunRecord, 'meta'>): 'the team store' | 'an imported pack' {
  return pulledRun(run) ? 'the team store' : 'an imported pack';
}

/**
 * Where the store's copy of a run came from, in words for a message: "recorded on this machine",
 * "pulled from pull request 12's folder in the team store", "pulled from the team store" or
 * "unpacked from <folder>". Terminal-safe.
 */
export function heldFrom(run: Pick<RunRecord, 'meta'>): string {
  const imported = run.meta?.imported;
  if (!imported) return 'recorded on this machine';
  if (imported.pr) return `pulled from pull request ${safeLine(String(imported.pr))}'s folder in the team store`;
  return pulledRun(run) ? 'pulled from the team store' : `unpacked from ${safeLine(String(imported.from))}`;
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
export function hasRecordedCommand(run: { command: { argv: readonly string[] } }): boolean {
  const argv = run.command.argv;
  return argv.length > 0 && !(argv.length === 1 && argv[0] === NO_COMMAND);
}
