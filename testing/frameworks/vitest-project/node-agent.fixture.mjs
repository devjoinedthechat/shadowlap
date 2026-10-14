// node:test with `node --import @shadowlap/test/register`. Run by vitest-plugin.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { withRecording } from '@shadowlap/test';

const client = new Anthropic({ apiKey: 'test-key', maxRetries: 0 });

test('answers with node:test', () =>
  withRecording({ recording: '__recordings__/node-agent/answers' }, async () => {
    const reply = await client.messages.create({ model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: process.env.PROMPT ?? 'hello' }] });
    assert.match(reply.content[0].text, /^echo: /);
  }));
