// A Jest suite for an agent, as a user writes it: CommonJS, Jest's own default. Run by jest.test.mjs.
const { appendFileSync } = require('node:fs');
const Anthropic = require('@anthropic-ai/sdk');
const { tool, scope } = require('@shadowlap/sdk');
const { currentRecording, recorded } = require('@shadowlap/test');

// Made when the module loads, before any test, pointing at the provider: a recorded test records it all the same.
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
    expect(await scope('triage', () => ask('item 1'))).toBe('echo: item 1 / notes about item 1');
    const rec = currentRecording();
    expect(await rec.called('lookup', { topic: 'item 1' })).toBe(1);
    expect(await rec.answer()).toBe('echo: item 1 / notes about item 1');
    const [lookupCall, modelCall] = await rec.calls();
    expect(lookupCall).toMatchObject({ kind: 'tool', name: 'lookup', scope: 'triage', origin: rec.mode === 'record' ? 'live' : 'replayed' });
    // The client made at import reached Shadowlap through in-process capture, in the test's scope.
    expect(modelCall).toMatchObject({ kind: 'api', name: 'POST /v1/messages', model: 'claude-opus-5', scope: 'triage', outcome: 'ok' });
  }),
);

test('a test without a recording calls its model and tools directly', async () => {
  const direct = new Anthropic({ apiKey: 'test-key', maxRetries: 0, baseURL: process.env.DIRECT_MODEL });
  if (!process.env.DIRECT_MODEL) return;
  const reply = await direct.messages.create({ model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: 'unrecorded' }] });
  expect(reply.content[0].text).toBe('echo: unrecorded');
  expect(await lookup({ topic: 'direct' })).toBe('notes about direct');
});
