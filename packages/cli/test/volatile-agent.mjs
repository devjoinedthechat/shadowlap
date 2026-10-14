// An agent whose requests change on every run for reasons nobody chose: a fresh UUID in the request
// metadata and a scratch directory with a random name, in the prompt and in a tool's arguments.
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { tool } from '@shadowlap/sdk';

const scratch = mkdtempSync(join(tmpdir(), 'agent-'));
const saveReport = tool('save_report', { effect: 'write' }, async ({ path }) => ({ saved: path }));
const client = new Anthropic({ apiKey: 'k', maxRetries: 0 });
const reply = await client.messages.create({
  model: 'claude-opus-5',
  max_tokens: 32,
  system: `Scratch directory: ${scratch}/ (write reports there)`,
  metadata: { user_id: randomUUID() },
  messages: [{ role: 'user', content: 'triage' }],
});
await saveReport({ path: join(scratch, 'report.md') });
console.log(reply.content[0].text);
