/**
 * The team store, as this machine knows the project's bucket (shadowlap push and pull), kept per
 * store URL: every run in the bucket or on its way there (team_runs), the blobs and index segments
 * already known to be there (team_blobs, team_segments), when this machine last synced and what
 * setup recorded (team_sync), the fixes both sides last agreed on (team_fixes), and the repairs that
 * came with a fix from the store (team_repairs).
 */
import { StorePart } from './core.js';

// ---- Team store (v4): the shapes of the team tables ----

/** How a run stands with the team store (v4 team_runs). */
export type TeamRunState = 'queued' | 'pushed' | 'pulled' | 'listed';

/** One row of team_runs: a run in the project's bucket, or on its way there. */
export interface TeamRunRow {
  runId: string;
  state: TeamRunState;
  /** When it was last synced (or queued), ms. */
  at: number;
  /** The run's shared metadata as of the last sync: the base of a three-way merge. */
  base: Record<string, unknown> | null;
  baseHash: string | null;
  /** The metadata hash the bucket's index last gave for it. */
  remoteHash: string | null;
  /** The bucket's index entry for it: who made it, when, its status, labels and calls. */
  entry: Record<string, unknown> | null;
}

/** A fix this machine and the store last agreed on (v4 team_fixes). */
export interface TeamFixRow {
  fixId: string;
  /** The hash of the fix as both sides last had it. */
  hash: string;
  /** The version (ETag, generation) of the store's object last read or written. */
  version: string | null;
  at: number;
}

/** When this machine last pushed to and pulled from a store, and what setup recorded about it. */
export interface TeamSyncRow {
  pushedAt: number | null;
  pulledAt: number | null;
  data: Record<string, unknown>;
}

export abstract class Team extends StorePart {
  // ---- Team store (v4): what this machine knows about the project's bucket ----

  teamRun(remote: string, runId: string): TeamRunRow | null {
    const row = this.db.prepare(`SELECT * FROM team_runs WHERE remote = ? AND run_id = ?`).get(remote, runId);
    return row ? rowToTeamRun(row) : null;
  }

  /** Every run this machine knows to be in the store (or queued for it). */
  teamRuns(remote: string): TeamRunRow[] {
    return this.db.prepare(`SELECT * FROM team_runs WHERE remote = ? ORDER BY run_id`).all(remote).map(rowToTeamRun);
  }

  setTeamRun(remote: string, row: TeamRunRow): void {
    this.db
      .prepare(
        `INSERT INTO team_runs (remote, run_id, state, at, base, base_hash, remote_hash, entry) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (remote, run_id) DO UPDATE SET state = excluded.state, at = excluded.at, base = excluded.base, base_hash = excluded.base_hash, remote_hash = excluded.remote_hash, entry = excluded.entry`,
      )
      .run(remote, row.runId, row.state, row.at, row.base === null ? null : JSON.stringify(row.base), row.baseHash, row.remoteHash, row.entry === null ? null : JSON.stringify(row.entry));
  }

  /** Forgets a run the store no longer has (deleted from the bucket), so pulls stop looking for it. */
  deleteTeamRun(remote: string, runId: string): void {
    this.db.prepare(`DELETE FROM team_runs WHERE remote = ? AND run_id = ?`).run(remote, runId);
  }

  /** Which of these blobs are known to be in the store already. */
  knownTeamBlobs(remote: string, hashes: readonly string[]): Set<string> {
    const known = new Set<string>();
    const get = this.db.prepare(`SELECT 1 AS x FROM team_blobs WHERE remote = ? AND hash = ?`);
    for (const h of hashes) if (get.get(remote, h)) known.add(h);
    return known;
  }

  addTeamBlobs(remote: string, hashes: Iterable<string>): void {
    const put = this.db.prepare(`INSERT OR IGNORE INTO team_blobs (remote, hash) VALUES (?, ?)`);
    this.transaction(() => {
      for (const h of hashes) put.run(remote, h);
    });
  }

  /** Index segments of the store already read. */
  seenTeamSegments(remote: string): Set<string> {
    return new Set(this.db.prepare(`SELECT key FROM team_segments WHERE remote = ?`).all(remote).map((r) => String(r.key)));
  }

  addTeamSegments(remote: string, keys: Iterable<string>, at: number = Date.now()): void {
    const put = this.db.prepare(`INSERT OR IGNORE INTO team_segments (remote, key, at) VALUES (?, ?, ?)`);
    this.transaction(() => {
      for (const k of keys) put.run(remote, k, at);
    });
  }

  teamSync(remote: string): TeamSyncRow | null {
    const row = this.db.prepare(`SELECT * FROM team_sync WHERE remote = ?`).get(remote);
    if (!row) return null;
    return { pushedAt: row.pushed_at === null ? null : Number(row.pushed_at), pulledAt: row.pulled_at === null ? null : Number(row.pulled_at), data: typeof row.data === 'string' ? (JSON.parse(row.data) as Record<string, unknown>) : {} };
  }

  /**
   * Records a push, a pull, or setup progress (merged into `data`). Read and written back under the
   * write lock, as updateRunMeta is, so a pull's stamp made while a push makes its own is kept.
   */
  setTeamSync(remote: string, patch: { pushedAt?: number; pulledAt?: number; data?: Record<string, unknown> }): void {
    const merge = () => {
      const current = this.teamSync(remote) ?? { pushedAt: null, pulledAt: null, data: {} };
      const next = { pushedAt: patch.pushedAt ?? current.pushedAt, pulledAt: patch.pulledAt ?? current.pulledAt, data: { ...current.data, ...(patch.data ?? {}) } };
      this.db
        .prepare(`INSERT INTO team_sync (remote, pushed_at, pulled_at, data) VALUES (?, ?, ?, ?) ON CONFLICT (remote) DO UPDATE SET pushed_at = excluded.pushed_at, pulled_at = excluded.pulled_at, data = excluded.data`)
        .run(remote, next.pushedAt, next.pulledAt, JSON.stringify(next.data));
    };
    if (this.db.isTransaction) merge();
    else this.transaction(merge);
  }

  /** The fixes this machine and a store last agreed on, by fix id. */
  teamFixes(remote: string): Map<string, TeamFixRow> {
    const rows = this.db.prepare(`SELECT * FROM team_fixes WHERE remote = ?`).all(remote);
    return new Map(rows.map((r) => [String(r.fix_id), { fixId: String(r.fix_id), hash: String(r.hash), version: r.version === null ? null : String(r.version), at: Number(r.at) }]));
  }

  setTeamFix(remote: string, row: TeamFixRow): void {
    this.db
      .prepare(`INSERT INTO team_fixes (remote, fix_id, hash, version, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (remote, fix_id) DO UPDATE SET hash = excluded.hash, version = excluded.version, at = excluded.at`)
      .run(remote, row.fixId, row.hash, row.version, row.at);
  }

  /** Marks a repair as one that came with a fix from a store (`remote`): made on another machine. */
  markRepairPulled(remote: string, repairId: string, at: number = Date.now()): void {
    this.db.prepare(`INSERT OR IGNORE INTO team_repairs (repair_id, remote, at) VALUES (?, ?, ?)`).run(repairId, remote, at);
  }

  /** The store a repair came from, and when; null for a repair made on this machine. */
  repairPulled(repairId: string): { remote: string; at: number } | null {
    const row = this.db.prepare(`SELECT remote, at FROM team_repairs WHERE repair_id = ?`).get(repairId);
    return row ? { remote: String(row.remote), at: Number(row.at) } : null;
  }

  /**
   * What this machine knows the store holds, counted in SQL rather than read row by row: runs its
   * index lists (a row not queued, with an index hash, as teamRunInStore in @shadowlap/remote has
   * it), runs queued, each author with their runs, and the CI providers of runs made by `ci`.
   */
  teamSummary(remote: string): { inStore: number; queued: number; authors: Array<{ author: string | null; runs: number }>; ciProviders: string[] } {
    const listed = `remote = ? AND state != 'queued' AND remote_hash IS NOT NULL`;
    const inStore = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM team_runs WHERE ${listed}`).get(remote)?.n ?? 0);
    // Queued and still recording: one that ended since goes with the next push, one deleted goes nowhere.
    const queued = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM team_runs t JOIN runs r ON r.run_id = t.run_id WHERE t.remote = ? AND t.state = 'queued' AND r.status = 'running'`).get(remote)?.n ?? 0);
    const authors = this.db
      .prepare(`SELECT json_extract(entry, '$.author') AS author, COUNT(*) AS n FROM team_runs WHERE ${listed} GROUP BY author ORDER BY author`)
      .all(remote)
      .map((r) => ({ author: typeof r.author === 'string' ? r.author : null, runs: Number(r.n) }));
    const ciProviders = this.db
      .prepare(`SELECT DISTINCT json_extract(entry, '$.ci') AS ci FROM team_runs WHERE ${listed} AND json_extract(entry, '$.author') = 'ci' AND json_extract(entry, '$.ci') IS NOT NULL ORDER BY ci`)
      .all(remote)
      .map((r) => String(r.ci));
    return { inStore, queued, authors, ciProviders };
  }

  /**
   * Runs on this machine the store's index doesn't list, runs still recording and runs pulled from a
   * pull request's folder aside (a push never sends those): how many, and the ids of the newest
   * `limit` of them. The Runs page's `local` tag.
   */
  teamLocalOnly(remote: string, limit: number): { count: number; ids: string[] } {
    const where = `r.status != 'running' AND json_extract(r.meta, '$.imported.pr') IS NULL AND NOT EXISTS (SELECT 1 FROM team_runs t WHERE t.remote = ? AND t.run_id = r.run_id AND t.state != 'queued' AND t.remote_hash IS NOT NULL)`;
    const count = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM runs r WHERE ${where}`).get(remote)?.n ?? 0);
    const ids = this.db
      .prepare(`SELECT r.run_id FROM runs r WHERE ${where} ORDER BY r.started_at DESC, r.run_id DESC LIMIT ?`)
      .all(remote, limit)
      .map((r) => String(r.run_id));
    return { count, ids };
  }
}

// ---- Team store (v4): rows to records ----

function rowToTeamRun(row: Record<string, unknown>): TeamRunRow {
  const json = (v: unknown) => (typeof v === 'string' ? (JSON.parse(v) as Record<string, unknown>) : null);
  return {
    runId: String(row.run_id),
    state: row.state as TeamRunState,
    at: Number(row.at),
    base: json(row.base),
    baseHash: (row.base_hash as string | null) ?? null,
    remoteHash: (row.remote_hash as string | null) ?? null,
    entry: json(row.entry),
  };
}
