/**
 * The recording core: runs, their calls and the content-addressed blobs the calls reference, the
 * fingerprints a replay starts from, and the write the sidecar makes each call in. Recording and
 * replay append to these and every reader of a run reads them; the other parts of the store keep
 * what was worked out or done about runs, naming them by id.
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import { sha256 } from '../ids.js';
import { currentOwner, recorderGone, type RunOwner } from '../liveness.js';
import type { CallEndRow, CallKind, CallMeta, CallRecord, CallStartRow, DivergenceReport, Effect, Origin, Outcome, RunCommand, RunMeta, RunMode, RunRecord, RunStatus } from '../types.js';
import { rollBack, StorePart, ulidNow, type QueuedWrites } from './core.js';

const GZIP_THRESHOLD = 512;

export interface CreateRunInput {
  runId?: string;
  parentRunId?: string | null;
  mode: RunMode;
  command: RunCommand;
  codeVersion?: string | null;
  startedAt?: number;
  meta?: RunMeta;
}

export abstract class Recording extends StorePart {
  // ---- runs ----

  /**
   * Starts a run: its record, its metadata and the process recording it (run_owners, which
   * recordingRuns reads) are written together or not at all, in a transaction of their own unless the
   * caller has one open (the sidecar writes a run's start in one of its StoreWriter's).
   */
  createRun(input: CreateRunInput): RunRecord {
    const run: RunRecord = {
      runId: input.runId ?? ulidNow(),
      parentRunId: input.parentRunId ?? null,
      mode: input.mode,
      status: 'running',
      divergence: null,
      command: input.command,
      codeVersion: input.codeVersion ?? null,
      startedAt: input.startedAt ?? Date.now(),
      endedAt: null,
      ...(input.meta ? { meta: input.meta } : {}),
    };
    const write = () => {
      this.stmts.insertRun.run(run.runId, run.parentRunId, run.mode, JSON.stringify(run.command), run.codeVersion, run.startedAt);
      if (input.meta) this.db.prepare(`UPDATE runs SET meta = ? WHERE run_id = ?`).run(JSON.stringify(input.meta), run.runId);
      // settings: who records it, until it ends (recordingRuns).
      const owner = currentOwner();
      this.db.prepare(`INSERT OR REPLACE INTO run_owners (run_id, pid, host) VALUES (?, ?, ?)`).run(run.runId, owner.pid, owner.host);
    };
    if (this.db.isTransaction) write();
    else this.transaction(write);
    return run;
  }

  /** Inserts a complete run record as-is (used by unpack). A parent that isn't present is kept as a dangling reference. */
  importRun(run: RunRecord): void {
    const parentPresent = run.parentRunId ? this.getRun(run.parentRunId) !== null : false;
    this.db
      .prepare(
        `INSERT INTO runs (run_id, parent_run_id, mode, status, divergence, command, code_version, started_at, ended_at, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.runId,
        parentPresent ? run.parentRunId : null,
        run.mode,
        run.status,
        run.divergence ? JSON.stringify(run.divergence) : null,
        JSON.stringify(run.command),
        run.codeVersion,
        run.startedAt,
        run.endedAt,
        run.meta ? JSON.stringify(run.meta) : null,
      );
  }

  /**
   * Puts another copy of a run in place of the one held (a pull's copy of a run that a pull
   * request's folder brought first): the held record and its calls go, the copy's record comes in
   * for the caller to append its calls, and the runs made from it stay linked to it.
   */
  replaceRun(run: RunRecord): void {
    const children = this.childRuns(run.runId).map((r) => r.runId);
    this.deleteRun(run.runId);
    this.importRun(run);
    const link = this.db.prepare(`UPDATE runs SET parent_run_id = ? WHERE run_id = ?`);
    for (const child of children) link.run(run.runId, child);
  }

  /**
   * Links a run that came here without its parent (unset, as an import leaves it when the parent
   * isn't here) to that parent, once the parent is here. A link already set stays, and one that
   * would make the run its own ancestor is never made. Whether it was linked.
   */
  linkParent(runId: string, parentRunId: string): boolean {
    if (this.getRun(runId)?.parentRunId !== null) return false;
    for (let at: string | null = parentRunId, depth = 0; at; depth++) {
      if (at === runId || depth > 10_000) return false;
      const up = this.getRun(at);
      if (!up) return false;
      at = up.parentRunId;
    }
    return Number(this.db.prepare(`UPDATE runs SET parent_run_id = ? WHERE run_id = ? AND parent_run_id IS NULL`).run(parentRunId, runId).changes) > 0;
  }

  /**
   * Gives a run another start time. An import writes its run as of the moment it starts, so the
   * store hears from it now (recordingRuns) however old the capture's times are, and gives it the
   * capture's start once it has ended.
   */
  setRunStart(runId: string, startedAt: number): void {
    this.db.prepare(`UPDATE runs SET started_at = ? WHERE run_id = ?`).run(startedAt, runId);
  }

  endRun(runId: string, status: Exclude<RunStatus, 'running'>, endedAt: number = Date.now()): void {
    this.stmts.endRun.run(status, endedAt, runId);
    this.db.prepare(`DELETE FROM run_owners WHERE run_id = ?`).run(runId);
  }

  setDivergence(runId: string, report: DivergenceReport): void {
    this.stmts.setDivergence.run(JSON.stringify(report), runId);
  }

  getRun(runId: string): RunRecord | null {
    this.settleQueued(runId, 'run');
    const row = this.stmts.getRun.get(runId);
    return row ? rowToRun(row) : null;
  }

  /** Resolves a full run id or a unique prefix (case-insensitive). */
  findRun(idOrPrefix: string): RunRecord | null {
    const exact = this.getRun(idOrPrefix.toUpperCase());
    if (exact) return exact;
    const rows = this.stmts.findRunByPrefix.all(idOrPrefix.toUpperCase().replace(/[%_]/g, '') + '%');
    if (rows.length === 1) return rowToRun(rows[0]!);
    if (rows.length > 1) throw new Error(`run id prefix "${idOrPrefix}" is ambiguous`);
    return null;
  }

  listRuns(limit = 50): RunRecord[] {
    return this.stmts.listRuns.all(limit).map(rowToRun);
  }

  childRuns(runId: string): RunRecord[] {
    return this.stmts.childRuns.all(runId).map(rowToRun);
  }

  /**
   * Merges `patch` into a run's metadata. The metadata is read and written back under the write lock
   * (in a transaction of its own, unless the caller has one open), so a change another command makes
   * to it meanwhile, as the dashboard's label does while the sidecar keeps a run's preloads, waits and
   * is not written over.
   */
  updateRunMeta(runId: string, patch: Partial<RunMeta>): void {
    this.settleQueued(runId, 'run');
    const merge = () => {
      const run = this.getRun(runId);
      if (!run) throw new Error(`unknown run ${runId}`);
      this.db.prepare(`UPDATE runs SET meta = ? WHERE run_id = ?`).run(JSON.stringify({ ...(run.meta ?? {}), ...patch }), runId);
    };
    if (this.db.isTransaction) merge();
    else this.transaction(merge);
  }

  /**
   * Deletes a run: its record, and with it its calls and what else names it by a foreign key, and what
   * the other parts keep of it otherwise, each by its own onRunDeleted (its search documents, a push
   * it was queued for).
   */
  deleteRun(runId: string): void {
    // What this process still has queued for the run is made first, so none of it lands after the run has gone.
    this.settleQueued(runId);
    // All of it or none: a run whose rows went while its search index could not be written (a Node
    // whose SQLite has no full-text search) would leave the text it recorded behind. A savepoint, as
    // a caller may have a transaction open already (replaceRun in a pull's).
    this.db.exec('SAVEPOINT delete_run');
    try {
      this.stmts.deleteRun.run(runId);
      this.forgetRun(runId);
      this.db.exec('RELEASE delete_run');
    } catch (err) {
      rollBack(this.db, 'delete_run');
      throw err;
    }
  }

  /** Every run, oldest last. */
  allRuns(): RunRecord[] {
    return this.listRuns(Number.MAX_SAFE_INTEGER);
  }

  /** Recordings that ran to an end (completed or failed), newest first. */
  finishedRecordings(limit = 50): RunRecord[] {
    return this.db
      .prepare(`SELECT * FROM runs WHERE mode = 'record' AND status IN ('completed', 'failed') ORDER BY started_at DESC, run_id DESC LIMIT ?`)
      .all(limit)
      .map(rowToRun);
  }

  /**
   * The runs still `running`, oldest first: `live` ones a process is recording, and `abandoned` ones
   * whose process stopped without ending them (see liveness.ts). `lastAt` is the run's start or its
   * latest call, whichever is later.
   */
  recordingRuns(now = Date.now()): { live: Array<{ run: RunRecord; lastAt: number }>; abandoned: Array<{ run: RunRecord; lastAt: number }> } {
    return splitRecordingRuns(this.db.prepare(RECORDING_RUNS_SQL).all(), now);
  }

  // ---- blobs ----

  /** Stores bytes under their SHA-256 (of the uncompressed content). Idempotent. */
  putBlob(bytes: Uint8Array): string {
    const hash = sha256(bytes);
    if (this.stmts.hasBlob.get(hash)) return hash;
    if (bytes.length > GZIP_THRESHOLD) {
      this.stmts.insertBlob.run(hash, 'gzip', bytes.length, gzipSync(bytes));
    } else {
      this.stmts.insertBlob.run(hash, 'raw', bytes.length, bytes);
    }
    return hash;
  }

  getBlob(hash: string): Buffer | null {
    const row = this.stmts.getBlob.get(hash);
    if (!row) return null;
    const bytes = Buffer.from(row.bytes as Uint8Array);
    return row.codec === 'gzip' ? gunzipSync(bytes) : bytes;
  }

  putJson(value: unknown): string {
    return this.putBlob(Buffer.from(JSON.stringify(value), 'utf8'));
  }

  getJson<T = unknown>(hash: string): T | null {
    const bytes = this.getBlob(hash);
    return bytes === null ? null : (JSON.parse(bytes.toString('utf8')) as T);
  }

  /** Whether a blob is here, without reading it. */
  hasBlob(hash: string): boolean {
    return this.stmts.hasBlob.get(hash) !== undefined;
  }

  /** A blob's size in bytes, without reading it; null when it isn't here. */
  blobSize(hash: string): number | null {
    const row = this.db.prepare(`SELECT size FROM blobs WHERE hash = ?`).get(hash);
    return row ? Number(row.size) : null;
  }

  // ---- call events ----

  nextCallNo(runId: string): number {
    const row = this.stmts.maxCallNo.get(runId);
    return Number(row?.n ?? 0) + 1;
  }

  countCalls(runId: string): number {
    this.settleQueued(runId, 'calls');
    return Number(this.stmts.countCalls.get(runId)?.n ?? 0);
  }

  /** The agent's calls in a run: every call but a judge check's, which are none of the agent's. */
  countAgentCalls(runId: string): number {
    this.settleQueued(runId, 'calls');
    return Number(this.stmts.countAgentCalls.get(runId, runId)?.n ?? 0);
  }

  appendCallStart(row: CallStartRow): void {
    this.stmts.insertEvent.run(
      row.runId,
      row.callNo,
      'start',
      0,
      row.kind,
      row.name,
      row.fingerprint,
      row.occurrence,
      row.origin,
      row.effect,
      row.requestRef,
      null,
      null,
      JSON.stringify(row.meta),
      row.at,
    );
  }

  appendCallEnd(identity: Pick<CallStartRow, 'kind' | 'name' | 'fingerprint' | 'occurrence'>, row: CallEndRow): void {
    this.stmts.insertEvent.run(
      row.runId,
      row.callNo,
      'end',
      row.attempt,
      identity.kind,
      identity.name,
      identity.fingerprint,
      identity.occurrence,
      null,
      null,
      null,
      row.responseRef,
      row.outcome,
      JSON.stringify(row.meta),
      row.at,
    );
  }

  // ---- writes this process queued and has not made yet (the sidecar's) ----

  /**
   * Registers writes this process queues for the store (the sidecar's StoreWriter): until the function
   * it returns is called, a read or change of a run here first makes what is queued for that run, so a
   * command that starts a run and stamps it, or ends one and reads its calls, finds them whatever
   * another process holds.
   */
  queueWrites(queue: QueuedWrites): () => void {
    this.queues.add(queue);
    return () => void this.queues.delete(queue);
  }

  /**
   * Makes what this process queued for a run (of its record, its calls, or both) before the run is
   * read or changed here. Never inside a transaction: a write made then would join it, and be undone
   * with it.
   */
  private settleQueued(runId: string, part?: 'run' | 'calls'): void {
    if (!this.queues.size || this.db.isTransaction) return;
    for (const queue of this.queues) queue.settle(runId, part);
  }

  /**
   * Runs `fn` as one write, waiting at most `waitMs` for another connection's write lock instead of
   * the busy timeout every other write waits: the sidecar writes its calls on the thread that streams
   * answers, so a store another process holds (the dashboard, gc, another recording) must never hold
   * the agent up. When the lock isn't free in time this throws SQLITE_BUSY and nothing was written;
   * the sidecar tries again later (its StoreWriter). Inside a transaction already open, `fn` joins it.
   */
  tryWrite<T>(fn: () => T, waitMs: number): T {
    if (this.db.isTransaction) return fn();
    const wait = Number((this.db.prepare('PRAGMA busy_timeout').get() as { timeout?: number } | undefined)?.timeout ?? 10_000);
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(waitMs))}`);
    try {
      return this.transaction(fn, 'immediate');
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${wait}`);
    }
  }

  // ---- fingerprint cache: what replay start reads instead of every stored request ----

  /** The fingerprints the cache holds under these keys, each with the dates and times its request holds (`clock`, as cached). */
  cachedFingerprints(keys: readonly string[]): Map<string, { fingerprint: string; clock: string | null }> {
    const found = new Map<string, { fingerprint: string; clock: string | null }>();
    if (!keys.length) return found;
    const rows = this.db.prepare(`SELECT key, fingerprint, clock FROM fingerprint_cache WHERE key IN (SELECT value FROM json_each(?))`).all(JSON.stringify(keys));
    for (const r of rows) found.set(String(r.key), { fingerprint: String(r.fingerprint), clock: typeof r.clock === 'string' ? r.clock : null });
    return found;
  }

  /** Keeps fingerprints worked out for stored requests, for the next replay to start from. */
  cacheFingerprints(rows: ReadonlyArray<{ key: string; requestRef: string; fingerprint: string; clock: string | null }>): void {
    const put = this.db.prepare(`INSERT OR REPLACE INTO fingerprint_cache (key, request_ref, fingerprint, clock) VALUES (?, ?, ?, ?)`);
    for (const r of rows) put.run(r.key, r.requestRef, r.fingerprint, r.clock);
  }

  /**
   * All calls of a run in arrival order, each with its final end row and earlier attempts. `range`
   * reads only some of them: the first `limit` (all, without one) numbered after `after`, or those
   * named in `only`.
   */
  getCalls(runId: string, range?: { after?: number; limit?: number; only?: readonly number[] }): CallRecord[] {
    this.settleQueued(runId, 'calls');
    const rows = !range
      ? this.stmts.eventsForRun.all(runId)
      : range.only
        ? this.db.prepare(`SELECT * FROM call_events WHERE run_id = ? AND call_no IN (SELECT value FROM json_each(?)) ORDER BY call_no ASC, phase DESC, attempt ASC`).all(runId, JSON.stringify(range.only))
        : this.db
            .prepare(
              `SELECT * FROM call_events WHERE run_id = ? AND call_no > ? AND call_no <= COALESCE(
                 (SELECT MAX(call_no) FROM (SELECT call_no FROM call_events WHERE run_id = ? AND phase = 'start' AND call_no > ? ORDER BY call_no LIMIT ?)), -1)
               ORDER BY call_no ASC, phase DESC, attempt ASC`,
            )
            .all(runId, range.after ?? 0, runId, range.after ?? 0, range.limit ?? -1);
    const byCall = new Map<number, CallRecord>();
    for (const r of rows) {
      const callNo = Number(r.call_no);
      if (r.phase === 'start') {
        byCall.set(callNo, {
          runId,
          callNo,
          kind: r.kind as CallKind,
          name: String(r.name),
          fingerprint: String(r.fingerprint),
          occurrence: Number(r.occurrence),
          origin: r.origin as Origin,
          effect: (r.effect as Effect | null) ?? null,
          requestRef: (r.request_ref as string | null) ?? null,
          meta: parseMeta(r.meta),
          at: Number(r.at),
          end: null,
          attempts: [],
        });
      } else {
        const call = byCall.get(callNo);
        if (!call) continue; // an end without a start: tolerated, never expected
        const end: CallEndRow = {
          runId,
          callNo,
          attempt: Number(r.attempt),
          responseRef: (r.response_ref as string | null) ?? null,
          outcome: r.outcome as Outcome,
          meta: parseMeta(r.meta),
          at: Number(r.at),
        };
        if (call.end) call.attempts.push(call.end);
        call.end = end;
      }
    }
    return [...byCall.values()].sort((a, b) => a.callNo - b.callNo);
  }
}

function parseMeta(raw: unknown): CallMeta {
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    return JSON.parse(raw) as CallMeta;
  } catch {
    return {};
  }
}

/** The runs still `running`, with the process the store names for each and their latest call: read by recordingRuns, and by a project's store opened read-only. */
export const RECORDING_RUNS_SQL = `SELECT r.*, o.pid AS owner_pid, o.host AS owner_host, (SELECT MAX(c.at) FROM call_events c WHERE c.run_id = r.run_id) AS last_call
  FROM runs r LEFT JOIN run_owners o ON o.run_id = r.run_id
  WHERE r.status = 'running' ORDER BY r.started_at, r.run_id`;

/** Rows of {@link RECORDING_RUNS_SQL} split into the runs a process records and those it left (recorderGone). */
export function splitRecordingRuns(rows: readonly Record<string, unknown>[], now: number): { live: Array<{ run: RunRecord; lastAt: number }>; abandoned: Array<{ run: RunRecord; lastAt: number }> } {
  const live: Array<{ run: RunRecord; lastAt: number }> = [];
  const abandoned: Array<{ run: RunRecord; lastAt: number }> = [];
  for (const row of rows) {
    const run = rowToRun(row);
    const lastAt = Math.max(run.startedAt, Number(row.last_call ?? 0));
    const owner: RunOwner | null = row.owner_pid === null || row.owner_pid === undefined ? null : { pid: Number(row.owner_pid), host: String(row.owner_host) };
    (recorderGone(owner, lastAt, now) ? abandoned : live).push({ run, lastAt });
  }
  return { live, abandoned };
}

/** A `runs` row as a run. Exported for readers that open a store read-only (projects/store-reader.ts). */
export function rowToRun(row: Record<string, unknown>): RunRecord {
  return {
    runId: String(row.run_id),
    parentRunId: (row.parent_run_id as string | null) ?? null,
    mode: row.mode as RunMode,
    status: row.status as RunStatus,
    divergence: typeof row.divergence === 'string' ? (JSON.parse(row.divergence) as DivergenceReport) : null,
    command: JSON.parse(String(row.command)) as RunCommand,
    codeVersion: (row.code_version as string | null) ?? null,
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at),
    ...(typeof row.meta === 'string' ? { meta: JSON.parse(row.meta) as RunMeta } : {}),
  };
}
