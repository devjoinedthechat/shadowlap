// A weather agent whose one read answers JSON text, which the agent parses itself: get_forecast
// returns a JSON string and the agent hands the model only the temperature in it. It handles what
// most agents learn to handle: a tool that fails (it tells the model), a tool that answers nothing
// (no forecast), a model call that fails (it says it can't answer, and exits 0). It doesn't handle a
// tool that answers JSON it can't parse: that crashes it, the error path a malformed preset finds.
//
//   node forecast-agent.mjs [city]
//
//   AGENT_OUTBOX=…   file the write tool appends to, so a test can see what really executed
//   AGENT_SAFE=1     parse the forecast in a try, so malformed JSON doesn't crash it either
import { appendFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { tool } from '@shadowlap/sdk';

const outbox = (entry) => process.env.AGENT_OUTBOX && appendFileSync(process.env.AGENT_OUTBOX, JSON.stringify(entry) + '\n');

const tools = {
  get_forecast: tool('get_forecast', { effect: 'read' }, async ({ city }) => JSON.stringify({ city, temp: 21, sky: 'clear', hours: ['09:00 18°', '12:00 21°', '15:00 22°'] })),
  get_units: tool('get_units', { effect: 'pure' }, async () => ({ units: 'celsius' })),
  send_alert: tool('send_alert', { effect: 'write', onFork: () => ({ sent: false, suppressed: true }) }, async (args) => {
    outbox({ tool: 'send_alert', ...args });
    return { sent: true };
  }),
};
const object = (properties) => ({ type: 'object', properties });
const definitions = [
  { name: 'get_units', description: 'The units to answer in.', input_schema: object({}) },
  { name: 'get_forecast', description: "A city's forecast.", input_schema: object({ city: { type: 'string' } }) },
  { name: 'send_alert', description: 'Alert the subscribers.', input_schema: object({ text: { type: 'string' } }) },
];

/** What the forecast text says, for the model: the temperature, or that there was none. */
function readForecast(text) {
  if (!text) return 'no forecast for that city';
  if (process.env.AGENT_SAFE) {
    try {
      return `${JSON.parse(text).temp}°`;
    } catch {
      return 'the forecast could not be read';
    }
  }
  return `${JSON.parse(text).temp}°`;
}

const client = new Anthropic({ apiKey: 'k', maxRetries: 0 });
const city = process.argv[2] ?? 'Lisbon';
const messages = [{ role: 'user', content: `What is the weather in ${city}? Alert the subscribers if it is above 20°.` }];
try {
  for (let turn = 0; turn < 8; turn++) {
    const reply = await client.messages.create({ model: 'small-model', max_tokens: 256, system: 'You answer weather questions with the tools.', tools: definitions, messages });
    messages.push({ role: 'assistant', content: reply.content });
    const uses = reply.content.filter((b) => b.type === 'tool_use');
    if (reply.stop_reason !== 'tool_use' || uses.length === 0) {
      console.log(reply.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
      break;
    }
    const results = [];
    for (const use of uses) {
      try {
        const out = await tools[use.name](use.input);
        results.push({ type: 'tool_result', tool_use_id: use.id, content: use.name === 'get_forecast' ? readForecast(out) : JSON.stringify(out) });
      } catch (err) {
        // A tool that failed tells the model so; a forecast that can't be parsed is not caught here.
        if (err instanceof SyntaxError) throw err;
        results.push({ type: 'tool_result', tool_use_id: use.id, content: `${err.name}: ${err.message}`, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
} catch (err) {
  if (!(err instanceof Anthropic.APIError)) throw err;
  console.log(`The weather service is unavailable (${err.status ?? 'no response'}); try again later.`);
}
