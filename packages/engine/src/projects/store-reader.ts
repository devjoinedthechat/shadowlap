import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { SCHEMA_VERSION, rowToRun, type StoredEvent } from '../store.js';
import type { RunRecord } from '../types.js';
import { emptyStoreFacts, storeFacts, type FactsSource, type StoreFacts } from './setup.js';

/**
 * Reading another project's store without changing it. `Store.open` creates what is missing and
 * brings an older store up to this version's schema, which a project pinned to an older Shadowlap
 * would then refuse; listing projects in the switcher, or looking at one before adding it, must do
 * neither, nor keep a connection per project open. This opens a read-only SQLite connection, reads
 * what the setup and the counts need, and closes it. Nothing is created or migrated: an older store
 * is read as it is (a table it doesn't have yet reads as empty), and one written by a newer
 * Shadowlap is refused, as `Store.open` refuses it.
 */

const require = createRequire(import.meta.url);

interface ReadOnlyStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
}
interface ReadOnlyDatabase {
  exec(sql: string): void;
  prepare(sql: string): ReadOnlyStatement;
  close(): void;
}

/** A store opened read-only: the runs, call counts and activity events the setup reads. */
export class StoreReader implements FactsSource {
  private countStmt: ReadOnlyStatement | null = null;

  constructor(
    private readonly db: ReadOnlyDatabase,
    private readonly tables: ReadonlySet<string>,
  ) {}

  allRuns(): RunRecord[] {
    if (!this.tables.has('runs')) return [];
    return this.db.prepare(`SELECT * FROM runs ORDER BY started_at DESC, run_id DESC`).all().map(rowToRun);
  }

  /** Runs still marked running, newest first. */
  runningRuns(): RunRecord[] {
    if (!this.tables.has('runs')) return [];
    return this.db.prepare(`SELECT * FROM runs WHERE status = 'running' ORDER BY started_at DESC`).all().map(rowToRun);
  }

  countCalls(runId: string): number {
    if (!this.tables.has('call_events')) return 0;
    this.countStmt ??= this.db.prepare(`SELECT COUNT(*) AS n FROM call_events WHERE run_id = ? AND phase = 'start'`);
    return Number(this.countStmt.get(runId)?.n ?? 0);
  }

  calledTools(runId: string): string[] {
    if (!this.tables.has('call_events')) return [];
    return this.db
      .prepare(`SELECT DISTINCT name FROM call_events WHERE run_id = ? AND kind = 'tool' AND phase = 'start'`)
      .all(runId)
      .map((r) => String(r.name));
  }

  listEvents(options: { kinds?: string[]; limit?: number } = {}): StoredEvent[] {
    if (!this.tables.has('events')) return [];
    const kinds = options.kinds ?? [];
    const where = kinds.length ? `WHERE kind IN (${kinds.map(() => '?').join(', ')})` : '';
    const rows = this.db.prepare(`SELECT * FROM events ${where} ORDER BY at DESC, event_id DESC LIMIT ?`).all(...kinds, Math.max(1, Math.min(10_000, options.limit ?? 100)));
    return rows.map((r) => ({
      eventId: String(r.event_id),
      at: Number(r.at),
      kind: String(r.kind),
      actor: r.actor === null || r.actor === undefined ? null : String(r.actor),
      runId: r.run_id === null || r.run_id === undefined ? null : String(r.run_id),
      ref: r.ref === null || r.ref === undefined ? null : String(r.ref),
      data: parseData(r.data),
    }));
  }
}

function parseData(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Runs `read` over the store at `path`, opened read-only and closed afterwards. Throws when the file
 * can't be opened, isn't a database, or was written by a newer Shadowlap.
 */
export function readStore<T>(path: string, read: (store: StoreReader) => T): T {
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string, options: { readOnly: boolean }) => ReadOnlyDatabase };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    // Another process may be writing (a recording): wait for it rather than fail.
    db.exec('PRAGMA busy_timeout = 10000');
    const tables = new Set(
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all()
        .map((r) => String(r.name)),
    );
    const version = tables.has('meta') ? Number(db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()?.value) : Number.NaN;
    if (Number.isInteger(version) && version > SCHEMA_VERSION) throw new Error(`${path} was written by a newer Shadowlap (store schema v${version}; this build understands v${SCHEMA_VERSION}). Upgrade Shadowlap to read it.`);
    return read(new StoreReader(db, tables));
  } finally {
    db.close();
  }
}

/** What a project's store says about its setup ({@link storeFacts}), read without changing it; empty facts when there is no store. */
export function readStoreFacts(path: string, now: number = Date.now(), options: { keep?: string | null } = {}): StoreFacts {
  if (!existsSync(path)) return emptyStoreFacts();
  return readStore(path, (store) => storeFacts(store, now, options));
}
