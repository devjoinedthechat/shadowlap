// A Vitest suite for an agent, as a user would write it. Run by vitest-plugin.test.mjs.
import { appendFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { tool } from '@shadowlap/sdk';
import { currentRecording, recorded } from '@shadowlap/test';
import { describe, expect, test } from 'vitest';

const client = new Anthropic({ apiKey: 'test-key', maxRetries: 0 });
const lookup = tool('lookup', { effect: 'read' }, async ({ topic }) => {
  if (process.env.TOOL_LOG) appendFileSync(process.env.TOOL_LOG, `${topic}\n`);
  return `notes about ${topic}`;
});

async function ask(prompt) {
  const notes = await lookup({ topic: prompt });
  const reply = await client.messages.create({ model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: `${prompt} / ${notes}` }] });
  return reply.content[0].text;
}

describe('the triage agent', () => {
  test(
    'triages the inbox',
    recorded(async () => {
      expect(await ask(process.env.PROMPT ?? 'hello')).toMatch(/^echo: /);
    }),
  );
});

test(
  'answers one item',
  recorded(async () => {
    expect(await ask('item 1')).toBe('echo: item 1 / notes about item 1');
    // What the agent did, the same whether the test records or replays.
    const rec = currentRecording();
    expect(await rec.called('lookup')).toBe(1);
    expect(await rec.called('lookup', { topic: 'item 1' })).toBe(1);
    expect(await rec.called('lookup', { topic: 'item 2' })).toBe(0);
    expect(await rec.answer()).toBe('echo: item 1 / notes about item 1');
    const [lookupCall, modelCall] = await rec.calls();
    expect(lookupCall).toMatchObject({ kind: 'tool', name: 'lookup', args: { topic: 'item 1' }, result: 'notes about item 1', outcome: 'ok', origin: rec.mode === 'record' ? 'live' : 'replayed' });
    expect(modelCall).toMatchObject({ kind: 'api', name: 'POST /v1/messages', model: 'claude-opus-5', outcome: 'ok' });
  }),
);
