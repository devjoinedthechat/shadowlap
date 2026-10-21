import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadApiRequest, storeApiRequest } from '../src/manifest.js';
import { noFullTextSearch, SCHEMA_VERSION, Store } from '../src/store.js';

const cmd = { argv: ['node', 'agent.js'], cwd: '/tmp' };

describe('Store', () => {
  it('opens a new store from several processes at once', async () => {
    // Test workers each start a Shadowlap host on the same store at the same moment. The first to
    // switch the new database to WAL holds a lock; the others must wait for it, not fail.
    const dir = mkdtempSync(join(tmpdir(), 'fp-race-'));
    const db = join(dir, 'store.db');
    const storeModule = fileURLToPath(new URL('../dist/store.js', import.meta.url));
    const script = `const { Store } = await import(${JSON.stringify('file://' + storeModule)}); const s = Store.open(${JSON.stringify(db)}); s.createRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } }); s.close();`;
    const codes = await Promise.all(
      Array.from({ length: 16 }, () => new Promise<[number | null, string]>((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        child.stderr.on('data', (d: Buffer) => (err += d.toString()));
        child.on('exit', (code) => resolve([code, err]));
      })),
    );
    expect(codes.filter(([code]) => code !== 0).map(([, err]) => err)).toEqual([]);
    const store = Store.open(db);
    expect(store.allRuns()).toHaveLength(16);
    store.close();
  });

  it('keeps ids made in a burst in creation order when the clock moves on mid-burst', () => {
    const store = Store.open(':memory:');
    // Three ids in one millisecond take the next milliseconds along; when the clock then ticks once,
    // the next id must still sort after them, not land among them.
    const base = Date.now() + 60_000;
    const clock = vi.spyOn(Date, 'now');
    try {
      const ids: string[] = [];
      for (const now of [base, base, base, base + 1, base + 1, base + 5]) {
        clock.mockReturnValue(now);
        ids.push(store.addEvent({ kind: 'test.tick', at: now }).eventId);
      }
      ids.push(store.createRun({ mode: 'record', command: cmd }).runId);
      expect([...ids].sort()).toEqual(ids);
      expect(new Set(ids.map((id) => id.slice(0, 10))).size).toBe(ids.length);
    } finally {
      clock.mockRestore();
      store.close();
    }
  });

  it('creates the directory and a .gitignore that hides recordings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-'));
    const store = Store.open(join(dir, '.shadowlap', 'shadowlap.db'));
    expect(existsSync(join(dir, '.shadowlap', '.gitignore'))).toBe(true);
    expect(readFileSync(join(dir, '.shadowlap', '.gitignore'), 'utf8')).toBe('*\n');
    store.close();
  });

  it.skipIf(process.platform === 'win32')('keeps recordings readable only by their owner', () => {
    const root = mkdtempSync(join(tmpdir(), 'fp-store-perm-'));
    const path = join(root, '.shadowlap', 'shadowlap.db');
    const store = Store.open(path);
    store.putBlob(Buffer.from('a prompt'));
    const mode = (f: string) => statSync(f).mode & 0o777;
    expect(mode(join(root, '.shadowlap'))).toBe(0o700);
    expect(mode(path)).toBe(0o600);
    expect(mode(`${path}-wal`)).toBe(0o600);
    store.close();

    // A store made by an earlier version is tightened when opened.
    const old = join(root, 'old.db');
    Store.open(old).close();
    chmodSync(old, 0o644);
    Store.open(old).close();
    expect(mode(old)).toBe(0o600);

    // A symbolic link planted where the .gitignore goes is not followed.
    const planted = join(root, 'planted');
    mkdirSync(planted);
    symlinkSync(join(root, 'elsewhere.txt'), join(planted, '.gitignore'));
    Store.open(join(planted, 'shadowlap.db')).close();
    expect(existsSync(join(root, 'elsewhere.txt'))).toBe(false);
  });

  it('round-trips blobs above and below the gzip threshold, content-addressed', () => {
    const store = Store.open(':memory:');
    const small = Buffer.from('hello');
    const big = Buffer.alloc(4096, 'x');
    const h1 = store.putBlob(small);
    const h2 = store.putBlob(big);
    expect(store.putBlob(small)).toBe(h1);
    expect(store.getBlob(h1)?.toString()).toBe('hello');
    expect(store.getBlob(h2)?.equals(big)).toBe(true);
    expect(store.getBlob('0'.repeat(64))).toBeNull();
    store.close();
  });

  it('records runs, folds call events with attempts, and resolves id prefixes', () => {
    const store = Store.open(':memory:');
    const run = store.createRun({ mode: 'record', command: cmd });
    expect(store.getRun(run.runId)?.status).toBe('running');
    expect(store.findRun(run.runId.slice(0, 8).toLowerCase())?.runId).toBe(run.runId);

    const id = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'f'.repeat(64), occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo: 1, ...id, origin: 'live', effect: null, requestRef: null, meta: {}, at: 1 });
    store.appendCallEnd(id, { runId: run.runId, callNo: 1, attempt: 0, responseRef: null, outcome: 'error', meta: { status: 429, retryable: true }, at: 2 });
    store.appendCallEnd(id, { runId: run.runId, callNo: 1, attempt: 1, responseRef: store.putJson({ ok: true }), outcome: 'ok', meta: { status: 200 }, at: 3 });
    store.appendCallStart({ runId: run.runId, callNo: 2, kind: 'tool', name: 't', fingerprint: 'a'.repeat(64), occurrence: 1, origin: 'live', effect: 'read', requestRef: null, meta: {}, at: 4 });

    const calls = store.getCalls(run.runId);
    expect(calls.map((c) => c.callNo)).toEqual([1, 2]);
    expect(calls[0]!.end?.outcome).toBe('ok');
    expect(calls[0]!.end?.attempt).toBe(1);
    expect(calls[0]!.attempts).toHaveLength(1);
    expect(calls[0]!.attempts[0]!.meta.status).toBe(429);
    expect(calls[1]!.end).toBeNull();
    expect(store.nextCallNo(run.runId)).toBe(3);

    const child = store.createRun({ mode: 'replay', parentRunId: run.runId, command: cmd });
    store.setDivergence(child.runId, { type: 'new_call', callNo: 3, kind: 'tool', name: 'x', replayedBefore: 2 });
    store.endRun(child.runId, 'completed');
    expect(store.childRuns(run.runId).map((r) => r.runId)).toEqual([child.runId]);
    expect(store.getRun(child.runId)?.divergence?.type).toBe('new_call');
    expect(store.getRun(child.runId)?.status).toBe('completed');
    expect(store.listRuns()[0]!.runId).toBe(child.runId);
    store.close();
  });

  it('links a run that came without its parent once the parent is here, and never into a loop', () => {
    const store = Store.open(':memory:');
    const parent = store.createRun({ mode: 'record', command: cmd });
    const fork = store.createRun({ mode: 'replay', parentRunId: parent.runId, command: cmd });
    const record = store.getRun(fork.runId)!;
    // The fork came without its parent: imported while the parent wasn't here.
    store.deleteRun(fork.runId);
    store.deleteRun(parent.runId);
    store.importRun(record);
    expect(store.getRun(fork.runId)!.parentRunId).toBeNull();
    expect(store.linkParent(fork.runId, parent.runId)).toBe(false); // not here yet
    store.importRun({ ...store.getRun(fork.runId)!, runId: parent.runId, parentRunId: null });
    expect(store.linkParent(fork.runId, parent.runId)).toBe(true);
    expect(store.getRun(fork.runId)!.parentRunId).toBe(parent.runId);
    // A link already set stays, and a run is never made its own ancestor.
    const other = store.createRun({ mode: 'record', command: cmd });
    expect(store.linkParent(fork.runId, other.runId)).toBe(false);
    expect(store.linkParent(parent.runId, fork.runId)).toBe(false);
    expect(store.linkParent(other.runId, other.runId)).toBe(false);
    expect(store.getRun(parent.runId)!.parentRunId).toBeNull();
    store.close();
  });
});

describe('a judge check’s calls', () => {
  /** Five calls: none in a scope, two in the agent's own scopes, and two in the judge's. */
  const record = (store: Store) => {
    const run = store.createRun({ mode: 'record', command: cmd });
    [undefined, 'triage', 'shadowlap:judge', 'shadowlap:judged', 'shadowlap:judge'].forEach((scope, i) => {
      const id = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: String(i).padStart(64, 'f'), occurrence: 1 };
      store.appendCallStart({ runId: run.runId, callNo: i + 1, ...id, origin: 'live', effect: null, requestRef: null, meta: scope ? { scope } : {}, at: i });
      // The scope is the request's: an answer that names one is not counted by it.
      store.appendCallEnd(id, { runId: run.runId, callNo: i + 1, attempt: 0, responseRef: null, outcome: 'ok', meta: { scope: 'shadowlap:judge' }, at: i });
    });
    return run.runId;
  };
  /** What the index of judge calls holds: a run and call number per judge call. */
  const indexed = (store: Store) => store.query(`SELECT run_id AS runId, call_no AS callNo FROM call_events INDEXED BY call_events_judge WHERE phase = 'start' AND json_extract(meta, '$.scope') = 'shadowlap:judge'`);

  it('are left out of the agent’s through an index of their own, which a store from before it gets on opening', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fp-judge-')), 's.db');
    const store = Store.open(path);
    const runId = record(store);
    expect([store.countCalls(runId), store.countAgentCalls(runId)]).toEqual([5, 3]);
    expect(indexed(store)).toEqual([{ runId, callNo: 3 }, { runId, callNo: 5 }]);
    store.close();
    const { DatabaseSync } = await import('node:sqlite');
    const before = new DatabaseSync(path);
    before.exec('DROP INDEX call_events_judge');
    before.close();
    const opened = Store.open(path);
    expect([opened.countCalls(runId), opened.countAgentCalls(runId)]).toEqual([5, 3]);
    expect(indexed(opened)).toEqual([{ runId, callNo: 3 }, { runId, callNo: 5 }]);
    opened.close();
  });

  it('are indexed by a condition SQLite before 3.38 reads, as is all of the schema: no -> or ->>', () => {
    // SQLite reads a store's whole schema before any table: one ->> in it, and the sqlite3 of Ubuntu
    // 22.04 or macOS 12 reads nothing in the store.
    const store = Store.open(':memory:');
    expect(store.query(`SELECT name FROM sqlite_master WHERE sql LIKE '%->%'`)).toEqual([]);
    store.close();
  });
});

describe('request manifests', () => {
  it('chunks conversations so shared messages are stored once', () => {
    const store = Store.open(':memory:');
    const turn1 = { model: 'm', system: 'S', tools: [{ name: 't' }], messages: [{ role: 'user', content: 'a' }] };
    const turn2 = { ...turn1, messages: [...turn1.messages, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] };
    const r1 = storeApiRequest(store, turn1);
    const r2 = storeApiRequest(store, turn2);
    expect(loadApiRequest(store, r1)).toEqual(turn1);
    expect(loadApiRequest(store, r2)).toEqual(turn2);
    // The manifests differ but the first message, system and tools blobs are shared.
    const m1 = store.getJson<{ messages: string[]; system: string; tools: string }>(r1)!;
    const m2 = store.getJson<{ messages: string[]; system: string; tools: string }>(r2)!;
    expect(m2.messages[0]).toBe(m1.messages[0]);
    expect(m2.system).toBe(m1.system);
    expect(m2.tools).toBe(m1.tools);
    store.close();
  });

  it('stores non-conversation bodies whole', () => {
    const store = Store.open(':memory:');
    expect(loadApiRequest(store, storeApiRequest(store, { a: 1 }))).toEqual({ a: 1 });
    expect(loadApiRequest(store, storeApiRequest(store, 'raw text'))).toBe('raw text');
    expect(Buffer.isBuffer(loadApiRequest(store, storeApiRequest(store, Buffer.from([1, 2]))))).toBe(true);
    store.close();
  });
});

describe('store schema version', () => {
  const freshDir = () => mkdtempSync(join(tmpdir(), 'fp-schema-'));
  const stamp = async (path: string, version: string) => {
    const { DatabaseSync } = (await import('node:sqlite')) as unknown as { DatabaseSync: new (p: string) => { prepare(sql: string): { run(...a: unknown[]): void }; close(): void } };
    const db = new DatabaseSync(path);
    db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(version);
    db.close();
  };

  it('reports the version the store was written under, not the one this build compiles with', () => {
    const path = join(freshDir(), 's.db');
    const store = Store.open(path);
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    store.close();
  });

  it('refuses a store written by a newer Shadowlap instead of using it', async () => {
    const path = join(freshDir(), 's.db');
    Store.open(path).close();
    await stamp(path, String(SCHEMA_VERSION + 1));
    // Migrations are additive, so without this guard every CREATE IF NOT EXISTS would no-op, the
    // version would be stamped backwards, and the recording would be read under stale assumptions.
    expect(() => Store.open(path)).toThrow(/written by a newer Shadowlap/);
  });

  it('blames a Node whose SQLite has no full-text search, not the file, and names the Node that has it', () => {
    // Node 22.13 to 22.15 and every Node 23: SQLite answers "no such module: fts5" for the index every store has.
    expect(noFullTextSearch('v22.13.0')).toBe('Node 22.13.0 has no full-text search (FTS5) in its built-in SQLite, which the store needs: use Node 22.16 or later (not 23)');
    expect(noFullTextSearch('v23.11.1')).toBe('Node 23.11.1, like every Node 23, has no full-text search (FTS5) in its built-in SQLite, which the store needs: use Node 22.16 or later (not 23)');
    expect(noFullTextSearch('v22.15.1')).toContain('use Node 22.16 or later (not 23)');
  });

  it('blames the build, not the version, of a Node in range whose SQLite has no full-text search', () => {
    // Every official build of 22.16 and later, and of 24 and later, has it: a custom or a distribution's build may leave it out, which another version wouldn't mend.
    expect(noFullTextSearch('v22.18.0')).toBe('this build of Node 22.18.0 has no full-text search (FTS5) in its built-in SQLite, which the store needs: use an official Node build');
    expect(noFullTextSearch('v24.1.0')).toBe('this build of Node 24.1.0 has no full-text search (FTS5) in its built-in SQLite, which the store needs: use an official Node build');
    expect(noFullTextSearch('v22.16.0')).toContain('use an official Node build');
    expect(noFullTextSearch('v25.0.0')).toContain('use an official Node build');
  });

  it('names both versions, so the message says what to do', async () => {
    const path = join(freshDir(), 's.db');
    Store.open(path).close();
    await stamp(path, '99');
    expect(() => Store.open(path)).toThrow(new RegExp(`v99.*understands v${SCHEMA_VERSION}`));
  });

  it('upgrades an older store in place', async () => {
    const path = join(freshDir(), 's.db');
    const first = Store.open(path);
    const run = first.createRun({ mode: 'record', command: cmd });
    first.close();
    await stamp(path, '1');
    const second = Store.open(path);
    expect(second.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(second.getRun(run.runId)?.runId).toBe(run.runId);
    second.close();
  });

  it('upgrades a v4 store to v5, which keeps the process running each session of error-path presets and what scored attempts\' judges cost', async () => {
    expect(SCHEMA_VERSION).toBe(5);
    const path = join(freshDir(), 's.db');
    const first = Store.open(path);
    // A session a v4 build started and never ended (its process was killed), and one that ended.
    first.startChaosSession({ sessionId: 'LEFT', startedAt: 10, command: ['shadowlap', 'test', 'goldens/*', '--chaos'], presets: ['timeout'], owner: null });
    first.startChaosSession({ sessionId: 'DONE', startedAt: 20, command: ['shadowlap', 'replay', 'R1', '--chaos'], presets: ['429'], owner: null });
    first.finishChaosSession('DONE', { passed: 1, failed: 0, inconclusive: 0, upstreamRequests: 2, endedAt: 30 });
    first.close();
    // The store as a v4 build left it: no table for the sessions' processes, no column for what a
    // scored attempt's judge checks cost (a v4 score's spend counted them), and its version.
    const { DatabaseSync } = (await import('node:sqlite')) as unknown as { DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void } };
    const raw = new DatabaseSync(path);
    raw.exec(`DROP TABLE chaos_session_owners; ALTER TABLE task_scores DROP COLUMN judge_spent; UPDATE meta SET value = '4' WHERE key = 'schema_version'`);
    raw.exec(`INSERT INTO task_scores (model, base_url, golden, attempt, run_id, score, checks, spent, via, session, at) VALUES ('claude-haiku-4-5', '', 'goldens/a', 1, 'R1', 1, '[]', 0.012, 'Anthropic API', 's4', 40)`);
    raw.close();

    const second = Store.open(path);
    expect(second.schemaVersion()).toBe(5);
    expect(second.listChaosSessions().map((s) => [s.sessionId, s.endedAt])).toEqual([
      ['DONE', 30],
      ['LEFT', null],
    ]);
    // The one left open names no process: it reads as one that did not finish, never as running.
    expect(second.chaosSessionOwner('LEFT')).toBeNull();
    // A session started now names this process until it ends, and the row goes with it.
    const now = second.startChaosSession({ command: ['shadowlap', 'test', 'goldens/*', '--chaos'], presets: ['timeout'] });
    expect(second.chaosSessionOwner(now.sessionId)).toEqual({ pid: process.pid, host: hostname() });
    second.finishChaosSession(now.sessionId, { passed: 0, failed: 0, inconclusive: 0, upstreamRequests: 0 });
    expect(second.chaosSessionOwner(now.sessionId)).toBeNull();
    // One recorded elsewhere names none.
    expect(second.chaosSessionOwner(second.startChaosSession({ command: ['shadowlap', 'test', 'goldens/a', '--chaos'], presets: ['500'], owner: null }).sessionId)).toBeNull();
    // The v4 score reads as having no judge spend apart; one kept now keeps it.
    expect(second.listTaskScores().map((r) => [r.golden, r.spent, r.judgeSpent])).toEqual([['goldens/a', 0.012, null]]);
    second.replaceTaskScores('claude-haiku-4-5', null, 'goldens/b', [{ attempt: 1, runId: 'R2', score: 1, checks: [], spent: 0.01, judgeSpent: 0.002, via: 'Anthropic API', session: 's5', at: 50 }]);
    expect(second.listTaskScores().map((r) => [r.golden, r.spent, r.judgeSpent])).toEqual([
      ['goldens/a', 0.012, null],
      ['goldens/b', 0.01, 0.002],
    ]);
    second.close();
    // Opened again, nothing is migrated twice.
    const third = Store.open(path);
    expect(third.schemaVersion()).toBe(5);
    expect(third.listChaosSessions()).toHaveLength(4);
    expect(third.listTaskScores().map((r) => r.judgeSpent)).toEqual([null, 0.002]);
    third.close();
  });
});
