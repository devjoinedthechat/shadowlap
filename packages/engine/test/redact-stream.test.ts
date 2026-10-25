import { describe, expect, it } from 'vitest';
import { encodeEventStreamFrame, eventStreamFrames, eventStreamMessages } from '../src/eventstream.js';
import { storeApiRequest } from '../src/manifest.js';
import { maskAcross } from '../src/redact-stream.js';
import { redactBytes, redactRun } from '../src/redact.js';
import { normalizeResponse } from '../src/responses.js';
import { Store } from '../src/store.js';
import type { Normalizer } from '../src/types.js';

/**
 * A model streams its text in pieces, so a secret it writes back is split across events: each run of
 * pieces is masked as the text it adds up to, and every reader of the stream sees the masked text.
 */

const EMAIL: Normalizer = { pattern: 'email', replace: '<EMAIL>' };
const KEY: Normalizer = { pattern: '/sk-live-[a-z0-9]+/', replace: '<KEY>' };
const RULES = [EMAIL, KEY];
/** Every piece of the address or the key, as the model streamed them. */
const LEAKS = /maya|ya@ex|example\.com|sk-li|ve-9f8e|9f8e7d/;

const sse = (events: Array<[string | null, unknown]>, eol = '\n') =>
  events.map(([name, data]) => `${name ? `event: ${name}${eol}` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}${eol}${eol}`).join('');

const text = (bytes: Buffer, contentType: string, provider?: string) =>
  normalizeResponse(bytes, contentType, [], provider)
    .blocks.map((b) => (b.type === 'tool_call' ? JSON.stringify(b.input) : b.text))
    .join('|');

describe('maskAcross', () => {
  it('masks the text the pieces add up to, and puts the replacement where the match starts', () => {
    expect(maskAcross(['Write to ma', 'ya@exam', 'ple.com', ' today'], RULES)).toEqual(['Write to <EMAIL>', '', '', ' today']);
    // Pieces a match does not reach keep their text, before and after it.
    expect(maskAcross(['Hi ', 'maya@example.co', 'm, key ', 'sk-live-9f', '8e7d.', ' Bye'], RULES)).toEqual(['Hi ', '<EMAIL>', ', key ', '<KEY>', '.', ' Bye']);
    expect(maskAcross(['nothing ', 'to mask'], RULES)).toBeNull();
  });

  it('keeps a character outside the Basic Multilingual Plane in one piece', () => {
    const smile: Normalizer = { pattern: '/😀/', replace: '😁' };
    expect(maskAcross(['x😀', 'y'], [smile])).toEqual(['x😁', 'y']);
  });
});

describe('redactBytes on a streamed response', () => {
  it('Anthropic: a secret split across text deltas and tool input deltas', () => {
    const body = Buffer.from(
      sse([
        ['message_start', { type: 'message_start', message: { id: 'msg_1', content: [], usage: { input_tokens: 9, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sent to ma' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ya@exam' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ple.com. Done.' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'rotate', input: {} } }],
        ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"key": "sk-li' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 've-9f8e7d"}' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 1 }],
        ['message_stop', { type: 'message_stop' }],
      ]),
    );
    const out = redactBytes(body, RULES);
    expect(out.toString()).not.toMatch(LEAKS);
    expect(text(out, 'text/event-stream')).toBe('Sent to <EMAIL>. Done.|{"key":"<KEY>"}');
    // Events nothing matched stay byte for byte.
    expect(out.toString()).toContain('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","content":[],"usage":{"input_tokens":9,"output_tokens":1}}}\n\n');
    expect(out.toString().split('\n\n')).toHaveLength(body.toString().split('\n\n').length);
  });

  it('OpenAI Chat Completions: content and tool call arguments split across chunks', () => {
    const chunk = (delta: unknown) => ({ object: 'chat.completion.chunk', choices: [{ index: 0, delta }] });
    const body = Buffer.from(
      sse([
        [null, chunk({ role: 'assistant', content: '' })],
        [null, chunk({ content: 'Mail ma' })],
        [null, chunk({ content: 'ya@example' })],
        [null, chunk({ content: '.com now' })],
        [null, chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'rotate', arguments: '{"key":"sk-' } }] })],
        [null, chunk({ tool_calls: [{ index: 0, function: { arguments: 'live-9f8e7d"}' } }] })],
        [null, '[DONE]'],
      ]),
    );
    const out = redactBytes(body, RULES);
    expect(out.toString()).not.toMatch(LEAKS);
    expect(text(out, 'text/event-stream', 'openai')).toBe('Mail <EMAIL> now|{"key":"<KEY>"}');
    expect(out.toString()).toMatch(/data: \[DONE\]\n\n$/);
  });

  it('OpenAI-compatible text completions: choice text split across chunks, two choices apart', () => {
    const chunk = (index: number, text: string) => ({ object: 'text_completion', choices: [{ index, text, logprobs: null, finish_reason: null }] });
    const body = Buffer.from(
      sse([
        [null, chunk(0, 'Sent to ma')],
        [null, chunk(1, 'Key sk-li')],
        [null, chunk(0, 'ya@exam')],
        [null, chunk(1, 've-9f8e7d.')],
        [null, chunk(0, 'ple.com today.')],
        [null, '[DONE]'],
      ]),
    );
    const out = redactBytes(body, RULES);
    expect(out.toString()).not.toMatch(LEAKS);
    const events = out
      .toString()
      .split('\n\n')
      .filter((e) => e.startsWith('data: {'))
      .map((e) => JSON.parse(e.slice(6)) as { choices: Array<{ index: number; text: string; logprobs: null }> });
    const choice = (n: number) => events.flatMap((e) => e.choices.filter((c) => c.index === n).map((c) => c.text)).join('');
    expect(choice(0)).toBe('Sent to <EMAIL> today.');
    expect(choice(1)).toBe('Key <KEY>.');
    expect(events.every((e) => e.choices[0].logprobs === null)).toBe(true);
    expect(out.toString()).toMatch(/data: \[DONE\]\n\n$/);
  });

  it('OpenAI Responses: output text deltas, and the whole text the done events repeat', () => {
    const body = Buffer.from(
      sse([
        ['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Reply to ma' }],
        ['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'ya@example.com' }],
        ['response.output_text.done', { type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, content_index: 0, text: 'Reply to maya@example.com' }],
        ['response.completed', { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Reply to maya@example.com' }] }] } }],
      ]),
    );
    const out = redactBytes(body, RULES);
    expect(out.toString()).not.toMatch(LEAKS);
    expect(text(out, 'text/event-stream', 'openai')).toBe('Reply to <EMAIL>');
  });

  it('Gemini: candidate text split across chunks, with Google\'s CRLF line endings kept', () => {
    const chunk = (t: string) => ({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: t }] } }] });
    const body = Buffer.from(sse([[null, chunk('Write to maya@')], [null, chunk('example.com today')], [null, { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }] }]], '\r\n'));
    const out = redactBytes(body, RULES);
    expect(out.toString()).not.toMatch(LEAKS);
    expect(text(out, 'text/event-stream', 'gemini')).toBe('Write to <EMAIL> today');
    expect(out.toString().replace(/\r\n/g, '')).not.toContain('\n');
    // Without alt=sse, the chunks come as one JSON array.
    const array = Buffer.from(JSON.stringify([chunk('Write to maya@'), chunk('example.com today')], null, 2));
    const masked = redactBytes(array, RULES).toString();
    expect(masked).not.toMatch(LEAKS);
    expect((JSON.parse(masked) as Array<{ candidates: Array<{ content: { parts: Array<{ text: string }> } }> }>).map((c) => c.candidates[0].content.parts[0].text).join('')).toBe('Write to <EMAIL> today');
  });

  it('Bedrock: text split across ConverseStream frames and InvokeModelWithResponseStream chunks, frames rebuilt', () => {
    const frame = (type: string, payload: unknown) => {
      const name = Buffer.from(':event-type');
      const value = Buffer.from(type);
      const header = Buffer.alloc(4 + name.length + value.length);
      header.writeUInt8(name.length, 0);
      name.copy(header, 1);
      header.writeUInt8(7, 1 + name.length);
      header.writeUInt16BE(value.length, 2 + name.length);
      value.copy(header, 4 + name.length);
      return encodeEventStreamFrame(header, Buffer.from(JSON.stringify(payload)));
    };
    const converse = Buffer.concat([
      frame('messageStart', { role: 'assistant', p: 'abc' }),
      frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Sent to ma' }, p: 'abcd' }),
      frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'ya@example.com.' }, p: 'ab' }),
      frame('messageStop', { stopReason: 'end_turn' }),
    ]);
    const chunk = (event: unknown) => frame('chunk', { bytes: Buffer.from(JSON.stringify(event)).toString('base64') });
    const invoke = Buffer.concat([
      chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Key sk-li' } }),
      chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 've-9f8e7d rotated.' } }),
    ]);
    for (const [body, expected] of [
      [converse, 'Sent to <EMAIL>.'],
      [invoke, 'Key <KEY> rotated.'],
    ] as const) {
      const out = redactBytes(body, RULES);
      expect(eventStreamFrames(out)).toHaveLength(eventStreamFrames(body)!.length);
      expect(JSON.stringify([...eventStreamMessages(out)])).not.toMatch(LEAKS);
      expect(text(out, 'application/vnd.amazon.eventstream')).toBe(expected);
      // The first frame held nothing to mask: it is the same bytes.
      expect(eventStreamFrames(out)![0].raw.equals(eventStreamFrames(body)![0].raw)).toBe(true);
    }
  });

  it('keeps a number an event holds as recorded, so every event stays JSON', () => {
    const CARD: Normalizer = { pattern: '/\\b(?:\\d[ -]?){13,16}\\b/', replace: '<CARD>' };
    // A count in an event that a card pattern matches: masked as text, the event would read "input_tokens":<CARD>.
    const body = Buffer.from(
      sse([
        ['message_start', { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 1792155242516, output_tokens: 1 } } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Card 4111 1111 1111 1111 on file.' } }],
      ]),
    );
    const out = redactBytes(body, [CARD]).toString();
    expect(out).toContain('data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1792155242516,"output_tokens":1}}}\n\n');
    expect(out).toContain('"text":"Card <CARD>on file."');
    for (const line of out.split('\n')) if (line.startsWith('data: ')) expect(() => JSON.parse(line.slice(6))).not.toThrow();
    // An event's data over two lines, with and without the space after the colon: each line keeps its own.
    const split = Buffer.from('event: x\r\ndata: {"note": "for bob@example.com",\r\ndata:"at": 1792155242516}\r\n\r\n');
    expect(redactBytes(split, [EMAIL, CARD]).toString()).toBe('event: x\r\ndata: {"note": "for <EMAIL>",\r\ndata:"at": 1792155242516}\r\n\r\n');
    // Bedrock's ConverseStream metadata keeps its latency as a number.
    const header = Buffer.concat([Buffer.from([11]), Buffer.from(':event-type'), Buffer.from([7, 0, 8]), Buffer.from('metadata')]);
    const frames = Buffer.concat([encodeEventStreamFrame(header, Buffer.from(JSON.stringify({ metadata: { usage: { inputTokens: 12 }, metrics: { latencyMs: 1792155242516 } }, note: 'paid 4111 1111 1111 1111' })))]);
    const masked = eventStreamFrames(redactBytes(frames, [CARD]))!;
    expect(JSON.parse(masked[0].payload.toString())).toEqual({ metadata: { usage: { inputTokens: 12 }, metrics: { latencyMs: 1792155242516 } }, note: 'paid <CARD>' });
  });

  it('leaves what only looks like a stream to the rules as text', () => {
    // A line that is no SSE field: the body is text, masked as text.
    const body = Buffer.from('data: {"text":"maya@"}\nnot a field\n\ndata: {"text":"example.com"}\n\n');
    expect(redactBytes(body, RULES).toString()).toBe(body.toString());
    expect(redactBytes(Buffer.from('to maya@example.com'), RULES).toString()).toBe('to <EMAIL>');
  });
});

describe('redactRun: a streamed response in a copy', () => {
  it('holds no piece of a secret the model streamed back', () => {
    const src = Store.open(':memory:');
    const run = src.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/tmp' } });
    const api = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'a'.repeat(64), occurrence: 1 };
    const body = sse([
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sent to ma' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ya@example.com' } }],
    ]);
    src.appendCallStart({ runId: run.runId, callNo: 1, ...api, origin: 'live', effect: null, requestRef: storeApiRequest(src, { model: 'm', messages: [] }), meta: { provider: 'anthropic' }, at: 1 });
    src.appendCallEnd(api, { runId: run.runId, callNo: 1, attempt: 0, responseRef: src.putBlob(Buffer.from(body)), outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'text/event-stream' } }, at: 2 });
    src.endRun(run.runId, 'completed');
    const dst = Store.open(':memory:');
    redactRun(src, run.runId, RULES, dst);
    const copied = dst.getBlob(dst.getCalls(run.runId)[0].end!.responseRef!)!;
    expect(copied.toString()).not.toMatch(LEAKS);
    expect(text(copied, 'text/event-stream')).toBe('Sent to <EMAIL>');
    src.close();
    dst.close();
  });
});
