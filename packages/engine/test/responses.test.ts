import { describe, expect, it } from 'vitest';
import { normalizeResponse } from '../src/responses.js';

/** A stream as a provider sends it: one `data:` line per event. */
const sse = (events: unknown[], named = false) =>
  Buffer.from(events.map((e) => `${named && typeof (e as { type?: unknown }).type === 'string' ? `event: ${(e as { type: string }).type}\n` : ''}data: ${JSON.stringify(e)}\n\n`).join(''), 'utf8');
const SSE = 'text/event-stream';

const anthropicStream = sse(
  [
    { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: 9, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'echo: refund ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'order A-1042' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ],
  true,
);
const geminiStream = sse([
  { candidates: [{ content: { role: 'model', parts: [{ text: 'echo: refund ' }] } }] },
  { candidates: [{ content: { role: 'model', parts: [{ text: 'order A-1042' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 5 } },
]);
const openaiStream = sse([
  { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'echo: refund ' } }] },
  { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'order A-1042' }, finish_reason: 'stop' }] },
]);

describe('streamed responses, read from their events whatever the provider id', () => {
  it('reads Claude and Gemini streams captured under vertex, and OpenAI chunks under gemini', () => {
    const cases: Array<[string, Buffer, string]> = [
      ['vertex', anthropicStream, 'end_turn'],
      ['vertex', geminiStream, 'STOP'],
      ['gemini', openaiStream, 'stop'],
      ['anthropic', anthropicStream, 'end_turn'],
      ['openai', openaiStream, 'stop'],
      ['azure', openaiStream, 'stop'],
    ];
    for (const [provider, bytes, stop] of cases) {
      const r = normalizeResponse(bytes, SSE, [], provider);
      expect(r.blocks, `${provider} ${stop}`).toEqual([{ type: 'text', text: 'echo: refund order A-1042' }]);
      expect(r.stopReason).toBe(stop);
    }
  });
});
