import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkKey, recordBlame, SCHEMA_VERSION, Store } from '../src/index.js';
import { blameReport, EXPECT, makeRun } from './fix-fixtures.js';

/**
 * Store schema v6, what the dashboard's pages keep, added in one step: the advice put away
 * (dismissals), and its counter.
 */

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string) => { exec(sql: string): void; prepare(sql: string): { all(...a: unknown[]): Array<Record<string, unknown>> }; close(): void } };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const storePath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-store-v6-'));
  dirs.push(dir);
  return join(dir, 'shadowlap.db');
};

const blame = (store: Store, runId: string, o: { expect?: unknown; at?: number; actor?: string } = {}) =>
  recordBlame(store, { runId, report: blameReport(runId), expect: o.expect === undefined ? EXPECT : o.expect, scope: null, command: `shadowlap blame ${runId.slice(0, 10)}`, title: 'Refunds above the limit issued without approval', checkText: 'issue_refund with {"amount":240} called 0 times', at: o.at ?? 2_000, ...(o.actor ? { actor: o.actor } : {}), ci: null }).fix;

const EMAIL = { tools: { send_email: 1 } };
const migration = (sessionId: string, at = 3_000) => ({ sessionId, kind: 'migrate' as const, at, change: 'the model claude-sonnet-5-5', actor: 'dana@northwind.example', revision: 'd2e8a1f', data: { to: 'claude-sonnet-5-5' }, runs: [{ runId: '01RUNA', golden: 'goldens/refund-in-limit', rank: 3, changed: 1, data: { runId: '01RUNA' } }] });

/** The store at `path` taken back to what a v5 build kept: none of v6's tables, triggers or counters, and its version. */
function asVersion5(path: string): void {
  const raw = new DatabaseSync(path);
  const triggers = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'change_counts_dismissals_%'`).all().map((r) => String(r.name));
  expect(triggers).toHaveLength(3);
  for (const name of triggers) raw.exec(`DROP TRIGGER ${name}`);
  raw.exec(`DROP TABLE dismissals`);
  raw.exec(`DELETE FROM change_counts WHERE name = 'dismissals'; UPDATE meta SET value = '5' WHERE key = 'schema_version'`);
  raw.close();
}

describe('store schema v6', () => {
  it('upgrades a v5 store in place: it gains what v6 keeps, and nothing else changes', () => {
    expect(SCHEMA_VERSION).toBe(6);
    const path = storePath();
    const first = Store.open(path);
    blame(first, makeRun(first), { at: 2_000, actor: 'dana@northwind.example' });
    // A fix whose blame named nobody.
    blame(first, makeRun(first), { expect: EMAIL, at: 2_500 });
    const session = first.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'd2e8a1f', owner: null });
    first.addTestResult({ sessionId: session.sessionId, golden: 'goldens/refund-in-limit', ok: true });
    first.finishTestSession(session.sessionId, { passed: 1, failed: 0, upstreamRequests: 0 });
    first.putDecisionSession(migration('mg-01M50000000000000000000001'));
    first.close();
    asVersion5(path);

    const second = Store.open(path);
    expect(second.schemaVersion()).toBe(6);
    // What a v5 build kept reads back as it was.
    expect(second.listFixes().map((f) => f.check.key)).toEqual([checkKey(EMAIL), checkKey(EXPECT)]);
    expect(second.getTestSession(session.sessionId)).toMatchObject({ revision: 'd2e8a1f', passed: 1 });
    expect(second.getDecisionSession('mg-01M50000000000000000000001')).toMatchObject({ change: 'the model claude-sonnet-5-5' });
    expect(second.listDismissals()).toEqual([]);
    expect(second.changeCounts()).toMatchObject({ dismissals: 0 });
    // What v6 keeps, kept from now on.
    second.putDismissal({ key: 'coverage', facts: ['3f9a2c1d5e8b7a60'] });
    second.close();

    // Opened again, nothing is added twice, and what was kept reads back.
    const third = Store.open(path);
    expect(third.schemaVersion()).toBe(6);
    expect(third.listDismissals().map((d) => d.key)).toEqual(['coverage']);
    third.close();
  });

  it('refuses a store a newer Shadowlap wrote, as it always has', () => {
    const path = storePath();
    Store.open(path).close();
    const raw = new DatabaseSync(path);
    raw.exec(`UPDATE meta SET value = '${SCHEMA_VERSION + 1}' WHERE key = 'schema_version'`);
    raw.close();
    expect(() => Store.open(path)).toThrow(`${path} was written by a newer Shadowlap (store schema v7; this build understands v6). Upgrade Shadowlap, or point --db at another store.`);
    expect(() => Store.openReadOnly(path)).toThrow('this build understands v6');
  });
});
