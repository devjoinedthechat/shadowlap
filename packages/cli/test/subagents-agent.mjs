// Two sub-agents that run at once and start with the same request, then continue from their answers.
// ORDER=reverse swaps which one asks first; USE_SCOPE=1 runs each inside scope().
import Anthropic from '@anthropic-ai/sdk';
import { scope } from '@shadowlap/sdk';

const client = new Anthropic({ apiKey: 'k', maxRetries: 0 });
const model = 'claude-opus-5';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function worker(name, wait) {
  await delay(wait);
  const plan = await client.messages.create({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Make a plan.' }] });
  const text = plan.content[0].text;
  const done = await client.messages.create({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Make a plan.' }, { role: 'assistant', content: text }, { role: 'user', content: `Carry it out as ${name}.` }] });
  return `${name}: ${text} / ${done.content[0].text}`;
}

const run = (name, wait) => (process.env.USE_SCOPE === '1' ? scope(name, () => worker(name, wait)) : worker(name, wait));
const [a, b] = process.env.ORDER === 'reverse' ? [80, 0] : [0, 80];
console.log(JSON.stringify(await Promise.all([run('alpha', a), run('beta', b)])));
