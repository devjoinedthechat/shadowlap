// Tests with and without recorded() in one file, as a suite grows into using shadowlap. Run by
// vitest-plugin.test.mjs with its own config, so the other runs' counts stay as they are.
import Anthropic from '@anthropic-ai/sdk';
import { isActive, tool } from '@shadowlap/sdk';
import { recorded } from '@shadowlap/test';
import { expect, test } from 'vitest';

// Created when the module loads, before any test: its base URL is the one the suite had.
const atImport = new Anthropic({ apiKey: 'test-key', maxRetries: 0 });
const lookup = tool('lookup', { effect: 'read' }, async ({ topic }) => `notes about ${topic}`);
const ask = async (client, prompt) => (await client.messages.create({ model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: prompt }] })).content[0].text;

async function unwrapped(name) {
  expect(await ask(atImport, name)).toBe(`echo: ${name}`);
  expect(await ask(new Anthropic({ apiKey: 'test-key', maxRetries: 0 }), `${name} again`)).toBe(`echo: ${name} again`);
  expect(await lookup({ topic: name })).toBe(`notes about ${name}`);
  expect(isActive()).toBe(false);
}

test('a test without a recording, before any recorded one', () => unwrapped('first'));

test(
  'a recorded test',
  recorded(async () => {
    expect(isActive()).toBe(true);
    expect(await lookup({ topic: 'recorded' })).toBe('notes about recorded');
    expect(await ask(atImport, 'recorded')).toBe('echo: recorded');
    expect(await ask(new Anthropic({ apiKey: 'test-key', maxRetries: 0 }), 'recorded again')).toBe('echo: recorded again');
  }),
);

test('a test without a recording, after a recorded one', () => unwrapped('last'));
