// An agent that reads the clock, looks a customer's card up, and acts on what the tool returned: the
// card and the time it was put on file come back as JSON numbers, the agent works the year out from
// that time, and sends the result back to the model as text. A pack that masked those numbers would
// hand the agent "<CARD>" on replay, and the replay would part from the recording.
import Anthropic from '@anthropic-ai/sdk';
import { now, tool } from '@shadowlap/sdk';

const lookup = tool('lookup_card', { effect: 'read' }, async ({ customer }) => ({ customer, card: 4111111111111111, created_at: 1500000000000 }));
const opened = await now('ticket opened');
const client = new Anthropic({ apiKey: 'k', maxRetries: 0 });
const tools = [{ name: 'lookup_card', description: 'Look a card up.', input_schema: { type: 'object', properties: { customer: { type: 'string' } } } }];
const messages = [{ role: 'user', content: `Which card does C-311 have on file? (asked at ${new Date(opened).toISOString()})` }];
for (let turn = 0; turn < 4; turn++) {
  const res = await client.messages.create({ model: 'claude-opus-5', max_tokens: 100, messages, tools });
  messages.push({ role: 'assistant', content: res.content });
  const use = res.content.find((b) => b.type === 'tool_use');
  if (!use) {
    console.log(res.content.map((b) => b.text ?? '').join(''));
    break;
  }
  const result = await lookup(use.input);
  const year = new Date(result.created_at).getUTCFullYear();
  messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(result) }, { type: 'text', text: `On file since ${year}.` }] });
}
