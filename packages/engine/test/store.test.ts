import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadApiRequest, storeApiRequest } from '../src/manifest.js';
import { SCHEMA_VERSION, Store } from '../src/store.js';

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
});
