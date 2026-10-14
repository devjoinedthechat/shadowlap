import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from '@google/genai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { tool } from '@shadowlap/sdk';
import { functionCall, startMockGemini, turn, type MockServer } from '@shadowlap-testing/mock-gemini';
import { Sidecar } from '../src/index.js';

/**
 * The Gemini path end to end: the official `@google/genai` SDK (streaming generateContent with
 * function calls) → sidecar → scripted mock. Record, clean replay, fork with the write fenced.
 * The SDK is pointed at the sidecar through GOOGLE_GEMINI_BASE_URL, exactly as `shadowlap run` does.
 */

const TURNS = [
  turn('Looking it up.', { functionCalls: [functionCall('search_web', { query: 'shadowlap' })] }),
  turn(null, { functionCalls: [functionCall('send_email', { to: 'team@example.com', body: 'summary' })] }),
  turn('Done: replay works for Gemini too.'),
];

let mock: MockServer;
let store: Store;
let sidecar: Sidecar;
let sent = 0;

const searchWeb = tool('search_web', { effect: 'read' }, async ({ query }: { query: string }) => ({ results: [`${query} #1`, `${query} #2`] }));
const sendEmail = tool('send_email', { effect: 'write' }, async ({ to }: { to: string }) => {
  sent++;
  return { sent: true, to };
});

const declarations: FunctionDeclaration[] = [
  { name: 'search_web', parametersJsonSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'send_email', parametersJsonSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } } } },
];

interface AgentResult {
  finalText: string;
  modelCalls: number;
  toolErrors: string[];
}

async function runAgent(system: string): Promise<AgentResult> {
  // A fresh client per run: the SDK reads GOOGLE_GEMINI_BASE_URL when it is constructed.
  const ai = new GoogleGenAI({ apiKey: 'AIza-test' });
  const contents: Content[] = [{ role: 'user', parts: [{ text: 'Research Shadowlap and email the team.' }] }];
  let modelCalls = 0;
  const toolErrors: string[] = [];
  for (let i = 0; i < 10; i++) {
    const stream = await ai.models.generateContentStream({ model: 'gemini-2.5-flash', contents, config: { systemInstruction: system, tools: [{ functionDeclarations: declarations }] } });
    modelCalls++;
    let text = '';
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    for await (const chunk of stream) {
      text += chunk.text ?? '';
      for (const fc of chunk.functionCalls ?? []) calls.push({ name: fc.name ?? '', args: (fc.args ?? {}) as Record<string, unknown> });
    }
    if (calls.length === 0) return { finalText: text, modelCalls, toolErrors };
    contents.push({ role: 'model', parts: [...(text ? [{ text }] : []), ...calls.map((c) => ({ functionCall: { name: c.name, args: c.args } }))] });
    const responses: Part[] = [];
    for (const c of calls) {
      try {
        const result = c.name === 'search_web' ? await searchWeb(c.args as never) : await sendEmail(c.args as never);
        responses.push({ functionResponse: { name: c.name, response: result as Record<string, unknown> } });
      } catch (err) {
        toolErrors.push(`${c.name}: ${(err as Error).name}`);
        responses.push({ functionResponse: { name: c.name, response: { error: (err as Error).message } } });
      }
    }
    contents.push({ role: 'user', parts: responses });
  }
  throw new Error('agent did not finish');
}

beforeAll(async () => {
  mock = await startMockGemini({ script: (ctx) => ({ turn: TURNS[ctx.modelTurns] ?? turn('(no scripted turn)') }) });
  store = Store.open(':memory:');
  sidecar = await Sidecar.start({ store, upstreams: { gemini: mock.url } });
  Object.assign(process.env, sidecar.envFor()); // the client is created before the runs: calls go to the run started last
});

afterAll(async () => {
  await sidecar.close();
  await mock.close();
  store.close();
  for (const k of Object.keys(sidecar.envFor())) delete process.env[k];
});

describe('Gemini provider', () => {
  let parent: string;

  it('records a streaming function-calling run', async () => {
    const run = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
    process.env.SHADOWLAP_RUN_ID = run.runId;
    const result = await runAgent('You are helpful.');
    const { summary } = sidecar.endRun(run.runId, 'completed');
    parent = run.runId;
    expect(result.modelCalls).toBe(3);
    expect(sent).toBe(1);
    expect(summary.byKind).toMatchObject({ api: 3, tool: 2 });
    expect(mock.requests).toHaveLength(3);
    expect(mock.requests[0]!.path).toBe('/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    const api = store.getCalls(run.runId).filter((c) => c.kind === 'api');
    expect(api[0]!.name).toBe('POST /v1beta/models/gemini-2.5-flash:streamGenerateContent');
    expect(api.every((c) => (c.end?.meta.usage?.inputTokens ?? 0) > 0)).toBe(true);
    expect(api.map((c) => c.end?.meta.stopReason)).toEqual(['STOP', 'STOP', 'STOP']);
    expect(api[0]!.end?.meta.provider).toBe('gemini');
    expect(summary.cost.spent).toBeGreaterThan(0); // gemini-2.5-flash is priced
    expect(mock.requests[0]!.headers['x-goog-api-key']).toBe('AIza-test'); // forwarded upstream…
    expect(JSON.stringify(store.getCalls(run.runId))).not.toContain('AIza-test'); // …never stored
  });

  it('replays with zero upstream requests', async () => {
    const before = mock.requests.length;
    const run = sidecar.startRun({ mode: 'replay', parentRunId: parent, command: { argv: ['agent'], cwd: '.' } });
    process.env.SHADOWLAP_RUN_ID = run.runId;
    const result = await runAgent('You are helpful.');
    const { summary } = sidecar.endRun(run.runId, 'completed');
    expect(summary.divergence).toBeNull();
    expect(summary.byOrigin.replayed).toBe(5);
    expect(mock.requests).toHaveLength(before);
    expect(sent).toBe(1);
    expect(result.finalText).toContain('Done');
  });

  it('forks on a changed system instruction and blocks the write', async () => {
    const run = sidecar.startRun({ mode: 'replay', parentRunId: parent, command: { argv: ['agent'], cwd: '.' } });
    process.env.SHADOWLAP_RUN_ID = run.runId;
    const result = await runAgent('You are terse.');
    const { summary } = sidecar.endRun(run.runId, 'completed');
    expect(summary.divergence).toMatchObject({ type: 'request_changed', callNo: 1 });
    expect(summary.divergence?.diff?.[0]?.path).toMatch(/^\$\.systemInstruction/);
    expect(summary.byOrigin.blocked).toBe(1);
    expect(result.toolErrors).toEqual(['send_email: ShadowlapWriteBlocked']);
    expect(sent).toBe(1);
  });
});
