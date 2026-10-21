// An agent whose model clients take their keys from the environment, as most do: `new OpenAI()`
// throws as it is built when there is none, and `new Anthropic()` on its first call.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

const anthropic = new Anthropic({ maxRetries: 0 });
const openai = new OpenAI({ maxRetries: 0 });
const a = await anthropic.messages.create({ model: 'claude-opus-5', max_tokens: 32, messages: [{ role: 'user', content: 'Where is order A-1042?' }] });
const o = await openai.chat.completions.create({ model: 'gpt-5', messages: [{ role: 'user', content: 'Where is order A-1042?' }] });
console.log(JSON.stringify({ anthropic: a.content[0].text, openai: o.choices[0].message.content }));
