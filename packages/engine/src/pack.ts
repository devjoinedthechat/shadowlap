import { closeSync, constants, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pulledRun } from './classify.js';
import { sameCommandLine } from './argv-credentials.js';
import { sha256 } from './ids.js';
import { keepingRunCanaries } from './injection.js';
import { agentCallsOf, isJudgeCall } from './judge-scope.js';
import { bringRequest, loadApiRequest, manifestRefs } from './manifest.js';
import { messageOf } from './message-of.js';
import { BLOB_NAME, manifestProblem, PACK_FORMAT, PACK_LIMITS, PACK_REFUSALS, PACK_VERSION } from './pack-manifest.js';
import { PackError, callRefs, validateCall, validateRun } from './pack-schema.js';
import { carriesCredentials, redactRun } from './redact.js';
import { Store, type StoreOf } from './store.js';
import { safeLine } from './text.js';
import type { CallRecord, Normalizer, RunRecord } from './types.js';

/**
 * Portable recordings: a directory with `run.json`, `calls.jsonl` and one
 * uncompressed file per blob under `blobs/`. Stable names and one file per blob keep it
 * git-friendly, so a recording can be committed as a CI golden or shared. A `.gitattributes`
 * beside them keeps git from converting line endings, which would break every blob's hash.
 */

export { PACK_FORMAT, PACK_VERSION };

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
export function asTheyStand<R extends RunRecord>(store: StoreOf<'recording'>, runs: readonly R[]): R[] {
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
  /**
   * Each redaction rule (`n` from 1, as `redact ls` numbers them) that matches inside signed
   * reasoning, which the pack keeps as recorded (signed.ts), with the calls it does in: what it
   * matches there leaves with the pack.
   */
  signed: Array<{ n: number; rule: Normalizer; calls: Array<{ runId: string; callNo: number }> }>;
}

/** What a pack's `.gitattributes` says: git keeps every file's bytes as they are. */
export const PACK_GITATTRIBUTES = '# A shadowlap pack: every blob is checked against its hash, so git must not convert line endings.\n* -text\n';

/**
 * Writes the pack's `.gitattributes` unless the folder has one: committed without it, a checkout
 * that converts line endings (Git for Windows' core.autocrlf, a `text=auto` attribute) changes the
 * blobs, and the pack no longer matches its hashes. One already there is the person's own, and is
 * never written through a link.
 */
export function writePackAttributes(dir: string): void {
  try {
    writeFileSync(join(dir, '.gitattributes'), PACK_GITATTRIBUTES, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

/**
 * A blob as it was committed, when git checked it out with its line endings converted: every CRLF
 * back to LF. Null when it has none. The result counts only if it matches the blob's hash.
 */
function withoutCrlf(bytes: Buffer): Buffer | null {
  if (!bytes.includes('\r\n')) return null;
  // latin1 maps each byte to one character and back, so nothing else changes.
  return Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

function blobRefs(call: CallRecord): string[] {
  const refs: string[] = [];
  if (call.requestRef) refs.push(call.requestRef);
  if (call.end?.responseRef) refs.push(call.end.responseRef);
  for (const a of call.attempts) if (a.responseRef) refs.push(a.responseRef);
  return refs;
}

/** Follows request manifests to the blobs they reference, of every version (manifest.ts). */
function manifestChildren(store: StoreOf<'recording'>, hash: string): string[] {
  return manifestRefs(store, hash);
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

  // Redaction works on a scratch copy; the source store is never modified. A run whose recording
  // kept a credential (one made before it was known to be one) is copied so too, with no rules,
  // which masks it (redactRun): no pack carries one, --no-redact or not.
  let store = source;
  const redacted = (opts.redact?.length ?? 0) > 0;
  const signed = new Map<number, Array<{ runId: string; callNo: number }>>();
  const heard = (rule: number, call: CallRecord) => {
    const calls = signed.get(rule) ?? [];
    if (!calls.some((c) => c.runId === call.runId && c.callNo === call.callNo)) calls.push({ runId: call.runId, callNo: call.callNo });
    signed.set(rule, calls);
  };
  if (redacted || runs.some((r) => carriesCredentials(source, r.runId))) {
    store = Store.open(':memory:');
    // An injection attempt's copy keeps its canaries, for whoever opens it to see its proof.
    runs = runs.map((r) => keepingRunCanaries(r, () => redactRun(source, r.runId, opts.redact ?? [], store, { signed: heard })).value);
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
    writePackAttributes(dir);
  } finally {
    if (store !== source) store.close();
  }
  return { dir, runs: runs.map((r) => r.runId), calls: lines.length, blobs: blobs.size, redacted, signed: [...signed].sort(([a], [b]) => a - b).map(([i, calls]) => ({ n: i + 1, rule: opts.redact![i]!, calls })) };
}

/** What a pack is made of; run.json last, since a folder is taken for a pack by it. */
export const PACK_ENTRIES = ['blobs', 'calls.jsonl', 'run.json'] as const;

/** Whether something is at a path, a link that leads nowhere included. */
export const lexists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** A rename, or across filesystems (a folder that is a link to another disk) a copy and a removal. */
export function movePath(from: string, to: string): void {
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
      movePath(fresh, target);
      return;
    }
    const aside = join(stage, 'old');
    mkdirSync(aside);
    const moved: Array<{ name: string; had: boolean }> = [];
    try {
      for (const name of PACK_ENTRIES) {
        const had = lexists(join(target, name));
        if (had) movePath(join(target, name), join(aside, name));
        moved.push({ name, had });
        movePath(join(fresh, name), join(target, name));
      }
    } catch (err) {
      // The old entries go back, so the folder holds the old pack or the new one, never a mix.
      for (const { name, had } of moved.reverse()) {
        try {
          if (had && !lexists(join(aside, name))) continue;
          rmSync(join(target, name), { recursive: true, force: true });
          if (had) movePath(join(aside, name), join(target, name));
        } catch {
          keep = true;
        }
      }
      if (keep) throw new Error(`${messageOf(err)}; the old pack's files are in ${aside}`, { cause: err });
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

/** Writes a run's calls into a store, each call's attempts and end after its start. */
function appendCalls(store: StoreOf<'recording'>, calls: readonly CallRecord[]): void {
  for (const call of calls) {
    const { end, attempts, ...start } = call;
    store.appendCallStart(start);
    const identity = { kind: call.kind, name: call.name, fingerprint: call.fingerprint, occurrence: call.occurrence };
    for (const a of attempts) store.appendCallEnd(identity, a);
    if (end) store.appendCallEnd(identity, end);
  }
}

/**
 * Whether the store's run holds the calls a pack holds under the same id. Either may carry more
 * redaction rules than the other, after the ones both carry: the pack, when it is the golden packed
 * from the run recorded here; the store's copy, when it came from a newer pack of the run (packed
 * again after a rule was added) and the pack is an older one, as an older checkout holds it. Then
 * the one with fewer is redacted with the rest, as `pack` did, and compared with the other. A
 * recording an earlier version made, which kept a credential before it was known to be one
 * (carriesCredentials: in a captured call's address or body, say), is compared as a pack writes it,
 * with those masked. The agent's calls decide: a judge check's calls are what a run was asked about
 * later, which a pack packed again (or a golden updated) gains under the same id (see
 * mergeJudgeCalls).
 */
function sameCalls(store: StoreOf<'recording' | 'readModels'>, held: RunRecord, packed: RunRecord, packedCalls: readonly CallRecord[], blobs: ReadonlyMap<string, Buffer>): boolean {
  const ours = agentCallsOf(store.getCalls(held.runId));
  const theirs = agentCallsOf([...packedCalls].sort((a, b) => a.callNo - b.callNo));
  if (ours.length !== theirs.length) return false;
  // What no copy changes first; a call's name and what it stored, which a copy masks, after.
  const shape = (c: CallRecord) => JSON.stringify([c.callNo, c.kind, c.fingerprint, c.occurrence]);
  if (ours.some((c, i) => shape(c) !== shape(theirs[i]!))) return false;
  const stored = (c: CallRecord) => JSON.stringify([c.name, ...callRefs(c)]);
  const same = (a: readonly CallRecord[], b: readonly CallRecord[]) => a.length === b.length && a.every((c, i) => stored(c) === stored(b[i]!));
  const mine = held.meta?.redactions ?? [];
  const rules = packed.meta?.redactions ?? [];
  const json = (v: unknown) => JSON.stringify(v);
  const into = Store.open(':memory:');
  try {
    if (json(rules) === json(mine)) {
      if (same(ours, theirs)) return true;
      if (!carriesCredentials(store, held.runId)) return false;
      redactRun(store, held.runId, [], into);
      return same(agentCallsOf(into.getCalls(held.runId)), theirs);
    }
    if (rules.length > mine.length && json(rules.slice(0, mine.length)) === json(mine)) {
      // Packed with more rules than this copy carries: this copy redacted with the rest.
      keepingRunCanaries(held, () => redactRun(store, held.runId, rules.slice(mine.length), into));
      return same(agentCallsOf(into.getCalls(held.runId)), theirs);
    }
    if (mine.length > rules.length && json(mine.slice(0, rules.length)) === json(rules)) {
      // This copy carries more rules than the pack: the pack's run, as unpack would bring it in, redacted with the rest.
      const from = Store.open(':memory:');
      try {
        from.transaction(() => {
          from.importRun(asImportedRun(packed, theirs));
          for (const c of theirs) {
            for (const h of callRefs(c)) if (blobs.has(h)) from.putBlob(blobs.get(h)!);
            if (c.kind === 'api' && c.requestRef) bringRequest(from, c.requestRef, (h) => (blobs.has(h) && from.putBlob(blobs.get(h)!), from.hasBlob(h)));
          }
          appendCalls(from, theirs);
        });
        keepingRunCanaries(packed, () => redactRun(from, packed.runId, mine.slice(rules.length), into));
      } catch {
        // A blob the pack's calls need is missing or unreadable: not a recording to compare with.
        return false;
      } finally {
        from.close();
      }
      return same(ours, agentCallsOf(into.getCalls(held.runId)));
    }
    return false;
  } finally {
    into.close();
  }
}

/**
 * A pack's judge calls that the store's copy of the same recording doesn't hold, added to it with
 * the blobs they need: a golden packed again, or updated, with a judge check's verdict keeps its run
 * id, and every replay of the store's copy is then judged from the verdict as a replay of the pack
 * is. A call whose number the copy already uses gets the next free one: judge calls are matched by
 * their request, never by number. One whose blobs the pack lacks is left out. Returns how many.
 */
function mergeJudgeCalls(store: StoreOf<'recording'>, runId: string, theirs: readonly CallRecord[], blobs: ReadonlyMap<string, Buffer>): number {
  if (!theirs.length) return 0;
  const ours = store.getCalls(runId);
  const sig = (c: CallRecord) => JSON.stringify([c.fingerprint, c.requestRef, c.end?.responseRef ?? null]);
  const held = new Set(ours.filter(isJudgeCall).map(sig));
  const taken = new Set(ours.map((c) => c.callNo));
  let next = ours.reduce((n, c) => Math.max(n, c.callNo), 0) + 1;
  let added = 0;
  for (const c of [...theirs].sort((a, b) => a.callNo - b.callNo)) {
    if (held.has(sig(c))) continue;
    const bring = (h: string) => {
      const bytes = blobs.get(h);
      if (bytes && !store.hasBlob(h)) store.putBlob(bytes);
      return store.hasBlob(h);
    };
    if (!callRefs(c).every(bring)) continue;
    if (c.kind === 'api' && c.requestRef && !bringRequest(store, c.requestRef, bring)) continue;
    const callNo = taken.has(c.callNo) ? next++ : c.callNo;
    taken.add(callNo);
    held.add(sig(c));
    appendCalls(store, [{ ...c, runId, callNo, end: c.end ? { ...c.end, runId, callNo } : null, attempts: c.attempts.map((a) => ({ ...a, runId, callNo })) }]);
    added++;
  }
  return added;
}

/** How the store's run under a pack run's id differs from it, or null when it is that recording. */
function mismatch(store: StoreOf<'recording' | 'readModels'>, held: RunRecord, packed: RunRecord, packedCalls: readonly CallRecord[], blobs: ReadonlyMap<string, Buffer>): RecordingMismatch | null {
  // A pack masks the credentials a command line carries (credentialFreeArgv): the store's, with them, is the same command.
  const sameCommand = sameCommandLine(held.command.argv, packed.command.argv) && held.command.cwd === packed.command.cwd;
  const calls = !sameCalls(store, held, packed, packedCalls, blobs);
  return sameCommand && !calls ? null : { runId: packed.runId, command: sameCommand ? null : { argv: packed.command.argv, cwd: packed.command.cwd }, calls };
}

/**
 * A pack file, read only if it is a regular file (never a symbolic link) within the size limit. It
 * is opened without following a link (O_NOFOLLOW) and checked on the very descriptor it is read
 * from (fstat), so a link or anything else swapped in after a check is never read; O_NONBLOCK keeps
 * a FIFO put in its place from stalling the open. It is read up to the size it had then, and
 * refused if it grew or shrank meanwhile. Where the system has no O_NOFOLLOW (Windows), the file is
 * checked before it is opened, and refused when the file opened is not the one checked.
 */
export function readPackFile(path: string, limit: number, what: string): Buffer {
  const link = () => new PackError(PACK_REFUSALS.link(what));
  const noFollow = constants.O_NOFOLLOW as number | undefined;
  const checked = noFollow === undefined ? lstatSync(path) : null;
  if (checked?.isSymbolicLink()) throw link();
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (noFollow ?? 0) | ((constants.O_NONBLOCK as number | undefined) ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ELOOP on Linux and macOS, EMLINK on FreeBSD: the last part of the path is a link.
    if (code === 'ELOOP' || code === 'EMLINK') throw link();
    if (code === 'ENXIO') throw new PackError(PACK_REFUSALS.notRegular(what));
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new PackError(PACK_REFUSALS.notRegular(what));
    if (checked && (checked.ino !== st.ino || checked.dev !== st.dev)) throw new PackError(`${what} was replaced while it was read`);
    if (st.size > limit) throw new PackError(PACK_REFUSALS.tooLarge(what, st.size, limit));
    const bytes = Buffer.alloc(st.size);
    let read = 0;
    while (read < bytes.length) {
      const n = readSync(fd, bytes, read, bytes.length - read, read);
      if (n === 0) throw new PackError(`${what} changed while it was read`);
      read += n;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, read) !== 0) throw new PackError(`${what} changed while it was read`);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/**
 * Imports a pack. A pack is untrusted input: every record is validated before anything is written,
 * blobs are verified against their hash, and every blob a call needs must be present. Runs that
 * already exist are skipped, and said to differ (`mismatched`) when the store's run under that id is
 * not the pack's recording. Imported runs are marked, because replaying them runs a command that
 * someone else recorded; `madeHere` holds them unmarked instead, for a pack this process has just
 * made from runs of its own (`coverage --pack`'s golden), whatever the pack itself claims.
 */
export function unpackRun(store: StoreOf<'recording' | 'readModels'>, dir: string, o: { madeHere?: boolean } = {}): UnpackResult {
  const root = resolve(dir);
  const manifestPath = join(root, 'run.json');
  if (!existsSync(manifestPath)) throw new PackError(PACK_REFUSALS.noManifest(dir));
  let manifest: Partial<PackManifest>;
  try {
    manifest = JSON.parse(readPackFile(manifestPath, PACK_LIMITS.manifestBytes, 'run.json').toString('utf8')) as Partial<PackManifest>;
  } catch (err) {
    if (err instanceof PackError) throw err;
    throw new PackError(PACK_REFUSALS.notJson(dir));
  }
  const problem = manifestProblem(manifest, dir);
  if (problem) throw new PackError(problem);
  const runs = manifest.runs!.map((r, i) => validateRun(r, `run.json runs[${i}]`));
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
    if (st.isSymbolicLink() || !st.isDirectory()) throw new PackError(PACK_REFUSALS.blobsNotFolder(dir));
    let total = 0;
    for (const name of readdirSync(blobDir)) {
      if (!BLOB_NAME.test(name)) throw new PackError(PACK_REFUSALS.unexpectedBlob(dir, name));
      let bytes = readPackFile(join(blobDir, name), PACK_LIMITS.blobBytes, `blobs/${name}`);
      if (sha256(bytes) !== name) {
        // A pack committed without its .gitattributes, checked out by a git that converts line
        // endings: undone, the blob is exactly the bytes its name hashes, or it is refused.
        const restored = withoutCrlf(bytes);
        if (!restored || sha256(restored) !== name) {
          const crlf = restored ? `: it has CRLF line endings, as git writes them when it converts a pack committed without the .gitattributes "* -text" that shadowlap pack writes beside it. Add that file to ${dir}, commit it and check the pack out again` : '';
          throw new PackError(`${dir}: blobs/${name} does not match its hash${crlf}`);
        }
        bytes = restored;
      }
      total += bytes.length;
      if (total > PACK_LIMITS.totalBytes) throw new PackError(`${dir}: blobs exceed ${PACK_LIMITS.totalBytes} bytes in total`);
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
    for (const c of needed) if (c.kind === 'api' && c.requestRef) bringRequest(store, c.requestRef, (h) => (bring(h), store.hasBlob(h)));
    // Every blob a call needs must now exist, including the parts of a chunked request.
    for (const c of needed) {
      for (const h of callRefs(c)) if (!store.getBlob(h)) throw new PackError(`calls.jsonl: call #${c.callNo} of run ${c.runId} needs blob ${h}, which the pack does not contain`);
      if (c.kind === 'api' && c.requestRef) {
        for (const h of manifestRefs(store, c.requestRef)) if (!store.getBlob(h)) throw new PackError(`calls.jsonl: the request of call #${c.callNo} needs blob ${h}, which the pack does not contain`);
        try {
          loadApiRequest(store, c.requestRef);
        } catch (err) {
          throw new PackError(`calls.jsonl: the request of call #${c.callNo} cannot be read: ${messageOf(err)}`);
        }
      }
    }
    for (const run of runs) {
      if (store.getRun(run.runId)) {
        skipped.push(run.runId);
        continue;
      }
      // Whatever the pack claims, the run is marked as imported here.
      const { imported: _claimed, commandFromImport: _also, commandFromClient: _sent, ...rest } = run.meta ?? {};
      const own = calls.filter((c) => c.runId === run.runId);
      store.importRun({ ...asImportedRun(run, own), meta: o.madeHere ? rest : { ...rest, imported: { at, from } } });
      appendCalls(store, own);
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
    const m = held && mismatch(store, held, run, calls.filter((c) => c.runId === run.runId), packed);
    if (m) mismatched.push(m);
  }
  // The same recording, with judge verdicts the store's copy lacks: it takes them in.
  store.transaction(() => {
    for (const run of runs) {
      if (!skipped.includes(run.runId) || mismatched.some((m) => m.runId === run.runId && m.calls)) continue;
      mergeJudgeCalls(store, run.runId, calls.filter((c) => c.runId === run.runId && isJudgeCall(c)), packed);
    }
  });
  return { imported, skipped, commands, mismatched };
}

/**
 * Whether replaying this run would execute a command that came from an imported pack, from the team
 * store, or from a program that sent it to the sidecar (`commandFromClient`).
 */
export function commandIsImported(run: RunRecord): boolean {
  return Boolean(run.meta?.imported || run.meta?.commandFromImport || run.meta?.commandFromClient);
}

/**
 * Where an imported run's command came from, as the question before replaying it says:
 * "the team store" for a run pulled from it (a teammate's or CI's recording), "a program that sent
 * the sidecar its command" for one started through the sidecar's API, else "an imported pack".
 */
export function importedCommandSource(run: Pick<RunRecord, 'meta'>): 'the team store' | 'a program that sent the sidecar its command' | 'an imported pack' {
  if (pulledRun(run)) return 'the team store';
  return !run.meta?.imported && run.meta?.commandFromClient ? 'a program that sent the sidecar its command' : 'an imported pack';
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
 * What a run recorded through `shadowlap serve` carries instead of a command: the person starts the
 * process, so serve never knows what started it. No command, as `NO_COMMAND` is, and kept apart
 * from it so a message can say where the run came from.
 */
export const EXTERNAL_COMMAND = '<external>';

/**
 * What a run recorded by a test carries instead of a command, followed by the test's name: a
 * Vitest or node:test recording, or a Python one that gave no command, starts its agent inside the
 * test, so there is nothing to run again on its own. (pytest's plugin gives `pytest <test id>`.)
 */
export const TEST_COMMAND = '<test>';

/**
 * Whether the run knows how to start its agent. Replaying one that does not needs the agent's own
 * command supplied; the replay that results records everything, so it has a command of its own.
 */
export function hasRecordedCommand(run: { command: { argv: readonly string[] } }): boolean {
  const argv = run.command.argv;
  return argv.length > 0 && argv[0] !== TEST_COMMAND && !(argv.length === 1 && (argv[0] === NO_COMMAND || argv[0] === EXTERNAL_COMMAND));
}

/**
 * How a run came to have no command to run again (`hasRecordedCommand` false), as the middle of a
 * sentence: `shadowlap serve` never saw what started the agent, a test started it inside itself, and
 * a capture records what was sent, not what sent it.
 */
export function withoutCommand(run: { command: { argv: readonly string[] } }): string {
  const first = run.command.argv[0];
  return first === EXTERNAL_COMMAND ? 'was recorded through shadowlap serve' : first === TEST_COMMAND ? 'was recorded by a test run' : 'was imported from a capture';
}
