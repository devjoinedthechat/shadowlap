import { gunzipSync, gzipSync } from 'node:zlib';
import { asImportedRun, callRefs, classifyRun, credentialFreeArgv, credentialFreeCallName, credentialFreeCalls, loadApiRequest, manifestRefs, PACK_LIMITS, sha256, validateCall, type CallRecord, type RunRecord, type Store, type StoreOf, type TeamRunRow } from '@shadowlap/engine';
import { pullFixes, pushFixes, type FixPullResult, type FixPushResult } from './fix-sync.js';
import { isRunId, keys, LAYOUT_VERSION, LayoutError, newSegmentId, parseRunDoc, parseSegment, RUN_FORMAT, INDEX_FORMAT, storeProblem, type IndexEntry, type IndexSegment, type StoredRunDoc } from './layout.js';
import { asTheStoreHolds, keptHere, madeHere, metaHash, reconcile, sharedMeta, syncedMeta, syncedPatch, withSynced, type SharedMeta } from './merge.js';
import { isPrecondition, StoreError, type ObjectStore } from './object-store.js';
import { eachLimit } from './pool.js';
import { storeKey } from './url.js';

/**
 * Push and pull: runs between this machine's store and the team's bucket. Content-addressed, so a
 * blob shared by many runs (a system prompt, a tool list, a replayed answer) goes up once. A run
 * still recording is queued and goes when it ends. Labels and notes merge both ways; see merge.ts
 * for what else syncs. Whatever comes from the bucket is checked as strictly as a pack: it is
 * shared, so it is someone else's data. A push checks each run with the same rules before it
 * uploads it, so nothing goes up that a teammate can't bring down.
 *
 * A run is only in the store for the team once an index segment lists it: a pull lists the store
 * from the index, not by reading every run. So a push indexes every run it uploaded, even when a
 * later one fails, and a run whose upload landed without being indexed (a push cut short, a write
 * retried after it had landed) is indexed by the next push that meets it.
 *
 * A pull request's folder (pr/<number>/, see pr.ts) is a store of its own to push and pull, with
 * `pullRequest` set: its runs come down marked as that pull request's, it changes nothing about runs
 * already here, and a run marked so never goes up into the store's own runs. Once the store's own
 * runs list one of them (the team pushed its own copy), a pull replaces it with that copy.
 */

export interface SyncContext {
  store: Store;
  remote: ObjectStore;
  /** Who is syncing: the author given to runs that have none, and the name on index segments. */
  actor: string | null;
  /** The CI provider the push runs under (ciProvider), recorded with `ci` as a run's author. */
  ci?: string | null;
  /** The pull request whose folder `remote` is (pr/<number>/ in the store), or null for the store itself. */
  pullRequest?: string | null;
  now?: () => number;
  /** Requests in flight at once. */
  concurrency?: number;
  /** A line per run, for progress. */
  log?: (line: string) => void;
}

export interface PushOptions {
  /** Runs to push; their ancestors go too, so a fork keeps its lineage. Checked against the bucket itself. */
  runIds?: string[];
  /** Every run on this machine that isn't in the store as it is, as far as this machine knows. */
  all?: boolean;
}

/** A run that couldn't go to the store, or come from it, and why. */
export interface RunProblem {
  runId: string;
  reason: string;
}

export interface PushResult {
  /** Runs uploaded, or listed for the team for the first time. */
  pushed: string[];
  /** Runs already in the store whose labels, notes or results were merged into it. */
  updated: string[];
  /** Runs already in the store as they are. */
  unchanged: string[];
  /** Runs still recording: they go when they end. */
  queued: string[];
  /** Runs named that were in the store with parts missing (their calls, a blob), sent again. */
  repaired: string[];
  /** Runs left on this machine: a pull would refuse them, the store's copy can't be read, or they came from a pull request's folder. */
  refused: RunProblem[];
  blobs: { uploaded: number; present: number; bytes: number };
  /** The index segment this push wrote, if it changed anything. */
  segment: string | null;
  /** The fixes that went with the runs (fix-sync.ts); none from a pull request's job. */
  fixes: FixPushResult;
}

export interface PullOptions {
  /** Pull these runs only (and their ancestors); default: every run not here yet. */
  runIds?: string[];
  /**
   * Runs never taken from this store. Pulling a pull request's folder, these are the runs the
   * store's own index lists: a pull request's copy of one of the team's runs never lands here.
   * One that a run pulled from here needs as an ancestor is asked of `fetchExcluded` first, which
   * brings it from the store's own folder, so the lineage holds.
   */
  exclude?: ReadonlySet<string>;
  fetchExcluded?: (runIds: string[]) => Promise<void>;
}

export interface PullResult {
  pulled: string[];
  /** Runs here whose labels, notes or results changed in the store, merged into this machine's copy. */
  merged: string[];
  /** Merged runs that now hold changes the store doesn't have yet: the next push sends them. */
  needPush: string[];
  /** Runs in the store this machine deleted: not pulled again unless named. */
  skippedDeleted: string[];
  /** Runs the index lists that are gone from the store (deleted there): forgotten, not looked for again. */
  missing: string[];
  /** Names asked for that match no run in the store, or more than one. */
  unknown: string[];
  /** Runs that couldn't be brought here, and why: the next pull tries them again. */
  failed: RunProblem[];
  /** Index segments that couldn't be read, and why: tried again on the next pull. */
  skippedSegments: Array<{ key: string; reason: string }>;
  blobs: { downloaded: number; bytes: number };
  /** Index segments read this time. */
  segments: number;
  /** Runs in the store, as far as this machine knows. */
  inStore: number;
  /** Pulled runs by who made them. */
  byAuthor: Record<string, number>;
  /** The fixes that came with them (fix-sync.ts); none from a pull request's folder. */
  fixes: FixPullResult;
}

const BLOB_HEAD_OVER = 64 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
/** The name a push gives an index segment: index/ and its id (newSegmentId), a ULID. */
const SEGMENT_KEY = /^index\/[0-9A-HJKMNP-TV-Z]{26}\.json$/;
const CALLS_MAX_GZ = 256 * 1024 * 1024;

function now(ctx: SyncContext): number {
  return ctx.now?.() ?? Date.now();
}

/** What this machine keeps about the store under: its identity (storeKey). */
function remoteId(ctx: SyncContext): string {
  return storeKey(ctx.remote.location);
}

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

/** A problem with one run's data, as opposed to the store or the network: the others go on. */
function isRunProblem(err: unknown): boolean {
  return err instanceof LayoutError || (err instanceof StoreError && err.code === 'too-large');
}

/** Whether the bucket's index lists a run for the team: it was pulled from the index, or a push indexed it. */
export function teamRunInStore(row: TeamRunRow): boolean {
  return row.state !== 'queued' && row.remoteHash !== null;
}

/** Every blob a run's calls need: what they point at, and the parts of each chunked model request. */
export function runBlobs(store: StoreOf<'recording'>, calls: readonly CallRecord[]): string[] {
  const out = new Set<string>();
  for (const c of calls) {
    for (const h of callRefs(c)) out.add(h);
    if (c.kind === 'api' && c.requestRef) for (const h of manifestRefs(store, c.requestRef)) if (HEX64.test(h)) out.add(h);
  }
  return [...out];
}

/**
 * The run an attempt is filed under (the run it replayed), as the Runs page files it, or null for
 * a run that is no attempt. The fork blame rescued a run with is a probe that shows as a fork.
 */
export function attemptOfRun(store: StoreOf<'recording'>, run: RunRecord): string | null {
  const parent = run.parentRunId ? store.getRun(run.parentRunId) : null;
  return classifyRun(run, { rescued: parent?.meta?.blame?.rescuedRunId === run.runId }).attemptOf;
}

export function indexEntry(run: RunRecord, calls: number, hash: string, attemptOf: string | null = null): IndexEntry {
  return {
    runId: run.runId,
    parentRunId: run.parentRunId,
    mode: run.mode,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    author: run.meta?.author ?? null,
    codeVersion: run.codeVersion,
    ci: run.meta?.ci ?? null,
    labels: run.meta?.labels ?? [],
    calls,
    metaHash: hash,
    ...(attemptOf ? { attemptOf } : {}),
  };
}

/** Gives this machine's copy of a run the synced metadata agreed with the store, when it differs. */
function applySynced(store: StoreOf<'recording'>, run: RunRecord, synced: SharedMeta): void {
  if (metaHash(run.meta) !== metaHash(synced)) store.updateRunMeta(run.runId, syncedPatch(synced));
}

// ---------------------------------------------------------------------------------------------- push

/**
 * Puts a run's blobs in the bucket, each once. `known` holds what this push already put there or saw
 * there. This machine's record of blobs it pushed before (team_blobs) saves sending them again, but
 * is never trusted as proof they are still there: a retention rule, a person or an emptied bucket may
 * have removed one since, and a run uploaded without its blobs is one nobody can pull. So a blob
 * remembered as pushed, or one too large to send blind, is asked about first (a HEAD); any other is
 * sent with a write that only lands when the bucket doesn't have it yet.
 */
async function uploadBlobs(ctx: SyncContext, hashes: readonly string[], known: Set<string>, tally: PushResult['blobs'], askAll = false): Promise<void> {
  const todo = [...new Set(hashes)].filter((h) => !known.has(h));
  const remembered = ctx.store.knownTeamBlobs(remoteId(ctx), todo);
  const fresh: string[] = [];
  try {
    await eachLimit(todo, ctx.concurrency ?? 8, async (hash) => {
      const size = ctx.store.blobSize(hash);
      if (size === null) throw new StoreError('service', `blob ${hash} is missing from this machine's store`);
      if ((askAll || remembered.has(hash) || size > BLOB_HEAD_OVER) && (await ctx.remote.head(keys.blob(hash)))) {
        tally.present++;
      } else {
        // Read only when it has to go up: a blob the bucket has is never loaded.
        const gz = gzipSync(ctx.store.getBlob(hash)!);
        try {
          await ctx.remote.put(keys.blob(hash), gz, { ifNoneMatch: true, contentType: 'application/gzip' });
          tally.uploaded++;
          tally.bytes += gz.length;
        } catch (err) {
          if (!isPrecondition(err)) throw err;
          tally.present++;
        }
      }
      known.add(hash);
      fresh.push(hash);
    });
  } finally {
    // What made it up is known to be there, even when another blob failed.
    ctx.store.addTeamBlobs(remoteId(ctx), fresh);
  }
}

/**
 * Why this machine's copy of a run can't go up whole, or null: a blob its calls need is missing here
 * (cleaned up, or never brought), or is larger than a pull reads.
 */
function localProblem(ctx: SyncContext, calls: readonly CallRecord[], blobs: readonly string[]): string | null {
  if (calls.length > PACK_LIMITS.calls) return `it has ${calls.length} calls, over the ${PACK_LIMITS.calls} a pull reads`;
  const absent: string[] = [];
  for (const h of blobs) {
    const size = ctx.store.blobSize(h);
    if (size === null) absent.push(h);
    else if (size > PACK_LIMITS.blobBytes) return `blob ${h} is ${size} bytes, over the ${PACK_LIMITS.blobBytes} a pull reads`;
  }
  return absent.length ? `this machine's copy is missing ${absent.length === 1 ? 'blob' : `${absent.length} blobs, such as`} ${absent[0]!}` : null;
}

type PushOutcome =
  | { kind: 'pushed' | 'updated' | 'unchanged'; entry: IndexEntry; index: boolean; repaired: boolean }
  | { kind: 'refused'; reason: string };

/**
 * A run's calls as `shadowlap pack` writes them, gzipped, from the calls a push sends
 * (credentialFreeCalls): as recorded, but for a credential a recording made before it was known to be
 * one kept, in a call's metadata (a model call's query, a response header) or a captured call's
 * body, which never goes up.
 */
function callsFile(calls: readonly CallRecord[]): { lines: Buffer; gz: Buffer } {
  const lines = Buffer.from(calls.map((c) => JSON.stringify(c)).join('\n') + (calls.length ? '\n' : ''), 'utf8');
  return { lines, gz: gzipSync(lines) };
}

/**
 * For a run named on the command line that the store has already: sends again whatever of it the
 * bucket lost (its calls, a blob), asking about each first. A retention rule that removes old
 * blobs takes them from every newer run that shares one; whoever has the run mends it by pushing it
 * by name. Ancestors pushed along with a run, and runs pushed by --all, aren't checked this way.
 */
async function repairParts(ctx: SyncContext, run: RunRecord, known: Set<string>, tally: PushResult['blobs']): Promise<boolean> {
  const calls = credentialFreeCalls(ctx.store, ctx.store.getCalls(run.runId));
  const blobs = runBlobs(ctx.store, calls);
  if (localProblem(ctx, calls, blobs)) return false; // this machine's copy can't mend it
  let sent = false;
  if (!(await ctx.remote.head(keys.calls(run.runId)))) {
    await ctx.remote.put(keys.calls(run.runId), callsFile(calls).gz, { contentType: 'application/gzip' });
    sent = true;
  }
  const before = tally.uploaded;
  await uploadBlobs(ctx, blobs, known, tally, true);
  return sent || tally.uploaded > before;
}

/**
 * Whether the store's copy of a run was sent before the run had finished being written, as the
 * index lists it: interrupted, with fewer calls than this machine's copy holds now that it has
 * ended. An older push took an import of old captures for a run its process had left, ended it as
 * interrupted and sent what was written so far; the import then went on and finished here.
 */
function cutShort(store: StoreOf<'recording'>, run: RunRecord, row: TeamRunRow | null): boolean {
  const entry = row?.entry as Partial<IndexEntry> | null | undefined;
  if (run.status === 'running' || entry?.status !== 'crashed' || typeof entry.calls !== 'number') return false;
  return store.countCalls(run.runId) > entry.calls;
}

/**
 * Sends a run cut short in the store whole again (cutShort): its calls, then its record with this
 * machine's status, end and call count, over the store's copy only while that copy still lists
 * fewer calls as interrupted. Returns the store's new copy, or null when there was nothing to mend.
 * `there` is the store's copy as the push just read it: one that isn't cut short costs nothing more.
 */
async function mendCutShort(ctx: SyncContext, run: RunRecord, there: StoredRunDoc, known: Set<string>, tally: PushResult['blobs']): Promise<StoredRunDoc | null> {
  const held = ctx.store.countCalls(run.runId);
  const short = (doc: StoredRunDoc) => run.status !== 'running' && doc.run.status === 'crashed' && doc.calls < held;
  if (!short(there)) return null;
  const calls = credentialFreeCalls(ctx.store, ctx.store.getCalls(run.runId));
  const blobs = runBlobs(ctx.store, calls);
  if (localProblem(ctx, calls, blobs)) return null; // this machine's copy can't mend it
  const { lines, gz } = callsFile(calls);
  if (lines.length > PACK_LIMITS.callsBytes || gz.length > CALLS_MAX_GZ) return null;
  let sent = false;
  for (let attempt = 0; ; attempt++) {
    // Read again for its version: the record goes over the store's copy only while that is still cut short.
    const got = await ctx.remote.get(keys.run(run.runId), { maxBytes: PACK_LIMITS.manifestBytes });
    if (!got) return null;
    const current = parseRunDoc(got.body, run.runId);
    if (!short(current) || current.calls >= calls.length) return null;
    const next: StoredRunDoc = { ...current, run: { ...current.run, status: run.status, endedAt: run.endedAt, divergence: run.divergence }, calls: calls.length, pushedAt: now(ctx), pushedBy: ctx.actor };
    if (storeProblem(next.run, calls)) return null;
    if (!sent) {
      await uploadBlobs(ctx, blobs, known, tally, true);
      await ctx.remote.put(keys.calls(run.runId), gz, { contentType: 'application/gzip' });
      sent = true;
    }
    try {
      await ctx.remote.put(keys.run(run.runId), json(next), { contentType: 'application/json', ...(got.version ? { ifMatch: got.version } : {}) });
      return next;
    } catch (err) {
      if (!isPrecondition(err) || attempt >= 3) throw err;
    }
  }
}

type Written = { doc: StoredRunDoc; synced: SharedMeta; fresh: boolean; wrote: boolean } | { refused: string };

/** Puts a run in the bucket: whole when it isn't there, or its synced metadata merged into the store's copy. */
async function writeRun(ctx: SyncContext, run: RunRecord, row: TeamRunRow | null, known: Set<string>, tally: PushResult['blobs']): Promise<Written> {
  let existing = await ctx.remote.get(keys.run(run.runId), { maxBytes: PACK_LIMITS.manifestBytes });
  if (!existing) {
    const calls = credentialFreeCalls(ctx.store, ctx.store.getCalls(run.runId));
    // Its command line without the credentials a flag or an argument carried, as a pack writes it (credentialFreeArgv).
    const first: StoredRunDoc = { format: RUN_FORMAT, version: LAYOUT_VERSION, run: { ...run, command: { ...run.command, argv: [...credentialFreeArgv(run.command.argv)] }, divergence: run.divergence && { ...run.divergence, name: credentialFreeCallName(run.divergence.name) }, meta: sharedMeta(run.meta) }, calls: calls.length, pushedAt: now(ctx), pushedBy: ctx.actor };
    const blobs = runBlobs(ctx.store, calls);
    const problem = storeProblem(first.run, calls) ?? localProblem(ctx, calls, blobs);
    if (problem) return { refused: problem };
    const doc = json(first);
    const { lines, gz } = callsFile(calls);
    // What a pull would refuse as too large is never sent.
    if (doc.length > PACK_LIMITS.manifestBytes) return { refused: `its run.json would be ${doc.length} bytes, over the ${PACK_LIMITS.manifestBytes} a pull reads` };
    if (lines.length > PACK_LIMITS.callsBytes || gz.length > CALLS_MAX_GZ) return { refused: `its calls would be ${lines.length} bytes, over what a pull reads` };
    await uploadBlobs(ctx, blobs, known, tally);
    await ctx.remote.put(keys.calls(run.runId), gz, { contentType: 'application/gzip' });
    try {
      await ctx.remote.put(keys.run(run.runId), doc, { ifNoneMatch: true, contentType: 'application/json' });
      return { doc: first, synced: syncedMeta(first.run.meta), fresh: true, wrote: true };
    } catch (err) {
      if (!isPrecondition(err)) throw err;
      // There already: someone pushed the same run a moment ago, or this push's own write landed
      // before a retry of it. Merge with what is there.
      existing = await ctx.remote.get(keys.run(run.runId), { maxBytes: PACK_LIMITS.manifestBytes });
      if (!existing) throw err;
    }
  }
  for (let attempt = 0; ; attempt++) {
    let there: StoredRunDoc;
    try {
      there = parseRunDoc(existing.body, run.runId);
    } catch (err) {
      if (err instanceof LayoutError) return { refused: `the store's copy can't be read: ${err.message}` };
      throw err;
    }
    const merged = reconcile(run.meta, there.run.meta, row?.base ?? null, madeHere(run.meta));
    if (metaHash(merged) === metaHash(there.run.meta)) return { doc: there, synced: merged, fresh: false, wrote: false };
    const next: StoredRunDoc = { ...there, run: { ...there.run, meta: withSynced(there.run.meta, merged) }, pushedAt: now(ctx), pushedBy: ctx.actor };
    const problem = storeProblem(next.run, []);
    if (problem) return { refused: problem };
    try {
      await ctx.remote.put(keys.run(run.runId), json(next), { contentType: 'application/json', ...(existing.version ? { ifMatch: existing.version } : {}) });
      return { doc: next, synced: merged, fresh: false, wrote: true };
    } catch (err) {
      if (!isPrecondition(err) || attempt >= 3) throw err;
      existing = await ctx.remote.get(keys.run(run.runId), { maxBytes: PACK_LIMITS.manifestBytes });
      if (!existing) throw err;
    }
  }
}

/**
 * Pushes one run. `verify`: the run was named, or is an ancestor of one, so the bucket itself is
 * asked whether it has it, instead of trusting this machine's record of an earlier push (a
 * retention rule or a person may have deleted it since). `repair`: the run itself was named, so
 * the parts of it the bucket lost are sent again too.
 */
async function pushRun(ctx: SyncContext, run: RunRecord, known: Set<string>, tally: PushResult['blobs'], verify: boolean, repair: boolean): Promise<PushOutcome> {
  const rid = remoteId(ctx);
  const row = ctx.store.teamRun(rid, run.runId);
  // What of this copy would go up: a result this machine made of a run made elsewhere never does.
  const localHash = metaHash(asTheStoreHolds(run.meta, row?.base ?? null, madeHere(run.meta)));
  const cut = cutShort(ctx.store, run, row);
  if (!verify && !cut && row && (row.state === 'pushed' || row.state === 'pulled') && row.baseHash === localHash && row.remoteHash === localHash) {
    return { kind: 'unchanged', entry: (row.entry as unknown as IndexEntry | null) ?? indexEntry(run, ctx.store.countCalls(run.runId), localHash, attemptOfRun(ctx.store, run)), index: false, repaired: false };
  }
  const written = await writeRun(ctx, run, row, known, tally);
  if ('refused' in written) return { kind: 'refused', reason: written.refused };
  const { synced, fresh, wrote } = written;
  let { doc } = written;
  let repaired = repair && !fresh ? await repairParts(ctx, run, known, tally) : false;
  // Sent before it had finished being written: sent whole now, and listed again with its calls.
  const mended = !fresh && (cut || repair) ? await mendCutShort(ctx, run, doc, known, tally) : null;
  if (mended) {
    doc = mended;
    repaired = true;
  }
  const hash = metaHash(synced);
  // Not listed by any index this machine knows of, or listed as it was before: the index gets an entry.
  const unindexed = !row || row.remoteHash === null;
  const index = fresh || unindexed || row.remoteHash !== hash || mended !== null;
  const entry = indexEntry(doc.run, doc.calls, hash, attemptOfRun(ctx.store, run));
  ctx.store.transaction(() => {
    // Read again after the round trip, under the write lock: a label or note added meanwhile is
    // merged with what the store now holds instead of written over, and, differing from the base,
    // goes up with the next push.
    const current = ctx.store.getRun(run.runId);
    if (current) {
      const origin = madeHere(current.meta);
      applySynced(ctx.store, current, keptHere(current.meta, reconcile(current.meta, synced, syncedMeta(run.meta), origin), row?.base ?? null, origin));
    }
    // What both sides now agree on is the base of the next merge. remoteHash stays what the index
    // lists, so until push() has written the segment this run counts as not yet in the store.
    ctx.store.setTeamRun(rid, {
      runId: run.runId,
      state: row?.state === 'pulled' ? 'pulled' : 'pushed',
      at: now(ctx),
      base: synced,
      baseHash: hash,
      remoteHash: fresh ? null : (row?.remoteHash ?? null),
      entry: entry as unknown as Record<string, unknown>,
    });
  });
  const kind = fresh || (index && unindexed) ? 'pushed' : wrote || index ? 'updated' : 'unchanged';
  return { kind, entry, index, repaired };
}

function withAncestors(store: StoreOf<'recording'>, runId: string): RunRecord[] {
  const out: RunRecord[] = [];
  let run = store.getRun(runId);
  while (run && out.length < 64) {
    out.unshift(run);
    run = run.parentRunId ? store.getRun(run.parentRunId) : null;
  }
  return out;
}

/** Writes an index segment listing these entries, and records that the index has them. */
async function writeSegment(ctx: SyncContext, entries: readonly IndexEntry[]): Promise<string> {
  const rid = remoteId(ctx);
  const at = now(ctx);
  const key = keys.segment(newSegmentId(at));
  const segment: IndexSegment = { format: INDEX_FORMAT, version: LAYOUT_VERSION, at, by: ctx.actor, runs: [...entries] };
  try {
    await ctx.remote.put(key, json(segment), { contentType: 'application/json', ifNoneMatch: true });
  } catch (err) {
    // The key is this push's own: it exists only if a retried write already landed.
    if (!isPrecondition(err)) throw err;
  }
  ctx.store.addTeamSegments(rid, [key], at);
  ctx.store.transaction(() => {
    for (const e of entries) {
      const row = ctx.store.teamRun(rid, e.runId);
      if (row) ctx.store.setTeamRun(rid, { ...row, remoteHash: e.metaHash });
    }
  });
  return key;
}

/**
 * Pushes runs to the store. A run without an author is given the pusher's: runs in a local store
 * were made on this machine. Runs queued earlier go too, once they have ended. When a run fails
 * part way, the runs already uploaded are still indexed before the error is thrown.
 */
export async function push(ctx: SyncContext, options: PushOptions): Promise<PushResult> {
  const rid = remoteId(ctx);
  const store = ctx.store;
  const targets = new Map<string, RunRecord>();
  const named = new Set<string>();
  const direct = new Set(options.runIds ?? []);
  if (options.all) for (const r of store.allRuns()) targets.set(r.runId, r);
  for (const id of options.runIds ?? []) {
    for (const r of withAncestors(store, id)) {
      targets.set(r.runId, r);
      named.add(r.runId);
    }
  }
  // Runs queued while they recorded go too, with their lineage. One deleted since goes nowhere: its
  // row goes, so nothing counts it as still recording.
  for (const row of store.teamRuns(rid)) {
    if (row.state !== 'queued') continue;
    if (!store.getRun(row.runId)) {
      store.deleteTeamRun(rid, row.runId);
      continue;
    }
    for (const r of withAncestors(store, row.runId)) targets.set(r.runId, r);
  }
  const result: PushResult = { pushed: [], updated: [], unchanged: [], queued: [], repaired: [], refused: [], blobs: { uploaded: 0, present: 0, bytes: 0 }, segment: null, fixes: { sent: [], failed: [], repairs: [] } };
  const known = new Set<string>();
  const entries: IndexEntry[] = [];
  const refused = new Set<string>();
  const ordered = [...targets.values()].sort((a, b) => a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : 1));
  let failure: { error: unknown } | null = null;
  for (const target of ordered) {
    let run = store.getRun(target.runId);
    if (!run) continue; // deleted since the list was read
    if (run.status === 'running') {
      const row = store.teamRun(rid, run.runId);
      if (!row || row.state === 'queued') {
        store.setTeamRun(rid, { runId: run.runId, state: 'queued', at: now(ctx), base: null, baseHash: null, remoteHash: null, entry: null });
        result.queued.push(run.runId);
      }
      continue;
    }
    // A run pulled from a pull request's folder never goes into the store's own runs: --all leaves
    // it out quietly, and one named (or the parent of one named) is refused, saying why.
    const fromPr = run.meta?.imported?.pr;
    if (fromPr && !ctx.pullRequest) {
      refused.add(run.runId);
      if (named.has(run.runId)) result.refused.push({ runId: run.runId, reason: `it came from pull request ${fromPr}'s folder in the store, and a pull request's runs stay out of the team's` });
      continue;
    }
    if (run.parentRunId && refused.has(run.parentRunId)) {
      // A fork goes with its lineage or not at all.
      refused.add(run.runId);
      result.refused.push({ runId: run.runId, reason: `its parent ${run.parentRunId} can't go to the store` });
      continue;
    }
    // A run made on this machine before authors were kept is the pusher's; in CI, with the provider.
    // One that came from a pack or the store is someone else's: it keeps the author it came with, or none.
    if (!run.meta?.imported) {
      const author = run.meta?.author ?? ctx.actor;
      const stamp: Partial<NonNullable<RunRecord['meta']>> = {
        ...(!run.meta?.author && ctx.actor ? { author: ctx.actor } : {}),
        ...(author === 'ci' && !run.meta?.ci && ctx.ci ? { ci: ctx.ci } : {}),
      };
      if (Object.keys(stamp).length) {
        store.updateRunMeta(run.runId, stamp);
        run = store.getRun(run.runId)!;
      }
    }
    let outcome: PushOutcome;
    try {
      outcome = await pushRun(ctx, run, known, result.blobs, named.has(run.runId), direct.has(run.runId));
    } catch (error) {
      failure = { error };
      break;
    }
    if (outcome.kind === 'refused') {
      refused.add(run.runId);
      result.refused.push({ runId: run.runId, reason: outcome.reason });
      ctx.log?.(`not pushed ${run.runId}: ${outcome.reason}`);
      // Said once: a run that can't go isn't kept waiting for every later push.
      if (store.teamRun(rid, run.runId)?.state === 'queued') store.deleteTeamRun(rid, run.runId);
      continue;
    }
    result[outcome.kind].push(run.runId);
    if (outcome.repaired) result.repaired.push(run.runId);
    if (outcome.index) entries.push(outcome.entry);
    if (outcome.kind !== 'unchanged') ctx.log?.(`${outcome.kind} ${run.runId}`);
    if (outcome.repaired) ctx.log?.(`sent again what the store had lost of ${run.runId}`);
  }
  // Index what went up, even when a later run failed: a run no index lists is one nobody can pull.
  if (entries.length) {
    try {
      result.segment = await writeSegment(ctx, entries);
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
  // The fixes about the runs in the store go with them; a pull request's job sends none.
  if (!ctx.pullRequest) result.fixes = await pushFixes(ctx);
  for (const f of result.fixes.sent) ctx.log?.(`sent fix ${f}`);
  store.setTeamSync(rid, { pushedAt: now(ctx) });
  return result;
}

/** Runs queued while recording that have ended since: what the next push will send. */
export function queuedRuns(store: StoreOf<'recording' | 'team'>, remote: string): { ready: string[]; recording: string[] } {
  const ready: string[] = [];
  const recording: string[] = [];
  for (const row of store.teamRuns(remote)) {
    if (row.state !== 'queued') continue;
    const run = store.getRun(row.runId);
    if (!run) continue;
    (run.status === 'running' ? recording : ready).push(run.runId);
  }
  return { ready, recording };
}

// ---------------------------------------------------------------------------------------------- pull

async function readIndex(ctx: SyncContext): Promise<{ segments: number; skipped: PullResult['skippedSegments'] }> {
  const rid = remoteId(ctx);
  const seen = ctx.store.seenTeamSegments(rid);
  const fresh: string[] = [];
  const done: string[] = [];
  const skipped: PullResult['skippedSegments'] = [];
  for await (const o of ctx.remote.list(keys.segments)) {
    if (!o.key.endsWith('.json') || seen.has(o.key)) continue;
    // Only a name a push writes is read: anyone who can write to the bucket names its objects, and
    // one named index/../../x.json would reach outside the store's folder. Said once.
    if (SEGMENT_KEY.test(o.key)) fresh.push(o.key);
    else {
      done.push(o.key);
      skipped.push({ key: o.key, reason: `isn't the name a push gives an index segment (index/<id>.json), so it isn't read` });
    }
  }
  fresh.sort();
  const segments = new Array<IndexSegment | null>(fresh.length).fill(null);
  await eachLimit(fresh, ctx.concurrency ?? 8, async (key, i) => {
    const got = await ctx.remote.get(key, { maxBytes: 64 * 1024 * 1024 });
    if (!got) {
      done.push(key); // deleted since it was listed: nothing to read again
      return;
    }
    try {
      segments[i] = parseSegment(got.body, key);
      done.push(key);
    } catch (err) {
      // Not marked as read: a segment a newer Shadowlap wrote is read once this one is updated.
      skipped.push({ key, reason: (err as Error).message });
      ctx.log?.(`skipped ${key}: ${(err as Error).message}`);
    }
  });
  const latest = new Map<string, IndexEntry>();
  for (const s of segments) for (const e of s?.runs ?? []) latest.set(e.runId, e);
  const at = now(ctx);
  ctx.store.transaction(() => {
    for (const [runId, entry] of latest) {
      const row = ctx.store.teamRun(rid, runId);
      const e = entry as unknown as Record<string, unknown>;
      ctx.store.setTeamRun(rid, row ? { ...row, remoteHash: entry.metaHash, entry: e } : { runId, state: 'listed', at, base: null, baseHash: null, remoteHash: entry.metaHash, entry: e });
    }
  });
  ctx.store.addTeamSegments(rid, done, at);
  return { segments: done.length, skipped: skipped.sort((a, b) => (a.key < b.key ? -1 : 1)) };
}

function gunzipCapped(bytes: Buffer, max: number, what: string): Buffer {
  try {
    return gunzipSync(bytes, { maxOutputLength: max });
  } catch (err) {
    throw new LayoutError(`${what} can't be read: ${(err as Error).message}`);
  }
}

async function downloadBlobs(ctx: SyncContext, runId: string, hashes: readonly string[], tally: PullResult['blobs']): Promise<void> {
  const missing = [...new Set(hashes)].filter((h) => HEX64.test(h) && !ctx.store.hasBlob(h));
  await eachLimit(missing, ctx.concurrency ?? 8, async (hash) => {
    const got = await ctx.remote.get(keys.blob(hash), { maxBytes: PACK_LIMITS.blobBytes });
    if (!got) throw new LayoutError(`blob ${hash} is listed by the run but isn't in the store; whoever has the run can send it again with shadowlap push ${runId}`);
    const bytes = gunzipCapped(got.body, PACK_LIMITS.blobBytes, `blobs/${hash}`);
    if (sha256(bytes) !== hash) throw new LayoutError(`blobs/${hash} doesn't match its hash: it was changed in the store`);
    ctx.store.putBlob(bytes);
    tally.downloaded++;
    tally.bytes += got.body.length;
  });
}

/** Downloads one run whole, checks it, and imports it. */
async function pullRun(ctx: SyncContext, runId: string, tally: PullResult['blobs']): Promise<StoredRunDoc | null> {
  const got = await ctx.remote.get(keys.run(runId), { maxBytes: PACK_LIMITS.manifestBytes });
  if (!got) return null;
  const doc = parseRunDoc(got.body, runId);
  const gz = await ctx.remote.get(keys.calls(runId), { maxBytes: CALLS_MAX_GZ });
  if (!gz) throw new LayoutError(`runs/${runId}/calls.jsonl.gz is missing; whoever has the run can send it again with shadowlap push ${runId}`);
  const text = gunzipCapped(gz.body, PACK_LIMITS.callsBytes, `runs/${runId}/calls.jsonl.gz`).toString('utf8');
  const calls: CallRecord[] = [];
  const seen = new Set<number>();
  for (const [i, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new LayoutError(`runs/${runId}/calls.jsonl.gz line ${i + 1} isn't JSON`);
    }
    let call: CallRecord;
    try {
      call = validateCall(parsed, `runs/${runId}/calls.jsonl.gz line ${i + 1}`);
    } catch (err) {
      throw new LayoutError((err as Error).message);
    }
    if (call.runId !== runId) throw new LayoutError(`runs/${runId}/calls.jsonl.gz line ${i + 1} belongs to another run`);
    if (seen.has(call.callNo)) throw new LayoutError(`runs/${runId}/calls.jsonl.gz has call #${call.callNo} twice`);
    seen.add(call.callNo);
    calls.push(call);
    if (calls.length > PACK_LIMITS.calls) throw new LayoutError(`runs/${runId} has more than ${PACK_LIMITS.calls} calls`);
  }
  // Direct references first, then what each request's manifest lists, as a pack's reader brings a
  // request (bringRequest): a version 2 manifest names its items through runs, which list them only
  // once they are here, so the manifests are read again until they list nothing new.
  await downloadBlobs(ctx, runId, calls.flatMap((c) => callRefs(c)), tally);
  const listed = new Set<string>();
  for (;;) {
    const more = calls.flatMap((c) => (c.kind === 'api' && c.requestRef ? manifestRefs(ctx.store, c.requestRef) : [])).filter((h) => !listed.has(h));
    if (!more.length) break;
    for (const h of more) listed.add(h);
    await downloadBlobs(ctx, runId, more, tally);
  }
  for (const c of calls) {
    for (const h of callRefs(c)) if (!ctx.store.hasBlob(h)) throw new LayoutError(`call #${c.callNo} of ${runId} needs blob ${h}, which the store doesn't have`);
    if (c.kind === 'api' && c.requestRef) {
      for (const h of manifestRefs(ctx.store, c.requestRef)) if (!ctx.store.hasBlob(h)) throw new LayoutError(`the request of call #${c.callNo} of ${runId} needs blob ${h}, which the store doesn't have`);
      try {
        loadApiRequest(ctx.store, c.requestRef);
      } catch (err) {
        throw new LayoutError(`the request of call #${c.callNo} of ${runId} can't be read: ${(err as Error).message}`);
      }
    }
  }
  const shared = sharedMeta(doc.run.meta);
  ctx.store.transaction(() => {
    const held = ctx.store.getRun(runId);
    // A copy a pull request's folder brought makes way for the store's own, whole: a run the store
    // holds comes from its own folder, and nothing a pull request's job wrote stays in it.
    const replace = held !== null && !ctx.pullRequest && Boolean(held.meta?.imported?.pr);
    if (held && !replace) return;
    // Replaying a pulled run runs a command someone else recorded: it is marked as imported, so replay
    // asks first. The mark names the store's URL, which is what tells a pulled run from a pack
    // (`pulledRun`): it reads as its author's recording, with what it spent. One from a pull request's
    // folder is marked as that pull request's, so no push takes it into the store's own runs.
    const imported = { at: now(ctx), from: ctx.remote.location.url, ...(ctx.pullRequest ? { pr: ctx.pullRequest } : {}) };
    // No process here records it: one marked running comes in as interrupted (asImportedRun).
    const copy = { ...asImportedRun(doc.run, calls), meta: { ...(shared as RunRecord['meta'] & object), imported } };
    if (replace) ctx.store.replaceRun(copy);
    else ctx.store.importRun(copy);
    for (const call of calls) {
      const { end, attempts, ...start } = call;
      ctx.store.appendCallStart(start);
      const identity = { kind: call.kind, name: call.name, fingerprint: call.fingerprint, occurrence: call.occurrence };
      for (const a of attempts) ctx.store.appendCallEnd(identity, a);
      if (end) ctx.store.appendCallEnd(identity, end);
    }
  });
  const synced = syncedMeta(doc.run.meta);
  const hash = metaHash(synced);
  const row = ctx.store.teamRun(remoteId(ctx), runId);
  ctx.store.setTeamRun(remoteId(ctx), { runId, state: 'pulled', at: now(ctx), base: synced, baseHash: hash, remoteHash: row?.remoteHash ?? hash, entry: row?.entry ?? (indexEntry(doc.run, calls.length, hash, attemptOfRun(ctx.store, doc.run)) as unknown as Record<string, unknown>) });
  return doc;
}

/** Merges the store's newer labels, notes and results for a run that is here into this machine's copy. */
async function mergeRun(ctx: SyncContext, row: TeamRunRow): Promise<'merged' | 'needs-push' | 'same' | 'missing'> {
  if (!ctx.store.getRun(row.runId)) return 'missing';
  const got = await ctx.remote.get(keys.run(row.runId), { maxBytes: PACK_LIMITS.manifestBytes });
  if (!got) return 'missing';
  const doc = parseRunDoc(got.body, row.runId);
  const remote = syncedMeta(doc.run.meta);
  const remoteHash = metaHash(remote);
  // This machine's copy is read after the round trip, under the write lock: a label or note added
  // while the store's copy was on its way is in it, so it is merged, not written over, and, as it
  // differs from the store's, the next push sends it.
  return ctx.store.transaction(() => {
    const run = ctx.store.getRun(row.runId);
    if (!run) return 'missing';
    const rid = remoteId(ctx);
    const current = ctx.store.teamRun(rid, row.runId) ?? row;
    const origin = madeHere(run.meta);
    const merged = reconcile(run.meta, doc.run.meta, current.base, origin);
    const kept = keptHere(run.meta, merged, current.base, origin);
    const before = metaHash(run.meta);
    applySynced(ctx.store, run, kept);
    // The store's copy is the new base. remoteHash stays what the index lists: when the index is behind
    // the copy (a push cut short before its segment), this machine's next push lists it again.
    ctx.store.setTeamRun(rid, { ...current, state: current.state === 'listed' ? 'pulled' : current.state, at: now(ctx), base: remote, baseHash: remoteHash });
    if (metaHash(merged) !== remoteHash) return 'needs-push';
    return metaHash(kept) === before ? 'same' : 'merged';
  });
}

/**
 * Pulls the store's runs that aren't here, and merges labels, notes and results that changed on
 * runs that are. A run that can't be read is reported and skipped, with any fork of it, and the
 * others come anyway: one bad object in the bucket never stops the team's pulls. From a pull
 * request's folder (`ctx.pullRequest`) only runs that aren't here come, and nothing is merged.
 */
export async function pull(ctx: SyncContext, options: PullOptions = {}): Promise<PullResult> {
  const rid = remoteId(ctx);
  const store = ctx.store;
  const { segments, skipped } = await readIndex(ctx);
  const rows = new Map(store.teamRuns(rid).map((r) => [r.runId, r]));
  const result: PullResult = { pulled: [], merged: [], needPush: [], skippedDeleted: [], missing: [], unknown: [], failed: [], skippedSegments: skipped, blobs: { downloaded: 0, bytes: 0 }, segments, inStore: 0, byAuthor: {}, fixes: { pulled: [], merged: [], failed: [], repairs: [] } };

  const excluded = options.exclude ?? new Set<string>();
  // A run here that a pull request's folder brought is the store's to replace, once the store's own
  // runs list it (pullRun): a run in both comes from the store's own folder.
  const fromPr = (id: string) => !ctx.pullRequest && Boolean(store.getRun(id)?.meta?.imported?.pr);
  const here = (id: string) => store.getRun(id) !== null && !fromPr(id);
  const wanted = new Set<string>();
  if (options.runIds?.length) {
    // A run id or a unique prefix of one, as the store's index lists them.
    for (const raw of options.runIds) {
      const name = raw.trim().toUpperCase();
      const matches = isRunId(name) && rows.has(name) ? [name] : name.length >= 4 ? [...rows.keys()].filter((k) => k.startsWith(name)) : [];
      if (matches.length !== 1) result.unknown.push(raw);
      else if (!here(matches[0]!) && !excluded.has(matches[0]!)) wanted.add(matches[0]!);
    }
  } else {
    for (const row of rows.values()) {
      if (here(row.runId) || excluded.has(row.runId)) continue;
      if (row.state === 'listed' || fromPr(row.runId)) wanted.add(row.runId);
      else if (row.state === 'pushed' || row.state === 'pulled') result.skippedDeleted.push(row.runId);
    }
  }
  // A fork comes with its ancestors, so its lineage holds here too; an ancestor never taken from
  // here comes from where it belongs first. One deleted here stays deleted unless it was named: the
  // fork comes without it, its link unset, as unpack brings a fork whose parent isn't there.
  const named = new Set(wanted);
  const deletedHere = (id: string) => {
    const state = rows.get(id)?.state;
    return (state === 'pushed' || state === 'pulled') && store.getRun(id) === null;
  };
  const parentOf = (id: string) => (rows.get(id)?.entry?.parentRunId as string | null | undefined) ?? null;
  const childrenOf = new Map<string, string[]>();
  for (const id of rows.keys()) {
    const parent = parentOf(id);
    if (!parent) continue;
    const siblings = childrenOf.get(parent);
    if (siblings) siblings.push(id);
    else childrenOf.set(parent, [id]);
  }
  const elsewhere = new Set<string>();
  for (const id of [...wanted]) {
    let parent = parentOf(id);
    for (let depth = 0; parent && depth < 64; depth++) {
      if (here(parent) || !rows.has(parent)) break;
      if (deletedHere(parent) && !named.has(parent)) break;
      if (excluded.has(parent)) {
        elsewhere.add(parent);
        break;
      }
      wanted.add(parent);
      parent = parentOf(parent);
    }
  }
  if (elsewhere.size && options.fetchExcluded) await options.fetchExcluded([...elsewhere].sort());
  const startedAt = (id: string) => Number(rows.get(id)?.entry?.startedAt ?? 0);
  const failed = new Set<string>();
  for (const id of [...wanted].sort((a, b) => startedAt(a) - startedAt(b) || (a < b ? -1 : 1))) {
    const parent = parentOf(id);
    if (parent && failed.has(parent)) {
      failed.add(id);
      result.failed.push({ runId: id, reason: `its parent ${parent} couldn't be pulled` });
      continue;
    }
    let doc: StoredRunDoc | null;
    try {
      doc = await pullRun(ctx, id, result.blobs);
    } catch (err) {
      if (!isRunProblem(err)) throw err;
      failed.add(id);
      result.failed.push({ runId: id, reason: (err as Error).message });
      ctx.log?.(`couldn't pull ${id}: ${(err as Error).message}`);
      continue;
    }
    if (!doc) {
      // The index is written after the run, so a listed run that isn't there was deleted from the bucket.
      store.deleteTeamRun(rid, id);
      result.missing.push(id);
      continue;
    }
    result.pulled.push(id);
    // A run here that came without it (deleted here when the run came, then named) links to it again,
    // as the store's index links them.
    for (const child of childrenOf.get(id) ?? []) store.linkParent(child, id);
    const who = doc.run.meta?.author ?? 'unknown';
    result.byAuthor[who] = (result.byAuthor[who] ?? 0) + 1;
    ctx.log?.(`pulled ${id}${doc.run.meta?.author ? ` (${doc.run.meta.author})` : ''}`);
  }
  // Runs here whose labels, notes or results changed in the store; a run that came here another way
  // (a pack) and is in the store too is merged the first time a pull meets it. A pull request's
  // folder is written by whoever opened the pull request: what it says about a run here, a golden
  // its job replayed above all, is never taken.
  for (const row of ctx.pullRequest ? [] : store.teamRuns(rid)) {
    if (row.state === 'queued' || !row.remoteHash || row.remoteHash === row.baseHash) continue;
    if (result.pulled.includes(row.runId) || !store.getRun(row.runId)) continue;
    let outcome: Awaited<ReturnType<typeof mergeRun>>;
    try {
      outcome = await mergeRun(ctx, row);
    } catch (err) {
      if (!isRunProblem(err)) throw err;
      result.failed.push({ runId: row.runId, reason: (err as Error).message });
      continue;
    }
    if (outcome === 'merged') result.merged.push(row.runId);
    else if (outcome === 'needs-push') {
      result.merged.push(row.runId);
      result.needPush.push(row.runId);
    } else if (outcome === 'missing') result.missing.push(row.runId);
  }
  result.inStore = store.teamRuns(rid).filter(teamRunInStore).length;
  // The fixes the team made, merged with this machine's; a pull request's folder brings none.
  if (!ctx.pullRequest) result.fixes = await pullFixes(ctx);
  for (const f of result.fixes.pulled) ctx.log?.(`pulled fix ${f}`);
  for (const f of result.fixes.merged) ctx.log?.(`merged fix ${f}`);
  store.setTeamSync(rid, { pulledAt: now(ctx) });
  return result;
}
