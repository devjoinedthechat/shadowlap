// node:test with `node --import @shadowlap/test/register`, the client built the default way inside
// the recorded test: its key from the environment. Run by vitest-plugin.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { withRecording } from '@shadowlap/test';

test('a client built the default way, with node:test', () =>
  withRecording({ recording: '__recordings__/node-keys/answers' }, async () => {
    const reply = await new Anthropic({ maxRetries: 0 }).messages.create({ model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: 'keys' }] });
    assert.equal(reply.content[0].text, 'echo: keys');
  }));
