import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadApiRequest, storeApiRequest } from '../src/manifest.js';
import { applyNormalizers, rewriteText } from '../src/normalize.js';
import { packRun, unpackRun } from '../src/pack.js';
import { redactRun } from '../src/redact.js';
import { Store } from '../src/store.js';

const cmd = { argv: ['node', 'agent.js'], cwd: '/tmp' };
const EMAIL = { pattern: 'email', replace: '<EMAIL>' };
const KEY = { path: '$.args.api_key', replace: '<KEY>', kind: 'tool' as const };

function seed(store: Store) {
  const run = store.createRun({ mode: 'record', command: cmd });
  const req = storeApiRequest(store, { model: 'm', system: 'Reply to alice@example.com', messages: [{ role: 'user', content: 'cc bob@example.com' }] });
  const res = store.putBlob(Buffer.from('event: content_block_delta\ndata: {"delta":{"text":"Sent to alice@example.com"}}\n\n'));
  const api = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'a'.repeat(64), occurrence: 1 };
  store.appendCallStart({ runId: run.runId, callNo: 1, ...api, origin: 'live', effect: null, requestRef: req, meta: { provider: 'anthropic' }, at: 1 });
  store.appendCallEnd(api, { runId: run.runId, callNo: 1, attempt: 0, responseRef: res, outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'text/event-stream' } }, at: 2 });
  const toolReq = store.putJson({ args: { api_key: 'sk-secret-123', to: 'carol@example.com' } });
  const toolRes = store.putJson({ result: { sent: true, to: 'carol@example.com' } });
  const tool = { kind: 'tool' as const, name: 'send_email', fingerprint: 'b'.repeat(64), occurrence: 1 };
  store.appendCallStart({ runId: run.runId, callNo: 2, ...tool, origin: 'live', effect: 'write', requestRef: toolReq, meta: {}, at: 3 });
  store.appendCallEnd(tool, { runId: run.runId, callNo: 2, attempt: 0, responseRef: toolRes, outcome: 'ok', meta: {}, at: 4 });
  store.endRun(run.runId, 'completed');
  return run;
}

describe('pathless normalizers', () => {
  it('apply a pattern to every string, and to raw text', () => {
    const out = applyNormalizers({ a: 'x alice@example.com', b: ['bob@example.com', 1], c: { d: 'none' } }, [EMAIL], 'api', 'n') as Record<string, unknown>;
    expect(out).toEqual({ a: 'x <EMAIL>', b: ['<EMAIL>', 1], c: { d: 'none' } });
    expect(rewriteText('data: {"t":"alice@example.com"}', [EMAIL, KEY])).toBe('data: {"t":"<EMAIL>"}');
  });
});

describe('redactRun', () => {
  it('masks requests, responses and tool I/O in a copy, records the rules, and leaves the source intact', () => {
    const src = Store.open(':memory:');
    const run = seed(src);
    const dst = Store.open(':memory:');
    const copy = redactRun(src, run.runId, [EMAIL, KEY], dst);
    expect(copy.meta?.redactions).toEqual([EMAIL, KEY]);

    const calls = dst.getCalls(run.runId);
    const apiBody = loadApiRequest(dst, calls[0]!.requestRef!) as { system: string; messages: Array<{ content: string }> };
    expect(apiBody.system).toBe('Reply to <EMAIL>');
    expect(apiBody.messages[0]!.content).toBe('cc <EMAIL>');
    expect(dst.getBlob(calls[0]!.end!.responseRef!)!.toString()).toContain('Sent to <EMAIL>');
    expect(dst.getJson(calls[1]!.requestRef!)).toEqual({ args: { api_key: '<KEY>', to: '<EMAIL>' } });
    expect(dst.getJson(calls[1]!.end!.responseRef!)).toEqual({ result: { sent: true, to: '<EMAIL>' } });
    // Identity is untouched: fingerprints and occurrences are what matching recomputes anyway.
    expect(calls.map((c) => [c.fingerprint, c.occurrence])).toEqual(src.getCalls(run.runId).map((c) => [c.fingerprint, c.occurrence]));
    // The source still has the originals.
    expect((loadApiRequest(src, src.getCalls(run.runId)[0]!.requestRef!) as { system: string }).system).toContain('alice@example.com');
    src.close();
    dst.close();
  });

  it('packs a redacted copy whose blobs contain no secret, and round-trips the rules', () => {
    const src = Store.open(':memory:');
    const run = seed(src);
    const dir = join(mkdtempSync(join(tmpdir(), 'fp-redact-')), 'pack');
    const result = packRun(src, run.runId, dir, { redact: [EMAIL, KEY] });
    expect(result.redacted).toBe(true);
    for (const f of readdirSync(join(dir, 'blobs'))) {
      const text = readFileSync(join(dir, 'blobs', f), 'utf8');
      expect(text).not.toMatch(/example\.com|sk-secret/);
    }
    expect(readFileSync(join(dir, 'calls.jsonl'), 'utf8')).not.toMatch(/example\.com|sk-secret/);
    const dst = Store.open(':memory:');
    unpackRun(dst, dir);
    expect(dst.getRun(run.runId)?.meta?.redactions).toEqual([EMAIL, KEY]);
    // The source store was not modified by packing.
    expect(src.getRun(run.runId)?.meta).toBeUndefined();
    src.close();
    dst.close();
  });
});
