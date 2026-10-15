import { describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';

/** What the store offers read models: read-only queries SQLite itself holds to, and run totals kept between processes. */

describe('Store.query', () => {
  it('answers read-only statements, and SQLite refuses anything that would write', () => {
    const store = Store.open(':memory:');
    try {
      store.createRun({ mode: 'record', command: { argv: ['node', 'a.js'], cwd: '/w' }, startedAt: 5 });
      expect(store.query(`SELECT COUNT(*) AS n FROM runs WHERE started_at >= ?`, 1)).toEqual([{ n: 1 }]);
      expect(store.query(`WITH x AS (SELECT run_id FROM runs) SELECT COUNT(*) AS n FROM x`)).toEqual([{ n: 1 }]);
      // Words that look like writes are data in a string literal or a function name.
      expect(store.query(`SELECT 'delete me' AS s, replace('abc', 'b', 'x') AS r`)).toEqual([{ s: 'delete me', r: 'axc' }]);
      expect(() => store.query(`DELETE FROM runs`)).toThrow(/read-only/);
      // Statements a text check would let through: SQLite itself refuses them.
      expect(() => store.query(`WITH x AS (SELECT 1) DELETE FROM runs`)).toThrow(/readonly/);
      expect(() => store.query(`WITH x AS (SELECT 1 AS "a'") DELETE FROM runs WHERE 'b' = 'b'`)).toThrow(/readonly/);
      expect(() => store.query(`WITH x AS (SELECT 1) INSERT INTO meta (key, value) VALUES ('k', 'v') RETURNING key`)).toThrow(/readonly/);
      // Only the first statement of several runs.
      expect(store.query(`SELECT 1 AS one; DELETE FROM runs`)).toEqual([{ one: 1 }]);
      expect(store.query(`SELECT COUNT(*) AS n FROM runs`)).toEqual([{ n: 1 }]);
      // Writing works again afterwards, and many different statements don't pile up.
      store.createRun({ mode: 'record', command: { argv: ['node', 'b.js'], cwd: '/w' }, startedAt: 6 });
      for (let i = 0; i < 200; i++) expect(store.query(`SELECT ${i} AS i`)).toEqual([{ i }]);
      expect(store.allRuns()).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it('leaves a connection that was read-only before read-only after', () => {
    const store = Store.open(':memory:');
    try {
      // As a dashboard started read-only might hold its connection.
      (store as unknown as { db: { exec(sql: string): void } }).db.exec('PRAGMA query_only = ON');
      expect(store.query(`SELECT 1 AS one`)).toEqual([{ one: 1 }]);
      expect(() => store.createRun({ mode: 'record', command: { argv: ['node', 'a.js'], cwd: '/w' } })).toThrow(/readonly/);
    } finally {
      store.close();
    }
  });

  it('keeps run statistics only for runs that exist, and drops them with their run', () => {
    const store = Store.open(':memory:');
    try {
      const a = store.createRun({ mode: 'record', command: { argv: ['node', 'a.js'], cwd: '/w' }, startedAt: 5 });
      expect(store.saveRunStats([{ runId: a.runId, key: 'k1', stats: '{}' }, { runId: 'GONE', key: 'k1', stats: '{}' }])).toBe(true);
      expect(store.query(`SELECT run_id AS id, key FROM run_stats`)).toEqual([{ id: a.runId, key: 'k1' }]);
      expect(store.saveRunStats([{ runId: a.runId, key: 'k2', stats: '{"x":1}' }])).toBe(true);
      expect(store.query(`SELECT key, stats FROM run_stats`)).toEqual([{ key: 'k2', stats: '{"x":1}' }]);
      // Inside another transaction it can't write: it says so instead of throwing.
      expect(store.transaction(() => store.saveRunStats([{ runId: a.runId, key: 'k3', stats: '{}' }]))).toBe(false);
      store.deleteRun(a.runId);
      expect(store.query(`SELECT COUNT(*) AS n FROM run_stats`)).toEqual([{ n: 0 }]);
    } finally {
      store.close();
    }
  });
});
