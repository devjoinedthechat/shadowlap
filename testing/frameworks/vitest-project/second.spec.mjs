// A second file, so Vitest runs two workers at once.
import Anthropic from '@anthropic-ai/sdk';
import { recorded } from '@shadowlap/test';
import { expect, test } from 'vitest';

const client = new Anthropic({ apiKey: 'test-key', maxRetries: 0 });

for (const n of [2, 3, 4]) {
  test(
    `answers item ${n}`,
    recorded(async () => {
      await new Promise((r) => setTimeout(r, 30));
      const reply = await client.messages.create({ model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: `item ${n}` }] });
      expect(reply.content[0].text).toBe(`echo: item ${n}`);
    }),
  );
}
