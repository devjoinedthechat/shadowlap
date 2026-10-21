// A recorded test whose client is built the default way inside it, its key from the environment, as
// a CI job without secrets has none; then a test that sees the variable as it was. Run by
// vitest-plugin.test.mjs with its own config, so the other runs' counts stay as they are.
import Anthropic from '@anthropic-ai/sdk';
import { recorded } from '@shadowlap/test';
import { expect, test } from 'vitest';

test(
  'a client built the default way',
  recorded(async () => {
    const reply = await new Anthropic({ maxRetries: 0 }).messages.create({ model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: 'keys' }] });
    expect(reply.content[0].text).toBe('echo: keys');
  }),
);

test('the variable as it was, after the recorded test', () => {
  expect(process.env.ANTHROPIC_API_KEY ?? '').toBe(process.env.KEY_BEFORE);
});
