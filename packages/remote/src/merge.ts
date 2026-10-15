import { canonicalize, sha256, type RunMeta, type RunNote } from '@shadowlap/engine';

/**
 * Run metadata on more than one machine. What syncs is what happens to a run after it ran:
 *
 * - Labels and notes, which anyone may add or remove on any machine, merge three ways against what
 *   both sides last agreed on (the base): something added on either side is kept, something removed
 *   on either side is removed. Without a base (a copy that never synced with the store, such as a
 *   golden unpacked in CI), both sides' are joined.
 * - Results (blame, verify, checks) belong to the machine that made the run: its push writes them,
 *   and this machine takes the store's only for a run made elsewhere (pulled, or unpacked).
 *
 * Everything else describes the recording itself: who made it, what it covers, its redaction rules,
 * the normalizers its fingerprints were computed under, its repeat group. It goes to the store with
 * the run's first push, comes down with its first pull, and no later push or pull changes it. The
 * bucket is writable by everyone the cloud admin lets in, CI included, so a changed run.json can
 * never change how a run on this machine replays, or who made it.
 */

/** Meta that describes this machine's copy, never shared: an import marker is set by whoever imports. */
export const LOCAL_ONLY_META: readonly string[] = ['imported', 'commandFromImport'];
/** Merged three ways on every push and pull. */
export const MERGED_META = ['labels', 'notes'] as const;
/** Given by the machine that made the run. */
export const RESULT_META = ['blame', 'verify', 'checks'] as const;
/** What push and pull keep in step; everything else is fixed when a run first goes up or comes down. */
export const SYNCED_META: readonly string[] = [...MERGED_META, ...RESULT_META];

export type SharedMeta = Record<string, unknown>;

type AnyMeta = RunMeta | Record<string, unknown> | undefined | null;

/** The metadata a run shares through the store: everything but this machine's own markers. */
export function sharedMeta(meta: AnyMeta): SharedMeta {
  const out: SharedMeta = {};
  for (const [k, v] of Object.entries(meta ?? {})) if (v !== undefined && !LOCAL_ONLY_META.includes(k)) out[k] = v;
  return out;
}

/** The part of a run's metadata that push and pull keep in step. No labels and an empty list are the same. */
export function syncedMeta(meta: AnyMeta): SharedMeta {
  const out: SharedMeta = {};
  const m = (meta ?? {}) as Record<string, unknown>;
  for (const k of SYNCED_META) {
    const v = m[k];
    if (v === undefined || ((k === 'labels' || k === 'notes') && Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out;
}

/** The hash of what syncs. The index carries it, so a pull knows when a run changed in the store. */
export function metaHash(meta: AnyMeta): string {
  return sha256(canonicalize(syncedMeta(meta)));
}

/** A run made on this machine: it carries no import marker (a pulled or unpacked run does). */
export function madeHere(meta: AnyMeta): boolean {
  return !(meta as RunMeta | null | undefined)?.imported;
}

function mergeList<T>(local: readonly T[], remote: readonly T[], base: readonly T[] | null, id: (x: T) => string): T[] {
  const b = new Set((base ?? []).map(id));
  const l = new Set(local.map(id));
  const r = new Set(remote.map(id));
  const out: T[] = [];
  const seen = new Set<string>();
  for (const x of local) {
    const k = id(x);
    if (!seen.has(k) && (r.has(k) || !b.has(k))) {
      out.push(x);
      seen.add(k);
    }
  }
  for (const x of remote) {
    const k = id(x);
    if (!seen.has(k) && !l.has(k) && !b.has(k)) {
      out.push(x);
      seen.add(k);
    }
  }
  return out;
}

const noteId = (n: RunNote) => `${n.callNo ?? '-'}|${n.at}|${n.text}`;
const asList = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/**
 * The synced metadata both copies of a run should hold: labels and notes merged against their base
 * (null: none known), and the results of whichever side made the run. `origin` says this machine
 * made it.
 */
export function reconcile(local: AnyMeta, remote: AnyMeta, base: SharedMeta | null, origin: boolean): SharedMeta {
  const l = (local ?? {}) as Record<string, unknown>;
  const r = (remote ?? {}) as Record<string, unknown>;
  const out: SharedMeta = {};
  const labels = mergeList(asList<string>(l.labels), asList<string>(r.labels), base ? asList<string>(base.labels) : null, (x) => x).slice(0, 50);
  if (labels.length) out.labels = labels;
  const notes = mergeList(asList<RunNote>(l.notes), asList<RunNote>(r.notes), base ? asList<RunNote>(base.notes) : null, noteId)
    .sort((x, y) => x.at - y.at)
    .slice(-1000);
  if (notes.length) out.notes = notes;
  const results = origin ? l : r;
  for (const k of RESULT_META) if (results[k] !== undefined) out[k] = results[k];
  return out;
}

/** A run's metadata with its synced part replaced, every other key kept as it is. */
export function withSynced<T extends AnyMeta>(meta: T, synced: SharedMeta): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(meta ?? {}) };
  for (const k of SYNCED_META) delete out[k];
  return { ...out, ...synced };
}

/** The patch that gives a run this synced metadata: each synced key set, or removed. */
export function syncedPatch(synced: SharedMeta): Partial<RunMeta> {
  const patch: Record<string, unknown> = {};
  for (const k of SYNCED_META) patch[k] = synced[k];
  return patch as Partial<RunMeta>;
}
