// An ES module test file, as Jest runs one with --experimental-vm-modules. Run by jest.test.mjs.
import Anthropic from '@anthropic-ai/sdk';
import { tool } from '@shadowlap/sdk';
import { currentRecording, recorded } from '@shadowlap/test';
import { expect, test } from '@jest/globals';

// Made when the module loads, before any test: recorded through in-process capture all the same.
const client = new Anthropic({ apiKey: 'test-key', maxRetries: 0 });
const lookup = tool('lookup', { effect: 'read' }, async ({ topic }) => `notes about ${topic}`);

test(
  'answers as an ES module',
  recorded(async () => {
    const notes = await lookup({ topic: 'esm' });
    const reply = await client.messages.create({ model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: notes }] });
    expect(reply.content[0].text).toBe('echo: notes about esm');
    expect(await currentRecording().called('lookup')).toBe(1);
  }),
);
