/**
 * What the store holds and gives back: the blobs no call references any more (gc collects them once
 * no run is recording), what deleting runs would free, what holds a run's deletion up, and the
 * store's size, with the vacuum that gives freed pages back.
 */
import { manifestRefs } from '../manifest.js';
import type { Store } from '../store.js';
import type { RunRecord } from '../types.js';
import { rollBack, StorePart } from './core.js';
import type { Recording } from './recording.js';

export abstract class Cleanup extends StorePart {
  /** The recording core's (store/recording.ts): a collection and a deletion wait for the runs a process records. */
  protected abstract readonly recordingRuns: Recording['recordingRuns'];

  /**
   * Deletes blobs that no call references (a run's rows go with `deleteRun`; its blobs are shared by
   * content, so they are collected here). Returns what was removed: `bytes` uncompressed, `stored`
   * as the store keeps them.
   *
   * Never while a run is recording, in this process or another: a recording stores a blob a moment
   * before the call row that references it, and a call whose content is already stored references
   * the existing blob without writing it again, so a blob that looks unreferenced may be one a
   * recording is about to use. With a run still recording, nothing is deleted and `recording` names
   * the runs. A run its process left `running` (killed, out of memory) is not recording and holds
   * nothing up (recordingRuns). The check and the deletes share one write transaction, so no run
   * can start between them; the slow part, reading every request manifest, happens before it, and
   * only what changed meanwhile is read again under the lock. `among` limits the collection to
   * those blobs (calibrate collects only what its own attempts wrote).
   */
  gcBlobs(options: { among?: Iterable<string> } = {}): { removed: number; bytes: number; stored: number; recording: string[] } {
    const recordingNow = () => this.recordingRuns().live.map((r) => r.run.runId);
    const early = recordingNow();
    if (early.length) return { removed: 0, bytes: 0, stored: 0, recording: early };
    const manifests = new Map<string, string[]>();
    const among = options.among ? new Set(options.among) : null;
    const candidates = this.blobsNotIn(this.referencedBlobs(new Set(), manifests)).filter((b) => !among || among.has(b.hash));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const recording = recordingNow();
      let removed = 0;
      let bytes = 0;
      let stored = 0;
      if (!recording.length && candidates.length) {
        // Calls committed since the first read may reference a candidate now: read their rows again.
        const referenced = this.referencedBlobs(new Set(), manifests);
        const del = this.db.prepare(`DELETE FROM blobs WHERE hash = ?`);
        for (const b of candidates) {
          if (referenced.has(b.hash)) continue;
          if (Number(del.run(b.hash).changes) === 0) continue;
          removed++;
          bytes += b.size;
          stored += b.stored;
        }
        // The fingerprints worked out for requests that are gone now.
        if (removed) this.db.exec(`DELETE FROM fingerprint_cache WHERE request_ref NOT IN (SELECT hash FROM blobs)`);
      }
      this.db.exec('COMMIT');
      return { removed, bytes, stored, recording };
    } catch (err) {
      rollBack(this.db);
      throw err;
    }
  }

  /**
   * Gives freed pages back to the filesystem, then checkpoints the write-ahead log so the file on
   * disk shrinks now rather than at the next checkpoint (as far as readers on other connections
   * allow; `size()` doesn't depend on it).
   */
  vacuum(): void {
    this.db.exec('VACUUM');
    try {
      this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    } catch {
      // a reader kept part of the log: the next checkpoint finishes it
    }
  }

  /**
   * The store's size as SQLite counts it, whatever its write-ahead log holds: `bytes` is every page
   * of the database, `free` the pages a vacuum would give back. Another connection holding the
   * store open (a dashboard) can keep the files on disk larger for a while; this is what they
   * come back to.
   */
  size(): { bytes: number; free: number } {
    const pageSize = Number(this.db.prepare('PRAGMA page_size').get()?.page_size ?? 0);
    const pages = Number(this.db.prepare('PRAGMA page_count').get()?.page_count ?? 0);
    const free = Number(this.db.prepare('PRAGMA freelist_count').get()?.freelist_count ?? 0);
    return { bytes: pages * pageSize, free: free * pageSize };
  }

  /** Every blob the calls of a run reference, the parts of its request manifests included. */
  runBlobRefs(runId: string): string[] {
    const refs = new Set<string>();
    for (const r of this.db.prepare(`SELECT kind, request_ref, response_ref FROM call_events WHERE run_id = ?`).all(runId)) {
      const req = r.request_ref as string | null;
      const res = r.response_ref as string | null;
      if (res) refs.add(res);
      if (req) {
        refs.add(req);
        if (r.kind === 'api') for (const h of manifestRefs(this as unknown as Store, req)) refs.add(h);
      }
    }
    return [...refs];
  }

  /**
   * The blobs some call references, leaving out the runs in `skip`. A request manifest never
   * changes (it is stored by its content), so `manifests` keeps what each one lists between reads.
   */
  private referencedBlobs(skip: Set<string>, manifests: Map<string, string[]>): Set<string> {
    const referenced = new Set<string>();
    for (const r of this.db.prepare(`SELECT run_id, kind, request_ref, response_ref FROM call_events`).all()) {
      if (skip.has(String(r.run_id))) continue;
      const req = r.request_ref as string | null;
      const res = r.response_ref as string | null;
      if (res) referenced.add(res);
      if (req) {
        referenced.add(req);
        if (r.kind !== 'api') continue;
        let parts = manifests.get(req);
        if (!parts) {
          parts = manifestRefs(this as unknown as Store, req);
          manifests.set(req, parts);
        }
        for (const h of parts) referenced.add(h);
      }
    }
    return referenced;
  }

  private blobsNotIn(referenced: Set<string>): Array<{ hash: string; size: number; stored: number }> {
    const out: Array<{ hash: string; size: number; stored: number }> = [];
    for (const b of this.db.prepare(`SELECT hash, size, length(bytes) AS stored FROM blobs`).all()) {
      const hash = String(b.hash);
      if (!referenced.has(hash)) out.push({ hash, size: Number(b.size), stored: Number(b.stored) });
    }
    return out;
  }

  /**
   * The blobs no call would reference once the runs in `without` are deleted, those nothing
   * references now included: what `gcBlobs` removes after those runs go (once no run is
   * recording), found without deleting anything. `bytes` is what they take in the store, `size`
   * their uncompressed length.
   */
  unreferencedBlobs(without: Iterable<string> = []): { hashes: string[]; bytes: number; size: number } {
    const blobs = this.blobsNotIn(this.referencedBlobs(new Set(without), new Map()));
    return { hashes: blobs.map((b) => b.hash), bytes: blobs.reduce((n, b) => n + b.stored, 0), size: blobs.reduce((n, b) => n + b.size, 0) };
  }

  /**
   * Why a run can't be deleted now, or null. A run a process is still recording (or replaying) is
   * left alone, and so is one a run in progress reads from: a replay, a fork or an attempt of it
   * serves its answers from it as it goes. A run its process left marked running holds nothing up,
   * as for gc. `live` is the runs in progress, when the caller has them already.
   */
  deletionHold(runId: string, live: readonly RunRecord[] = this.recordingRuns().live.map((r) => r.run)): string | null {
    const run = live.find((r) => r.runId === runId);
    if (run) return run.mode === 'record' ? 'still recording' : 'still running';
    return live.some((r) => r.parentRunId === runId) ? 'a replay of it is still running' : null;
  }
}
