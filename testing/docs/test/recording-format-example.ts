// The worked example in docs/recording-format.md, made the way the page tells a producer to make one:
// with no Shadowlap code, only SHA-256 and canonical JSON. The test checks that the page shows exactly
// these files, that Shadowlap's engine computes the same fingerprints, and that the pack replays.
import { createHash } from 'node:crypto';

const sha256 = (bytes: string) => createHash('sha256').update(bytes, 'utf8').digest('hex');

/**
 * JSON with every object's keys sorted, no whitespace: RFC 8785 for values like these (strings
 * without lone surrogates, integers), which is all a request needs here.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const RUN_ID = '01K5RECQRD1NGF0RMATEXAMP1E';
const STARTED = 1790000000000;

/** The request the example agent sends to Anthropic's Messages API, as its body. */
export const REQUEST = {
  model: 'claude-haiku-4-5',
  max_tokens: 256,
  system: 'You look orders up.',
  tools: [{ name: 'lookup_order', input_schema: { type: 'object' } }],
  messages: [{ role: 'user', content: 'What did order A-17 cost?' }],
};
/** What the model answered: the response body as received. */
export const RESPONSE = { id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'tool_use', id: 'toolu_01', name: 'lookup_order', input: { id: 'A-17' } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 61, output_tokens: 18 } };
export const ARGS = { id: 'A-17' };
export const RESULT = { id: 'A-17', total: 180 };

export interface ExamplePack {
  /** File name in the pack → its text. */
  files: Map<string, string>;
  /** The blobs, by what each holds, for the page's walk-through. */
  blobs: Record<'system' | 'tools' | 'message' | 'manifest' | 'response' | 'toolRequest' | 'toolResult', { name: string; text: string }>;
  fingerprints: { api: string; tool: string };
}

/** The example pack: a run with one model call and one tool call. */
export function examplePack(): ExamplePack {
  const blob = (text: string) => ({ name: sha256(text), text });
  const system = blob(JSON.stringify(REQUEST.system));
  const tools = blob(JSON.stringify(REQUEST.tools));
  const message = blob(JSON.stringify(REQUEST.messages[0]));
  const { system: _s, tools: _t, messages: _m, ...fields } = REQUEST;
  // Any JSON reads: these two are written spread over lines, as a provider may send a response.
  const manifest = blob(JSON.stringify({ v: 1, kind: 'chunked', fields, system: system.name, tools: tools.name, messages: [message.name] }, null, 2));
  const response = blob(JSON.stringify(RESPONSE, null, 2));
  const toolRequest = blob(JSON.stringify({ args: ARGS }));
  const toolResult = blob(JSON.stringify({ result: RESULT }));
  const fingerprints = {
    api: sha256(canonical({ kind: 'api', method: 'POST', path: '/v1/messages', headers: { 'anthropic-version': '2023-06-01' }, body: REQUEST })),
    tool: sha256(canonical({ kind: 'tool', name: 'lookup_order', args: ARGS })),
  };
  const run = {
    runId: RUN_ID,
    parentRunId: null,
    mode: 'record',
    status: 'completed',
    divergence: null,
    command: { argv: ['node', 'agent.mjs'], cwd: '.' },
    codeVersion: null,
    startedAt: STARTED,
    endedAt: STARTED + 900,
    meta: {},
  };
  const calls = [
    {
      runId: RUN_ID,
      callNo: 1,
      kind: 'api',
      name: 'POST /v1/messages',
      fingerprint: fingerprints.api,
      occurrence: 1,
      origin: 'live',
      effect: null,
      requestRef: manifest.name,
      meta: { provider: 'anthropic', fingerprintHeaders: { 'anthropic-version': '2023-06-01' } },
      at: STARTED + 100,
      end: { runId: RUN_ID, callNo: 1, attempt: 0, responseRef: response.name, outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'application/json' }, model: 'claude-haiku-4-5', usage: { inputTokens: 61, outputTokens: 18 } }, at: STARTED + 700 },
      attempts: [],
    },
    {
      runId: RUN_ID,
      callNo: 2,
      kind: 'tool',
      name: 'lookup_order',
      fingerprint: fingerprints.tool,
      occurrence: 1,
      origin: 'live',
      effect: 'read',
      requestRef: toolRequest.name,
      meta: {},
      at: STARTED + 710,
      end: { runId: RUN_ID, callNo: 2, attempt: 0, responseRef: toolResult.name, outcome: 'ok', meta: { latencyMs: 40 }, at: STARTED + 750 },
      attempts: [],
    },
  ];
  const files = new Map<string, string>([
    ['run.json', `${JSON.stringify({ format: 'shadowlap-pack', version: 1, createdAt: STARTED + 1000, runs: [run] }, null, 2)}\n`],
    ['calls.jsonl', calls.map((c) => JSON.stringify(c)).join('\n') + '\n'],
    ['.gitattributes', '* -text\n'],
  ]);
  const blobs = { system, tools, message, manifest, response, toolRequest, toolResult };
  for (const b of Object.values(blobs)) files.set(`blobs/${b.name}`, b.text);
  return { files, blobs, fingerprints };
}

/** The agent the example recorded: one model call, then the tool the model asked for, through the SDK. */
export function exampleAgent(sdkUrl: string): string {
  return `import { tool } from ${JSON.stringify(sdkUrl)};

const res = await fetch(\`\${process.env.ANTHROPIC_BASE_URL}/v1/messages\`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'unused-on-replay' },
  body: JSON.stringify(${JSON.stringify(REQUEST)}),
});
const reply = await res.json();
const use = reply.content.find((b) => b.type === 'tool_use');
const lookupOrder = tool('lookup_order', { effect: 'read' }, async () => {
  throw new Error('a replay serves this call from the recording');
});
const order = await lookupOrder(use.input);
console.log(\`order \${order.id}: $\${order.total}\`);
`;
}
