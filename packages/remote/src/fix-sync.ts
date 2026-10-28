import { PACK_LIMITS, messageOf } from '@shadowlap/engine';
import { applyFixDoc, fixDocBytes, fixDocHash, fixDocOf, fixKey, FIXES_PREFIX, isFixId, mergeFixDocs, parseFixDoc, type FixDoc } from './fix-doc.js';
import { LayoutError } from './layout.js';
import { isPrecondition, StoreError, type GetResult, type ObjectStore } from './object-store.js';
import { storeKey } from './url.js';
import type { StoreOf } from '@shadowlap/engine';

/**
 * Fixes travel with the team store: every push sends the fixes that changed here, and every pull
 * brings the ones that changed there, so a blame, a repair and its verdicts made on one machine
 * show on a teammate's Fixes page with their three steps. A fix goes with the runs it is about:
 * once one of its failing or good runs is in the store (or the fix went before), never on its own,
 * so a fix about runs kept on this machine stays here too. Copies merge by joining (fix-doc.ts), so
 * a fix worked on from two machines ends up with everything both did.
 *
 * A pull request's CI job sends no fixes and reads none: its folder holds what the pull request
 * says, and a fix decides what the team applies.
 */

export interface FixProblem {
  fixId: string;
  reason: string;
}

export interface FixPushResult {
  /** Fixes written to the store: new there, or with something the store's copy lacked. */
  sent: string[];
  /** Fixes that couldn't go, and why; the next push tries them again. */
  failed: FixProblem[];
  /** Repairs a teammate made that the store's copies brought, whose files the CLI writes beside the project. */
  repairs: string[];
}

export interface FixPullResult {
  /** Fixes new to this machine. */
  pulled: string[];
  /** Fixes here that the store's copy added to. */
  merged: string[];
  /** Fixes in the store that couldn't be read, and why; the next pull tries them again. */
  failed: FixProblem[];
  /** Repairs that came with them, whose files the CLI writes beside the project. */
  repairs: string[];
}

interface FixSyncContext {
  store: StoreOf<'fixes' | 'team'>;
  remote: ObjectStore;
  now?: () => number;
}

const now = (ctx: FixSyncContext) => ctx.now?.() ?? Date.now();

/** A problem with one fix's data, as opposed to the store or the network: the others go on. */
const isFixProblem = (err: unknown) => err instanceof LayoutError || (err instanceof StoreError && err.code === 'too-large');

/** The runs a fix is about: those failing in it, and the good ones its verdicts kept. */
function runsOf(doc: FixDoc): string[] {
  return doc.links.filter((l) => l.kind === 'failing' || l.kind === 'good').map((l) => l.ref);
}

/** The most a fix document may be: what a pull reads of one, as of a run's run.json. */
const FIX_BYTES = PACK_LIMITS.manifestBytes;

/** A fix's object, read with the limit a pull reads it with: one over it is that fix's problem, never the pull's. */
async function readFix(ctx: FixSyncContext, key: string): Promise<GetResult | null> {
  try {
    return await ctx.remote.get(key, { maxBytes: FIX_BYTES });
  } catch (err) {
    if (err instanceof StoreError && err.code === 'too-large') throw new LayoutError(`${key} is over the ${FIX_BYTES} bytes a pull reads (${err.message})`);
    throw err;
  }
}

/**
 * Writes one fix, merged with the store's copy when there is one; 'same' when the store had it all.
 * What the store's copy adds is taken here too: the repairs it brought go into `repairs`.
 */
async function sendFix(ctx: FixSyncContext, rid: string, doc: FixDoc, hash: string, repairs: string[]): Promise<'sent' | 'same'> {
  const key = fixKey(doc.fix.fixId);
  const take = (next: FixDoc) => repairs.push(...applyFixDoc(ctx.store, next, { from: rid, at: now(ctx) }).repairs);
  for (let attempt = 0; ; attempt++) {
    try {
      const got = await readFix(ctx, key);
      let next = doc;
      if (got) {
        let there: FixDoc;
        try {
          there = parseFixDoc(got.body, doc.fix.fixId);
        } catch (err) {
          throw new LayoutError(`the store's copy can't be read: ${messageOf(err)}`);
        }
        next = mergeFixDocs(doc, there);
        const merged = fixDocHash(next);
        if (merged === fixDocHash(there)) {
          // The store has everything this machine has, and maybe more: take what it adds.
          if (merged !== hash) take(next);
          ctx.store.setTeamFix(rid, { fixId: doc.fix.fixId, hash: merged, version: got.version, at: now(ctx) });
          return 'same';
        }
      }
      // One a pull couldn't read stays here: written, it would stop every teammate's pull of it.
      const bytes = fixDocBytes(next);
      if (bytes.length > FIX_BYTES) throw new LayoutError(`it would be ${bytes.length} bytes, over the ${FIX_BYTES} a pull reads, so it stays on this machine`);
      const put = await ctx.remote.put(key, bytes, { contentType: 'application/json', ...(got ? (got.version ? { ifMatch: got.version } : {}) : { ifNoneMatch: true }) });
      const merged = fixDocHash(next);
      if (merged !== hash) take(next);
      ctx.store.setTeamFix(rid, { fixId: doc.fix.fixId, hash: merged, version: put.version, at: now(ctx) });
      return 'sent';
    } catch (err) {
      // Someone wrote the fix a moment ago: merge with what they wrote.
      if (!isPrecondition(err) || attempt >= 3) throw err;
    }
  }
}

/**
 * Sends the fixes that changed here since this machine and the store last agreed on them, each
 * merged with the store's copy. One that can't go is reported and the others go on; the store
 * failing (the network, access) stops it, reported as that fix's problem.
 */
export async function pushFixes(ctx: FixSyncContext): Promise<FixPushResult> {
  const rid = storeKey(ctx.remote.location);
  const result: FixPushResult = { sent: [], failed: [], repairs: [] };
  const synced = ctx.store.teamFixes(rid);
  const inStore = new Set(ctx.store.teamRuns(rid).filter((r) => r.state !== 'queued' && r.remoteHash !== null).map((r) => r.runId));
  for (const fix of ctx.store.listFixes()) {
    const doc = fixDocOf(ctx.store, fix.fixId);
    if (!doc) continue;
    const row = synced.get(fix.fixId);
    if (!row && !runsOf(doc).some((id) => inStore.has(id))) continue;
    const hash = fixDocHash(doc);
    if (row?.hash === hash) continue;
    try {
      if ((await sendFix(ctx, rid, doc, hash, result.repairs)) === 'sent') result.sent.push(fix.fixId);
    } catch (err) {
      result.failed.push({ fixId: fix.fixId, reason: messageOf(err) });
      if (!isFixProblem(err)) break;
    }
  }
  return result;
}

/**
 * Brings the fixes that changed in the store since this machine last read them, merged with this
 * machine's copies. One that can't be read is reported and skipped; the next pull tries it again.
 */
export async function pullFixes(ctx: FixSyncContext): Promise<FixPullResult> {
  const rid = storeKey(ctx.remote.location);
  const result: FixPullResult = { pulled: [], merged: [], failed: [], repairs: [] };
  const synced = ctx.store.teamFixes(rid);
  const changed: Array<{ key: string; fixId: string }> = [];
  for await (const o of ctx.remote.list(FIXES_PREFIX)) {
    const m = /^fixes\/([^/]+)\.json$/.exec(o.key);
    if (!m || !isFixId(m[1])) continue;
    const row = synced.get(m[1]);
    if (row && row.version !== null && row.version === o.version) continue;
    changed.push({ key: o.key, fixId: m[1] });
  }
  for (const { key, fixId } of changed) {
    let got: GetResult | null;
    let there: FixDoc;
    try {
      got = await readFix(ctx, key);
      if (!got) continue; // deleted since it was listed
      there = parseFixDoc(got.body, fixId);
    } catch (err) {
      if (!isFixProblem(err)) throw err;
      result.failed.push({ fixId, reason: messageOf(err) });
      continue;
    }
    const here = fixDocOf(ctx.store, fixId);
    const merged = here ? mergeFixDocs(here, there) : there;
    if (!here || fixDocHash(here) !== fixDocHash(merged)) {
      const applied = applyFixDoc(ctx.store, merged, { from: rid, at: now(ctx) });
      result.repairs.push(...applied.repairs);
      (applied.created ? result.pulled : result.merged).push(fixId);
    }
    // What both sides agree on is the store's copy: whatever this machine adds goes with the next push.
    ctx.store.setTeamFix(rid, { fixId, hash: fixDocHash(there), version: got.version, at: now(ctx) });
  }
  return result;
}
