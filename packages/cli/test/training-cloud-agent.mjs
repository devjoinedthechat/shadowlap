// The support agent of the training tests on a cloud's own API, for recordings that another
// provider's model takes over: it looks the order up, reads the refund policy, then refunds or
// escalates. Azure OpenAI and Gemini (on the Gemini API and on Vertex AI) go through their own SDKs;
// Claude on Vertex AI and on Bedrock, and Bedrock's Converse API, are called with fetch, as their
// SDKs send them. Every call goes to the cloud's real host and is captured in the process.
//
//   node training-cloud-agent.mjs <api> [--stream]
//
//   api               azure | gemini | vertex-gemini | vertex-claude | bedrock-claude | bedrock-converse
//   --stream          read every answer as the API streams it
//   AGENT_OUTBOX=…    file the write tools append to
import { appendFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';
import { AzureOpenAI } from 'openai';
import { eventStreamFrames, eventStreamMessages } from '@shadowlap/engine';
import { tool } from '@shadowlap/sdk';

const API = process.argv[2];
const STREAM = process.argv.includes('--stream');
const outbox = (entry) => process.env.AGENT_OUTBOX && appendFileSync(process.env.AGENT_OUTBOX, JSON.stringify(entry) + '\n');

const impls = {
  lookup_order: tool('lookup_order', { effect: 'read' }, async ({ order_id }) => ({ order_id, amount: 240, status: 'delivered' })),
  read_policy: tool('read_policy', { effect: 'pure' }, async () => ({ text: 'Refunds above $100 need a manager: escalate them.' })),
  issue_refund: tool('issue_refund', { effect: 'write', onFork: () => ({ refunded: false, suppressed: true }) }, async (args) => {
    outbox({ tool: 'issue_refund', ...args });
    return { refunded: true, ...args };
  }),
  escalate: tool('escalate', { effect: 'write', onFork: () => ({ ticket: null, suppressed: true }) }, async (args) => {
    outbox({ tool: 'escalate', ...args });
    return { ticket: 'T-1', ...args };
  }),
};
const TOOLS = [
  { name: 'lookup_order', description: 'Look an order up.', schema: { type: 'object', properties: { order_id: { type: 'string' } } } },
  { name: 'read_policy', description: 'Read the refund policy.', schema: { type: 'object', properties: {} } },
  { name: 'issue_refund', description: 'Refund an order.', schema: { type: 'object', properties: { order_id: { type: 'string' }, amount: { type: 'number' } } } },
  { name: 'escalate', description: 'Hand the case to a manager.', schema: { type: 'object', properties: { reason: { type: 'string' } } } },
];
const SYSTEM = 'You are a support agent. Follow the refund policy.';
const QUESTION = 'The customer asks for a refund on order A-1042.';

/** The conversation in no API's shape: { role: 'user', text } | { role: 'assistant', text, calls: [{ id, name, input }] } | { role: 'tool', results: [{ id, name, output }] }. */
const turns = [{ role: 'user', text: QUESTION }];

async function json(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${await res.text()}`);
  return res;
}

/** Anthropic's server-sent events, or Bedrock's base64 chunks of them, into a message. */
function assembleAnthropic(events) {
  const content = [];
  let stop = null;
  for (const e of events) {
    if (e.type === 'content_block_start') content[e.index] = { ...e.content_block, ...(e.content_block.type === 'tool_use' ? { json: '' } : {}) };
    else if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') content[e.index].text += e.delta.text;
    else if (e.type === 'content_block_delta' && e.delta.type === 'input_json_delta') content[e.index].json += e.delta.partial_json;
    else if (e.type === 'message_delta') stop = e.delta.stop_reason;
  }
  return { content: content.map((b) => (b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.json ? JSON.parse(b.json) : {} } : b)), stop_reason: stop };
}
function sseEvents(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join(''))
    .filter((d) => d && d !== '[DONE]')
    .map((d) => JSON.parse(d));
}
const fromAnthropic = (m) => ({ text: m.content.filter((b) => b.type === 'text').map((b) => b.text).join(''), calls: m.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input })) });

function anthropicMessages() {
  return turns.map((t) =>
    t.role === 'user'
      ? { role: 'user', content: t.text }
      : t.role === 'assistant'
        ? { role: 'assistant', content: [...(t.text ? [{ type: 'text', text: t.text }] : []), ...t.calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input }))] }
        : { role: 'user', content: t.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: JSON.stringify(r.output) })) },
  );
}
const anthropicTools = () => TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));

const ASK = {
  async azure() {
    const client = new AzureOpenAI({ endpoint: 'https://acme.openai.azure.com', apiKey: 'k', apiVersion: '2025-01-01-preview', deployment: 'gpt-prod', maxRetries: 0 });
    const messages = [{ role: 'system', content: SYSTEM }];
    for (const t of turns) {
      if (t.role === 'user') messages.push({ role: 'user', content: t.text });
      else if (t.role === 'assistant') messages.push({ role: 'assistant', content: t.text || null, ...(t.calls.length ? { tool_calls: t.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}) });
      else for (const r of t.results) messages.push({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.output) });
    }
    const request = { model: 'gpt-prod', messages, tools: TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })) };
    if (!STREAM) {
      const r = await client.chat.completions.create(request);
      const m = r.choices[0].message;
      return { text: m.content ?? '', calls: (m.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments || '{}') })) };
    }
    let text = '';
    const calls = new Map();
    for await (const chunk of await client.chat.completions.create({ ...request, stream: true, stream_options: { include_usage: true } })) {
      const d = chunk.choices[0]?.delta;
      if (!d) continue;
      text += d.content ?? '';
      for (const tc of d.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
      }
    }
    return { text, calls: [...calls.values()].map((c) => ({ id: c.id, name: c.name, input: JSON.parse(c.args || '{}') })) };
  },

  async gemini(vertex = false) {
    const ai = vertex ? new GoogleGenAI({ vertexai: true, apiKey: 'k' }) : new GoogleGenAI({ apiKey: 'k' });
    const contents = turns.map((t) =>
      t.role === 'user'
        ? { role: 'user', parts: [{ text: t.text }] }
        : t.role === 'assistant'
          ? { role: 'model', parts: [...(t.text ? [{ text: t.text }] : []), ...t.calls.map((c) => ({ functionCall: { name: c.name, args: c.input } }))] }
          : { role: 'user', parts: t.results.map((r) => ({ functionResponse: { name: r.name, response: { output: JSON.stringify(r.output) } } })) },
    );
    const params = { model: 'gemini-2.5-flash', contents, config: { systemInstruction: SYSTEM, tools: [{ functionDeclarations: TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.schema })) }] } };
    const parts = [];
    if (STREAM) for await (const chunk of await ai.models.generateContentStream(params)) parts.push(...(chunk.candidates?.[0]?.content?.parts ?? []));
    else parts.push(...((await ai.models.generateContent(params)).candidates?.[0]?.content?.parts ?? []));
    let n = 0;
    return { text: parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join(''), calls: parts.filter((p) => p.functionCall).map((p) => ({ id: `g${++n}`, name: p.functionCall.name, input: p.functionCall.args ?? {} })) };
  },

  async 'vertex-claude'() {
    const url = `https://us-east5-aiplatform.googleapis.com/v1/projects/acme/locations/us-east5/publishers/anthropic/models/claude-sonnet-5:${STREAM ? 'streamRawPredict' : 'rawPredict'}`;
    const res = await json(url, { anthropic_version: 'vertex-2023-10-16', max_tokens: 1024, system: SYSTEM, messages: anthropicMessages(), tools: anthropicTools(), ...(STREAM ? { stream: true } : {}) }, { authorization: 'Bearer ya29.token' });
    return fromAnthropic(STREAM ? assembleAnthropic(sseEvents(await res.text())) : await res.json());
  },

  async 'bedrock-claude'() {
    const url = `https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-sonnet-5-v1%3A0/${STREAM ? 'invoke-with-response-stream' : 'invoke'}`;
    const res = await json(url, { anthropic_version: 'bedrock-2023-05-31', max_tokens: 1024, system: SYSTEM, messages: anthropicMessages(), tools: anthropicTools() }, { accept: STREAM ? 'application/vnd.amazon.eventstream' : 'application/json' });
    if (!STREAM) return fromAnthropic(await res.json());
    const body = Buffer.from(await res.arrayBuffer());
    // The AWS SDK checks both checksums of every frame before it reads one.
    if (!eventStreamFrames(body)) throw new Error('the answer is not an AWS event stream');
    return fromAnthropic(assembleAnthropic([...eventStreamMessages(body)].map((e) => e.payload)));
  },

  async 'bedrock-converse'() {
    const url = `https://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.nova-pro-v1%3A0/${STREAM ? 'converse-stream' : 'converse'}`;
    const messages = turns.map((t) =>
      t.role === 'user'
        ? { role: 'user', content: [{ text: t.text }] }
        : t.role === 'assistant'
          ? { role: 'assistant', content: [...(t.text ? [{ text: t.text }] : []), ...t.calls.map((c) => ({ toolUse: { toolUseId: c.id, name: c.name, input: c.input } }))] }
          : { role: 'user', content: t.results.map((r) => ({ toolResult: { toolUseId: r.id, content: [{ json: r.output }], status: 'success' } })) },
    );
    const res = await json(url, { system: [{ text: SYSTEM }], messages, toolConfig: { tools: TOOLS.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.schema } } })) }, inferenceConfig: { maxTokens: 1024 } });
    if (!STREAM) {
      const r = await res.json();
      return { text: r.output.message.content.filter((b) => typeof b.text === 'string').map((b) => b.text).join(''), calls: r.output.message.content.filter((b) => b.toolUse).map((b) => ({ id: b.toolUse.toolUseId, name: b.toolUse.name, input: b.toolUse.input })) };
    }
    const body = Buffer.from(await res.arrayBuffer());
    if (!eventStreamFrames(body)) throw new Error('the answer is not an AWS event stream');
    const blocks = [];
    for (const { type, payload } of eventStreamMessages(body)) {
      if (type === 'contentBlockStart' && payload.start?.toolUse) blocks[payload.contentBlockIndex] = { id: payload.start.toolUse.toolUseId, name: payload.start.toolUse.name, json: '' };
      else if (type === 'contentBlockDelta' && typeof payload.delta?.text === 'string') blocks[payload.contentBlockIndex] = { text: (blocks[payload.contentBlockIndex]?.text ?? '') + payload.delta.text };
      else if (type === 'contentBlockDelta' && payload.delta?.toolUse) blocks[payload.contentBlockIndex].json += payload.delta.toolUse.input;
    }
    return { text: blocks.filter((b) => b && 'text' in b).map((b) => b.text).join(''), calls: blocks.filter((b) => b && 'name' in b).map((b) => ({ id: b.id, name: b.name, input: b.json ? JSON.parse(b.json) : {} })) };
  },
};
ASK['vertex-gemini'] = () => ASK.gemini(true);

if (!ASK[API]) throw new Error(`no such API: ${API}`);
for (let step = 0; step < 6; step++) {
  const answer = await ASK[API]();
  turns.push({ role: 'assistant', text: answer.text, calls: answer.calls });
  if (!answer.calls.length) {
    console.log(answer.text);
    break;
  }
  const results = [];
  for (const c of answer.calls) results.push({ id: c.id, name: c.name, output: await impls[c.name](c.input) });
  turns.push({ role: 'tool', results });
}
