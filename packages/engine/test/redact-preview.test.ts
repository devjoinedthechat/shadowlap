import { describe, expect, it } from 'vitest';
import { loadApiRequest, storeApiRequest } from '../src/manifest.js';
import { applyNormalizers, rewriteText, type RewriteObserver } from '../src/normalize.js';
import { REDACTION_EXPORTS, clipChange, previewRedaction, redactRun } from '../src/redact.js';
import { Store } from '../src/store.js';
import type { Normalizer } from '../src/types.js';

const cmd = { argv: ['node', 'agent.js'], cwd: '/tmp' };
const API = { kind: 'api' as const, name: 'POST /v1/messages' };

/** A support run: the system prompt names a customer, the conversation grows, a tool sends an email with a key. */
function seed(store: Store) {
  const run = store.createRun({ mode: 'record', command: cmd });
  const system = 'You help customers. The account owner is alice@example.com.';
  const turn1 = [{ role: 'user', content: 'Refund order 4417 for bob@example.com' }];
  const turn2 = [...turn1, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'send_email', input: { to: 'bob@example.com' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'sent' }] }];
  [turn1, turn2].forEach((messages, i) => {
    const callNo = i === 0 ? 1 : 3;
    const req = storeApiRequest(store, { model: 'm', system, messages, metadata: { user_id: `9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6${i}` } });
    const res = store.putBlob(Buffer.from(`event: content_block_delta\ndata: {"delta":{"text":"Writing to bob@example.com${i ? ' again' : ''}"}}\n\n`));
    const id = { ...API, fingerprint: `${'a'.repeat(63)}${i}`, occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo, ...id, origin: 'live', effect: null, requestRef: req, meta: {}, at: callNo });
    store.appendCallEnd(id, { runId: run.runId, callNo, attempt: 0, responseRef: res, outcome: 'ok', meta: {}, at: callNo });
  });
  const tool = { kind: 'tool' as const, name: 'send_email', fingerprint: 'b'.repeat(64), occurrence: 1 };
  const toolReq = store.putJson({ args: { api_key: 'sk-live-123', to: 'bob@example.com' } });
  // The first attempt failed; the retry carries the same address, and both count as pack writes both.
  store.appendCallStart({ runId: run.runId, callNo: 2, ...tool, origin: 'live', effect: 'write', requestRef: toolReq, meta: {}, at: 2 });
  store.appendCallEnd(tool, { runId: run.runId, callNo: 2, attempt: 0, responseRef: store.putJson({ error: 'timeout reaching carol@example.com' }), outcome: 'error', meta: {}, at: 2 });
  store.appendCallEnd(tool, { runId: run.runId, callNo: 2, attempt: 1, responseRef: store.putJson({ result: { sent: true } }), outcome: 'ok', meta: {}, at: 2 });
  store.endRun(run.runId, 'completed');
  return run;
}

const EMAIL: Normalizer = { pattern: 'email', replace: '<EMAIL>' };
const KEY: Normalizer = { kind: 'tool', path: '$.args.api_key', replace: '<KEY>' };
const CARD: Normalizer = { pattern: '/\\b(?:\\d[ -]?){13,16}\\b/', replace: '<CARD>' };
const USER: Normalizer = { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' };
const MISSING: Normalizer = { kind: 'tool', name: 'charge_card', path: '$.args.card', replace: '<CARD>' };
const NOWHERE: Normalizer = { kind: 'api', path: '$.metadata.session', pattern: 'uuid', replace: '<UUID>' };
const NOMATCH: Normalizer = { kind: 'tool', path: '$.args.to', pattern: 'uuid', replace: '<UUID>' };

describe('previewRedaction', () => {
  it('counts what pack would mask per rule, with samples, path rules included', () => {
    const store = Store.open(':memory:');
    const run = seed(store);
    const p = previewRedaction(store, run.runId, [EMAIL, KEY, CARD, USER, MISSING, NOWHERE, NOMATCH]);
    const [email, key, card, user, missing, nowhere, nomatch] = p.rules;

    // The system prompt and the first message go out again with every request; each counts once, as
    // does "bob@example.com" in the tool_use input and again in the tool's arguments. So: the system
    // prompt, the user turn, that address, the failed attempt's error and both streamed responses.
    expect(email!.count).toBe(6);
    expect(email!.samples).toHaveLength(2);
    expect(email!.samples[0]).toEqual({ before: '…customers. The account owner is alice@example.com.', after: '…customers. The account owner is <EMAIL>.' });
    expect(key).toMatchObject({ n: 2, count: 1, reached: 1, samples: [{ before: 'sk-live-123', after: '<KEY>' }], note: null });
    expect(card).toMatchObject({ count: 0, note: 'no matches in this run', reached: null });
    // Two requests, two different user ids.
    expect(user).toMatchObject({ count: 2, reached: 2 });
    expect(missing).toMatchObject({ count: 0, note: 'no tool call named charge_card in this run' });
    expect(nowhere).toMatchObject({ count: 0, reached: 0, note: 'no request in this run has $.metadata.session' });
    expect(nomatch).toMatchObject({ count: 0, reached: 1, note: '$.args.to is in a request, but nothing there matches uuid' });
    expect(p).toMatchObject({ runId: run.runId, calls: 3, unreadable: 0, total: 9 });
    store.close();
  });

  it('applies exactly what pack does: every value it counts is gone from the packed copy', () => {
    const store = Store.open(':memory:');
    const run = seed(store);
    const rules = [EMAIL, KEY, USER];
    const preview = previewRedaction(store, run.runId, rules);
    const dst = Store.open(':memory:');
    redactRun(store, run.runId, rules, dst);
    const text = dst.getCalls(run.runId).flatMap((c) => [
      JSON.stringify(c.kind === 'api' ? loadApiRequest(dst, c.requestRef!) : dst.getJson(c.requestRef!)),
      ...[...c.attempts, c.end!].map((e) => dst.getBlob(e.responseRef!)!.toString('utf8')),
    ]).join('\n');
    for (const value of ['alice@example.com', 'bob@example.com', 'carol@example.com', 'sk-live-123', '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb60']) expect(text).not.toContain(value);
    for (const r of preview.rules) for (const s of r.samples) expect(text).toContain(s.after.replace(/^…|…$/g, ''));
    dst.close();
    store.close();
  });

  it('refuses a run still recording, and names a rule that cannot compile', () => {
    const store = Store.open(':memory:');
    const live = store.createRun({ mode: 'record', command: cmd });
    expect(() => previewRedaction(store, live.runId, [EMAIL])).toThrow(/is still recording; preview it once it has ended/);
    const run = seed(store);
    expect(() => previewRedaction(store, run.runId, [EMAIL, { pattern: 'nope', replace: 'x' }])).toThrow(/redaction rule #2: unknown pattern "nope"/);
    expect(() => previewRedaction(store, 'NOPE', [EMAIL])).toThrow(/unknown run/);
    expect(previewRedaction(store, run.runId, [])).toMatchObject({ total: 0, rules: [] });
    store.close();
  });

  it('counts a call it cannot read apart instead of failing the preview', () => {
    const store = Store.open(':memory:');
    const run = seed(store);
    const broken = store.createRun({ mode: 'record', command: cmd });
    store.appendCallStart({ runId: broken.runId, callNo: 1, ...API, fingerprint: 'c'.repeat(64), occurrence: 1, origin: 'live', effect: null, requestRef: 'f'.repeat(64), meta: {}, at: 1 });
    store.endRun(broken.runId, 'failed');
    expect(previewRedaction(store, broken.runId, [EMAIL])).toMatchObject({ calls: 0, unreadable: 1, total: 0 });
    expect(previewRedaction(store, run.runId, [EMAIL]).unreadable).toBe(0);
    store.close();
  });
});

describe('the rewrite observer', () => {
  it('reports each change with its rule and match count, and leaves results as they were', () => {
    const changes: Array<[number, unknown, unknown, number]> = [];
    const reached: Array<[number, unknown]> = [];
    const observer: RewriteObserver = { changed: (i, b, a, n) => changes.push([i, b, a, n]), reached: (i, v) => reached.push([i, v]) };
    const rules: Normalizer[] = [{ pattern: 'email', replace: '<E>' }, { path: '$.args.token', replace: '<T>' }, { path: '$.args.n', pattern: 'number', replace: '<N>' }];
    const value = { args: { to: 'a@x.io, b@x.io', token: { secret: 1 }, n: 7 } };
    const out = applyNormalizers(value, rules, 'tool', 't', observer);
    expect(out).toEqual(applyNormalizers(value, rules, 'tool', 't'));
    expect(out).toEqual({ args: { to: '<E>, <E>', token: '<T>', n: 7 } });
    expect(changes).toEqual([
      [0, 'a@x.io, b@x.io', '<E>, <E>', 2],
      [1, { secret: 1 }, '<T>', 1],
    ]);
    expect(reached).toEqual([[1, { secret: 1 }], [2, 7]]);
    const text: unknown[] = [];
    expect(rewriteText('to a@x.io', [rules[1]!, rules[0]!], { changed: (i, b, a, n) => text.push([i, b, a, n]) })).toBe('to <E>');
    expect(text).toEqual([[1, 'to a@x.io', 'to <E>', 1]]);
  });
});

describe('clipChange', () => {
  it('cuts both versions to the change with a little context', () => {
    const before = `${'x'.repeat(100)} mail bob@example.com today ${'y'.repeat(100)}`;
    const after = `${'x'.repeat(100)} mail <EMAIL> today ${'y'.repeat(100)}`;
    expect(clipChange(before, after, 6)).toEqual({ before: '…mail bob@example.com today…', after: '…mail <EMAIL> today…' });
    // A word cut in half is left out rather than shown in part.
    expect(clipChange('id 123456 and more words', 'id <N> and more words', 4)).toEqual({ before: 'id 123456 and…', after: 'id <N> and…' });
    expect(clipChange('id 123456 and more words', 'id <N> and more words', 3)).toEqual({ before: 'id 123456…', after: 'id <N>…' });
    expect(clipChange('short', 'shirt')).toEqual({ before: 'short', after: 'shirt' });
  });
});

describe('REDACTION_EXPORTS', () => {
  it('names every way a run leaves the machine, as decision 6 settles it', () => {
    expect(REDACTION_EXPORTS.map((e) => [e.id, e.applies])).toEqual([
      ['pack', 'all'],
      ['html', 'all'],
      ['har', 'all'],
      ['dataset', 'messages'],
      ['pairs', 'messages'],
      ['otel', 'attributes'],
    ]);
  });
});
