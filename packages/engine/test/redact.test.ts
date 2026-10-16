import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeEventStreamFrame, eventStreamFrames, eventStreamMessages } from '../src/eventstream.js';
import { loadApiRequest, storeApiRequest } from '../src/manifest.js';
import { applyNormalizers, rewriteText } from '../src/normalize.js';
import { packRun, unpackRun } from '../src/pack.js';
import { redactBytes, redactRun } from '../src/redact.js';
import { Store } from '../src/store.js';
import type { Normalizer } from '../src/types.js';

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

  it('keeps a model request sent as bytes whole: a rule finds no string in it', () => {
    const src = Store.open(':memory:');
    const run = src.createRun({ mode: 'record', command: cmd });
    const audio = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x31, 0x32, 0x33]);
    const api = { kind: 'api' as const, name: 'POST /v1/audio/transcriptions', fingerprint: 'c'.repeat(64), occurrence: 1 };
    src.appendCallStart({ runId: run.runId, callNo: 1, ...api, origin: 'live', effect: null, requestRef: storeApiRequest(src, audio), meta: {}, at: 1 });
    src.endRun(run.runId, 'completed');
    const dst = Store.open(':memory:');
    redactRun(src, run.runId, [EMAIL, { kind: 'api', path: '$["0"]', replace: '<X>' }], dst);
    const copy = loadApiRequest(dst, dst.getCalls(run.runId)[0]!.requestRef!);
    expect(Buffer.from(copy as Uint8Array).equals(audio)).toBe(true);
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

// ---- Bedrock's streamed responses ----

/** One AWS event stream frame as Bedrock sends it: string headers, a JSON payload, both checksums. */
function frame(type: string, payload: unknown): Buffer {
  const headers = Buffer.concat(
    Object.entries({ ':event-type': type, ':content-type': 'application/json', ':message-type': 'event' }).map(([name, value]) => {
      const n = Buffer.from(name);
      const v = Buffer.from(value);
      const b = Buffer.alloc(4 + n.length + v.length);
      b.writeUInt8(n.length, 0);
      n.copy(b, 1);
      b.writeUInt8(7, 1 + n.length);
      b.writeUInt16BE(v.length, 2 + n.length);
      v.copy(b, 4 + n.length);
      return b;
    }),
  );
  return encodeEventStreamFrame(headers, Buffer.from(JSON.stringify(payload)));
}
const SECRET_RULES: Normalizer[] = [{ pattern: '/sk-live-[a-z0-9]+/', replace: '<KEY>' }, EMAIL];

describe('redactBytes on a Bedrock event stream', () => {
  it('masks a ConverseStream event by event, rebuilds its frames, and leaves the others byte for byte', () => {
    const start = frame('messageStart', { role: 'assistant' });
    const delta = frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Rotated sk-live-9f8e7d for maya@example.com.' }, p: 'abcdefgh' });
    const stop = frame('messageStop', { stopReason: 'end_turn' });
    const body = Buffer.concat([start, delta, stop]);
    // The secret is in the stored bytes, and they are not text a rule could be applied to as they are.
    expect(body.includes('sk-live-9f8e7d')).toBe(true);

    const out = redactBytes(body, SECRET_RULES);
    expect(out.includes('sk-live')).toBe(false);
    expect(out.includes('maya@example.com')).toBe(false);
    const frames = eventStreamFrames(out)!; // every checksum holds
    expect(frames).toHaveLength(3);
    expect(frames[0]!.raw.equals(start)).toBe(true);
    expect(frames[2]!.raw.equals(stop)).toBe(true);
    expect([...eventStreamMessages(out)].map((m) => m.payload)).toEqual([{ role: 'assistant' }, { contentBlockIndex: 0, delta: { text: 'Rotated <KEY> for <EMAIL>.' }, p: 'abcdefgh' }, { stopReason: 'end_turn' }]);
  });

  it('decodes InvokeModelWithResponseStream chunks, masks the provider\'s event inside, and encodes it again', () => {
    const chunk = (event: unknown) => frame('chunk', { bytes: Buffer.from(JSON.stringify(event)).toString('base64'), p: 'abc' });
    const body = Buffer.concat([chunk({ type: 'message_start', message: { id: 'msg_1' } }), chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Key: sk-live-0a1b2c' } })]);
    expect(body.includes('sk-live')).toBe(false); // base64: invisible to a rule applied to the bytes
    const out = redactBytes(body, SECRET_RULES);
    const events = [...eventStreamMessages(out)].map((m) => m.payload);
    expect(events).toEqual([{ type: 'message_start', message: { id: 'msg_1' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Key: <KEY>' } }]);
    expect(eventStreamFrames(out)).not.toBeNull();
  });

  it('masks the strings of a JSON body and leaves its numbers whole, so a recorded time still replays', () => {
    const CARD = { pattern: '/\\b(?:\\d[ -]?){13,16}\\b/', replace: '<CARD>' };
    // A clock read keeps its 13-digit time; a card number in a string, or an email as a key, is masked.
    const clock = Buffer.from('{"result":1792155242516}');
    expect(redactBytes(clock, [CARD]).equals(clock)).toBe(true);
    const body = Buffer.from('{\n  "card": "4111 1111 1111 1111",\n  "at": 1792155242516,\n  "alice@example.com": {"paid": 4111111111111111}\n}');
    const out = redactBytes(body, [CARD, EMAIL]).toString();
    expect(out).toBe('{\n  "card": "<CARD>",\n  "at": 1792155242516,\n  "<EMAIL>": {"paid": 4111111111111111}\n}');
    expect(JSON.parse(out)).toMatchObject({ card: '<CARD>', at: 1792155242516 });
    // Text that is no JSON document is masked as text, as before.
    expect(redactBytes(Buffer.from('paid with 4111 1111 1111 1111'), [CARD]).toString()).toBe('paid with <CARD>');
  });

  it('leaves bytes nothing matched, and binary that is no event stream, exactly as they were', () => {
    const body = Buffer.concat([frame('messageStart', { role: 'assistant' }), frame('messageStop', { stopReason: 'end_turn' })]);
    expect(redactBytes(body, SECRET_RULES).equals(body)).toBe(true);
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01]);
    expect(redactBytes(binary, SECRET_RULES).equals(binary)).toBe(true);
    // A frame whose checksum is off is not taken apart.
    const broken = Buffer.from(body);
    broken[broken.length - 1] ^= 0xff;
    expect(eventStreamFrames(broken)).toBeNull();
  });
});

// ---- what the run record repeats ----

describe('redactRun: the run record', () => {
  it('masks a fork\'s flags, its divergence, checks, errors and headers, and drops what would rebuild them', () => {
    const src = Store.open(':memory:');
    const run = seed(src);
    const override = '{"sent":true,"to":"maya@example.com"}';
    src.updateRunMeta(run.runId, {
      interventions: [
        { kind: 'override', at: 2, flag: '--override 2=…', args: ['--override', `2=${override}`] },
        { kind: 'inject', at: 1, flag: '--inject 1=Write to maya@example.com', args: ['--inject', '1=Write to maya@example.com', '--inject-as', 'user'] },
      ],
      expect: { output: { contains: 'maya@example.com' } },
      checks: [{ ok: false, label: 'output contains maya@example.com', detail: 'it printed bob@example.com' }],
    });
    src.setDivergence(run.runId, {
      type: 'request_changed',
      callNo: 1,
      kind: 'api',
      name: 'POST /v1/messages',
      replayedBefore: 0,
      reason: 'changed by --set 1:metadata.user_id=maya@example.com',
      diff: [
        { path: '$.messages[0].content', op: 'changed', before: 'cc bob@example.com', after: 'cc maya@example.com' },
        { path: '$.metadata', op: 'added', after: { user_id: 'u-123', note: 'x' } },
        { path: '$.metadata.user_id', op: 'changed', before: 'u-122', after: 'u-123' },
      ],
    });
    const call = src.getCalls(run.runId)[1]!;
    src.appendCallEnd({ kind: call.kind, name: call.name, fingerprint: call.fingerprint, occurrence: call.occurrence }, {
      runId: run.runId,
      callNo: 2,
      attempt: 1,
      responseRef: null,
      outcome: 'error',
      meta: { injected: true, failure: { kind: 'error', message: 'mailbox maya@example.com is full' }, error: { name: 'Error', message: 'mailbox maya@example.com is full' }, headers: { 'x-request-for': 'maya@example.com' } },
      at: 5,
    });
    const rules: Normalizer[] = [EMAIL, { kind: 'api', path: '$.metadata.user_id', replace: '<USER>' }];
    const dst = Store.open(':memory:');
    const copy = redactRun(src, run.runId, rules, dst);
    const stored = dst.getRun(run.runId)!;
    for (const r of [copy, stored]) {
      expect(JSON.stringify(r)).not.toContain('maya@example.com');
      expect(JSON.stringify(r)).not.toContain('u-12');
      // Shown as they were, masked; the exact arguments and checks that could rebuild them are left out.
      expect(r.meta?.interventions).toEqual([
        { kind: 'override', at: 2, flag: '--override 2=…' },
        { kind: 'inject', at: 1, flag: '--inject 1=Write to <EMAIL>' },
      ]);
      expect(r.meta?.expect).toBeUndefined();
      expect(r.meta?.checks).toEqual([{ ok: false, label: 'output contains <EMAIL>', detail: 'it printed <EMAIL>' }]);
      expect(r.divergence?.reason).toBe('changed by --set 1:metadata.user_id=<EMAIL>');
      expect(r.divergence?.diff).toEqual([
        { path: '$.messages[0].content', op: 'changed', before: 'cc <EMAIL>', after: 'cc <EMAIL>' },
        // A path rule applies where the value sits, at its own path or inside a parent's value.
        { path: '$.metadata', op: 'added', after: { user_id: '<USER>', note: 'x' } },
        { path: '$.metadata.user_id', op: 'changed', before: '<USER>', after: '<USER>' },
      ]);
    }
    const end = dst.getCalls(run.runId)[1]!.end!;
    expect(end.meta).toMatchObject({ failure: { kind: 'error', message: 'mailbox <EMAIL> is full' }, error: { message: 'mailbox <EMAIL> is full' }, headers: { 'x-request-for': '<EMAIL>' } });
    // The source keeps what it recorded.
    expect(JSON.stringify(src.getRun(run.runId))).toContain('maya@example.com');
    src.close();
    dst.close();
  });

  it('packs a fork without the values its flags and divergence carried', () => {
    const src = Store.open(':memory:');
    const run = seed(src);
    src.updateRunMeta(run.runId, { interventions: [{ kind: 'override', at: 2, flag: '--override 2=…', args: ['--override', '2={"to":"maya@example.com"}'] }] });
    src.setDivergence(run.runId, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff: [{ path: '$.system', op: 'changed', before: 'Reply to alice@example.com', after: 'Reply to maya@example.com' }] });
    const dir = join(mkdtempSync(join(tmpdir(), 'fp-redact-meta-')), 'pack');
    packRun(src, run.runId, dir, { redact: [EMAIL] });
    const manifest = readFileSync(join(dir, 'run.json'), 'utf8');
    expect(manifest).not.toContain('example.com');
    expect(manifest).toContain('--override 2=…');
    src.close();
  });
});
