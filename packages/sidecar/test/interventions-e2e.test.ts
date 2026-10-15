import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiRequest, Store, type ReplayOptions } from '@shadowlap/engine';
import { message, startMockAnthropic, text, toolUse, type MockServer as AnthropicMock } from '@shadowlap-testing/mock-anthropic';
import { functionCall, startMockGemini, turn as geminiTurn, type MockServer as GeminiMock } from '@shadowlap-testing/mock-gemini';
import { startMockOpenAI, toolCall, turn as openaiTurn, type MockServer as OpenAIMock } from '@shadowlap-testing/mock-openai';
import { Sidecar, type Interventions } from '../src/index.js';

/**
 * `--inject`, `--set` and `--model` on every provider's wire format, end to end through the official
 * SDKs and the scripted fakes: what reaches the provider is the change, in its own shape, at the
 * model call the flag named, counted as the recording counts its model calls.
 */

const command = { argv: ['agent'], cwd: '/' };
type Run = { runId: string };

async function replay(sidecar: Sidecar, parent: string, interventions: Interventions, drive: (run: Run) => Promise<unknown>, options: Partial<ReplayOptions> = {}) {
  const run = sidecar.startRun({ mode: 'replay', parentRunId: parent, command, interventions, replay: options });
  let error: unknown;
  try {
    await drive(run);
  } catch (err) {
    error = err;
  }
  const ended = sidecar.endRun(run.runId, error ? 'failed' : 'completed');
  return { run, error, summary: ended.summary };
}

// ---- Anthropic ----

describe('Anthropic', () => {
  let mock: AnthropicMock;
  let store: Store;
  let sidecar: Sidecar;
  let parent: string;

  // Look an order up, then answer: two model calls, the second after a tool result.
  async function agent(sc: Sidecar, run: Run): Promise<string> {
    const client = new Anthropic({ apiKey: 'k', baseURL: sc.envFor(run.runId).ANTHROPIC_BASE_URL, maxRetries: 0 });
    const tools = [{ name: 'lookup_order', input_schema: { type: 'object' as const, properties: { id: { type: 'number' } } } }];
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'Refund order 42.' }];
    const first = await client.messages.create({ model: 'claude-sonnet-5', max_tokens: 64, system: 'You are support.', tools, messages });
    const use = first.content.find((b) => b.type === 'tool_use')!;
    messages.push({ role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: 'order 42: $240' }] });
    const second = await client.messages.create({ model: 'claude-sonnet-5', max_tokens: 64, system: 'You are support.', tools, messages });
    return second.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  }

  beforeAll(async () => {
    mock = await startMockAnthropic({ script: (ctx) => ({ message: ctx.assistantTurns === 0 ? message([toolUse('lookup_order', { id: 42 })]) : message([text('Refund issued.')]) }) });
    store = Store.open(':memory:');
    sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
    const run = sidecar.startRun({ mode: 'record', command });
    await agent(sidecar, run);
    sidecar.endRun(run.runId, 'completed');
    parent = run.runId;
  });
  afterAll(async () => {
    await sidecar.close();
    await mock.close();
    store.close();
  });

  it('injects as part of the user turn by default: a text block after the tool result, at the call named', async () => {
    const before = mock.requests.length;
    const { summary } = await replay(sidecar, parent, { inject: { atCall: 2, text: 'Escalate refunds above $200 to tier 2.', as: 'user' } }, (run) => agent(sidecar, run));
    // Call 1 replayed; only the injected call reached the provider.
    expect(mock.requests.length - before).toBe(1);
    const sent = mock.requests.at(-1)!.body;
    expect(sent.messages.at(-1)).toEqual({ role: 'user', content: [expect.objectContaining({ type: 'tool_result' }), { type: 'text', text: 'Escalate refunds above $200 to tier 2.' }] });
    // The fork is where the request changed, its diff shows the instruction, and the report names the flag.
    expect(summary.divergence).toMatchObject({ type: 'request_changed', callNo: 2, counterpart: { callNo: 2 }, reason: 'changed by --inject 2: an instruction added to the user turn' });
    expect(summary.divergence!.diff).toEqual([{ path: '$.messages[2].content[1]', op: 'added', after: { type: 'text', text: 'Escalate refunds above $200 to tier 2.' } }]);
    expect(summary.divergence!.hints).toBeUndefined();
  });

  it('injects as a system message after the conversation with --inject-as system', async () => {
    await replay(sidecar, parent, { inject: { atCall: 2, text: 'Prefer store credit.', as: 'system' } }, (run) => agent(sidecar, run));
    expect(mock.requests.at(-1)!.body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'system']);
  });

  it('still forks at the call named when the request already had the setting', async () => {
    const before = mock.requests.length;
    const { summary } = await replay(sidecar, parent, { set: { fromCall: 2, fields: { max_tokens: 64 } } }, (run) => agent(sidecar, run));
    // Asked again, not served from the recording: the flag named this call.
    expect(mock.requests.length - before).toBe(1);
    expect(summary.divergence).toMatchObject({ type: 'forced', callNo: 2, reason: 'forced live by --set 2:max_tokens=64', counterpart: { callNo: 2 } });
  });

  it('forks at the named call even when --prompt-from hides the injected system message from matching', async () => {
    const before = mock.requests.length;
    // --prompt-from matches earlier calls without their system messages, which hides this injection.
    const { summary } = await replay(sidecar, parent, { inject: { atCall: 1, text: 'Prefer store credit.', as: 'system' } }, (run) => agent(sidecar, run), { promptFrom: 2 });
    expect(mock.requests.length - before).toBe(2);
    expect(mock.requests[before]!.body.messages.at(-1)).toEqual({ role: 'system', content: 'Prefer store credit.' });
    expect(summary.divergence).toMatchObject({ type: 'forced', callNo: 1, reason: 'forced live by --inject 1 --inject-as system: an instruction added as a system message, a change the normalizers or --prompt-from hide from matching' });
  });

  it('sets fields and switches the model from the call named on', async () => {
    const { run } = await replay(sidecar, parent, { set: { fromCall: 2, fields: { temperature: 0, model: 'claude-opus-5' } } }, (r) => agent(sidecar, r));
    expect(mock.requests.at(-1)!.body).toMatchObject({ model: 'claude-opus-5', temperature: 0 });
    // The fork's record names what made it.
    expect(store.getRun(run.runId)!.meta?.interventions).toEqual([
      { kind: 'set', at: 2, flag: '--set 2:temperature=0', args: ['--set', '2:temperature=0'] },
      { kind: 'model', at: 2, flag: '--model 2:claude-opus-5', args: ['--model', '2:claude-opus-5'] },
    ]);
  });
});

// ---- OpenAI: Chat Completions after an embeddings call, and the Responses API ----

describe('OpenAI', () => {
  let mock: OpenAIMock;
  let store: Store;
  let sidecar: Sidecar;

  const chatAgent = async (sc: Sidecar, run: Run) => {
    const client = new OpenAI({ apiKey: 'k', baseURL: sc.envFor(run.runId).OPENAI_BASE_URL, maxRetries: 0 });
    // An embeddings call first: it is model call 1, on both sides.
    await client.embeddings.create({ model: 'text-embedding-3-small', input: 'refund policy' });
    const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'system', content: 'You are support.' }, { role: 'user', content: 'Refund order 42.' }];
    const first = await client.chat.completions.create({ model: 'gpt-mock', messages });
    const calls = first.choices[0]!.message.tool_calls ?? [];
    messages.push({ role: 'assistant', content: null, tool_calls: calls }, ...calls.map((c) => ({ role: 'tool' as const, tool_call_id: c.id, content: 'order 42: $240' })));
    const second = await client.chat.completions.create({ model: 'gpt-mock', messages });
    return second.choices[0]!.message.content;
  };

  const responsesAgent = async (sc: Sidecar, run: Run) => {
    const client = new OpenAI({ apiKey: 'k', baseURL: sc.envFor(run.runId).OPENAI_BASE_URL, maxRetries: 0 });
    const input: OpenAI.Responses.ResponseInputItem[] = [{ role: 'user', content: 'Refund order 42.' }];
    const first = await client.responses.create({ model: 'gpt-5', instructions: 'You are support.', input });
    const call = first.output.find((o) => o.type === 'function_call') as OpenAI.Responses.ResponseFunctionToolCall;
    input.push(call, { type: 'function_call_output', call_id: call.call_id, output: 'order 42: $240' });
    const second = await client.responses.create({ model: 'gpt-5', instructions: 'You are support.', input });
    return second.output_text;
  };

  beforeAll(async () => {
    mock = await startMockOpenAI({
      script: (ctx) => ({ turn: ctx.assistantTurns === 0 ? openaiTurn(null, { tool_calls: [toolCall('lookup_order', { id: 42 })] }) : openaiTurn('Refund issued.') }),
      responses: (ctx) => ({ turn: Array.isArray(ctx.request.input) && ctx.request.input.some((i) => i.type === 'function_call_output') ? openaiTurn('Refund issued.') : openaiTurn(null, { tool_calls: [toolCall('lookup_order', { id: 42 })] }) }),
    });
    store = Store.open(':memory:');
    sidecar = await Sidecar.start({ store, upstreams: { openai: mock.url } });
  });
  afterAll(async () => {
    await sidecar.close();
    await mock.close();
    store.close();
  });

  const record = async (drive: (run: Run) => Promise<unknown>) => {
    const run = sidecar.startRun({ mode: 'record', command });
    await drive(run);
    sidecar.endRun(run.runId, 'completed');
    return run.runId;
  };

  it('counts an embeddings call like the recording does, and adds a user message after the tool output', async () => {
    const parent = await record((run) => chatAgent(sidecar, run));
    expect(store.getCalls(parent).map((c) => c.name)).toEqual(['POST /v1/embeddings', 'POST /v1/chat/completions', 'POST /v1/chat/completions']);
    const before = mock.requests.length;
    const { summary } = await replay(sidecar, parent, { inject: { atCall: 3, text: 'Escalate refunds above $200.', as: 'user' }, set: { fromCall: 3, fields: { temperature: 0 } } }, (run) => chatAgent(sidecar, run));
    expect(mock.requests.length - before).toBe(1);
    const sent = mock.requests.at(-1)!.body;
    expect(sent.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(sent.messages.at(-1)).toEqual({ role: 'user', content: 'Escalate refunds above $200.' });
    expect((sent as unknown as { temperature: number }).temperature).toBe(0);
    expect(summary.divergence).toMatchObject({ type: 'request_changed', callNo: 3, reason: 'changed by --inject 3: an instruction added to the user turn; --set 3:temperature=0' });
  });

  it('injects into the Responses API input, and sets max_tokens as max_output_tokens', async () => {
    const parent = await record((run) => responsesAgent(sidecar, run));
    const before = mock.otherRequests.length;
    await replay(sidecar, parent, { inject: { atCall: 2, text: 'Answer in one line.', as: 'user' }, set: { fromCall: 2, fields: { max_tokens: 100 } } }, (run) => responsesAgent(sidecar, run));
    expect(mock.otherRequests.length - before).toBe(1);
    const sent = mock.otherRequests.at(-1)!.body as { input: Array<Record<string, unknown>>; max_output_tokens: number; instructions: string };
    expect(sent.input.at(-2)).toMatchObject({ type: 'function_call_output' });
    expect(sent.input.at(-1)).toEqual({ role: 'user', content: 'Answer in one line.' });
    expect(sent.max_output_tokens).toBe(100);
    expect(sent.instructions).toBe('You are support.');
    // As a system message, the Responses API takes it in the input too.
    await replay(sidecar, parent, { inject: { atCall: 2, text: 'Mind the limit.', as: 'system' } }, (run) => responsesAgent(sidecar, run));
    expect((mock.otherRequests.at(-1)!.body as { input: unknown[] }).input.at(-1)).toEqual({ role: 'system', content: 'Mind the limit.' });
  });
});

// ---- Gemini ----

describe('Gemini', () => {
  let mock: GeminiMock;
  let store: Store;
  let sidecar: Sidecar;
  let parent: string;
  let failNext = 0;

  /**
   * Two generateContent calls with a function call between, sent with fetch; a 503 is retried, as an
   * SDK does. With `tagAttempts`, each attempt carries its own number in a label a normalizer masks.
   */
  async function agent(sc: Sidecar, run: Run, tagAttempts = false): Promise<string> {
    const base = `${sc.url}/r/${run.runId}/gemini/v1beta/models/gemini-2.5-flash:generateContent`;
    const send = async (body: Record<string, unknown>) => {
      for (let attempt = 0; ; attempt++) {
        const sent = tagAttempts ? { ...body, labels: { attempt: String(attempt) } } : body;
        const res = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': 'AIza-test' }, body: JSON.stringify(sent) });
        if (res.status === 503 && attempt < 2) continue;
        if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
        return (await res.json()) as { candidates: Array<{ content: { parts: Array<{ text?: string; functionCall?: unknown }> } }> };
      }
    };
    const contents: unknown[] = [{ role: 'user', parts: [{ text: 'Refund order 42.' }] }];
    const config = { systemInstruction: { parts: [{ text: 'You are support.' }] }, contents };
    const first = await send(config);
    contents.push(first.candidates[0]!.content, { role: 'user', parts: [{ functionResponse: { name: 'lookup_order', response: { total: 240 } } }] });
    const second = await send({ ...config, contents });
    return second.candidates[0]!.content.parts.map((p) => p.text ?? '').join('');
  }

  beforeAll(async () => {
    mock = await startMockGemini({
      script: (ctx) => {
        if (failNext > 0) {
          failNext--;
          return { status: 503, body: { error: { code: 503, message: 'overloaded', status: 'UNAVAILABLE' } } };
        }
        return { turn: ctx.modelTurns === 0 ? geminiTurn(null, { functionCalls: [functionCall('lookup_order', { id: 42 })] }) : geminiTurn('Refund issued.') };
      },
    });
    store = Store.open(':memory:');
    sidecar = await Sidecar.start({ store, upstreams: { gemini: mock.url } });
    const run = sidecar.startRun({ mode: 'record', command });
    await agent(sidecar, run);
    sidecar.endRun(run.runId, 'completed');
    parent = run.runId;
  });
  afterAll(async () => {
    await sidecar.close();
    await mock.close();
    store.close();
  });

  it('adds the instruction as a part of the user turn, next to the function response', async () => {
    await replay(sidecar, parent, { inject: { atCall: 2, text: 'Escalate refunds above $200.', as: 'user' } }, (run) => agent(sidecar, run));
    const last = mock.requests.at(-1)!.body.contents.at(-1)!;
    expect(last).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'lookup_order', response: { total: 240 } } }, { text: 'Escalate refunds above $200.' }] });
  });

  it('sets sampling in generationConfig and switches the model in the path', async () => {
    const { run, summary } = await replay(sidecar, parent, { set: { fromCall: 2, fields: { temperature: 0, max_tokens: 256, model: 'gemini-2.5-pro' } } }, (r) => agent(sidecar, r));
    // Another path is another call name, so the report names the flags instead of diffing two endpoints.
    expect(summary.divergence).toMatchObject({ type: 'forced', callNo: 2, counterpart: { callNo: 2 }, reason: 'forced live by --set 2:temperature=0 --set 2:max_tokens=256 --model 2:gemini-2.5-pro' });
    const last = mock.requests.at(-1)!;
    expect(last.path).toBe('/v1beta/models/gemini-2.5-pro:generateContent');
    expect(last.body.generationConfig).toEqual({ temperature: 0, maxOutputTokens: 256 });
    const call = store.getCalls(run.runId).find((c) => c.callNo === 2)!;
    expect(call.name).toBe('POST /v1beta/models/gemini-2.5-pro:generateContent');
    expect(call.end?.meta.model).toBe('gemini-2.5-pro');
  });

  it('refuses a system message mid-conversation, with the reason, instead of sending something Gemini rejects', async () => {
    const before = mock.requests.length;
    const { error, summary, run } = await replay(sidecar, parent, { inject: { atCall: 2, text: 'x', as: 'system' } }, (r) => agent(sidecar, r));
    expect(String(error)).toContain('Gemini takes system instructions only in systemInstruction');
    expect(mock.requests.length).toBe(before);
    expect(summary.warnings.join('\n')).toContain('Not applied: --inject 2 --inject-as system');
    expect(store.getCalls(run.runId).find((c) => c.callNo === 2)!.end).toMatchObject({ outcome: 'error', meta: { status: 400, refused: true } });
  });

  it('resamples for blame: the probed call forced live with the setting where Gemini keeps it', async () => {
    const before = mock.requests.length;
    // What a blame probe at call 2 with --set temperature=1 starts.
    const { summary } = await replay(sidecar, parent, { set: { fromCall: 2, fields: { temperature: 1 } } }, (run) => agent(sidecar, run), { divergeAt: 2, writes: 'stub' });
    expect(summary.divergence).toMatchObject({ type: 'forced', callNo: 2, kind: 'api' });
    expect(mock.requests.slice(before).map((r) => r.body.generationConfig)).toEqual([{ temperature: 1 }]);
  });

  it('counts a retry as the call it retries, so the next call is still the one named', async () => {
    failNext = 1;
    const before = mock.requests.length;
    // Call 1 runs live with the field and fails once; its retry must not take call 2's injection.
    await replay(sidecar, parent, { set: { fromCall: 1, fields: { temperature: 0 } }, inject: { atCall: 2, text: 'Escalate.', as: 'user' } }, (run) => agent(sidecar, run));
    const sent = mock.requests.slice(before).map((r) => JSON.stringify(r.body.contents).includes('Escalate.'));
    expect(sent).toEqual([false, false, true]);
  });

  it('counts a retry that differs only in a masked field as the call it retries', async () => {
    const masked = await Sidecar.start({ store, upstreams: { gemini: mock.url }, normalizers: [{ kind: 'api', path: '$.labels.attempt', replace: '<attempt>' }] });
    try {
      const rec = masked.startRun({ mode: 'record', command });
      await agent(masked, rec, true);
      masked.endRun(rec.runId, 'completed');
      failNext = 1;
      const before = mock.requests.length;
      await replay(masked, rec.runId, { set: { fromCall: 1, fields: { temperature: 0 } }, inject: { atCall: 2, text: 'Escalate.', as: 'user' } }, (run) => agent(masked, run, true));
      const sent = mock.requests.slice(before).map((r) => [(r.body as { labels?: { attempt?: string } }).labels?.attempt, JSON.stringify(r.body.contents).includes('Escalate.')]);
      expect(sent).toEqual([['0', false], ['1', false], ['0', true]]);
    } finally {
      await masked.close();
    }
  });
});

// ---- Bedrock Converse, Vertex AI and Azure OpenAI, against the fake that checks SigV4 ----

interface CloudMock {
  url: string;
  stats: { requests: number; signaturesOk: number; signatureFailures: string[] };
  close(): Promise<void>;
}

describe('Bedrock, Vertex and Azure', () => {
  let cloud: CloudMock;
  let AWS: { accessKeyId: string; secretAccessKey: string; region: string };
  let SIGNED_HOST: string;
  let store: Store;

  beforeAll(async () => {
    const mod = (await import(new URL('../../../testing/frameworks/cloud-mock.mjs', import.meta.url).href)) as { startCloudMock: () => Promise<CloudMock>; AWS: typeof AWS; SIGNED_HOST: string };
    cloud = await mod.startCloudMock();
    AWS = mod.AWS;
    SIGNED_HOST = mod.SIGNED_HOST;
    store = Store.open(':memory:');
  });
  afterAll(async () => {
    await cloud.close();
    store.close();
  });

  /** A Converse request signed as the AWS SDK signs it, sent the way in-process capture sends it. */
  async function converse(sc: Sidecar, run: Run, resign: typeof import('../src/index.js').resignSigV4) {
    const path = '/model/anthropic.claude-3-5-haiku-20241022-v1%3A0/converse';
    const body = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: [{ text: 'hello' }] }], inferenceConfig: { maxTokens: 64 } }));
    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const unsigned = { 'content-type': 'application/json', 'x-amz-date': now, authorization: `AWS4-HMAC-SHA256 Credential=${AWS.accessKeyId}/${now.slice(0, 8)}/${AWS.region}/bedrock/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=${'0'.repeat(64)}` };
    const signed = resign({ method: 'POST', path, query: '', headers: unsigned, body, host: SIGNED_HOST }, () => AWS);
    if ('error' in signed) throw new Error(signed.error);
    const res = await fetch(`${sc.url}/r/${run.runId}/bedrock${path}`, { method: 'POST', headers: { ...signed.headers, 'x-shadowlap-upstream': `https://${SIGNED_HOST}` }, body });
    return { status: res.status, body: (await res.json()) as { output?: { message: { content: Array<{ text: string }> } }; error?: { message: string } } };
  }

  it('Bedrock Converse: changes path and body, signs the request again, and the provider accepts the signature', async () => {
    const { resignSigV4 } = await import('../src/index.js');
    const sidecar = await Sidecar.start({ store, upstreams: { bedrock: cloud.url }, awsCredentials: (id) => (id === AWS.accessKeyId ? AWS : null) });
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      expect((await converse(sidecar, rec, resignSigV4)).status).toBe(200);
      sidecar.endRun(rec.runId, 'completed');
      const failures = cloud.stats.signatureFailures.length;

      const { run } = await replay(sidecar, rec.runId, { inject: { atCall: 1, text: ' Be brief.', as: 'user' }, set: { fromCall: 1, fields: { temperature: 0.2, model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' } } }, async (r) => {
        const answer = await converse(sidecar, r, resignSigV4);
        expect(answer.status).toBe(200);
        // The fake echoes the last user turn: the injected block reached it.
        expect(answer.body.output!.message.content[0]!.text).toBe('echo: hello Be brief.');
      });
      expect(cloud.stats.signatureFailures.slice(failures)).toEqual([]);
      const call = store.getCalls(run.runId)[0]!;
      expect(call.name).toBe('POST /model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse');
      expect(loadApiRequest(store, call.requestRef!)).toMatchObject({ inferenceConfig: { maxTokens: 64, temperature: 0.2 }, messages: [{ role: 'user', content: [{ text: 'hello' }, { text: ' Be brief.' }] }] });
    } finally {
      await sidecar.close();
    }
  });

  it('Bedrock: refuses a change it cannot sign, rather than sending a request AWS would reject', async () => {
    const { resignSigV4 } = await import('../src/index.js');
    const sidecar = await Sidecar.start({ store, upstreams: { bedrock: cloud.url }, awsCredentials: () => null });
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      await converse(sidecar, rec, resignSigV4);
      sidecar.endRun(rec.runId, 'completed');
      const requests = cloud.stats.requests;
      const { summary } = await replay(sidecar, rec.runId, { set: { fromCall: 1, fields: { temperature: 0 } } }, async (r) => {
        const answer = await converse(sidecar, r, resignSigV4);
        expect(answer.status).toBe(400);
        expect(answer.body.error?.message).toContain(`signed it with AWS access key ${AWS.accessKeyId}`);
      });
      expect(cloud.stats.requests).toBe(requests);
      expect(summary.warnings.some((w) => w.startsWith('Not applied: --set 1:temperature=0'))).toBe(true);
    } finally {
      await sidecar.close();
    }
  });

  it('Vertex and Azure: the model switch rewrites the path, which the provider routes on', async () => {
    const sidecar = await Sidecar.start({ store, upstreams: { vertex: cloud.url, azure: cloud.url } });
    try {
      const vertexPath = '/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-3-5-haiku@20241022:rawPredict';
      const azurePath = '/openai/deployments/gpt-4o/chat/completions';
      const drive = async (run: Run) => {
        const v = await fetch(`${sidecar.url}/r/${run.runId}/vertex${vertexPath}`, { method: 'POST', headers: { authorization: 'Bearer ya29.test', 'content-type': 'application/json' }, body: JSON.stringify({ anthropic_version: 'vertex-2023-10-16', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
        const a = await fetch(`${sidecar.url}/r/${run.runId}/azure${azurePath}?api-version=2024-10-21`, { method: 'POST', headers: { 'api-key': 'az-test', 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }) });
        return { vertex: (await v.json()) as { content: Array<{ text: string }> }, azure: (await a.json()) as { model: string; choices: Array<{ message: { content: string } }> } };
      };
      const rec = sidecar.startRun({ mode: 'record', command });
      await drive(rec);
      sidecar.endRun(rec.runId, 'completed');

      let out: Awaited<ReturnType<typeof drive>> | undefined;
      const { run: vertexFork } = await replay(sidecar, rec.runId, { set: { fromCall: 1, fields: { model: 'claude-sonnet-4-5@20250929' } }, inject: { atCall: 1, text: 'Be brief.', as: 'user' } }, async (r) => (out = await drive(r)));
      expect(store.getCalls(vertexFork.runId)[0]!.name).toBe('POST /v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5@20250929:rawPredict');
      expect(out!.vertex.content[0]!.text).toBe('echo: helloBe brief.');
      // The Azure call is another provider: the Vertex model never reaches it.
      expect(out!.azure.model).toBe('gpt-4o');

      const { run: azureFork } = await replay(sidecar, rec.runId, { set: { fromCall: 2, fields: { model: 'gpt-4o-mini' } }, inject: { atCall: 2, text: 'Be brief.', as: 'user' } }, async (r) => (out = await drive(r)));
      expect(store.getCalls(azureFork.runId)[1]!.name).toBe('POST /openai/deployments/gpt-4o-mini/chat/completions');
      expect(out!.azure.model).toBe('gpt-4o-mini');
      expect(out!.azure.choices[0]!.message.content).toBe('echo: hello\n\nBe brief.');
    } finally {
      await sidecar.close();
    }
  });
});
