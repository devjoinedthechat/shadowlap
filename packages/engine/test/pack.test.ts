import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { storeApiRequest } from '../src/manifest.js';
import { packRun, unpackRun } from '../src/pack.js';
import { Store } from '../src/store.js';

const cmd = { argv: ['node', 'agent.js'], cwd: '/tmp' };

function seed(store: Store) {
  const parent = store.createRun({ mode: 'record', command: cmd });
  const req = storeApiRequest(store, { model: 'm', system: 'S', messages: [{ role: 'user', content: 'hi' }] });
  const res = store.putBlob(Buffer.from('event: message_start\ndata: {}\n\n'));
  const id = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'f'.repeat(64), occurrence: 1 };
  store.appendCallStart({ runId: parent.runId, callNo: 1, ...id, origin: 'live', effect: null, requestRef: req, meta: { provider: 'anthropic' }, at: 1 });
  store.appendCallEnd(id, { runId: parent.runId, callNo: 1, attempt: 0, responseRef: null, outcome: 'error', meta: { status: 429, retryable: true }, at: 2 });
  store.appendCallEnd(id, { runId: parent.runId, callNo: 1, attempt: 1, responseRef: res, outcome: 'ok', meta: { status: 200 }, at: 3 });
  store.endRun(parent.runId, 'completed');
  const child = store.createRun({ mode: 'replay', parentRunId: parent.runId, command: cmd });
  store.appendCallStart({ runId: child.runId, callNo: 1, ...id, origin: 'replayed', effect: null, requestRef: req, meta: {}, at: 4 });
  store.appendCallEnd(id, { runId: child.runId, callNo: 1, attempt: 0, responseRef: res, outcome: 'ok', meta: { status: 200, replayedFrom: 1 }, at: 5 });
  store.setDivergence(child.runId, { type: 'beyond_recording', callNo: 2, kind: 'api', name: 'POST /v1/messages', replayedBefore: 1 });
  store.endRun(child.runId, 'completed');
  return { parent, child };
}

describe('pack / unpack', () => {
  it('round-trips a run with its lineage, blobs and attempts', () => {
    const src = Store.open(':memory:');
    const { parent, child } = seed(src);
    const dir = join(mkdtempSync(join(tmpdir(), 'fp-pack-')), 'out');
    const packed = packRun(src, child.runId, dir, { lineage: true });
    expect(packed.runs).toEqual([parent.runId, child.runId]);
    expect(packed.calls).toBe(2);
    // manifest + system + message + response (the manifest's fields are inline)
    expect(readdirSync(join(dir, 'blobs'))).toHaveLength(4);
    expect(readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);

    const dst = Store.open(':memory:');
    const result = unpackRun(dst, dir);
    expect(result.imported).toEqual([parent.runId, child.runId]);
    // Identical apart from the mark every import gets.
    const { meta: importedMeta, ...importedRun } = dst.getRun(child.runId)!;
    const { meta: _sourceMeta, ...sourceRun } = src.getRun(child.runId)!;
    expect(importedRun).toEqual(sourceRun);
    expect(importedMeta?.imported?.from).toBe('out');
    expect(result.commands.map((c) => c.runId)).toEqual([parent.runId, child.runId]);
    expect(dst.getCalls(parent.runId)).toEqual(src.getCalls(parent.runId));
    expect(dst.getCalls(child.runId)).toEqual(src.getCalls(child.runId));
    expect(dst.childRuns(parent.runId).map((r) => r.runId)).toEqual([child.runId]);

    // Importing again is a no-op.
    expect(unpackRun(dst, dir)).toEqual({ imported: [], skipped: [parent.runId, child.runId], commands: [] });
    src.close();
    dst.close();
  });

  it('keeps git from converting its line endings, with a .gitattributes of its own', () => {
    const src = Store.open(':memory:');
    const { parent } = seed(src);
    const dir = join(mkdtempSync(join(tmpdir(), 'fp-pack-')), 'out');
    packRun(src, parent.runId, dir);
    expect(readFileSync(join(dir, '.gitattributes'), 'utf8')).toMatch(/^\* -text$/m);
    // One the folder has already is the person's own.
    writeFileSync(join(dir, '.gitattributes'), '* -text -diff\n');
    packRun(src, parent.runId, dir);
    expect(readFileSync(join(dir, '.gitattributes'), 'utf8')).toBe('* -text -diff\n');
    src.close();
  });

  it('reads a pack a git checkout converted to CRLF line endings as it was committed', () => {
    const src = Store.open(':memory:');
    const { parent } = seed(src);
    const dir = join(mkdtempSync(join(tmpdir(), 'fp-pack-')), 'out');
    packRun(src, parent.runId, dir);
    // What core.autocrlf does on checkout to every text file of a pack committed without its .gitattributes.
    const crlf = (path: string) => writeFileSync(path, readFileSync(path, 'latin1').replace(/\n/g, '\r\n'), 'latin1');
    for (const name of readdirSync(join(dir, 'blobs'))) crlf(join(dir, 'blobs', name));
    crlf(join(dir, 'calls.jsonl'));
    crlf(join(dir, 'run.json'));
    const dst = Store.open(':memory:');
    expect(unpackRun(dst, dir).imported).toEqual([parent.runId]);
    expect(dst.getCalls(parent.runId)).toEqual(src.getCalls(parent.runId));
    const res = src.getCalls(parent.runId)[0]!.end!.responseRef!;
    expect(dst.getBlob(res)).toEqual(src.getBlob(res));
    src.close();
    dst.close();
  });

  it('names the .gitattributes when a blob with CRLF line endings still does not match', () => {
    const src = Store.open(':memory:');
    const { parent } = seed(src);
    const dir = join(mkdtempSync(join(tmpdir(), 'fp-pack-')), 'out');
    packRun(src, parent.runId, dir);
    const res = src.getCalls(parent.runId)[0]!.end!.responseRef!;
    writeFileSync(join(dir, 'blobs', res), 'event: message_stop\r\ndata: {}\r\n\r\n');
    const dst = Store.open(':memory:');
    expect(() => unpackRun(dst, dir)).toThrow(/does not match its hash: it has CRLF line endings.*"\* -text"/);
    expect(dst.listRuns()).toEqual([]);
    src.close();
    dst.close();
  });

  it('rejects a tampered blob', () => {
    const src = Store.open(':memory:');
    const { parent } = seed(src);
    const dir = join(mkdtempSync(join(tmpdir(), 'fp-pack-')), 'out');
    packRun(src, parent.runId, dir);
    const [first] = readdirSync(join(dir, 'blobs'));
    writeFileSync(join(dir, 'blobs', first!), 'tampered');
    const dst = Store.open(':memory:');
    expect(() => unpackRun(dst, dir)).toThrow(/does not match its hash/);
    expect(dst.listRuns()).toEqual([]); // the transaction rolled back
    src.close();
    dst.close();
  });

  it('packs a fork without lineage as a self-contained run', () => {
    const src = Store.open(':memory:');
    const { child } = seed(src);
    const dir = join(mkdtempSync(join(tmpdir(), 'fp-pack-')), 'out');
    expect(packRun(src, child.runId, dir).runs).toEqual([child.runId]);
    const dst = Store.open(':memory:');
    unpackRun(dst, dir);
    expect(dst.getRun(child.runId)?.parentRunId).toBeNull(); // parent absent: dangling reference dropped
    expect(dst.getCalls(child.runId)).toHaveLength(1);
    src.close();
    dst.close();
  });
});
