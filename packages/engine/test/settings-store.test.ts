import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { calibrationTarget } from '../src/calibrate.js';
import { SILENT_UNKNOWN_MS } from '../src/liveness.js';
import { storeApiRequest } from '../src/manifest.js';
import { NO_COMMAND } from '../src/pack.js';
import { Store } from '../src/store.js';
import type { CallMeta, Effect, RunMeta, RunStatus } from '../src/types.js';

/** The built engine, for a process of its own that records and goes away. */
const ENGINE = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => { prepare(sql: string): { run(...a: unknown[]): unknown }; close(): void } };

const cmd = { argv: ['node', 'agent.js'], cwd: '/tmp' };

function run(store: Store, o: { mode?: 'record' | 'replay'; status?: RunStatus | 'running'; at: number; meta?: RunMeta; argv?: string[] }) {
  const r = store.createRun({ mode: o.mode ?? 'record', command: o.argv ? { argv: o.argv, cwd: '/tmp' } : cmd, startedAt: o.at, ...(o.meta ? { meta: o.meta } : {}) });
  if (o.status && o.status !== 'running') store.endRun(r.runId, o.status, o.at + 1);
  return r;
}

function tool(store: Store, runId: string, callNo: number, name: string, effect: Effect | null, at: number, requestRef: string | null = null) {
  store.appendCallStart({ runId, callNo, kind: 'tool', name, fingerprint: `${name}${callNo}`, occurrence: 1, origin: 'live', effect, requestRef, meta: {}, at });
}

describe('calibrationTarget', () => {
  it('takes the setup run, else the newest finished recording made here, else none', () => {
    const store = Store.open(':memory:');
    expect(calibrationTarget(store)).toBeNull();
    const setup = run(store, { status: 'completed', at: 1000 });
    const failed = run(store, { status: 'failed', at: 2000 });
    run(store, { status: 'crashed', at: 3000 });
    run(store, { status: 'running', at: 4000 });
    run(store, { mode: 'replay', status: 'completed', at: 5000 });
    run(store, { status: 'completed', at: 6000, meta: { imported: { at: 6000, from: 'goldens/x' } } });
    run(store, { status: 'completed', at: 7000, argv: [NO_COMMAND], meta: { covers: ['api'] } });
    expect(calibrationTarget(store)).toEqual({ run: expect.objectContaining({ runId: failed.runId }), source: 'newest' });
    expect(calibrationTarget(store, { setupRunId: setup.runId })).toEqual({ run: expect.objectContaining({ runId: setup.runId }), source: 'setup' });
    // A setup run that is gone, or can't be calibrated, falls back to the newest.
    expect(calibrationTarget(store, { setupRunId: 'GONE' })?.source).toBe('newest');
    store.close();
  });

  it('looks past a long run of recordings it cannot use', () => {
    const store = Store.open(':memory:');
    const good = run(store, { status: 'completed', at: 1 });
    for (let i = 0; i < 120; i++) run(store, { status: 'completed', at: 10 + i, meta: { imported: { at: 0, from: 'x' } } });
    expect(calibrationTarget(store)?.run.runId).toBe(good.runId);
    store.close();
  });
});

describe('toolUsage', () => {
  it('lists every tool across runs with its effects, calls, runs and latest call', () => {
    const store = Store.open(':memory:');
    const a = run(store, { status: 'completed', at: 1 });
    const b = run(store, { status: 'completed', at: 2 });
    tool(store, a.runId, 1, 'lookup_order', 'read', 100);
    tool(store, a.runId, 2, 'lookup_order', 'read', 110);
    tool(store, a.runId, 3, 'issue_refund', 'write', 120);
    tool(store, b.runId, 1, 'lookup_order', 'read', 200);
    tool(store, b.runId, 2, 'issue_refund', 'read', 210);
    store.appendCallStart({ runId: b.runId, callNo: 3, kind: 'api', name: 'POST /v1/messages', fingerprint: 'm', occurrence: 1, origin: 'live', effect: null, requestRef: null, meta: {}, at: 220 });
    expect(store.toolUsage()).toEqual([
      { name: 'issue_refund', effect: 'read', calls: 1, runs: 1, lastAt: 210 },
      { name: 'issue_refund', effect: 'write', calls: 1, runs: 1, lastAt: 120 },
      { name: 'lookup_order', effect: 'read', calls: 3, runs: 2, lastAt: 200 },
    ]);
    store.close();
  });
});

describe('runCounts', () => {
  it('tells runs from the attempts blame, verify and --repeat make, and counts runs still running', () => {
    const store = Store.open(':memory:');
    expect(store.runCounts()).toEqual({ runs: 0, attempts: 0, running: 0 });
    run(store, { status: 'completed', at: 1 });
    run(store, { status: 'running', at: 2 });
    run(store, { mode: 'replay', status: 'completed', at: 3, meta: { probe: { of: 'X', callNo: 3, passed: true } } });
    run(store, { mode: 'replay', status: 'failed', at: 4, meta: { verify: { role: 'target', passed: false } } });
    run(store, { mode: 'replay', status: 'completed', at: 5, meta: { repeat: { group: 'g', attempt: 1, of: 2 }, labels: ['x'] } });
    run(store, { mode: 'replay', status: 'completed', at: 6, meta: { labels: ['good'] } });
    expect(store.runCounts()).toEqual({ runs: 3, attempts: 3, running: 1 });
    store.close();
  });
});

describe('unreferencedBlobs', () => {
  it('finds what deleting runs would free without deleting anything, as gcBlobs then does', () => {
    const store = Store.open(':memory:');
    const old = run(store, { status: 'completed', at: 1 });
    const kept = run(store, { status: 'completed', at: 2 });
    const shared = store.putJson({ args: { shared: true } });
    const only = store.putBlob(Buffer.from('x'.repeat(4000)));
    const manifest = storeApiRequest(store, { model: 'm', messages: [{ role: 'user', content: 'only in the old run' }] });
    tool(store, old.runId, 1, 't', 'read', 1, shared);
    tool(store, old.runId, 2, 't', 'read', 2, only);
    store.appendCallStart({ runId: old.runId, callNo: 3, kind: 'api', name: 'POST /v1/messages', fingerprint: 'm', occurrence: 1, origin: 'live', effect: null, requestRef: manifest, meta: {}, at: 3 });
    tool(store, kept.runId, 1, 't', 'read', 4, shared);
    const orphan = store.putJson({ nobody: 'references this' });

    expect(store.unreferencedBlobs().hashes).toEqual([orphan]);
    const plan = store.unreferencedBlobs([old.runId]);
    // The old run's own blob, its request manifest and the message under it, and the orphan.
    expect(plan.hashes.sort()).toEqual([only, manifest, orphan, expect.any(String)].sort());
    expect(plan.size).toBeGreaterThan(4000);
    expect(plan.bytes).toBeLessThan(plan.size); // the 4000-byte blob is stored compressed
    expect(store.getBlob(only)).not.toBeNull();

    store.deleteRun(old.runId);
    expect(store.gcBlobs()).toEqual({ removed: 4, bytes: plan.size, stored: plan.bytes, recording: [] });
    expect(store.getJson(shared)).toEqual({ args: { shared: true } });
    store.close();
  });
});

describe('recordingRuns', () => {
  it('tells a recording from a run its process left running, and stops waiting for the latter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-owners-'));
    const path = join(dir, 'store.db');
    try {
      const store = Store.open(path);
      const mine = store.createRun({ mode: 'record', command: cmd });
      // A recording in a process of its own that is killed before it ends the run.
      const left = execFileSync(process.execPath, ['--input-type=module', '-e', `const { Store } = await import(${JSON.stringify(`file://${ENGINE}`)}); const s = Store.open(${JSON.stringify(path)}); const r = s.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '.' } }); s.putBlob(Buffer.from('stored just before the call that would have used it')); process.stdout.write(r.runId); process.exit(0);`], { encoding: 'utf8' });
      const ended = store.createRun({ mode: 'record', command: cmd });
      store.endRun(ended.runId, 'completed');
      // Runs whose process can't be asked: another machine's, and an import of a run that was still recording.
      const elsewhere = store.createRun({ mode: 'record', command: cmd });
      const quiet = store.createRun({ mode: 'record', command: cmd, startedAt: Date.now() - SILENT_UNKNOWN_MS - 60_000 });
      const db = new DatabaseSync(path);
      db.prepare(`UPDATE run_owners SET host = 'another-machine' WHERE run_id IN (?, ?)`).run(elsewhere.runId, quiet.runId);
      db.close();
      const imported = { ...store.getRun(ended.runId)!, runId: 'IMPORTED0000000000000000AA', status: 'running' as const, startedAt: Date.now() - 3 * SILENT_UNKNOWN_MS };
      store.importRun(imported);

      const now = store.recordingRuns();
      expect(now.live.map((r) => r.run.runId).sort()).toEqual([mine.runId, elsewhere.runId].sort());
      expect(now.abandoned.map((r) => r.run.runId).sort()).toEqual([left, quiet.runId, imported.runId].sort());
      // A call is a sign of life: one an hour ago keeps the other machine's quiet run recording.
      tool(store, quiet.runId, 1, 't', 'read', Date.now() - 3_600_000);
      expect(store.recordingRuns().live.map((r) => r.run.runId)).toContain(quiet.runId);
      // Only a recording holds up blob collection: the blob the killed process stored goes.
      store.endRun(mine.runId, 'completed');
      store.endRun(elsewhere.runId, 'completed');
      store.endRun(quiet.runId, 'completed');
      expect(store.gcBlobs()).toMatchObject({ removed: 1, recording: [] });
      // Ending a run forgets its process; deleting one does too.
      expect(store.recordingRuns().abandoned.map((r) => r.run.runId).sort()).toEqual([left, imported.runId].sort());
      store.deleteRun(left);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mcpServerUsage', () => {
  it('counts the calls through each MCP server and the tools it last listed', () => {
    const store = Store.open(':memory:');
    const a = run(store, { status: 'completed', at: 1 });
    const b = run(store, { status: 'completed', at: 2 });
    const via = (runId: string, callNo: number, name: string, effect: Effect, at: number, mcp: NonNullable<CallMeta['mcp']>) =>
      store.appendCallStart({ runId, callNo, kind: 'tool', name, fingerprint: `${name}${callNo}`, occurrence: 1, origin: 'live', effect, requestRef: null, meta: { mcp }, at });
    const fs = { transport: 'stdio' as const, server: 'npx @modelcontextprotocol/server-filesystem' };
    via(a.runId, 1, 'read_file', 'read', 10, { ...fs, tools: [{ name: 'read_file', effect: 'read' }, { name: 'write_file', effect: 'write' }] });
    via(a.runId, 2, 'write_file', 'write', 20, fs);
    // A later listing wins: the server added a tool.
    via(b.runId, 1, 'read_file', 'read', 30, { ...fs, tools: [{ name: 'read_file', effect: 'read' }, { name: 'write_file', effect: 'write' }, { name: 'move_file', effect: 'write' }] });
    via(b.runId, 2, 'create_issue', 'write', 40, { transport: 'http', server: 'mcp.example.com' });
    tool(store, b.runId, 3, 'lookup_order', 'read', 50);
    expect(store.mcpServerUsage()).toEqual([
      { transport: 'http', server: 'mcp.example.com', calls: 1, lastAt: 40, tools: null, called: [{ name: 'create_issue', effect: 'write' }] },
      {
        transport: 'stdio',
        server: 'npx @modelcontextprotocol/server-filesystem',
        calls: 3,
        lastAt: 30,
        tools: [
          { name: 'read_file', effect: 'read' },
          { name: 'write_file', effect: 'write' },
          { name: 'move_file', effect: 'write' },
        ],
        called: [
          { name: 'read_file', effect: 'read' },
          { name: 'write_file', effect: 'write' },
        ],
      },
    ]);
    store.close();
  });
});

describe('gcBlobs', () => {
  it('collects nothing while a run is recording, because its next call may reference any blob', () => {
    const store = Store.open(':memory:');
    const done = run(store, { status: 'completed', at: 1 });
    const orphan = store.putJson({ nobody: 'references this yet' });
    const live = run(store, { status: 'running', at: 2 });
    expect(store.gcBlobs()).toEqual({ removed: 0, bytes: 0, stored: 0, recording: [live.runId] });
    expect(store.getJson(orphan)).not.toBeNull();
    // The recording stores the blob, then the call that references it: still there.
    tool(store, live.runId, 1, 't', 'read', 3, orphan);
    store.endRun(live.runId, 'completed');
    store.deleteRun(done.runId);
    expect(store.gcBlobs()).toMatchObject({ removed: 0, recording: [] });
    expect(store.getJson(orphan)).not.toBeNull();
    store.close();
  });

  it('collects only the blobs it is given, and only those nothing references', () => {
    const store = Store.open(':memory:');
    const kept = run(store, { status: 'completed', at: 1 });
    const attempt = run(store, { mode: 'replay', status: 'completed', at: 2 });
    const shared = store.putJson({ args: { shared: true } });
    const own = store.putJson({ args: { only: 'the attempt' } });
    const unrelated = store.putJson({ written: 'by something else' });
    tool(store, kept.runId, 1, 't', 'read', 1, shared);
    tool(store, attempt.runId, 1, 't', 'read', 2, shared);
    tool(store, attempt.runId, 2, 't', 'read', 3, own);
    const refs = store.runBlobRefs(attempt.runId);
    expect(refs.sort()).toEqual([shared, own].sort());
    store.deleteRun(attempt.runId);
    expect(store.gcBlobs({ among: refs })).toMatchObject({ removed: 1, recording: [] });
    expect(store.getJson(own)).toBeNull();
    expect(store.getJson(shared)).not.toBeNull();
    expect(store.getJson(unrelated)).not.toBeNull();
    store.close();
  });
});

describe('size', () => {
  it('counts the database pages whatever the write-ahead log holds, and shrinks with a vacuum', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-size-'));
    const path = join(dir, 'store.db');
    const store = Store.open(path);
    // Another connection holding the store open, as a dashboard does, keeps the log from being folded back.
    const holder = Store.open(path);
    const r = run(store, { status: 'completed', at: 1 });
    for (let i = 0; i < 200; i++) tool(store, r.runId, i + 1, 't', 'read', i, store.putBlob(randomBytes(4096)));
    const before = store.size();
    expect(before.bytes).toBeGreaterThan(200 * 4096);
    expect(holder.size().bytes).toBe(before.bytes);
    store.deleteRun(r.runId);
    store.gcBlobs();
    expect(store.size().free).toBeGreaterThan(100 * 4096);
    store.vacuum();
    const after = store.size();
    // The vacuum gives back what the blobs took; what is left is the store's schema, whatever its size.
    expect(before.bytes - after.bytes).toBeGreaterThan(0.9 * 200 * 4096);
    expect(after.free).toBe(0);
    holder.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
