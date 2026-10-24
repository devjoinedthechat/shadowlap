import { createRequire } from 'node:module';
import { EARLIEST_MS, FUTURE_ALLOWANCE_MS, type ValidBatch, type ValidEvent } from './schema.js';

// Same loader as the engine's store: filter node:sqlite's experimental warning, nothing else.
const originalEmitWarning = process.emitWarning;
process.emitWarning = function patched(warning: unknown, ...rest: unknown[]): void {
  const message = typeof warning === 'string' ? warning : (warning as { message?: string } | undefined)?.message;
  if (typeof message === 'string' && message.includes('SQLite is an experimental feature')) return;
  return (originalEmitWarning as (this: NodeJS.Process, ...a: unknown[]) => void).call(process, warning, ...rest);
} as typeof process.emitWarning;
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => Db };

interface Stmt {
  run(...p: unknown[]): unknown;
  get(...p: unknown[]): Record<string, unknown> | undefined;
  all(...p: unknown[]): Record<string, unknown>[];
}
interface Db {
  /** Whether a transaction is open (Node 22.16+). SQLite ends one itself on some errors, such as a full disk. */
  readonly isTransaction?: boolean;
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  install_id TEXT NOT NULL,
  type TEXT NOT NULL,
  at INTEGER NOT NULL,
  version TEXT NOT NULL,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  node TEXT NOT NULL,
  ci TEXT,
  providers TEXT NOT NULL,
  sdks TEXT NOT NULL,
  calls INTEGER NOT NULL,
  replayed INTEGER NOT NULL,
  live INTEGER NOT NULL,
  blocked INTEGER NOT NULL,
  stubbed INTEGER NOT NULL,
  overridden INTEGER NOT NULL,
  divergence TEXT,
  tokens_not_respent INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  exit_code INTEGER
);
CREATE INDEX IF NOT EXISTS events_at ON events (at);
CREATE INDEX IF NOT EXISTS events_install ON events (install_id, at);
`;

export interface Stats {
  generatedAt: number;
  /** `active7dPrev`: developers who replayed in the 7 days before the last 7. */
  installs: { total: number; active7d: number; active7dPrev: number; active30d: number; ci: number };
  events: { total: number; last7d: number; last30d: number; byType: Record<string, number> };
  replays: { total: number; clean: number; forked: number; last30d: number; clean30d: number; divergenceByType: Record<string, number>; falseDivergenceHintRate: null };
  tokensNotRespent: number;
  /** Calls served from recordings instead of running again, all time. */
  callsReplayed: number;
  providers: Record<string, number>;
  sdks: Record<string, number>;
  versions: Record<string, number>;
  /** Installs by operating system and by CI system, last 30 days. */
  os: Record<string, number>;
  ciSystems: Record<string, number>;
  /** Days with events only, oldest first. */
  daily: Array<{ day: string; installs: number; runs: number; replays: number; clean: number; forked: number; tokensNotRespent: number }>;
  /** The last 12 weeks, Monday-based, oldest first, empty weeks included. */
  weekly: Array<{ week: string; activeDevelopers: number; replays: number }>;
}

const DAY = 86_400_000;

export class CollectorStore {
  private readonly db: Db;
  private readonly insert: Stmt;

  constructor(path: string, now = Date.now()) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
    // Events a collector took before it checked their time, which validateBatch refuses: one dated
    // more than a day ahead would count as recent until that day comes, and one before 2025 is no
    // Shadowlap's. Both go, so they inflate no count.
    this.db.prepare('DELETE FROM events WHERE at > ? OR at < ?').run(now + FUTURE_ALLOWANCE_MS, EARLIEST_MS);
    this.insert = this.db.prepare(
      `INSERT INTO events (received_at, install_id, type, at, version, os, arch, node, ci, providers, sdks, calls, replayed, live, blocked, stubbed, overridden, divergence, tokens_not_respent, duration_ms, exit_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  close(): void {
    this.db.close();
  }

  ingest(batch: ValidBatch, receivedAt = Date.now()): number {
    this.db.exec('BEGIN');
    try {
      for (const e of batch.events) this.insertEvent(batch.installId, e, receivedAt);
      this.db.exec('COMMIT');
    } catch (err) {
      // On a full disk SQLite has already rolled the batch back, and a second ROLLBACK would throw
      // "no transaction is active" in place of the error that says what happened.
      if (this.db.isTransaction !== false) this.db.exec('ROLLBACK');
      throw err;
    }
    return batch.events.length;
  }

  private insertEvent(installId: string, e: ValidEvent, receivedAt: number): void {
    this.insert.run(receivedAt, installId, e.type, e.at, e.version, e.os, e.arch, e.node, e.ci, JSON.stringify(e.providers), JSON.stringify(e.sdks), e.calls, e.replayed, e.live, e.blocked, e.stubbed, e.overridden, e.divergence, e.tokensNotRespent, e.durationMs, e.exitCode);
  }

  stats(now = Date.now()): Stats {
    const one = (sql: string, ...p: unknown[]) => Number(this.db.prepare(sql).get(...p)?.n ?? 0);
    const counts = (sql: string, ...p: unknown[]): Record<string, number> => Object.fromEntries(this.db.prepare(sql).all(...p).map((r) => [String(r.k), Number(r.n)]));
    const d7 = now - 7 * DAY;
    const d30 = now - 30 * DAY;
    const jsonListCounts = (column: 'providers' | 'sdks'): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const r of this.db.prepare(`SELECT ${column} AS v, COUNT(*) AS n FROM events WHERE at >= ? GROUP BY ${column}`).all(d30)) {
        for (const item of JSON.parse(String(r.v)) as string[]) out[item] = (out[item] ?? 0) + Number(r.n);
      }
      return out;
    };
    const daily = this.db
      .prepare(
        `SELECT date(at / 1000, 'unixepoch') AS day, COUNT(DISTINCT install_id) AS installs,
                SUM(CASE WHEN type = 'run' THEN 1 ELSE 0 END) AS runs,
                SUM(CASE WHEN type = 'replay' THEN 1 ELSE 0 END) AS replays,
                SUM(CASE WHEN type = 'replay' AND divergence IS NULL THEN 1 ELSE 0 END) AS clean,
                SUM(CASE WHEN type = 'replay' AND divergence IS NOT NULL THEN 1 ELSE 0 END) AS forked,
                SUM(tokens_not_respent) AS tokens
         FROM events WHERE at >= ? GROUP BY day ORDER BY day ASC`,
      )
      .all(d30)
      .map((r) => ({ day: String(r.day), installs: Number(r.installs), runs: Number(r.runs), replays: Number(r.replays), clean: Number(r.clean), forked: Number(r.forked), tokensNotRespent: Number(r.tokens) }));
    // Weeks start on Monday (UTC). Twelve of them, the current one last, empty ones kept so the chart has no gaps.
    const monday = (ms: number) => {
      const d = new Date(ms);
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d.getTime();
    };
    const firstWeek = monday(now) - 11 * 7 * DAY;
    const byWeek = new Map(
      this.db
        .prepare(
          `SELECT date(at / 1000, 'unixepoch', '-6 days', 'weekday 1') AS week,
                  COUNT(DISTINCT CASE WHEN type = 'replay' THEN install_id END) AS devs,
                  SUM(CASE WHEN type = 'replay' THEN 1 ELSE 0 END) AS replays
           FROM events WHERE at >= ? GROUP BY week`,
        )
        .all(firstWeek)
        .map((r) => [String(r.week), { activeDevelopers: Number(r.devs), replays: Number(r.replays) }]),
    );
    const weekly = Array.from({ length: 12 }, (_, i) => {
      const week = new Date(firstWeek + i * 7 * DAY).toISOString().slice(0, 10);
      return { week, ...(byWeek.get(week) ?? { activeDevelopers: 0, replays: 0 }) };
    });
    return {
      generatedAt: now,
      installs: {
        total: one(`SELECT COUNT(DISTINCT install_id) AS n FROM events`),
        active7d: one(`SELECT COUNT(DISTINCT install_id) AS n FROM events WHERE at >= ? AND type = 'replay'`, d7),
        active7dPrev: one(`SELECT COUNT(DISTINCT install_id) AS n FROM events WHERE at >= ? AND at < ? AND type = 'replay'`, now - 14 * DAY, d7),
        active30d: one(`SELECT COUNT(DISTINCT install_id) AS n FROM events WHERE at >= ? AND type = 'replay'`, d30),
        ci: one(`SELECT COUNT(DISTINCT install_id) AS n FROM events WHERE ci IS NOT NULL`),
      },
      events: {
        total: one(`SELECT COUNT(*) AS n FROM events`),
        last7d: one(`SELECT COUNT(*) AS n FROM events WHERE at >= ?`, d7),
        last30d: one(`SELECT COUNT(*) AS n FROM events WHERE at >= ?`, d30),
        byType: counts(`SELECT type AS k, COUNT(*) AS n FROM events GROUP BY type`),
      },
      replays: {
        total: one(`SELECT COUNT(*) AS n FROM events WHERE type = 'replay'`),
        clean: one(`SELECT COUNT(*) AS n FROM events WHERE type = 'replay' AND divergence IS NULL`),
        forked: one(`SELECT COUNT(*) AS n FROM events WHERE type = 'replay' AND divergence IS NOT NULL`),
        last30d: one(`SELECT COUNT(*) AS n FROM events WHERE type = 'replay' AND at >= ?`, d30),
        clean30d: one(`SELECT COUNT(*) AS n FROM events WHERE type = 'replay' AND divergence IS NULL AND at >= ?`, d30),
        divergenceByType: counts(`SELECT divergence AS k, COUNT(*) AS n FROM events WHERE divergence IS NOT NULL GROUP BY divergence`),
        falseDivergenceHintRate: null,
      },
      tokensNotRespent: one(`SELECT COALESCE(SUM(tokens_not_respent), 0) AS n FROM events`),
      callsReplayed: one(`SELECT COALESCE(SUM(replayed), 0) AS n FROM events`),
      providers: jsonListCounts('providers'),
      sdks: jsonListCounts('sdks'),
      versions: counts(`SELECT version AS k, COUNT(DISTINCT install_id) AS n FROM events WHERE at >= ? GROUP BY version`, d30),
      os: counts(`SELECT os AS k, COUNT(DISTINCT install_id) AS n FROM events WHERE at >= ? GROUP BY os`, d30),
      ciSystems: counts(`SELECT ci AS k, COUNT(DISTINCT install_id) AS n FROM events WHERE at >= ? AND ci IS NOT NULL GROUP BY ci`, d30),
      daily,
      weekly,
    };
  }
}
