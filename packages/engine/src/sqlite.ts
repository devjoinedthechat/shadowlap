/**
 * node:sqlite, as every store of Shadowlap's opens it (the engine's, the telemetry collector's), and
 * the rollback a failed write needs. Its own module, with nothing else of the engine's, so the
 * collector loads it alone (`@shadowlap/engine/sqlite`).
 */
import { createRequire } from 'node:module';

/*
 * `node:sqlite` prints an ExperimentalWarning when loaded. Loading it through `require` (not a
 * hoisted `import`) lets us filter that one warning first; every other warning still surfaces.
 */
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = function patchedEmitWarning(warning: unknown, ...rest: unknown[]): void {
  const message = typeof warning === 'string' ? warning : (warning as { message?: string } | undefined)?.message;
  if (typeof message === 'string' && message.includes('SQLite is an experimental feature')) return;
  return (originalEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
};
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase };
export { DatabaseSync };

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
  /** Whether a transaction is open on this connection. */
  readonly isTransaction?: boolean;
}

/**
 * Undoes a failed write's transaction, or with `savepoint` what it did since that savepoint, unless
 * SQLite already undid the whole transaction itself: it does on some errors (a full disk, an I/O
 * error), and a ROLLBACK then fails with "no transaction is active" in place of the error that
 * ended it, which is the one to report.
 */
export function rollBack(db: SqliteDatabase, savepoint?: string): void {
  if (db.isTransaction === false) return;
  if (savepoint === undefined) {
    db.exec('ROLLBACK');
    return;
  }
  db.exec(`ROLLBACK TO ${savepoint}`);
  db.exec(`RELEASE ${savepoint}`);
}
