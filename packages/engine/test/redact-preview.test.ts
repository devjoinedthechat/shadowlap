import { describe, expect, it } from 'vitest';
import { loadApiRequest, storeApiRequest } from '../src/manifest.js';
import { applyNormalizers, parsePath, rewriteText, type RewriteObserver } from '../src/normalize.js';
import { REDACTION_EXPORTS, clipChange, jsonPath, previewRedaction, redactRun, redactRunDetails, redactRunWithDetails } from '../src/redact.js';
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
    // A path that starts with a key reaches what a call got back too: neither has it.
    expect(nowhere).toMatchObject({ count: 0, reached: 0, note: 'no request or response in this run has $.metadata.session' });
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
    // One its process left running two days ago is not recording: nothing will add to it.
    store.importRun({ ...live, runId: '01ABANDONED000000000000000', startedAt: Date.now() - 2 * 86_400_000 });
    expect(previewRedaction(store, '01ABANDONED000000000000000', [EMAIL])).toMatchObject({ calls: 0, total: 0 });
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
    expect(previewRedaction(store, run.runId, [EMAIL], { maxCalls: 2 })).toMatchObject({ calls: 2, partial: { read: 2, of: 5, stopped: 'calls' }, total: 2 });
    expect(previewRedaction(store, run.runId, [EMAIL], { maxCalls: 5 }).partial).toBeNull();
    // A byte limit stops it between calls, once what it read reaches the limit: the first call's request.
    expect(previewRedaction(store, run.runId, [EMAIL], { maxBytes: 1 })).toMatchObject({ calls: 1, partial: { read: 1, of: 5, stopped: 'bytes' }, total: 1 });
    expect(previewRedaction(store, run.runId, [EMAIL], { maxBytes: 10_000 }).partial).toBeNull();
    // A deadline already past reads nothing more, and says so.
    expect(previewRedaction(store, run.runId, [EMAIL], { deadline: Date.now() - 1 })).toMatchObject({ calls: 0, partial: { read: 0, of: 5, stopped: 'time' }, total: 0 });
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
    // The policy, each user turn and each answer: a response is a JSON document whose strings are
    // read as values, so an answer counts once, in its response and as the conversation sends it
    // back. Then the cards, ids, orders and the company.
    expect(fast.rules.map((r) => r.count)).toEqual([1 + 150 + 150, 150, 150, 150, 1]);
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

  it("counts the run's command line, labels and notes apart: what export html masks and pack keeps", () => {
    const store = Store.open(':memory:');
    const run = seed(store);
    store.updateRunMeta(run.runId, { labels: ['erin@example.com'], notes: [{ callNo: null, text: 'called back hank@example.com', at: 1 }] });
    const noted = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js', '--customer', 'erin@example.com'], cwd: '/home/erin@example.com/agent' } });
    store.updateRunMeta(noted.runId, { labels: ['vip'], notes: [{ callNo: 1, text: 'called back hank@example.com', at: 1 }] });
    store.endRun(noted.runId, 'completed');

    const p = previewRedaction(store, noted.runId, [KEY, EMAIL, USER]);
    // The command line and the note, by the rule without a path; the folder is masked too but not counted, as only html carries it.
    expect(p.details).toEqual({ count: 2, rules: [2], samples: [{ before: 'node agent.js --customer erin@example.com', after: 'node agent.js --customer <EMAIL>' }, { before: 'called back hank@example.com', after: 'called back <EMAIL>' }] });
    expect(p.total).toBe(0);
    expect(previewRedaction(store, run.runId, [EMAIL]).details).toMatchObject({ count: 2, rules: [1] });
    expect(previewRedaction(store, noted.runId, [KEY, USER]).details).toEqual({ count: 0, rules: [], samples: [] });
    store.close();
  });

  it('masks the run\'s own record in a copy that is only read, and keeps it in a pack', () => {
    const store = Store.open(':memory:');
    const run = store.createRun({ mode: 'replay', command: { argv: ['node', 'agent.js', '--notify', 'dave@example.com'], cwd: '/srv/dave@example.com' } });
    store.updateRunMeta(run.runId, {
      labels: ['dave@example.com'],
      notes: [{ callNo: null, text: 'see erin@example.com', at: 1 }],
      checks: [{ ok: false, label: 'mails frank@example.com', detail: 'sent to gina@example.com' }],
      imported: { at: 1, from: 'goldens/hank@example.com' },
      author: 'ivy@example.com',
    });
    store.setDivergence(run.runId, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff: [{ path: '$.messages[0].content', op: 'changed', before: 'for jo@example.com', after: { to: 'kim@example.com' } }], hints: [{ message: 'lee@example.com changes' }], reason: 'mo@example.com' });
    store.endRun(run.runId, 'failed');
    const original = store.getRun(run.runId)!;
    const masked = redactRunDetails(original, [EMAIL]);
    expect(JSON.stringify(masked)).not.toMatch(/[a-z]+@example\.com/);
    expect(masked.command).toEqual({ argv: ['node', 'agent.js', '--notify', '<EMAIL>'], cwd: '/srv/<EMAIL>' });
    expect(masked.meta).toMatchObject({ labels: ['<EMAIL>'], author: '<EMAIL>', imported: { from: 'goldens/<EMAIL>' } });
    expect(masked.divergence!.diff![0]).toEqual({ path: '$.messages[0].content', op: 'changed', before: 'for <EMAIL>', after: { to: '<EMAIL>' } });
    // Ids, times and the rules a replay applies stay as they are; without a rule that has no path nothing changes.
    expect({ ...masked, command: original.command, meta: original.meta, divergence: original.divergence }).toEqual(original);
    expect(redactRunDetails(original, [KEY, USER])).toBe(original);

    // The copy export html makes masks it; the copy pack makes keeps it, since a replay runs the command.
    const html = Store.open(':memory:');
    redactRunWithDetails(store, run.runId, [EMAIL], html);
    expect(JSON.stringify(html.getRun(run.runId))).not.toMatch(/[a-z]+@example\.com/);
    expect(html.getRun(run.runId)!.meta!.redactions).toEqual([EMAIL]);
    const pack = Store.open(':memory:');
    redactRun(store, run.runId, [EMAIL], pack);
    expect(pack.getRun(run.runId)!.command.argv).toEqual(original.command.argv);
    html.close();
    pack.close();
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

/** One call of a run: its request, and what each attempt got back (the bytes stored, or an error in its record). */
function addCall(store: Store, runId: string, callNo: number, kind: 'api' | 'tool' | 'clock' | 'random', name: string, request: unknown, ends: Array<{ body?: string; error?: { name: string; message: string; code?: string; data?: unknown } }>) {
  const id = { kind, name, fingerprint: String(callNo).padStart(64, 'f'), occurrence: 1 };
  const requestRef = request === undefined ? null : kind === 'api' ? storeApiRequest(store, request) : store.putJson(request);
  store.appendCallStart({ runId, callNo, ...id, origin: 'live', effect: kind === 'tool' ? 'read' : null, requestRef, meta: {}, at: callNo });
  ends.forEach((e, attempt) => {
    const responseRef = e.body === undefined ? null : store.putBlob(Buffer.from(e.body));
    store.appendCallEnd(id, { runId, callNo, attempt, responseRef, outcome: e.error ? 'error' : 'ok', meta: e.error ? { error: e.error } : {}, at: callNo });
  });
}

/** What a copy of the run holds for each call: its request, and each attempt's response and error, as text. */
function copied(store: Store, runId: string, rules: Normalizer[]) {
  const dst = Store.open(':memory:');
  redactRun(store, runId, rules, dst);
  const out = dst.getCalls(runId).map((c) => ({
    request: c.requestRef ? JSON.stringify(c.kind === 'api' ? loadApiRequest(dst, c.requestRef) : dst.getJson(c.requestRef)) : null,
    ends: [...c.attempts, ...(c.end ? [c.end] : [])].map((e) => ({ body: e.responseRef ? dst.getBlob(e.responseRef)!.toString('utf8') : null, error: e.meta.error ?? null })),
  }));
  dst.close();
  return out;
}

describe('what a copy leaves as it is', () => {
  it('counts the strings of a JSON document, and the numbers a pattern matches apart, with where each is and the path rule that masks it', () => {
    const store = Store.open(':memory:');
    const run = store.createRun({ mode: 'record', command: cmd });
    // A clock read, a card on file as a number and as text, and the result sent back to the model as a string.
    const result = '{\n  "result": {"card": 4111111111111111, "on_file": "4111 1111 1111 1111", "owner": "ann@example.com"}\n}';
    addCall(store, run.runId, 1, 'clock', 'now', { label: 'now' }, [{ body: '{"result":1792155242516}' }]);
    addCall(store, run.runId, 2, 'tool', 'lookup_card', { args: { customer: 'ann@example.com' } }, [{ body: result }]);
    const sentBack = JSON.stringify(JSON.parse(result).result);
    addCall(store, run.runId, 3, 'api', 'POST /v1/messages', { model: 'm', messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: sentBack }] }] }, [{ body: '{"content":[{"type":"text","text":"Card on file."}],"usage":{"input_tokens":4111}}' }]);
    store.endRun(run.runId, 'completed');

    const p = previewRedaction(store, run.runId, [EMAIL, CARD]);
    const [email, card] = p.rules;
    // The address, one value as the request and the result hold it, and the result sent back.
    expect(email).toMatchObject({ count: 2, unmasked: { count: 0, samples: [], remedies: [] } });
    // The card as text in the result, and both cards in the string sent back; not the number the result holds.
    expect(card!.count).toBe(3);
    expect(card!.samples[0]).toEqual({ before: '4111 1111 1111 1111', after: '<CARD>' });
    expect(card!.unmasked).toEqual({
      count: 2,
      samples: [
        { value: '1792155242516', key: false, callNo: 1, kind: 'clock', name: 'now', in: 'response', path: '$.result' },
        { value: '4111111111111111', key: false, callNo: 2, kind: 'tool', name: 'lookup_card', in: 'response', path: '$.result.card' },
      ],
      // None for the clock read: a replay needs the time as recorded.
      remedies: [{ rule: { kind: 'tool', name: 'lookup_card', path: '$.result.card', replace: '<CARD>' }, command: "shadowlap redact add --kind tool --name lookup_card --path '$.result.card' --replace '<CARD>'" }],
    });
    expect(p).toMatchObject({ total: 5, unmasked: 2 });

    // The copy holds exactly that: the strings masked, both numbers as recorded, the layout kept.
    const [clock, lookup] = copied(store, run.runId, [EMAIL, CARD]);
    expect(clock!.ends[0]!.body).toBe('{"result":1792155242516}');
    expect(lookup!.ends[0]!.body).toBe('{\n  "result": {"card": 4111111111111111, "on_file": "<CARD>", "owner": "<EMAIL>"}\n}');

    // The rule the preview proposes masks the number, as it says: the card is gone from the copy.
    const fix = card!.unmasked.remedies[0]!.rule;
    const after = previewRedaction(store, run.runId, [EMAIL, CARD, fix]);
    expect(after.rules[1]!.unmasked).toMatchObject({ count: 1, remedies: [] });
    expect(after.rules[2]).toMatchObject({ count: 1, reached: 1, samples: [{ before: '4111111111111111', after: '<CARD>' }] });
    expect(copied(store, run.runId, [EMAIL, CARD, fix])[1]!.ends[0]!.body).toBe('{\n  "result": {"card": "<CARD>", "on_file": "<CARD>", "owner": "<EMAIL>"}\n}');
    store.close();
  });

  it('says a rule matches only numbers here, and proposes one rule for each place, positions read as [*]', () => {
    const store = Store.open(':memory:');
    const run = store.createRun({ mode: 'record', command: cmd });
    const use = (id: string, amount: number) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'refund', input: { amount } }] });
    const messages = [{ role: 'user', content: 'Refund both orders.' }, use('t1', 4111111111111111), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, use('t2', 5500000000000004)];
    addCall(store, run.runId, 1, 'api', 'POST /v1/messages', { model: 'm', messages: messages.slice(0, 1) }, [{ body: JSON.stringify({ content: messages[1]!.content }) }]);
    addCall(store, run.runId, 2, 'api', 'POST /v1/messages', { model: 'm', messages: messages.slice(0, 3) }, [{ body: JSON.stringify({ content: messages[3]!.content }) }]);
    addCall(store, run.runId, 3, 'api', 'POST /v1/messages', { model: 'm', messages }, [{ body: '{"content":[{"type":"text","text":"Done."}]}' }]);
    store.endRun(run.runId, 'completed');
    const card = previewRedaction(store, run.runId, [CARD]).rules[0]!;
    expect(card.count).toBe(0);
    expect(card.note).toBe('it matches only numbers here, which a copy leaves as they are');
    // Each amount once, wherever it is sent again; a rule for the responses' place and one for the requests'.
    expect(card.unmasked.count).toBe(2);
    expect(card.unmasked.samples.map((s) => [s.value, s.in, s.path])).toEqual([
      ['4111111111111111', 'response', '$.content[0].input.amount'],
      ['5500000000000004', 'response', '$.content[0].input.amount'],
    ]);
    expect(card.unmasked.remedies.map((r) => r.command)).toEqual([
      "shadowlap redact add --kind api --path '$.content[*].input.amount' --replace '<CARD>'",
      "shadowlap redact add --kind api --path '$.messages[*].content[*].input.amount' --replace '<CARD>'",
    ]);
    // With both, nothing of either is left in the copy, and the preview says so.
    const fixed = [CARD, ...card.unmasked.remedies.map((r) => r.rule)];
    expect(previewRedaction(store, run.runId, fixed)).toMatchObject({ unmasked: 0, total: 4 });
    expect(JSON.stringify(copied(store, run.runId, fixed))).not.toMatch(/4111111111111111|5500000000000004/);
    store.close();
  });

  it("reads keys as the copy does: a response's are strings it masks, a request's and an error's stay", () => {
    const store = Store.open(':memory:');
    const run = store.createRun({ mode: 'record', command: cmd });
    const error = { name: 'Error', message: 'over the limit', data: { 'dan@example.com': 'blocked', account: 4111111111111111 } };
    addCall(store, run.runId, 1, 'tool', 'notify', { args: { 'bob@example.com': 'cc' } }, [{ body: JSON.stringify({ error }), error }, { body: '{"result":{"carol@example.com":true}}' }]);
    store.endRun(run.runId, 'completed');
    const [email, card] = previewRedaction(store, run.runId, [EMAIL, CARD]).rules;
    // The result's key, and the key of the error's response, which a tool stores as JSON.
    expect(email!.count).toBe(2);
    expect(email!.unmasked.samples.map((s) => [s.value, s.in, s.path])).toEqual([
      ['bob@example.com', 'request', '$.args["bob@example.com"]'],
      ['dan@example.com', 'error', '$.error.data["dan@example.com"]'],
    ]);
    expect(email!.unmasked.samples.every((s) => s.key)).toBe(true);
    // A key can't be masked alone: a path rule masks the object that holds it.
    expect(email!.unmasked.remedies.map((r) => r.command)).toEqual([
      "shadowlap redact add --kind tool --name notify --path '$.args' --replace '<EMAIL>'",
      "shadowlap redact add --kind tool --name notify --path '$.error.data' --replace '<EMAIL>'",
    ]);
    // The account, as the error's response holds it and as the error in the call's record does.
    expect(card!.unmasked.samples.map((s) => [s.value, s.in, s.path])).toEqual([['4111111111111111', 'response', '$.error.data.account']]);
    expect(card!.unmasked.remedies.map((r) => r.command)).toEqual(["shadowlap redact add --kind tool --name notify --path '$.error.data.account' --replace '<CARD>'"]);
    // A path rule reaches the error in the record too, read as the tool stores it.
    const fix = card!.unmasked.remedies[0]!.rule;
    const [notify] = copied(store, run.runId, [EMAIL, CARD, fix]);
    expect(notify!.ends[0]!.error).toEqual({ name: 'Error', message: 'over the limit', data: { 'dan@example.com': 'blocked', account: '<CARD>' } });
    expect(JSON.parse(notify!.ends[0]!.body!)).toEqual({ error: { name: 'Error', message: 'over the limit', data: { '<EMAIL>': 'blocked', account: '<CARD>' } } });
    expect(previewRedaction(store, run.runId, [EMAIL, CARD, fix]).rules[1]!.unmasked.count).toBe(0);
    store.close();
  });

  it("says what a path rule's pattern leaves at its path, and that the rule without it masks the whole value", () => {
    const store = Store.open(':memory:');
    const run = store.createRun({ mode: 'record', command: cmd });
    addCall(store, run.runId, 1, 'tool', 'charge', { args: { card: 4111111111111111 } }, [{ body: '{"result":{"ok":true}}' }]);
    store.endRun(run.runId, 'completed');
    const rule: Normalizer = { kind: 'tool', path: '$.args.card', pattern: '/\\d{16}/', replace: '<CARD>' };
    const [r] = previewRedaction(store, run.runId, [rule]).rules;
    expect(r).toMatchObject({ count: 0, reached: 1, note: "what /\\d{16}/ matches at $.args.card here isn't a string, so it stays as it is: without the pattern, the rule masks the whole value" });
    expect(r!.unmasked).toEqual({
      count: 1,
      samples: [{ value: '4111111111111111', key: false, callNo: 1, kind: 'tool', name: 'charge', in: 'request', path: '$.args.card' }],
      remedies: [{ rule: { kind: 'tool', path: '$.args.card', replace: '<CARD>' }, command: "shadowlap redact add --kind tool --path '$.args.card' --replace '<CARD>'" }],
    });
    store.close();
  });

  it('counts a value a streamed response splits across events once, as the copy masks it', () => {
    const store = Store.open(':memory:');
    const run = store.createRun({ mode: 'record', command: cmd });
    const delta = (text: string) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`;
    const stream = ['Sent to ma', 'ya@exam', 'ple.com today.'].map(delta).join('');
    addCall(store, run.runId, 1, 'api', 'POST /v1/messages', { model: 'm', messages: [{ role: 'user', content: 'Send it.' }] }, [{ body: stream }]);
    // The answer goes back with the next request: the same value, counted once.
    addCall(store, run.runId, 2, 'api', 'POST /v1/messages', { model: 'm', messages: [{ role: 'user', content: 'Send it.' }, { role: 'assistant', content: [{ type: 'text', text: 'Sent to maya@example.com today.' }] }, { role: 'user', content: 'Thanks.' }] }, [{ body: '{"content":[{"type":"text","text":"Bye."}]}' }]);
    store.endRun(run.runId, 'completed');
    const [email] = previewRedaction(store, run.runId, [EMAIL]).rules;
    expect(email).toMatchObject({ count: 1, samples: [{ before: 'Sent to maya@example.com today.', after: 'Sent to <EMAIL> today.' }] });
    expect(JSON.stringify(copied(store, run.runId, [EMAIL]))).not.toContain('maya@');
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

describe('REDACTION_EXPORTS', () => {
  it('names every export decision 6 covers, and what each does with the run\'s details', () => {
    expect(REDACTION_EXPORTS.map((e) => [e.id, e.applies, e.details])).toEqual([
      ['pack', 'all', 'kept'],
      ['html', 'all', 'masked'],
      ['har', 'all', 'absent'],
      ['dataset', 'messages', 'masked'],
      ['pairs', 'messages', 'absent'],
      ['otel', 'attributes', 'masked'],
    ]);
    for (const e of REDACTION_EXPORTS) expect(e.command).toBe(e.id === 'pack' ? 'shadowlap pack' : `shadowlap export ${e.id}`);
  });
});

describe('jsonPath', () => {
  it('writes where a value is as a path rule reads it back, positions after the first as [*] when asked', () => {
    for (const key of ['amount', 'a.b', 'a b', '$ref', '', '*', 'a"b', "a'b", '[0', 'é', 'bob@example.com', ' sp ', 'a[b', 'new\nline']) {
      expect(parsePath(jsonPath(['args', key, 3])), key).toEqual([{ type: 'key', key: 'args' }, { type: 'key', key }, { type: 'index', index: 3 }]);
    }
    // A key with a ] can't be named: it reads as every key there.
    expect(parsePath(jsonPath(['x]y']))).toEqual([{ type: 'wild' }]);
    expect(jsonPath(['messages', 3, 'content', 1, 'input', 'amount'], true)).toBe('$.messages[*].content[*].input.amount');
    // An array of chunks keeps its first position: a path that starts with a wildcard reaches requests only.
    expect(jsonPath([0, 'usageMetadata', 'totalTokenCount'], true)).toBe('$[0].usageMetadata.totalTokenCount');
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
