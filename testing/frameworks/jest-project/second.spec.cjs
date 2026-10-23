// A second file, so Jest runs two workers at once.
const Anthropic = require('@anthropic-ai/sdk');
const { recorded } = require('@shadowlap/test');

for (const n of [2, 3, 4]) {
  test(
    `answers item ${n}`,
    recorded(async () => {
      await new Promise((r) => setTimeout(r, 30));
      const client = new Anthropic({ apiKey: 'test-key', maxRetries: 0 });
      const reply = await client.messages.create({ model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: `item ${n}` }] });
      expect(reply.content[0].text).toBe(`echo: item ${n}`);
    }),
  );
}
