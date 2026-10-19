import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type DecisionsReport } from '@shadowlap/engine';
import { functionCall, startMockGemini, turn as geminiTurn, type MockServer as GeminiMock } from '@shadowlap-testing/mock-gemini';
import { startMockOpenAI, toolCall, turn as openaiTurn, type MockServer as OpenAIMock } from '@shadowlap-testing/mock-openai';

/**
 * `shadowlap decisions` beyond Anthropic: an agent that looks an order up and refunds it, recorded
 * through OpenAI Chat Completions, the Responses API and Gemini, asked again under a model that
 * escalates instead, and under a prompt in the working tree that says to. Each provider's request
 * has its model and its prompt swapped where that provider keeps them, and its answer read the
 * provider's way: the refund at the second step is a write removed, rank 1, and no tool runs.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const TS_SDK = new URL('../../sdk/dist/index.js', import.meta.url).href;
const ESCALATE = 'Escalate refunds over $100.';

let openai: OpenAIMock;
let gemini: GeminiMock;
let cwd: string;
let db: string;

/** What the model does at each step: look the order up, refund it (or escalate), then answer. */
const decide = (step: number, escalates: boolean) => (step === 0 ? 'lookup' : step === 1 ? (escalates ? 'escalate' : 'refund') : 'answer');
const CALLS = {
  lookup: toolCall('lookup_order', { order_id: 'A-1042' }),
  refund: toolCall('issue_refund', { order_id: 'A-1042', amount: 240 }),
  escalate: toolCall('escalate', { order_id: 'A-1042', reason: 'refund over $100' }),
};
const escalating = (model: string, system: string) => model.endsWith('-escalates') || system.includes(ESCALATE);

beforeAll(async () => {
  openai = await startMockOpenAI({
    script: ({ request, assistantTurns }) => {
      const system = request.messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => String(m.content)).join('\n');
      const d = decide(assistantTurns, escalating(request.model, system));
      return { turn: d === 'answer' ? openaiTurn('Done.') : openaiTurn(null, { tool_calls: [CALLS[d]] }) };
    },
    responses: ({ request }) => {
      const input = Array.isArray(request.input) ? request.input : [];
      const d = decide(input.filter((i) => i.type === 'function_call_output').length, escalating(request.model, String(request.instructions ?? '')));
      return { turn: d === 'answer' ? openaiTurn('Done.') : openaiTurn(null, { tool_calls: [CALLS[d]] }) };
    },
  });
  gemini = await startMockGemini({
    script: ({ request, requestNo, modelTurns }) => {
      const system = JSON.stringify(request.systemInstruction ?? '');
      const model = /models\/([^:]+):/.exec(gemini.requests[requestNo - 1]!.path)![1]!;
      const d = decide(modelTurns, escalating(model, system));
      if (d === 'answer') return { turn: geminiTurn('Done.') };
      const call = CALLS[d];
      return { turn: geminiTurn(null, { functionCalls: [functionCall(call.function.name, JSON.parse(call.function.arguments) as Record<string, unknown>)] }) };
    },
  });
  cwd = mkdtempSync(join(tmpdir(), 'sl-decisions-providers-'));
  db = join(cwd, 'store.db');
  writeFileSync(join(cwd, 'tools.mjs'), TOOLS);
  writeFileSync(join(cwd, 'chat.mjs'), CHAT_AGENT);
  writeFileSync(join(cwd, 'responses.mjs'), RESPONSES_AGENT);
  writeFileSync(join(cwd, 'gemini.mjs'), GEMINI_AGENT);
});
afterAll(async () => {
  await Promise.all([openai?.close(), gemini?.close()]);
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** The tools, as an agent wraps them: their effects are what tells a write from a read. */
const TOOLS = `
import { tool } from ${JSON.stringify(TS_SDK)};
export const impl = {
  lookup_order: tool('lookup_order', { effect: 'read' }, async ({ order_id }) => ({ order_id, total: 240, state: 'delivered' })),
  issue_refund: tool('issue_refund', { effect: 'write' }, async ({ amount }) => ({ refunded: amount })),
  escalate: tool('escalate', { effect: 'write' }, async () => ({ queued: true })),
};
export const schemas = [
  { name: 'lookup_order', description: 'Look an order up.', parameters: { type: 'object', properties: { order_id: { type: 'string' } } } },
  { name: 'issue_refund', description: 'Refund an order.', parameters: { type: 'object', properties: { order_id: { type: 'string' }, amount: { type: 'number' } } } },
  { name: 'escalate', description: 'Hand the order to a person.', parameters: { type: 'object', properties: { order_id: { type: 'string' }, reason: { type: 'string' } } } },
];
export const system = ['You refund orders.', process.env.AGENT_SYSTEM ?? ''].join(' ').trim();
`;

const CHAT_AGENT = `
import { impl, schemas, system } from './tools.mjs';
const messages = [{ role: 'system', content: system }, { role: 'user', content: 'Refund order A-1042.' }];
for (let i = 0; i < 5; i++) {
  const res = await fetch(process.env.OPENAI_BASE_URL + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' }, body: JSON.stringify({ model: 'gpt-5', messages, tools: schemas.map((s) => ({ type: 'function', function: s })) }) });
  const message = (await res.json()).choices[0].message;
  messages.push(message);
  if (!message.tool_calls?.length) break;
  for (const c of message.tool_calls) messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(await impl[c.function.name](JSON.parse(c.function.arguments))) });
}
`;

const RESPONSES_AGENT = `
import { impl, schemas, system } from './tools.mjs';
const input = [{ role: 'user', content: 'Refund order A-1042.' }];
for (let i = 0; i < 5; i++) {
  const res = await fetch(process.env.OPENAI_BASE_URL + '/responses', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' }, body: JSON.stringify({ model: 'gpt-5', instructions: system, input, tools: schemas.map((s) => ({ type: 'function', ...s })) }) });
  const output = (await res.json()).output;
  input.push(...output);
  const calls = output.filter((o) => o.type === 'function_call');
  if (!calls.length) break;
  for (const c of calls) input.push({ type: 'function_call_output', call_id: c.call_id, output: JSON.stringify(await impl[c.name](JSON.parse(c.arguments))) });
}
`;

const GEMINI_AGENT = `
import { impl, schemas, system } from './tools.mjs';
const contents = [{ role: 'user', parts: [{ text: 'Refund order A-1042.' }] }];
for (let i = 0; i < 5; i++) {
  const res = await fetch(process.env.GOOGLE_GEMINI_BASE_URL + '/v1beta/models/gemini-3.8-flash:generateContent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': 'test-key' }, body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, tools: [{ functionDeclarations: schemas }] }) });
  const content = (await res.json()).candidates[0].content;
  contents.push(content);
  const calls = content.parts.filter((p) => p.functionCall);
  if (!calls.length) break;
  contents.push({ role: 'user', parts: await Promise.all(calls.map(async (p) => ({ functionResponse: { name: p.functionCall.name, response: await impl[p.functionCall.name](p.functionCall.args) } }))) });
}
`;

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], {
      cwd,
      env: { ...process.env, SHADOWLAP_UPSTREAM_OPENAI: openai.url, SHADOWLAP_UPSTREAM_GEMINI: gemini.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_HOME: join(cwd, 'home'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => ((out += d.toString()), (stdout += d.toString())));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out, stdout }));
  });
}

const report = (r: { stdout: string; out: string }): DecisionsReport => {
  try {
    return JSON.parse(r.stdout) as DecisionsReport;
  } catch {
    throw new Error(`not JSON:\n${r.out}`);
  }
};

async function record(agent: string): Promise<string> {
  const r = await shadowlap(['run', '--', process.execPath, agent]);
  expect(r.code, r.out).toBe(0);
  return /recording run (\w{26})/.exec(r.out)![1]!;
}

const toolRuns = () => {
  const store = Store.open(db);
  try {
    return store.allRuns().length;
  } finally {
    store.close();
  }
};

/** The refund step's change, as each provider's answer reads: the refund is no longer called, an escalation is. */
function expectEscalation(r: DecisionsReport, runId: string): void {
  expect(r.flagged).toEqual([runId]);
  expect(r.runs[0]).toMatchObject({ steps: 3, asked: 3, rank: 1 });
  const [step] = r.runs[0]!.decisions;
  expect(step).toMatchObject({ step: 2, rank: 1, recorded: { stop: 'tools', tools: [{ name: 'issue_refund', effect: 'write' }] }, now: { stop: 'tools', tools: [{ name: 'escalate' }] } });
  expect(step!.changes.map((c) => [c.kind, c.tool])).toEqual([
    ['write-removed', 'issue_refund'],
    ['write-added', 'escalate'],
  ]);
  expect(r.counts).toMatchObject({ 1: 1, same: 2, notAsked: 0 });
}

describe('shadowlap decisions, provider by provider', () => {
  it('OpenAI Chat Completions: the model in the body, the prompt as the system message the conversation starts with', async () => {
    const runId = await record('chat.mjs');
    const runs = toolRuns();
    let before = openai.requests.length;
    const model = report(await shadowlap(['decisions', runId, '--model', 'gpt-5-escalates', '--json']));
    expectEscalation(model, runId);
    expect(openai.requests.slice(before).map((q) => q.body.model)).toEqual(['gpt-5-escalates', 'gpt-5-escalates', 'gpt-5-escalates']);

    before = openai.requests.length;
    const prompt = report(await shadowlap(['decisions', runId, '--from-code', '--json'], { AGENT_SYSTEM: ESCALATE }));
    expectEscalation(prompt, runId);
    expect(prompt.change.fromCode!.instructions!.after).toBe(`You refund orders. ${ESCALATE}`);
    const sent = openai.requests.slice(before).map((q) => q.body);
    expect(sent.map((q) => q.messages[0])).toEqual(Array(3).fill({ role: 'system', content: `You refund orders. ${ESCALATE}` }));
    expect(sent.map((q) => q.messages.length)).toEqual([2, 4, 6]);
    expect(toolRuns()).toBe(runs);
  }, 120_000);

  it('the Responses API: the prompt as its instructions', async () => {
    const runId = await record('responses.mjs');
    let before = openai.otherRequests.length;
    expectEscalation(report(await shadowlap(['decisions', runId, '--model', 'gpt-5-escalates', '--json'])), runId);
    expect(openai.otherRequests.slice(before).map((q) => [q.path, q.body.model])).toEqual(Array(3).fill(['/v1/responses', 'gpt-5-escalates']));

    before = openai.otherRequests.length;
    expectEscalation(report(await shadowlap(['decisions', runId, '--from-code', '--json'], { AGENT_SYSTEM: ESCALATE })), runId);
    const sent = openai.otherRequests.slice(before).map((q) => q.body);
    expect(sent.map((q) => [q.model, q.instructions])).toEqual(Array(3).fill(['gpt-5', `You refund orders. ${ESCALATE}`]));
  }, 120_000);

  it("Gemini: the model in the request's path, the prompt as its system instruction", async () => {
    const runId = await record('gemini.mjs');
    let before = gemini.requests.length;
    expectEscalation(report(await shadowlap(['decisions', runId, '--model', 'gemini-3.8-flash-escalates', '--json'])), runId);
    expect(gemini.requests.slice(before).map((q) => q.path)).toEqual(Array(3).fill('/v1beta/models/gemini-3.8-flash-escalates:generateContent'));

    before = gemini.requests.length;
    expectEscalation(report(await shadowlap(['decisions', runId, '--from-code', '--json'], { AGENT_SYSTEM: ESCALATE })), runId);
    const sent = gemini.requests.slice(before);
    expect(sent.map((q) => [q.path, q.body.systemInstruction])).toEqual(Array(3).fill(['/v1beta/models/gemini-3.8-flash:generateContent', { parts: [{ text: `You refund orders. ${ESCALATE}` }] }]));
    expect(sent.map((q) => q.body.contents.length)).toEqual([1, 3, 5]);
  }, 120_000);
});
