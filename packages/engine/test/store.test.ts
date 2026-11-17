import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadApiRequest, storeApiRequest } from '../src/manifest.js';
import { noFullTextSearch, SCHEMA_VERSION, Store } from '../src/store.js';

const cmd = { argv: ['node', 'agent.js'], cwd: '/tmp' };

describe('Store', () => {
  it('opens a new store from several processes at once', async () => {
    // Test workers each start a shadowlap host on the same store at the same moment. The first to
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

  it('opens a store that is there for writing, and makes none, nor its directory, where there is none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-existing-'));
    try {
      const path = join(dir, '.shadowlap', 'shadowlap.db');
      expect(() => Store.openExisting(path)).toThrow(`There is no store at ${path}.`);
      expect(readdirSync(dir)).toEqual([]);
      // One that is there opens as open opens it, for writing.
      Store.open(path).close();
      const store = Store.openExisting(path);
      const run = store.createRun({ mode: 'record', command: cmd });
      expect(store.getRun(run.runId)?.runId).toBe(run.runId);
      store.close();
      // Deleted since, as deleting a project's recordings deletes it: nothing is made in its place.
      for (const name of ['shadowlap.db', 'shadowlap.db-wal', 'shadowlap.db-shm']) rmSync(join(dir, '.shadowlap', name), { force: true });
      expect(() => Store.openExisting(path)).toThrow(`There is no store at ${path}.`);
      expect(readdirSync(join(dir, '.shadowlap'))).toEqual(['.gitignore']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it.skipIf(process.platform === 'win32')('keeps a store only in a directory of its own user that not every user can write to, never through a link', () => {
    const root = mkdtempSync(join(tmpdir(), 'fp-store-dir-'));
    try {
      // A link where the store's directory goes, to a directory elsewhere: refused, and nothing
      // written there, a .gitignore included.
      const elsewhere = join(root, 'elsewhere');
      mkdirSync(elsewhere, { mode: 0o700 });
      const linked = join(root, '.shadowlap');
      symlinkSync(elsewhere, linked);
      expect(() => Store.open(join(linked, 'shadowlap.db'))).toThrow(`${linked} is a symbolic link: a store is kept only in a directory of its own, never through a link to one elsewhere`);
      expect(readdirSync(elsewhere)).toEqual([]);
      // A store already there, read through the link: refused too.
      Store.open(join(elsewhere, 'shadowlap.db')).close();
      expect(() => Store.openReadOnly(join(linked, 'shadowlap.db'))).toThrow(`${linked} is a symbolic link`);
      expect(() => Store.open(join(linked, 'shadowlap.db'))).toThrow(`${linked} is a symbolic link`);
      // A link to no directory yet isn't followed to make one.
      const dangling = join(root, 'dangling');
      symlinkSync(join(root, 'made-elsewhere'), dangling);
      expect(() => Store.open(join(dangling, 'shadowlap.db'))).toThrow(`${dangling} is a symbolic link`);
      expect(existsSync(join(root, 'made-elsewhere'))).toBe(false);
      // A directory every user can write to, with the sticky bit a shared /tmp has too: whoever can
      // write there can put a link where the WAL goes. Refused, and nothing written there.
      for (const mode of [0o777, 0o1777, 0o703]) {
        const open = join(root, `open-${mode.toString(8)}`);
        mkdirSync(open);
        chmodSync(open, mode);
        expect(() => Store.open(join(open, 'shadowlap.db')), mode.toString(8)).toThrow(`${open} can be written by every user: a store is kept only in a directory that not everyone can write to`);
        expect(readdirSync(open)).toEqual([]);
        // Nor is a store there read once it is.
        chmodSync(open, 0o700);
        Store.open(join(open, 'shadowlap.db')).close();
        chmodSync(open, mode);
        expect(() => Store.openReadOnly(join(open, 'shadowlap.db')), mode.toString(8)).toThrow(`${open} can be written by every user`);
      }
      // One in a directory another user keeps that every user can change: whoever can write there
      // can put another directory in its place. Refused, unless the directory is sticky, as a shared
      // /tmp is, or is this user's own (a CI job's checkout under a umask of 0).
      const shared = join(root, 'open-parent');
      mkdirSync(shared);
      chmodSync(shared, 0o777);
      const inside = join(shared, '.shadowlap');
      mkdirSync(inside, { mode: 0o700 });
      Store.open(join(inside, 'shadowlap.db')).close();
      const me = process.getuid!();
      const other = vi.spyOn(process, 'getuid').mockReturnValue(me + 1);
      try {
        expect(() => Store.open(join(inside, 'shadowlap.db'))).toThrow(`${shared}, the directory ${inside} is in, belongs to another user (uid ${me}) and every user can change it`);
        chmodSync(shared, 0o1777);
        // Sticky: past it, to the directory's own owner.
        expect(() => Store.open(join(inside, 'shadowlap.db'))).toThrow(`${inside} belongs to another user (uid ${me})`);
      } finally {
        other.mockRestore();
        chmodSync(shared, 0o700);
      }
      // One that belongs to another user, as lstat would say it: refused, and nothing written there.
      const theirs = join(root, 'theirs');
      mkdirSync(theirs, { mode: 0o700 });
      const uid = process.getuid!();
      const asked = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
      try {
        expect(() => Store.open(join(theirs, 'shadowlap.db'))).toThrow(`${theirs} belongs to another user (uid ${uid}): a store is kept only in a directory of yours`);
      } finally {
        asked.mockRestore();
      }
      expect(readdirSync(theirs)).toEqual([]);
      // One its group can write to: refused as well, and nothing written there.
      for (const mode of [0o770, 0o775]) {
        const grouped = join(root, `group-${mode.toString(8)}`);
        mkdirSync(grouped);
        chmodSync(grouped, mode);
        expect(() => Store.open(join(grouped, 'shadowlap.db')), mode.toString(8)).toThrow(`${grouped} can be written by its group: a store is kept only in a directory no one else can write to`);
        expect(readdirSync(grouped)).toEqual([]);
      }
      // A directory of this user's that only they can write to holds one.
      for (const mode of [0o700, 0o750, 0o755]) {
        const mine = join(root, `mine-${mode.toString(8)}`);
        mkdirSync(mine);
        chmodSync(mine, mode);
        Store.open(join(mine, 'shadowlap.db')).close();
        Store.openReadOnly(join(mine, 'shadowlap.db')).close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('opens a store only as a regular file of its own user, never through a link, and makes a new one so', () => {
    const root = mkdtempSync(join(tmpdir(), 'fp-store-file-'));
    try {
      const victim = join(root, 'victim.txt');
      writeFileSync(victim, 'not a store\n');
      // A link planted where the store goes, to a file elsewhere: refused, and the file left as it was.
      const linked = join(root, 'linked');
      mkdirSync(linked);
      symlinkSync(victim, join(linked, 'shadowlap.db'));
      expect(() => Store.open(join(linked, 'shadowlap.db'))).toThrow(/is a symbolic link: a store is opened only as a file of its own/);
      expect(() => Store.openReadOnly(join(linked, 'shadowlap.db'))).toThrow(/symbolic link/);
      expect(readFileSync(victim, 'utf8')).toBe('not a store\n');
      // A link to a file not there yet is not followed to make one.
      const dangling = join(root, 'dangling');
      mkdirSync(dangling);
      symlinkSync(join(root, 'made-elsewhere.db'), join(dangling, 'shadowlap.db'));
      expect(() => Store.open(join(dangling, 'shadowlap.db'))).toThrow(/symbolic link/);
      expect(existsSync(join(root, 'made-elsewhere.db'))).toBe(false);
      // Its write-ahead log or shared-memory file, planted as a link: refused the same.
      for (const suffix of ['-wal', '-shm']) {
        const dir = join(root, `planted${suffix}`);
        mkdirSync(dir);
        Store.open(join(dir, 'shadowlap.db')).close();
        symlinkSync(victim, join(dir, `shadowlap.db${suffix}`));
        expect(() => Store.open(join(dir, 'shadowlap.db')), suffix).toThrow(new RegExp(`shadowlap\\.db${suffix} is a symbolic link`));
      }
      expect(readFileSync(victim, 'utf8')).toBe('not a store\n');
      // A folder where the store goes.
      const folder = join(root, 'folder');
      mkdirSync(join(folder, 'shadowlap.db'), { recursive: true });
      expect(() => Store.open(join(folder, 'shadowlap.db'))).toThrow(/is not a file/);
      // One that belongs to another user, as lstat would say it.
      const theirs = join(root, 'theirs.db');
      Store.open(theirs).close();
      const uid = process.getuid!();
      const asked = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
      try {
        expect(() => Store.open(theirs)).toThrow(/belongs to another user/);
        expect(() => Store.openReadOnly(theirs)).toThrow(/belongs to another user/);
      } finally {
        asked.mockRestore();
      }
      // A new store is made readable only by its owner, and opens again.
      const fresh = join(root, 'fresh.db');
      Store.open(fresh).close();
      expect(statSync(fresh).mode & 0o777).toBe(0o600);
      Store.open(fresh).close();
      Store.openReadOnly(fresh).close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    expect(calls[0].end?.outcome).toBe('ok');
    expect(calls[0].end?.attempt).toBe(1);
    expect(calls[0].attempts).toHaveLength(1);
    expect(calls[0].attempts[0].meta.status).toBe(429);
    expect(calls[1].end).toBeNull();
    expect(store.nextCallNo(run.runId)).toBe(3);

    const child = store.createRun({ mode: 'replay', parentRunId: run.runId, command: cmd });
    store.setDivergence(child.runId, { type: 'new_call', callNo: 3, kind: 'tool', name: 'x', replayedBefore: 2 });
    store.endRun(child.runId, 'completed');
    expect(store.childRuns(run.runId).map((r) => r.runId)).toEqual([child.runId]);
    expect(store.getRun(child.runId)?.divergence?.type).toBe('new_call');
    expect(store.getRun(child.runId)?.status).toBe('completed');
    expect(store.listRuns()[0].runId).toBe(child.runId);
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

  it('starts a run whole or not at all: its record, its metadata and the process recording it', () => {
    const store = Store.open(':memory:');
    const db = (store as unknown as { db: { exec(sql: string): void } }).db;
    // The last of its writes refused, as a full disk refuses one.
    db.exec(`CREATE TEMP TRIGGER refuse_owner BEFORE INSERT ON run_owners BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`);
    expect(() => store.createRun({ mode: 'record', command: cmd, meta: { labels: ['first'] } })).toThrow('database or disk is full');
    // No run is left recording with no process to end it.
    expect(store.listRuns()).toEqual([]);
    db.exec('DROP TRIGGER refuse_owner');
    // In a transaction the caller has open, as the sidecar writes a run's start: a part of it.
    const later = new Error('a later write failed');
    expect(() =>
      store.transaction(() => {
        store.createRun({ mode: 'record', command: cmd });
        throw later;
      }),
    ).toThrow(later);
    expect(store.listRuns()).toEqual([]);
    const run = store.createRun({ mode: 'record', command: cmd, meta: { labels: ['first'] } });
    expect(store.getRun(run.runId)?.meta).toEqual({ labels: ['first'] });
    expect(store.recordingRuns().live.map((r) => r.run.runId)).toEqual([run.runId]);
    store.close();
  });

  it('ends a run whole or not at all: its status and end, and the process that recorded it let go', () => {
    const store = Store.open(':memory:');
    const db = (store as unknown as { db: { exec(sql: string): void } }).db;
    const run = store.createRun({ mode: 'record', command: cmd });
    // The last of its writes refused, as a full disk refuses one.
    db.exec(`CREATE TEMP TRIGGER refuse_release BEFORE DELETE ON run_owners BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`);
    expect(() => store.endRun(run.runId, 'completed')).toThrow('database or disk is full');
    // Still recording, as its process still holds it: never ended with an owner left behind.
    expect(store.getRun(run.runId)?.status).toBe('running');
    expect(store.recordingRuns().live.map((r) => r.run.runId)).toEqual([run.runId]);
    db.exec('DROP TRIGGER refuse_release');
    store.endRun(run.runId, 'completed', 5_000);
    expect(store.getRun(run.runId)).toMatchObject({ status: 'completed', endedAt: 5_000 });
    expect(store.recordingRuns().live).toEqual([]);
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

  it('refuses a store written by a newer shadowlap instead of using it', async () => {
    const path = join(freshDir(), 's.db');
    Store.open(path).close();
    await stamp(path, String(SCHEMA_VERSION + 1));
    // Migrations are additive, so without this guard every CREATE IF NOT EXISTS would no-op, the
    // version would be stamped backwards, and the recording would be read under stale assumptions.
    expect(() => Store.open(path)).toThrow(/written by a newer shadowlap/);
  });

  it('blames a Node whose SQLite has no full-text search, not the file, and names the Node that has it', () => {
    // Node 22.13 to 22.15 and every Node 23: SQLite answers "no such module: fts5" for the index every store has.
    expect(noFullTextSearch('v22.13.0')).toBe('Node 22.13.0 has no full-text search (FTS5) in its built-in SQLite, which the store needs: use Node 22.17 or later (not 23)');
    expect(noFullTextSearch('v23.11.1')).toBe('Node 23.11.1, like every Node 23, has no full-text search (FTS5) in its built-in SQLite, which the store needs: use Node 22.17 or later (not 23)');
    expect(noFullTextSearch('v22.15.1')).toContain('use Node 22.17 or later (not 23)');
  });

  it('blames the build, not the version, of a Node whose official builds have full-text search but whose SQLite has none', () => {
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

  it('upgrades a v4 store, which gains v5\'s process running each session of error-path presets and what scored attempts\' judges cost', async () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
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
    expect(second.schemaVersion()).toBe(SCHEMA_VERSION);
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
    expect(third.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(third.listChaosSessions()).toHaveLength(4);
    expect(third.listTaskScores().map((r) => r.judgeSpent)).toEqual([null, 0.002]);
    third.close();
  });
});
