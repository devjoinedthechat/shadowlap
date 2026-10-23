import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/index.js';

/**
 * The dashboard reads its store on threads of its own through connections that only read
 * (`Store.openReadOnly`), beside the connection that writes; and keeps what each finished
 * recording's user asked first apart from the run totals (`run_asks`), so its run index reads it with
 * each run.
 */

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sl-store-read-only-'));
  path = join(dir, 'shadowlap.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (store: Store) => {
  const r = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/work' } });
  store.endRun(r.runId, 'completed', Date.now());
  return r.runId;
};

describe('a connection that only reads', () => {
  it('reads what the writing connection wrote, and refuses any write of its own', () => {
    const writer = Store.open(path);
    const reader = Store.openReadOnly(path);
    try {
      const a = run(writer);
      expect(reader.getRun(a)?.runId).toBe(a);
      expect(() => reader.createRun({ mode: 'record', command: { argv: ['x'], cwd: '/' } })).toThrow(/readonly|read-only/i);
      // Best-effort keeps say they kept nothing, rather than throw.
      expect(reader.saveRunStats([{ runId: a, key: 'k', stats: '{}' }])).toBe(false);
      expect(reader.saveRunAsks([{ runId: a, key: 'k', ask: null }])).toBe(false);
      // A reader in the middle of a read holds no writer up.
      writer.transaction(() => run(writer));
      expect(reader.query('SELECT COUNT(*) AS n FROM runs')).toEqual([{ n: 2 }]);
    } finally {
      reader.close();
      writer.close();
    }
  });

  it('refuses a store from a newer Shadowlap, as open does', () => {
    const writer = Store.open(path);
    writer.close();
    const raw = Store.open(path);
    // Stamped as a version far ahead of this build's.
    (raw as unknown as { db: { exec(sql: string): void } }).db.exec(`UPDATE meta SET value = '999' WHERE key = 'schema_version'`);
    raw.close();
    expect(() => Store.openReadOnly(path)).toThrow(/newer Shadowlap/);
  });
});

describe('what recordings’ users asked first', () => {
  it('is kept per run, replaced when kept again, and goes with its run', () => {
    const store = Store.open(path);
    try {
      const a = run(store);
      const b = run(store);
      expect(store.saveRunAsks([{ runId: a, key: 'a1|completed|1|2', ask: JSON.stringify({ text: 'Refund order A-1042', agent: false, batch: false }) }, { runId: b, key: 'a1|completed|1|2', ask: null }])).toBe(true);
      // A run deleted meanwhile is skipped.
      expect(store.saveRunAsks([{ runId: 'GONE', key: 'k', ask: null }])).toBe(true);
      expect(store.query('SELECT run_id AS id, ask FROM run_asks ORDER BY rowid')).toEqual([
        { id: a, ask: '{"text":"Refund order A-1042","agent":false,"batch":false}' },
        { id: b, ask: null },
      ]);
      store.saveRunAsks([{ runId: b, key: 'a1|completed|1|3', ask: JSON.stringify({ text: 'Where is my order?', agent: false, batch: false }) }]);
      expect(store.query('SELECT key FROM run_asks WHERE run_id = ?', b)).toEqual([{ key: 'a1|completed|1|3' }]);
      store.deleteRun(a);
      expect(store.query('SELECT run_id AS id FROM run_asks')).toEqual([{ id: b }]);
    } finally {
      store.close();
    }
  });
});
