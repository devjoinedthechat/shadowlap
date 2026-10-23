// An agent that asks the model for a note and saves it with a write tool. With a file named
// log-time in its working folder it first logs the day, read from the clock and formatted by a pure
// tool, as an agent changed to log timestamps would: two reads its recording never held.
import { existsSync } from 'node:fs';
import { now, tool } from '@shadowlap/sdk';

const saveNote = tool('save_note', { effect: 'write' }, async ({ text }) => ({ saved: text.length }));
const formatDay = tool('format_day', { effect: 'pure' }, async ({ ms }) => new Date(ms).toISOString().slice(0, 10));

if (existsSync('log-time')) console.error(`[${await formatDay({ ms: await now() })}] asking for a note`);
const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model: 'small-model', max_tokens: 64, messages: [{ role: 'user', content: 'Write a one-line note.' }] }),
});
if (!res.ok) {
  console.error(await res.text());
  process.exit(1);
}
const reply = await res.json();
const text = reply.content[0].text;
await saveNote({ text });
console.log(`saved: ${text}`);
