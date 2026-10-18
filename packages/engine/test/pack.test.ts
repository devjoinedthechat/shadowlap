import { createHash } from 'node:crypto';
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
    expect(unpackRun(dst, dir)).toEqual({ imported: [], skipped: [parent.runId, child.runId], commands: [], mismatched: [] });
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

  it('says when the store holds another recording under a run id it skips, and leaves it as it is', () => {
    const src = Store.open(':memory:');
    const { parent } = seed(src);
    const dir = join(mkdtempSync(join(tmpdir(), 'fp-pack-')), 'sent');
    packRun(src, parent.runId, dir);
    const dst = Store.open(':memory:');
    unpackRun(dst, dir);
    // The same pack with another command, then with another answer at call 1.
    const m = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { runs: Array<{ command: { argv: string[]; cwd: string } }> };
    m.runs[0]!.command.argv = ['sh', '-c', 'echo owned'];
    writeFileSync(join(dir, 'run.json'), JSON.stringify(m));
    expect(unpackRun(dst, dir).mismatched).toEqual([{ runId: parent.runId, command: { argv: ['sh', '-c', 'echo owned'], cwd: '/tmp' }, calls: false }]);
    const lines = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { end: { responseRef: string } });
    const other = Buffer.from('event: message_start\ndata: {"other":true}\n\n');
    const hash = createHash('sha256').update(other).digest('hex');
    writeFileSync(join(dir, 'blobs', hash), other);
    lines[0]!.end.responseRef = hash;
    writeFileSync(join(dir, 'calls.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect(unpackRun(dst, dir).mismatched).toEqual([{ runId: parent.runId, command: { argv: ['sh', '-c', 'echo owned'], cwd: '/tmp' }, calls: true }]);
    expect(dst.getRun(parent.runId)!.command.argv).toEqual(['node', 'agent.js']);
    expect(dst.hasBlob(hash)).toBe(false);
    src.close();
    dst.close();
  });

  it('unpacks a run recorded from a command line with tabs and line breaks, as it packs it', () => {
    const src = Store.open(':memory:');
    // `node -e` with a script of its own, from a folder whose name has a tab in it.
    const argv = ['node', '--input-type=module', '-e', "const r = await fetch(url);\n\tconsole.log(await r.text());\n"];
    const run = src.createRun({ mode: 'record', command: { argv, cwd: '/tmp/odd\tfolder' } });
    src.endRun(run.runId, 'completed');
    const dir = join(mkdtempSync(join(tmpdir(), 'fp-pack-')), 'multi');
    packRun(src, run.runId, dir);
    const dst = Store.open(':memory:');
    expect(unpackRun(dst, dir).commands).toEqual([{ runId: run.runId, argv }]);
    expect(dst.getRun(run.runId)!.command).toEqual({ argv, cwd: '/tmp/odd\tfolder' });
    // Anything else that could move a terminal's cursor is still refused.
    const m = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { runs: Array<{ command: { argv: string[] } }> };
    m.runs[0]!.command.argv[3] = 'console.log(1)\r\u001b[2Kclean';
    writeFileSync(join(dir, 'run.json'), JSON.stringify(m));
    expect(() => unpackRun(Store.open(':memory:'), dir)).toThrow(/argv\[3\]: contains control characters/);
    src.close();
    dst.close();
  });
});
