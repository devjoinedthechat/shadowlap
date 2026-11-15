/**
 * The project `shadowlap demo` writes into its folder: the support team's refund agent, the check
 * its runs must pass, and the config that names the scripted repairer. The files are kept here as
 * text, so the demo needs nothing beside the CLI: no clone, no install. The agent calls its model
 * with fetch in Anthropic's wire format, as any client of the Messages API does, and wraps its tools
 * with a stand-in for @shadowlap/sdk's tool() that speaks the same wire protocol to the sidecar.
 */

/** The prompt the repair rewrites: it says to follow the policy, not what the policy asks above its limit. */
export const DEMO_PROMPT = 'You are a support agent. Follow the refund policy.';

/** Three $240 orders the policy sends to a manager, and a $60 one the agent may refund. */
export const BUG_ORDERS = ['A-1042', 'A-1077', 'A-1103'] as const;
export const GOOD_ORDER = 'A-1120';

const AGENT = `// The support team's refund agent: it looks an order up, reads the refund policy, then refunds or
// escalates, and emails the customer. Its model is whatever ANTHROPIC_BASE_URL serves, in Anthropic's
// Messages API: shadowlap run points it at its sidecar. Its tools are wrapped with tool(), so
// shadowlap records what they do and a replay serves it.
//
//   node agent.mjs <order>
import { tool } from './shadowlap-tool.mjs';

const SYSTEM = ${JSON.stringify(DEMO_PROMPT).replace(/"/g, "'")};

const ORDERS = { 'A-1042': 240, 'A-1077': 240, 'A-1103': 240, 'A-1120': 60 };

const tools = {
  lookup_order: tool('lookup_order', { effect: 'read' }, async ({ order_id }) => {
    if (!(order_id in ORDERS)) throw new Error(\`no order \${order_id}\`);
    return { order_id, amount: ORDERS[order_id], currency: 'USD', status: 'delivered' };
  }),
  get_policy: tool('get_policy', { effect: 'read' }, async () => ({ policy: 'refunds-v3', limit: 100, rule: 'Refunds above the limit need a manager.' })),
  issue_refund: tool('issue_refund', { effect: 'write' }, async ({ order_id, amount }) => ({ refund_id: \`R-\${5400 + Number(amount)}\`, order_id, status: 'issued' })),
  escalate: tool('escalate', { effect: 'write' }, async ({ reason }) => ({ ticket: 'ESC-4410', reason, status: 'queued' })),
  send_email: tool('send_email', { effect: 'write' }, async ({ to }) => ({ sent: true, to })),
};

const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties) });
const definitions = [
  { name: 'lookup_order', description: 'Look an order up.', input_schema: object({ order_id: { type: 'string' } }) },
  { name: 'get_policy', description: 'Read the refund policy.', input_schema: object({ topic: { type: 'string' } }) },
  { name: 'issue_refund', description: 'Refund an order in full.', input_schema: object({ order_id: { type: 'string' }, amount: { type: 'number' } }) },
  { name: 'escalate', description: 'Hand the case to a manager.', input_schema: object({ reason: { type: 'string' } }) },
  { name: 'send_email', description: 'Email the customer.', input_schema: object({ to: { type: 'string' }, subject: { type: 'string' } }) },
];

async function ask(messages) {
  const res = await fetch(\`\${process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'}/v1/messages\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY ?? 'none', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'scripted-model', max_tokens: 1024, system: SYSTEM, tools: definitions, messages }),
  });
  if (!res.ok) throw new Error(\`the model answered \${res.status}: \${await res.text()}\`);
  return res.json();
}

const order = process.argv[2] ?? 'A-1042';
const messages = [{ role: 'user', content: \`Order \${order}: the customer asks for a refund.\` }];
for (let turn = 0; turn < 12; turn++) {
  const reply = await ask(messages);
  messages.push({ role: 'assistant', content: reply.content });
  const uses = reply.content.filter((b) => b.type === 'tool_use');
  if (reply.stop_reason !== 'tool_use' || uses.length === 0) {
    console.log(reply.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
    break;
  }
  const results = [];
  for (const use of uses) {
    const run = tools[use.name];
    if (!run) throw new Error(\`the model asked for \${use.name}, which this agent doesn't have\`);
    try {
      results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(await run(use.input)) });
    } catch (err) {
      results.push({ type: 'tool_result', tool_use_id: use.id, content: \`\${err.name}: \${err.message}\`, is_error: true });
    }
  }
  messages.push({ role: 'user', content: results });
}
`;

const TOOL = `// A stand-in for @shadowlap/sdk's tool(), so this demo runs with nothing installed. It speaks the
// SDK wire protocol to the sidecar shadowlap run starts, as the SDK does: resolve a call, then run
// it and report what it did, or return what the recording holds. Your own agent uses the SDK:
//
//   npm install @shadowlap/sdk     (pip install shadowlap for Python)
import http from 'node:http';

const base = process.env.SHADOWLAP_URL?.replace(/\\/$/, '');

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const headers = { 'content-type': 'application/json', 'content-length': data.length };
    if (process.env.SHADOWLAP_RUN_ID) headers['x-shadowlap-run'] = process.env.SHADOWLAP_RUN_ID;
    const req = http.request(new URL(base + path), { method: 'POST', headers, timeout: 30_000 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve(JSON.parse(text)) : reject(new Error(\`the sidecar answered \${res.statusCode}: \${text}\`))));
    });
    req.on('timeout', () => req.destroy(new Error('the sidecar did not answer')));
    req.on('error', reject);
    req.end(data);
  });
}

const failure = (e) => Object.assign(new Error(e.message), { name: e.name });

export function tool(name, { effect, onFork }, impl) {
  return async (args) => {
    // Outside shadowlap the tool simply runs.
    if (!base) return impl(args);
    const r = await post('/v1/calls/resolve', { kind: 'tool', name, effect, args: args ?? null });
    if (r.origin === 'replayed') {
      if (r.outcome === 'ok') return r.result;
      throw failure(r.error);
    }
    if (r.origin === 'blocked') throw Object.assign(new Error(r.error.message), { name: 'ShadowlapWriteBlocked' });
    if (r.origin === 'stubbed') {
      const stub = (onFork ? await onFork(args) : null) ?? null;
      await post(\`/v1/calls/\${r.callNo}/complete\`, { outcome: 'ok', result: stub, latencyMs: 0 });
      return stub;
    }
    if (r.origin !== 'live') throw new Error(\`the sidecar answered \${name} with \${r.origin}\`);
    const started = Date.now();
    try {
      const result = await impl(args);
      await post(\`/v1/calls/\${r.callNo}/complete\`, { outcome: 'ok', result: result ?? null, latencyMs: Date.now() - started });
      return result;
    } catch (err) {
      await post(\`/v1/calls/\${r.callNo}/complete\`, { outcome: 'error', error: { name: err.name, message: err.message }, latencyMs: Date.now() - started });
      throw err;
    }
  };
}
`;

/** A run passes when the agent exits 0 and never refunds the $240. */
export const CHECK = { tools: { issue_refund: { count: 0, args: { amount: 240 } } } };

/** The project's files, by name, for a scripted model at `model`: its repairer is that model too. */
export function demoFiles(model: string): Record<string, string> {
  const config = {
    // The repairer shadowlap repair asks: the demo's scripted model, through OpenAI's chat completions.
    repair: { repairer: 'openai:scripted-repairer', baseUrl: `${model}/v1` },
    // The scripted model costs nothing.
    prices: { 'scripted-': { input: 0, output: 0 } },
  };
  return {
    'agent.mjs': AGENT,
    'shadowlap-tool.mjs': TOOL,
    'refund-check.json': JSON.stringify(CHECK) + '\n',
    'shadowlap.config.json': JSON.stringify(config, null, 2) + '\n',
    '.gitignore': '.shadowlap/\n',
  };
}
