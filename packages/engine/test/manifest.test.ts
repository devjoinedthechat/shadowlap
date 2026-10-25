import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadApiRequest, manifestRefs, storeApiRequest } from '../src/manifest.js';
import { packRun, unpackRun } from '../src/pack.js';
import { Store } from '../src/store.js';

/**
 * A request is stored as its growing list one item per blob, so a run of n calls stores each turn
 * once: for Anthropic's and Chat Completions' `messages` (version 1 manifests, still written), and
 * for Gemini's `contents` and the Responses API's `input` items (version 2).
 */

const TURN = 'x'.repeat(1000);
const SYSTEM = 'You answer questions about orders. '.repeat(30);

/** The body of call n of a conversation that grows by two turns a call, in each wire format. */
const bodies = {
  messages: (n: number) => ({ model: 'claude-haiku-4-5', max_tokens: 64, system: SYSTEM, messages: Array.from({ length: 2 * n + 1 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i} ${TURN}` })) }),
  contents: (n: number) => ({ systemInstruction: { parts: [{ text: SYSTEM }] }, generationConfig: { temperature: 0 }, contents: Array.from({ length: 2 * n + 1 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', parts: [{ text: `${i} ${TURN}` }] })) }),
  input: (n: number) => ({ model: 'gpt-5', instructions: SYSTEM, store: false, input: Array.from({ length: 2 * n + 1 }, (_, i) => (i % 2 ? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `${i} ${TURN}` }] } : { role: 'user', content: `${i} ${TURN}` })) }),
};

/** Bytes the store holds after storing calls 0..n-1 of a conversation. */
function storedBytes(body: (n: number) => unknown, calls: number): number {
  const store = Store.open(':memory:');
  try {
    for (let n = 0; n < calls; n++) storeApiRequest(store, body(n));
    return Number(store.query('SELECT SUM(size) AS bytes FROM blobs')[0].bytes);
  } finally {
    store.close();
  }
}

describe('request manifests', () => {
  it('store each turn once, in every wire format: a fraction of the requests\' own bytes', () => {
    for (const [format, body] of Object.entries(bodies)) {
      const sent = Array.from({ length: 160 }, (_, n) => JSON.stringify(body(n)).length).reduce((a, b) => a + b, 0);
      // Stored whole, each request would be all of it again: about 1. Each turn once is a few per cent.
      expect(storedBytes(body, 160) / sent, format).toBeLessThan(0.1);
    }
  });

  it('store a Gemini or Responses conversation in space that grows with its turns, not with their square', () => {
    for (const format of ['contents', 'input'] as const) {
      const small = storedBytes(bodies[format], 40);
      const large = storedBytes(bodies[format], 160);
      // Four times the calls: four times the turns and as many manifests, the runs a little more. Whole, it would be sixteen.
      expect(large / small, format).toBeLessThan(5);
      // Each turn once, the instructions once, and per call a manifest and the runs it adds.
      expect(large, format).toBeLessThan(320 * (TURN.length + 100) + 160 * 1200 + SYSTEM.length * 2);
    }
  });

  it('read back each body as it was sent, its repeated members stored once', () => {
    const store = Store.open(':memory:');
    for (const [format, body] of Object.entries(bodies)) {
      for (const n of [0, 3]) expect(loadApiRequest(store, storeApiRequest(store, body(n))), `${format} ${n}`).toEqual(body(n));
    }
    // Gemini's instruction and the Responses API's instructions are blobs of their own, shared by every call.
    const first = store.getJson<{ v: number; kind: string; parts: Record<string, string>; list: string; runs: string[] }>(storeApiRequest(store, bodies.contents(1)))!;
    const later = store.getJson<{ parts: Record<string, string> }>(storeApiRequest(store, bodies.contents(5)))!;
    expect(first).toMatchObject({ v: 2, kind: 'list', list: 'contents', fields: { generationConfig: { temperature: 0 } } });
    expect(Object.keys(first.parts)).toEqual(['systemInstruction']);
    expect(later.parts.systemInstruction).toBe(first.parts.systemInstruction);
    // Three contents as runs of 2 and 1; eleven as runs of 8, 2 and 1, the first 2 inside the run of 8.
    expect(first.runs.map((r) => store.getJson<string[]>(r)!.length)).toEqual([2, 1]);
    const eleven = store.getJson<{ runs: string[] }>(storeApiRequest(store, bodies.contents(5)))!;
    expect(eleven.runs.map((r) => store.getJson<string[]>(r)!.length)).toEqual([8, 2, 1]);
    // Thirteen share the run of 8 with eleven.
    expect(store.getJson<{ runs: string[] }>(storeApiRequest(store, bodies.contents(6)))!.runs[0]).toBe(eleven.runs[0]);
    expect(store.getJson(storeApiRequest(store, bodies.input(2)))).toMatchObject({ v: 2, kind: 'list', list: 'input', fields: { model: 'gpt-5', store: false } });
    // A messages conversation is a version 1 manifest, as every reader of one already reads it.
    expect(store.getJson(storeApiRequest(store, bodies.messages(1)))).toMatchObject({ v: 1, kind: 'chunked' });
    // A Responses request whose input is one string is no list: stored whole.
    expect(store.getJson(storeApiRequest(store, { model: 'gpt-5', input: 'hello' }))).toMatchObject({ v: 1, kind: 'whole' });
    store.close();
  });

  it('name every blob they need, for gc and packs alike, and gc keeps a version 2 request whole', () => {
    const store = Store.open(':memory:');
    const run = store.createRun({ mode: 'record', command: { argv: ['x'], cwd: '/' } });
    const ref = storeApiRequest(store, bodies.contents(2));
    // The instruction, the runs of 4 and 1 contents, and the 5 contents.
    expect(manifestRefs(store, ref)).toHaveLength(1 + 2 + 5);
    store.appendCallStart({ runId: run.runId, callNo: 1, kind: 'api', name: 'POST /v1beta/models/gemini-2.5-flash:generateContent', fingerprint: 'f', occurrence: 1, origin: 'live', effect: null, requestRef: ref, meta: {}, at: 1 });
    store.endRun(run.runId, 'completed');
    store.putJson({ unreferenced: true });
    expect(store.gcBlobs().removed).toBe(1);
    expect(loadApiRequest(store, ref)).toEqual(bodies.contents(2));
    store.close();
  });

  it('travel in a pack, and come back readable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-manifest-v2-'));
    const source = Store.open(':memory:');
    const target = Store.open(':memory:');
    try {
      const run = source.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: '.' } });
      const identity = { kind: 'api' as const, name: 'POST /v1/responses', fingerprint: 'f'.repeat(64), occurrence: 1 };
      source.appendCallStart({ runId: run.runId, callNo: 1, ...identity, origin: 'live', effect: null, requestRef: storeApiRequest(source, bodies.input(3)), meta: { provider: 'openai', fingerprintHeaders: {} }, at: run.startedAt });
      source.appendCallEnd(identity, { runId: run.runId, callNo: 1, attempt: 0, responseRef: source.putBlob(Buffer.from('{"id":"resp_1","output":[]}')), outcome: 'ok', meta: { status: 200 }, at: run.startedAt + 1 });
      source.endRun(run.runId, 'completed');
      packRun(source, run.runId, join(dir, 'golden'));
      const { imported } = unpackRun(target, join(dir, 'golden'));
      const [call] = target.getCalls(imported[0]);
      expect(loadApiRequest(target, call.requestRef!)).toEqual(bodies.input(3));
    } finally {
      source.close();
      target.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuse a version 2 manifest that names a list or a part no request has, or a version they don\'t know', () => {
    const store = Store.open(':memory:');
    const item = store.putJson({ role: 'user', parts: [{ text: 'hi' }] });
    const read = (manifest: unknown) => () => loadApiRequest(store, store.putJson(manifest));
    const run = store.putJson([item, item]);
    expect(read({ v: 2, kind: 'list', fields: {}, parts: {}, list: 'contents', runs: [run] })()).toEqual({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }, { role: 'user', parts: [{ text: 'hi' }] }] });
    expect(read({ v: 2, kind: 'list', fields: {}, parts: {}, list: 'prompt', runs: [run] })).toThrow(/its list is "prompt"/);
    expect(read(JSON.parse(`{"v":2,"kind":"list","fields":{},"parts":{"__proto__":"${item}"},"list":"contents","runs":[]}`))).toThrow(/stores "__proto__" apart/);
    expect(read({ v: 2, kind: 'list', fields: {}, parts: { model: item }, list: 'input', runs: [] })).toThrow(/stores "model" apart/);
    expect(read({ v: 2, kind: 'list', fields: {}, parts: {}, list: 'input', runs: [store.putJson(['0'.repeat(64)])] })).toThrow(/missing blob/);
    expect(read({ v: 2, kind: 'list', fields: {}, parts: {}, list: 'input', runs: [store.putJson({ not: 'a run' })] })).toThrow(/not a list of blob hashes/);
    expect(read({ v: 3, kind: 'chunked', fields: {}, system: null, tools: null, messages: [] })).toThrow(/version 3/);
    store.close();
  });

  it('keep a __proto__ member of a version 2 body as data', () => {
    const store = Store.open(':memory:');
    const body = JSON.parse('{"contents":[],"__proto__":{"x":1}}') as Record<string, unknown>;
    const back = loadApiRequest(store, storeApiRequest(store, body)) as Record<string, unknown>;
    expect(Object.keys(back).sort()).toEqual(['__proto__', 'contents']);
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
    store.close();
  });
});
