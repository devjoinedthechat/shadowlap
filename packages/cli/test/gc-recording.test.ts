import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store, manifestRefs, storeApiRequest } from '@shadowlap/engine';

/**
 * gc next to a recording in another process, as when the dashboard's "Clean up old runs" runs while
 * an agent records in a terminal. A recording stores a blob a moment before the call that
 * references it, and reuses a blob whose content is already stored (the same system prompt as the
 * old runs being deleted), so collecting blobs then would leave its calls pointing at nothing.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const ENGINE = fileURLToPath(new URL('../../engine/dist/index.js', import.meta.url));
const SYSTEM = `You are the support agent. ${'Policy. '.repeat(100)}`;

let cwd: string;
beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sl-gc-rec-')));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const dbPath = () => join(cwd, '.shadowlap', 'shadowlap.db');
const api = (fingerprint: string) => ({ kind: 'api' as const, name: 'POST /v1/messages', fingerprint: fingerprint.padStart(64, '0'), occurrence: 1 });

/** Old finished runs sharing the agent's system prompt, each with blobs only it references. */
function seedOld(runs: number, calls: number): string[] {
  const store = Store.open(dbPath());
  const ids: string[] = [];
  store.transaction(() => {
    for (let r = 0; r < runs; r++) {
      const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd }, startedAt: Date.now() - 40 * 86_400_000 });
      for (let i = 1; i <= calls; i++) {
        const id = api(`${r}-${i}`);
        store.appendCallStart({ runId: run.runId, callNo: i, ...id, origin: 'live', effect: null, requestRef: storeApiRequest(store, { model: 'm', system: SYSTEM, messages: [{ role: 'user', content: `old ${r} ${i}` }] }), meta: {}, at: 1 });
        store.appendCallEnd(id, { runId: run.runId, callNo: i, attempt: 0, responseRef: store.putBlob(Buffer.from(`old answer ${r} ${i}`)), outcome: 'ok', meta: {}, at: 2 });
      }
      store.endRun(run.runId, 'completed');
      ids.push(run.runId);
    }
  });
  store.close();
  return ids;
}

/** A recording in its own process: model calls back to back, then a check that every blob its calls reference is there. */
const WRITER = `
const { existsSync } = await import('node:fs');
const { Store, storeApiRequest, manifestRefs } = await import(${JSON.stringify(`file://${ENGINE}`)});
const [db, stop, system] = process.argv.slice(1);
const store = Store.open(db);
const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '.' } });
process.stdout.write('recording\\n');
// Records until the test says stop, however slow the machine is (and never more than 25 seconds).
const until = Date.now() + 25000;
let n = 0;
while (Date.now() < until && !(n % 20 === 0 && existsSync(stop))) {
  n++;
  const id = { kind: 'api', name: 'POST /v1/messages', fingerprint: String(n).padStart(64, 'f'), occurrence: 1 };
  store.appendCallStart({ runId: run.runId, callNo: n, ...id, origin: 'live', effect: null, requestRef: storeApiRequest(store, { model: 'm', system, messages: [{ role: 'user', content: 'new ' + n }] }), meta: {}, at: Date.now() });
  store.appendCallEnd(id, { runId: run.runId, callNo: n, attempt: 0, responseRef: store.putBlob(Buffer.from('old answer 0 ' + (1 + (n % 5)))), outcome: 'ok', meta: {}, at: Date.now() });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
}
store.endRun(run.runId, 'completed');
let missing = 0;
for (const c of store.getCalls(run.runId)) {
  if ([c.requestRef, ...manifestRefs(store, c.requestRef), c.end.responseRef].some((h) => !store.getBlob(h))) missing++;
}
process.stdout.write(JSON.stringify({ runId: run.runId, calls: n, missing }) + '\\n');
store.close();
`;

function cli(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

describe('gc while another process records', () => {
  it('deletes old runs but leaves every blob alone until no run is recording', async () => {
    const old = seedOld(6, 40);
    const stop = join(cwd, 'stop');
    const writer = spawn(process.execPath, ['--input-type=module', '-e', WRITER, dbPath(), stop, SYSTEM], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    writer.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const done = new Promise<void>((resolve) => writer.on('close', () => resolve()));
    await new Promise<void>((resolve) => {
      writer.stdout.on('data', (d: Buffer) => {
        out += d.toString();
        if (out.includes('recording\n')) resolve();
      });
    });

    // Every few milliseconds, as a dashboard deleting runs or a calibration finishing would: for 800 ms
    // and six times at least, however long each takes on this machine.
    const store = Store.open(dbPath());
    for (let looked = 0, until = Date.now() + 800; looked < 6 || Date.now() < until; looked++) {
      const gc = store.gcBlobs();
      expect(gc).toMatchObject({ removed: 0, recording: [expect.any(String)] });
    }
    store.close();

    const r = await cli(['gc', '--older-than', '30', '--json']);
    expect(r.code, r.err).toBe(0);
    const report = JSON.parse(r.out) as { runs: Array<{ runId: string }>; blobs: number; deferred: boolean; recording: Array<{ runId: string }> };
    expect(report.runs.map((x) => x.runId).sort()).toEqual([...old].sort());
    expect(report).toMatchObject({ blobs: 0, deferred: true, recording: [{ runId: expect.any(String) }] });

    writeFileSync(stop, '');
    await done;
    const result = JSON.parse(out.trim().split('\n').pop()!) as { runId: string; calls: number; missing: number };
    expect(err).toBe('');
    expect(result.calls).toBeGreaterThan(20);
    expect(result.missing).toBe(0);
    expect(report.recording[0].runId).toBe(result.runId);

    // Once nothing records, the old runs' own blobs go, and the recording keeps everything it uses.
    const again = await cli(['gc', '--json']);
    expect(JSON.parse(again.out)).toMatchObject({ deferred: false, recording: [] });
    expect(JSON.parse(again.out).blobs).toBeGreaterThan(200);
    const check = Store.open(dbPath());
    for (const call of check.getCalls(result.runId)) {
      for (const hash of [call.requestRef!, ...manifestRefs(check, call.requestRef!), call.end!.responseRef!]) expect(check.getBlob(hash)).not.toBeNull();
    }
    check.close();
  }, 30_000);
});
