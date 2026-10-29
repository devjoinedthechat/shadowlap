import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { normalizeConversation } from '../src/conversation.js';
import { encodeEventStreamFrame, eventStreamMessages } from '../src/eventstream.js';
import { canonicalModel, priceFor, shortModel } from '../src/prices.js';
import { normalizeResponse } from '../src/responses.js';

/** One AWS event stream message, CRCs included, as Bedrock sends it. */
export function frame(type: string, payload: unknown): Buffer {
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
  const body = Buffer.from(JSON.stringify(payload));
  const prelude = Buffer.alloc(12);
  prelude.writeUInt32BE(16 + headers.length + body.length, 0);
  prelude.writeUInt32BE(headers.length, 4);
  prelude.writeUInt32BE(crc32(prelude.subarray(0, 8)), 8);
  const message = Buffer.concat([prelude, headers, body]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(message), 0);
  return Buffer.concat([message, tail]);
}
const wrap = (event: unknown) => ({ bytes: Buffer.from(JSON.stringify(event)).toString('base64') });
const STREAM = 'application/vnd.amazon.eventstream';

describe('Bedrock event streams', () => {
  it('reads InvokeModelWithResponseStream frames: the model events inside, base64 unwrapped', () => {
    const bytes = Buffer.concat([
      frame('chunk', wrap({ type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 1 } } })),
      frame('chunk', wrap({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })),
      frame('chunk', wrap({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } })),
      frame('chunk', wrap({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } })),
      frame('chunk', wrap({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })),
    ]);
    expect([...eventStreamMessages(bytes)].map((m) => m.type)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'message_delta']);
    const r = normalizeResponse(bytes, STREAM, [[0, 0], [0, 10], [0, 20], [0, 30], [0, 40]]);
    expect(r).toMatchObject({ kind: 'sse', blocks: [{ type: 'text', text: 'Hello' }], stopReason: 'end_turn', events: 5 });
    expect(r.raw).toContain('"event":"content_block_delta"');
  });

  it('reads ConverseStream frames with text and a tool call', () => {
    const bytes = Buffer.concat([
      frame('messageStart', { role: 'assistant' }),
      frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Looking' } }),
      frame('contentBlockStart', { contentBlockIndex: 1, start: { toolUse: { toolUseId: 't1', name: 'search_web' } } }),
      frame('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '{"query":' } } }),
      frame('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '"replay"}' } } }),
      frame('messageStop', { stopReason: 'tool_use' }),
      frame('metadata', { usage: { inputTokens: 12, outputTokens: 5 } }),
    ]);
    expect(normalizeResponse(bytes, STREAM)).toMatchObject({ blocks: [{ type: 'text', text: 'Looking' }, { type: 'tool_call', name: 'search_web', input: { query: 'replay' } }], stopReason: 'tool_use' });
  });

  it('reads past headers of every fixed-size type, a 16-byte UUID among them, to the event type', () => {
    /** A header with a value of `type` and the given bytes; a string's and a byte array's get their length. */
    const header = (name: string, type: number, value: Buffer) => {
      const n = Buffer.from(name);
      const sized = type === 6 || type === 7 ? Buffer.concat([Buffer.from([value.length >> 8, value.length & 0xff]), value]) : value;
      return Buffer.concat([Buffer.from([n.length]), n, Buffer.from([type]), sized]);
    };
    const headers = Buffer.concat([
      header(':message-id', 9, Buffer.alloc(16, 0xab)),
      header(':date', 8, Buffer.alloc(8, 1)),
      header('flag', 0, Buffer.alloc(0)),
      header('count', 4, Buffer.alloc(4, 2)),
      header('blob', 6, Buffer.from([1, 2, 3])),
      header(':event-type', 7, Buffer.from('messageStop')),
    ]);
    const bytes = Buffer.concat([encodeEventStreamFrame(headers, Buffer.from(JSON.stringify({ stopReason: 'end_turn' }))), frame('metadata', { usage: { inputTokens: 3, outputTokens: 1 } })]);
    expect([...eventStreamMessages(bytes)]).toEqual([
      { type: 'messageStop', payload: { stopReason: 'end_turn' } },
      { type: 'metadata', payload: { usage: { inputTokens: 3, outputTokens: 1 } } },
    ]);
  });

  it('stops reading headers at a value type it cannot size, keeping the payload', () => {
    const name = Buffer.from('odd');
    const headers = Buffer.concat([Buffer.from([name.length]), name, Buffer.from([42]), Buffer.alloc(5, 7)]);
    expect([...eventStreamMessages(encodeEventStreamFrame(headers, Buffer.from(JSON.stringify({ ok: true }))))]).toEqual([{ type: null, payload: { ok: true } }]);
  });

  it('stops at a truncated frame instead of reading past it', () => {
    const whole = frame('messageStart', { role: 'assistant' });
    expect([...eventStreamMessages(Buffer.concat([whole, whole.subarray(0, 20)]))]).toHaveLength(1);
  });
});

describe('Bedrock Converse messages', () => {
  it('normalizes a Converse request: system, text, tool use and tool results, and the tools offered', () => {
    const conv = normalizeConversation({
      system: [{ text: 'Be brief.' }],
      messages: [
        { role: 'user', content: [{ text: 'Find sources' }] },
        { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'search_web', input: { query: 'replay' } } }] },
        { role: 'user', content: [{ toolResult: { toolUseId: 't1', content: [{ json: { hits: 2 } }], status: 'error' } }] },
      ],
      toolConfig: { tools: [{ toolSpec: { name: 'search_web', inputSchema: { json: {} } } }] },
    }, 'anthropic.claude-sonnet-4-5-20250929-v1:0')!;
    expect(conv.model).toBe('anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(conv.tools).toEqual(['search_web']);
    expect(conv.turns.map((t) => [t.role, t.blocks.map((b) => b.type)])).toEqual([
      ['system', ['text']],
      ['user', ['text']],
      ['assistant', ['tool_call']],
      ['tool', ['tool_result']],
    ]);
    expect(conv.turns[3].blocks[0]).toMatchObject({ isError: true, id: 't1' });
  });

  it('normalizes a Converse response', () => {
    const body = Buffer.from(JSON.stringify({ output: { message: { role: 'assistant', content: [{ text: 'Done' }, { toolUse: { toolUseId: 't2', name: 'send_email', input: { to: 'a@b.c' } } }] } }, stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } }));
    expect(normalizeResponse(body, 'application/json')).toMatchObject({ kind: 'json', blocks: [{ type: 'text', text: 'Done' }, { type: 'tool_call', name: 'send_email', id: 't2' }], stopReason: 'tool_use' });
  });
});

describe('model ids across platforms', () => {
  it('prices and shortens Bedrock and Vertex ids like the provider API ids', () => {
    expect(canonicalModel('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('claude-sonnet-4-5-20250929');
    // Vercel's AI Gateway names a model by its provider, and Claude's version with a dot: `claude-sonnet-4.5`.
    expect(canonicalModel('anthropic/claude-sonnet-4.5')).toBe('claude-sonnet-4-5');
    expect(canonicalModel('openai/gpt-4.1')).toBe('gpt-4.1');
    expect(priceFor('anthropic/claude-sonnet-4.5')).toEqual(priceFor('claude-sonnet-4-5'));
    expect(priceFor('google/gemini-2.5-flash')).toEqual(priceFor('gemini-2.5-flash'));
    expect(canonicalModel('anthropic.claude-opus-5-v1')).toBe('claude-opus-5');
    expect(canonicalModel('claude-sonnet-4-5@20250929')).toBe('claude-sonnet-4-5-20250929');
    expect(canonicalModel('gpt-4o')).toBe('gpt-4o');
    expect(priceFor('global.anthropic.claude-haiku-4-5-20251001-v1:0')).toEqual(priceFor('claude-haiku-4-5'));
    expect(priceFor('claude-opus-5@20260401')).toEqual(priceFor('claude-opus-5'));
    expect(shortModel('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('sonnet-4-5');
  });
});

describe('server-sent events', () => {
  it('parse with LF, CRLF (Google) and CR line endings, with offsets into the recorded bytes', async () => {
    const { parseSse } = await import('../src/sse.js');
    const { normalizeResponse } = await import('../src/responses.js');
    for (const nl of ['\n', '\r\n', '\r']) {
      const bytes = Buffer.from(`event: a${nl}data: {"x":1}${nl}${nl}data: {"x":2}${nl}${nl}`);
      const events = parseSse(bytes);
      expect(events.map((e) => [e.event, e.data])).toEqual([['a', { x: 1 }], ['message', { x: 2 }]]);
      expect(events[1].endOffset).toBe(bytes.length);
    }
    // A Gemini stream as the API sends it.
    const gemini = Buffer.from(['{"candidates":[{"content":{"parts":[{"text":"rea"}],"role":"model"}}]}', '{"candidates":[{"content":{"parts":[{"text":"dy"}],"role":"model"},"finishReason":"STOP"}]}'].map((d) => `data: ${d}\r\n\r\n`).join(''));
    const r = normalizeResponse(gemini, 'text/event-stream', [], 'gemini');
    expect(r.blocks).toEqual([{ type: 'text', text: 'ready' }]);
  });
});
