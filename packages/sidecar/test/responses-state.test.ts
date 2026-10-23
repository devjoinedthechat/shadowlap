import OpenAI from 'openai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { tool } from '@shadowlap/sdk';
import { startMockOpenAI, toolCall, turn, type MockServer, type ResponsesScript } from '@shadowlap-testing/mock-openai';
import { Sidecar } from '../src/index.js';

/**
 * An agent on OpenAI's Responses API that keeps its conversation on OpenAI's side, streamed through
 * the official `openai` SDK. A fork's first live call continues a response the recording made
 * (`previous_response_id`), which the provider holds only for the key that made it: here a second
 * mock server, which knows none of the first one's responses, stands in for another key, another
 * organization, or a response past its retention. The fork sends the whole conversation instead. A
 * fork of a call that names a recorded conversation is refused, since the conversation already holds
 * the recorded run's later turns.
 */

const command = { argv: ['agent'], cwd: '/' };
const MODEL = 'gpt-5';
const tools: OpenAI.Responses.Tool[] = [{ type: 'function', name: 'lookup_order', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, strict: false }];

/** The model: asks for the order, then answers with the total the tool's output gave, as it read it; in a conversation, "ok". */
const script: ResponsesScript = ({ request, context }) => {
  if (request.conversation) return { turn: turn('ok') };
  const output = [...context].reverse().find((i) => i.type === 'function_call_output');
  if (!output) return { turn: turn(null, { tool_calls: [toolCall('lookup_order', { id: 'A-17' })] }) };
  return { turn: turn(`Order A-17 cost ${(JSON.parse(output.output as string) as { total: number }).total}.`) };
};

const lookupOrder = tool('lookup_order', { effect: 'read' }, async ({ id }: { id: string }) => ({ id, total: 180 }));

/** The agent: one streamed turn that asks for a tool, the tool, and one that continues the first by its id. */
async function agent(client: OpenAI): Promise<string> {
  const first = await client.responses.stream({ model: MODEL, instructions: 'You look orders up.', input: 'What did order A-17 cost?', tools }).finalResponse();
  const call = first.output.find((i): i is OpenAI.Responses.ResponseFunctionToolCall => i.type === 'function_call')!;
  const result = await lookupOrder(JSON.parse(call.arguments) as { id: string });
  const second = await client.responses.stream({ model: MODEL, instructions: 'You look orders up.', previous_response_id: first.id, input: [{ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) }], tools }).finalResponse();
  return second.output_text;
}

let recording: MockServer;
let elsewhere: MockServer;
let store: Store;
beforeAll(async () => {
  recording = await startMockOpenAI({ script: () => ({ turn: turn('unused') }), responses: script });
  elsewhere = await startMockOpenAI({ script: () => ({ turn: turn('unused') }), responses: script });
  store = Store.open(':memory:');
});
afterAll(async () => {
  await recording.close();
  await elsewhere.close();
  store.close();
});
afterEach(() => {
  delete process.env.SHADOWLAP_URL;
  delete process.env.SHADOWLAP_RUN_ID;
});

/** Runs `body` in a run of `mode` through a sidecar whose OpenAI upstream is `upstream`: the run's summary, and what `body` returned or threw. */
async function inRun<T>(upstream: MockServer, start: Omit<Parameters<Sidecar['startRun']>[0], 'command'>, body: (client: OpenAI) => Promise<T>) {
  const sidecar = await Sidecar.start({ store, upstreams: { openai: upstream.url } });
  try {
    const run = sidecar.startRun({ ...start, command });
    process.env.SHADOWLAP_URL = sidecar.url;
    process.env.SHADOWLAP_RUN_ID = run.runId;
    const client = new OpenAI({ apiKey: 'sk-test', baseURL: sidecar.envFor(run.runId).OPENAI_BASE_URL, maxRetries: 0 });
    let outcome: { value: T } | { error: unknown };
    try {
      outcome = { value: await body(client) };
    } catch (error) {
      outcome = { error };
    }
    return { runId: run.runId, outcome, summary: sidecar.endRun(run.runId, 'completed').summary };
  } finally {
    await sidecar.close();
  }
}

describe('a fork of a Responses agent that continues its conversation by previous_response_id', () => {
  let parent = '';

  it('records the streamed turns, and replays them offline', async () => {
    const rec = await inRun(recording, { mode: 'record' }, agent);
    expect(rec.outcome).toEqual({ value: 'Order A-17 cost 180.' });
    parent = rec.runId;
    const calls = store.getCalls(parent);
    expect(calls.map((c) => `${c.kind} ${c.name}`)).toEqual(['api POST /v1/responses', 'tool lookup_order', 'api POST /v1/responses']);
    expect(calls[0]!.end!.meta.headers?.['content-type']).toContain('text/event-stream');
    expect(calls[0]!.end!.meta.usage?.inputTokens).toBeGreaterThan(0);

    const before = recording.otherRequests.length + elsewhere.otherRequests.length;
    const rep = await inRun(elsewhere, { mode: 'replay', parentRunId: parent, offline: true }, agent);
    expect(rep.outcome).toEqual({ value: 'Order A-17 cost 180.' });
    expect(rep.summary).toMatchObject({ divergence: null, upstreamRequests: 0 });
    expect(recording.otherRequests.length + elsewhere.otherRequests.length).toBe(before);
  });

  it('sends the forked call with the whole conversation, which a server that never saw the recording can answer', async () => {
    // The tool now returns another total: the second turn changes, and goes live, to a server that
    // knows none of the recording's responses, as another key or another organization would be.
    const toolCallNo = store.getCalls(parent).find((c) => c.kind === 'tool')!.callNo;
    const fork = await inRun(elsewhere, { mode: 'replay', parentRunId: parent, replay: { overrides: new Map([[toolCallNo, { id: 'A-17', total: 240 }]]) } }, agent);
    expect(fork.outcome).toEqual({ value: 'Order A-17 cost 240.' });
    expect(fork.summary.divergence).toMatchObject({ type: 'request_changed', callNo: 3 });
    expect(fork.summary.upstreamRequests).toBe(1);
    const sent = elsewhere.otherRequests.at(-1)!.body;
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.instructions).toBe('You look orders up.');
    expect(sent.input).toEqual([
      { role: 'user', content: 'What did order A-17 cost?' },
      { type: 'function_call', call_id: expect.stringMatching(/^call_lookup_order_/), name: 'lookup_order', arguments: '{"id":"A-17"}' },
      { type: 'function_call_output', call_id: expect.stringMatching(/^call_lookup_order_/), output: '{"id":"A-17","total":240}' },
    ]);
    expect(fork.summary.warnings.join('\n')).toMatch(/call 3 continued resp_\w+, a response the recording made, .* sent with the whole conversation it continues instead, rebuilt from the recorded call #1/);
    // Its recording holds the request as the agent sent it, so a replay of the fork matches it.
    const forked = store.getCalls(fork.runId).at(-1)!;
    expect(forked.origin).toBe('live');
    const again = await inRun(elsewhere, { mode: 'replay', parentRunId: fork.runId, offline: true, replay: { overrides: new Map([[toolCallNo, { id: 'A-17', total: 240 }]]) } }, agent);
    expect(again.outcome).toEqual({ value: 'Order A-17 cost 240.' });
    expect(again.summary.divergence).toBeNull();
  });
});

describe('a fork of a Responses agent that keeps its turns in a conversation', () => {
  /** Two questions in one conversation it makes first. */
  const chatter = (second: string) => async (client: OpenAI) => {
    const conversation = await client.conversations.create({});
    const answers: string[] = [];
    for (const input of ['First question?', second]) answers.push((await client.responses.stream({ model: MODEL, conversation: conversation.id, input }).finalResponse()).output_text);
    return answers;
  };
  let parent = '';

  it('refuses the forked call, which would read the recorded run\'s later turns, in OpenAI\'s error shape and in the summary', async () => {
    const rec = await inRun(recording, { mode: 'record' }, chatter('Second question?'));
    expect(rec.outcome).toMatchObject({ value: ['ok', 'ok'] });
    parent = rec.runId;
    const before = elsewhere.otherRequests.length;
    const fork = await inRun(elsewhere, { mode: 'replay', parentRunId: parent }, chatter('A different second question?'));
    const error = (fork.outcome as { error: unknown }).error;
    expect(error).toBeInstanceOf(OpenAI.BadRequestError);
    expect((error as Error).message).toContain('shadowlap did not send this call: it continues conversation conv_');
    expect((error as Error).message).toContain('Fork from call #1, which made the conversation (--diverge-at 1)');
    expect(fork.summary.warnings.join('\n')).toMatch(/Call 3 was not sent: it continues conversation conv_\w+, which OpenAI keeps with every turn of the recorded run/);
    expect(fork.summary).toMatchObject({ upstreamRequests: 0, refused: 1 });
    expect(elsewhere.otherRequests.length).toBe(before);
  });

  it('runs a fork from the call that made the conversation, which then makes its own', async () => {
    const fork = await inRun(elsewhere, { mode: 'replay', parentRunId: parent, replay: { divergeAt: 1 } }, chatter('A different second question?'));
    expect(fork.outcome).toMatchObject({ value: ['ok', 'ok'] });
    expect(fork.summary.divergence).toMatchObject({ type: 'forced', callNo: 1 });
  });
});
