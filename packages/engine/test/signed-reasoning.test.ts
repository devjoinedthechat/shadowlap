import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadApiRequest, storeApiRequest } from '../src/manifest.js';
import { packRun, unpackRun } from '../src/pack.js';
import { previewRedaction, redactBytes, redactRunWithDetails } from '../src/redact.js';
import { Store } from '../src/store.js';
import type { Normalizer } from '../src/types.js';

/**
 * A provider signs a model's thinking and refuses a request that sends a changed block back. A
 * pack, which a fork replays and then sends on live, keeps signed reasoning as recorded whatever
 * the redaction rules, and names the rules that matched inside it; a copy that is only read masks it.
 */

const EMAIL: Normalizer = { pattern: 'email', replace: '<EMAIL>' };
/** A rule for anything that looks like a long token, which a signature does. */
const TOKENS: Normalizer = { pattern: '/[A-Za-z0-9+/]{40,}/', replace: '<TOKEN>' };
const THINKING = 'The customer alice@example.com asks for a refund of order 4417; check the order first.';
const SIGNATURE = 'EqQBCkYIBxgCKkBhZGRlZDEyMzQ1Njc4OTBhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejEyMzQ1Njc4OTA=';

/** The stream the Messages API sends for a turn that thinks, says something and calls a tool: the thinking text in pieces. */
function thinkingStream(): string {
  const events = [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    // The address split across two pieces, as a stream sends it.
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: THINKING.slice(0, 22) } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: THINKING.slice(22) } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: SIGNATURE } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Looking up the order for alice@example.com.' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

/** The SSE events' data in a stored response. */
const events = (sse: string) => sse.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)) as Record<string, any>);

function recording(store: Store) {
  const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/tmp' } });
  const call = (callNo: number, request: unknown, response: string, at: number) => {
    const id = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: String(callNo).repeat(64), occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo, ...id, origin: 'live', effect: null, requestRef: storeApiRequest(store, request), meta: { provider: 'anthropic' }, at });
    store.appendCallEnd(id, { runId: run.runId, callNo, attempt: 0, responseRef: store.putBlob(Buffer.from(response)), outcome: 'ok', meta: { status: 200, headers: { 'content-type': callNo === 1 ? 'text/event-stream' : 'application/json' } }, at: at + 1 });
  };
  const user = { role: 'user', content: 'Refund order 4417 for alice@example.com' };
  call(1, { model: 'claude-sonnet-5', thinking: { type: 'enabled', budget_tokens: 2048 }, messages: [user] }, thinkingStream(), 1);
  // The next request sends the thinking block back, as the SDK hands it on, signature and all.
  const back = { role: 'assistant', content: [{ signature: SIGNATURE, thinking: THINKING, type: 'thinking' }, { type: 'redacted_thinking', data: 'EmwKAhgBEgy3va3pzix/LafPsn4aDFIT2Xlxh0L5L8rLVyIwxtE3rAFBa8cr3qyR' }, { type: 'text', text: 'Looking up the order for alice@example.com.' }] };
  call(2, { model: 'claude-sonnet-5', messages: [user, back, { role: 'user', content: 'Go ahead.' }] }, JSON.stringify({ id: 'msg_2', type: 'message', role: 'assistant', content: [{ type: 'thinking', thinking: 'Refund approved for alice@example.com.', signature: SIGNATURE }, { type: 'text', text: 'Done: refunded alice@example.com.' }] }), 3);
  store.endRun(run.runId, 'completed');
  return run;
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('a pack of a run with signed reasoning', () => {
  it('keeps each thinking block as recorded, masks everything around it, and names the rules that matched inside', () => {
    const store = Store.open(':memory:');
    const run = recording(store);
    const dir = join(mkdtempSync(join(tmpdir(), 'sl-signed-')), 'pack');
    dirs.push(join(dir, '..'));
    const result = packRun(store, run.runId, dir, { redact: [EMAIL, TOKENS] });
    // Both rules match inside: the address in the thinking, the signature as a long token.
    expect(result.signed).toEqual([
      { n: 1, rule: EMAIL, calls: [{ runId: run.runId, callNo: 1 }, { runId: run.runId, callNo: 2 }] },
      { n: 2, rule: TOKENS, calls: [{ runId: run.runId, callNo: 1 }, { runId: run.runId, callNo: 2 }] },
    ]);
    const into = Store.open(':memory:');
    const [id] = unpackRun(into, dir).imported;
    const [first, second] = into.getCalls(id);

    // What a replay hands the agent: the thinking as it streamed, piece by piece, and its signature.
    const streamed = events(into.getBlob(first.end!.responseRef!)!.toString('utf8'));
    const thinking = streamed.filter((e) => e.delta?.type === 'thinking_delta').map((e) => e.delta.thinking as string).join('');
    expect(thinking).toBe(THINKING);
    expect(streamed.find((e) => e.delta?.type === 'signature_delta')!.delta.signature).toBe(SIGNATURE);
    // The text around it is masked.
    expect(streamed.find((e) => e.delta?.type === 'text_delta')!.delta.text).toBe('Looking up the order for <EMAIL>.');

    // The next request keeps the block it sends back, and masks the rest.
    const request = loadApiRequest(into, second.requestRef!) as { messages: Array<{ content: any }> };
    expect(request.messages[0].content).toBe('Refund order 4417 for <EMAIL>');
    expect(request.messages[1].content[0]).toEqual({ signature: SIGNATURE, thinking: THINKING, type: 'thinking' });
    expect(request.messages[1].content[1]).toEqual({ type: 'redacted_thinking', data: 'EmwKAhgBEgy3va3pzix/LafPsn4aDFIT2Xlxh0L5L8rLVyIwxtE3rAFBa8cr3qyR' });
    expect(request.messages[1].content[2]).toEqual({ type: 'text', text: 'Looking up the order for <EMAIL>.' });
    // A response that is one message keeps its thinking block too.
    const message = JSON.parse(into.getBlob(second.end!.responseRef!)!.toString('utf8'));
    expect(message.content).toEqual([{ type: 'thinking', thinking: 'Refund approved for alice@example.com.', signature: SIGNATURE }, { type: 'text', text: 'Done: refunded <EMAIL>.' }]);
    into.close();
    store.close();
  });

  it('is masked through and through in a copy that is only read', () => {
    const store = Store.open(':memory:');
    const run = recording(store);
    const copy = Store.open(':memory:');
    redactRunWithDetails(store, run.runId, [EMAIL], copy);
    const [first, second] = copy.getCalls(run.runId);
    expect(copy.getBlob(first.end!.responseRef!)!.toString('utf8')).not.toContain('alice@example.com');
    expect(JSON.stringify(loadApiRequest(copy, second.requestRef!))).not.toContain('alice@example.com');
    expect(copy.getBlob(second.end!.responseRef!)!.toString('utf8')).not.toContain('alice@example.com');
    store.close();
  });

  it('is counted by the preview as what a pack leaves as it is, for its own reason', () => {
    const store = Store.open(':memory:');
    const run = recording(store);
    const preview = previewRedaction(store, run.runId, [EMAIL]);
    const rule = preview.rules[0];
    // Masked: the user's message, and the answers' text.
    expect(rule.count).toBe(3);
    expect(rule.unmasked.reasons).toEqual(['signed']);
    expect(rule.unmasked.remedies).toEqual([]);
    // The streamed thinking counts once, whole; the block sent back and the second thinking are other texts.
    expect(rule.unmasked.samples.map((s) => s.value)).toEqual([THINKING, 'Refund approved for alice@example.com.']);
    expect(rule.unmasked.count).toBe(2);
    // A rule that matches only there says so, and that a pack is what leaves it.
    expect(previewRedaction(store, run.runId, [TOKENS]).rules[0].note).toBe('it matches only signed reasoning (a thinking block, its signature) here, which a pack leaves as they are');
    store.close();
  });
});

describe('the signed reasoning of the other providers', () => {
  it('stays as recorded in a pack and is masked in a copy that is only read', () => {
    const cases: Array<{ name: string; body: unknown; kept: (doc: any) => unknown }> = [
      // Bedrock Converse: reasoningContent, its text and signature.
      { name: 'converse', body: { output: { message: { content: [{ reasoningContent: { reasoningText: { text: 'think about alice@example.com', signature: SIGNATURE } } }, { text: 'mail alice@example.com' }] } } }, kept: (d) => d.output.message.content[0] },
      // Gemini: a part's thought signature.
      { name: 'gemini', body: { candidates: [{ content: { parts: [{ text: 'mail alice@example.com', thoughtSignature: `${SIGNATURE}alice@example.com` }] } }] }, kept: (d) => d.candidates[0].content.parts[0].thoughtSignature },
      // OpenAI Responses: a reasoning item's encrypted content.
      { name: 'responses', body: { output: [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: `gAAAAB${SIGNATURE}` }, { type: 'message', content: [{ type: 'output_text', text: 'mail alice@example.com' }] }] }, kept: (d) => d.output[0].encrypted_content },
    ];
    for (const c of cases) {
      const recorded = Buffer.from(JSON.stringify(c.body));
      const packed = JSON.parse(redactBytes(recorded, [EMAIL, TOKENS], undefined, undefined, true).toString('utf8'));
      expect(c.kept(packed), c.name).toEqual(c.kept(c.body));
      expect(JSON.stringify(packed), c.name).toContain('mail <EMAIL>');
      const read = redactBytes(recorded, [EMAIL, TOKENS], { kind: 'api', name: 'POST /v1/x' }).toString('utf8');
      expect(read, c.name).not.toContain('alice@example.com');
    }
  });
});
