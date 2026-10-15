import { describe, expect, it } from 'vitest';
import { loadApiRequest, storeApiRequest } from '../src/manifest.js';
import { applyNormalizers, rewriteText, type RewriteObserver } from '../src/normalize.js';
import { clipChange, previewRedaction, redactRun } from '../src/redact.js';
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

  it('counts what pack masks in an error, and stops early when asked to, saying how far it got', () => {
    const store = Store.open(':memory:');
    const run = store.createRun({ mode: 'record', command: cmd });
    const tool = { kind: 'tool' as const, name: 'send_email', fingerprint: 'e'.repeat(64), occurrence: 1 };
    const error = { name: 'Error', message: 'mailbox of dana@example.com is full' };
    store.appendCallStart({ runId: run.runId, callNo: 1, ...tool, origin: 'live', effect: 'write', requestRef: store.putJson({ args: { to: 'x' } }), meta: {}, at: 1 });
    store.appendCallEnd(tool, { runId: run.runId, callNo: 1, attempt: 0, responseRef: null, outcome: 'error', meta: { error }, at: 2 });
    for (let i = 2; i <= 5; i++) {
      const t = { ...tool, fingerprint: String(i).padStart(64, 'e') };
      store.appendCallStart({ runId: run.runId, callNo: i, ...t, origin: 'live', effect: 'write', requestRef: store.putJson({ args: { to: `user${i}@example.com` } }), meta: {}, at: i });
    }
    store.endRun(run.runId, 'completed');
    const full = previewRedaction(store, run.runId, [EMAIL]);
    expect(full).toMatchObject({ calls: 5, partial: null, total: 5 });
    expect(full.rules[0]!.samples[0]).toEqual({ before: 'mailbox of dana@example.com is full', after: 'mailbox of <EMAIL> is full' });
    // The copy pack writes carries the error masked too.
    const dst = Store.open(':memory:');
    redactRun(store, run.runId, [EMAIL], dst);
    expect(dst.getCalls(run.runId)[0]!.end!.meta.error).toEqual({ name: 'Error', message: 'mailbox of <EMAIL> is full' });
    dst.close();
    expect(previewRedaction(store, run.runId, [EMAIL], { maxCalls: 2 })).toMatchObject({ calls: 2, partial: { read: 2, of: 5 }, total: 2 });
    store.close();
  });

  it('reads a long conversation once, and counts exactly what reading every request whole counts', () => {
    const store = Store.open(':memory:');
    const run = store.createRun({ mode: 'record', command: cmd });
    const system = [{ type: 'text', text: `Support policy for acme. Escalate to lead@example.com. ${'Be kind. '.repeat(400)}` }];
    const messages: unknown[] = [];
    for (let i = 1; i <= 150; i++) {
      messages.push({ role: 'user', content: `Order ${4400 + i} for customer${i}@example.com, card 4111 1111 1111 ${String(1000 + i)}` });
      const id = { ...API, fingerprint: String(i).padStart(64, 'c'), occurrence: 1 };
      store.appendCallStart({ runId: run.runId, callNo: i, ...id, origin: 'live', effect: null, requestRef: storeApiRequest(store, { model: 'm', system, messages: [...messages], metadata: { user_id: `9b1deb4d-3b7d-4bad-9bdd-${String(i).padStart(12, '0')}` } }), meta: {}, at: i });
      store.appendCallEnd(id, { runId: run.runId, callNo: i, attempt: 0, responseRef: store.putBlob(Buffer.from(`{"content":[{"type":"text","text":"Done for customer${i}@example.com"}]}`)), outcome: 'ok', meta: {}, at: i });
      messages.push({ role: 'assistant', content: `Done for customer${i}@example.com` });
    }
    store.endRun(run.runId, 'completed');
    const rules: Normalizer[] = [EMAIL, CARD, USER, { kind: 'api', path: '$.messages[*].content', pattern: '/Order \\d+/', replace: 'Order <N>' }, { kind: 'api', path: '$.system[0].text', pattern: '/acme/', replace: '<CO>' }];
    const fast = previewRedaction(store, run.runId, rules);
    // A rule that sees one whole message makes the preview read every request whole; it applies to no call here.
    const whole = previewRedaction(store, run.runId, [...rules, { kind: 'tool', name: 'nothing', path: '$.messages[0]', replace: 'x' }]);
    expect(fast.rules).toEqual(whole.rules.slice(0, rules.length));
    expect(fast.total).toBe(whole.total);
    // The policy, each user turn, each answer sent back, and each response; then the cards, ids, orders and the company.
    expect(fast.rules.map((r) => r.count)).toEqual([1 + 150 + 149 + 150, 150, 150, 150, 1]);
    store.close();
  });

  it('takes time in proportion to a long run, not to the square of its length', () => {
    const store = Store.open(':memory:');
    const run = store.createRun({ mode: 'record', command: cmd });
    // Stored as storeApiRequest stores a conversation: each message once, and a manifest per request listing them.
    const system = store.putJson(`You help customers. The account owner is alice@example.com. ${'Policy text. '.repeat(200)}`);
    const messages: string[] = [];
    store.transaction(() => {
      for (let i = 0; i < 400; i++) {
        messages.push(store.putJson({ role: 'user', content: `Turn ${i}: refund order ${4400 + i} for user${i}@example.com. ${'More words here. '.repeat(20)}` }));
        const id = { ...API, fingerprint: String(i).padStart(64, 'd'), occurrence: 1 };
        const manifest = store.putJson({ v: 1, kind: 'chunked', fields: { model: 'm' }, system, tools: null, messages: [...messages] });
        store.appendCallStart({ runId: run.runId, callNo: i + 1, ...id, origin: 'live', effect: null, requestRef: manifest, meta: {}, at: i });
        store.appendCallEnd(id, { runId: run.runId, callNo: i + 1, attempt: 0, responseRef: store.putBlob(Buffer.from(`data: {"delta":{"text":"Emailing user${i}@example.com"}}\n\n`)), outcome: 'ok', meta: {}, at: i });
        messages.push(store.putJson({ role: 'assistant', content: `Emailing user${i}@example.com` }));
      }
    });
    store.endRun(run.runId, 'completed');
    const rules = [EMAIL, CARD, USER];
    let started = performance.now();
    const p = previewRedaction(store, run.runId, rules);
    const fast = performance.now() - started;
    // Reading every request whole, as the preview must with a rule that sees a whole message: the square of the length.
    started = performance.now();
    const whole = previewRedaction(store, run.runId, [...rules, { kind: 'tool', name: 'nothing', path: '$.messages[0]', replace: 'x' }]);
    const slow = performance.now() - started;
    expect(p.rules).toEqual(whole.rules.slice(0, rules.length));
    // About seven times faster at 400 calls here, and the gap widens with the length; a third is the floor.
    expect(fast).toBeLessThan(slow / 3);
    // The system prompt, each user turn, each answer as the conversation sends it back, and each response.
    expect(p).toMatchObject({ calls: 400, partial: null });
    expect(p.rules[0]!.count).toBe(1 + 400 + 399 + 400);
    store.close();
  }, 30_000);

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
