import { describe, expect, it } from 'vitest';
import { compareRuns } from '../src/compare.js';
import { storeApiRequest } from '../src/manifest.js';
import { pathSetByCode, requestPathLabel } from '../src/request-paths.js';
import { Store } from '../src/store.js';
import type { RunRecord } from '../src/types.js';

// What a path into a model request points at, in words, for each provider's request shape: what
// Compare shows above a difference in place of `$.messages[14].content[0].content`.

const anthropic: { messages: Array<{ role: string; content: unknown }>; [key: string]: unknown } = {
  model: 'claude-sonnet-5',
  system: [{ type: 'text', text: 'You are a support agent.' }],
  tools: [{ name: 'lookup_policy', input_schema: { type: 'object', properties: { region: { type: 'string' } } } }],
  messages: [
    { role: 'user', content: 'Refund order A-1042.' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'Check the policy.', signature: 's' }, { type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'toolu_1', name: 'lookup_policy', input: { region: 'EU' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"approval":"tier2"}' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'a' }] }, { type: 'text', text: 'And hurry.' }] },
  ],
  metadata: { user_id: 'u-1' },
};

describe('requestPathLabel', () => {
  it('names a tool result by the tool its call id answers, as Compare shows it', () => {
    expect(requestPathLabel(anthropic, '$.messages[2].content[0].content')).toBe('tool_result lookup_policy');
    // A user turn that only carries a result is the result; one block among others is itself.
    expect(requestPathLabel(anthropic, '$.messages[2]')).toBe('tool_result lookup_policy');
    expect(requestPathLabel(anthropic, '$.messages[3].content[0].content[0].text')).toBe('tool_result lookup_policy');
    expect(requestPathLabel(anthropic, '$.messages[3].content[1].text')).toBe('user message');
    expect(requestPathLabel(anthropic, '$.messages[3]')).toBe('user message');
  });

  it('names messages by role, a call by its tool with the field below it, and thinking', () => {
    expect(requestPathLabel(anthropic, '$.messages[0].content')).toBe('user message');
    expect(requestPathLabel(anthropic, '$.messages[1].content[1].text')).toBe('assistant message');
    expect(requestPathLabel(anthropic, '$.messages[1].content[2].input.region')).toBe('tool_call lookup_policy · region');
    expect(requestPathLabel(anthropic, '$.messages[1].content[2].input')).toBe('tool_call lookup_policy');
    expect(requestPathLabel(anthropic, '$.messages[1].content[0].signature')).toBe('thinking');
  });

  it('names the system prompt, a tool definition with the field that changed, and any other field by its path', () => {
    expect(requestPathLabel(anthropic, '$.system[0].text')).toBe('system prompt');
    expect(requestPathLabel({ ...anthropic, system: 'You are terse.' }, '$.system')).toBe('system prompt');
    expect(requestPathLabel(anthropic, '$.tools[0].input_schema.properties.region.type')).toBe('tool definition lookup_policy · input_schema.properties.region.type');
    expect(requestPathLabel(anthropic, '$.metadata.user_id')).toBe('metadata.user_id');
    expect(requestPathLabel(anthropic, '$.temperature')).toBe('temperature');
    // The whole request stands for a call of another kind or name, which the difference itself says.
    expect(requestPathLabel(anthropic, '$')).toBeNull();
  });

  it('reads OpenAI Chat Completions: tool messages by their call, calls by their function', () => {
    const chat = {
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: [{ type: 'text', text: 'Refund A-1042.' }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'issue_refund', arguments: '{"amount":240}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
      ],
      tools: [{ type: 'function', function: { name: 'issue_refund', parameters: { type: 'object' } } }],
    };
    expect(requestPathLabel(chat, '$.messages[0].content')).toBe('system prompt');
    expect(requestPathLabel(chat, '$.messages[1].content[0].text')).toBe('user message');
    expect(requestPathLabel(chat, '$.messages[2].tool_calls[0].function.arguments')).toBe('tool_call issue_refund');
    expect(requestPathLabel(chat, '$.messages[3].content')).toBe('tool_result issue_refund');
    expect(requestPathLabel(chat, '$.tools[0].function.parameters.type')).toBe('tool definition issue_refund · parameters.type');
  });

  it('reads the Responses API: outputs by the call they answer, and the instructions as the system prompt', () => {
    const responses = {
      model: 'gpt-5',
      instructions: 'Be brief.',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Refund A-1042.' }] },
        { type: 'reasoning', id: 'rs_1', summary: [] },
        { type: 'function_call', call_id: 'fc_1', name: 'lookup_policy', arguments: '{}' },
        { type: 'function_call_output', call_id: 'fc_1', output: '{"limit":100}' },
      ],
      tools: [{ type: 'function', name: 'lookup_policy', parameters: {} }, { type: 'web_search' }],
    };
    expect(requestPathLabel(responses, '$.instructions')).toBe('system prompt');
    expect(requestPathLabel(responses, '$.input[0].content[0].text')).toBe('user message');
    expect(requestPathLabel(responses, '$.input[1].summary')).toBe('thinking · summary');
    expect(requestPathLabel(responses, '$.input[2].arguments')).toBe('tool_call lookup_policy');
    expect(requestPathLabel(responses, '$.input[3].output')).toBe('tool_result lookup_policy');
    expect(requestPathLabel(responses, '$.tools[1].search_context_size')).toBe('tool definition web_search · search_context_size');
    expect(requestPathLabel({ model: 'gpt-5', input: 'Hello' }, '$.input')).toBe('user message');
  });

  it('reads Gemini: parts by the function they call or answer, the model as the assistant', () => {
    const gemini = {
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      contents: [
        { role: 'user', parts: [{ text: 'Refund A-1042.' }] },
        { role: 'model', parts: [{ text: 'Checking.' }, { functionCall: { name: 'lookup_policy', args: { region: 'EU' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'lookup_policy', response: { limit: 100 } } }] },
      ],
      tools: [{ functionDeclarations: [{ name: 'lookup_policy', parameters: {} }] }],
    };
    expect(requestPathLabel(gemini, '$.systemInstruction.parts[0].text')).toBe('system prompt');
    expect(requestPathLabel(gemini, '$.contents[0].parts[0].text')).toBe('user message');
    expect(requestPathLabel(gemini, '$.contents[1].parts[0].text')).toBe('assistant message');
    expect(requestPathLabel(gemini, '$.contents[1].parts[1].functionCall.args.region')).toBe('tool_call lookup_policy · region');
    expect(requestPathLabel(gemini, '$.contents[2].parts[0].functionResponse.response.limit')).toBe('tool_result lookup_policy · limit');
    expect(requestPathLabel(gemini, '$.contents[2]')).toBe('tool_result lookup_policy');
    expect(requestPathLabel(gemini, '$.tools[0].functionDeclarations[0].parameters')).toBe('tool definition lookup_policy · parameters');
  });

  it('reads Bedrock Converse: blocks keyed by kind, and the tools in toolConfig', () => {
    const converse = {
      system: [{ text: 'Be brief.' }],
      messages: [
        { role: 'assistant', content: [{ toolUse: { toolUseId: 'tu_1', name: 'lookup_policy', input: { region: 'EU' } } }] },
        { role: 'user', content: [{ toolResult: { toolUseId: 'tu_1', content: [{ json: { limit: 100 } }] } }] },
      ],
      toolConfig: { tools: [{ toolSpec: { name: 'lookup_policy', inputSchema: { json: {} } } }] },
    };
    expect(requestPathLabel(converse, '$.system[0].text')).toBe('system prompt');
    expect(requestPathLabel(converse, '$.messages[0].content[0].toolUse.input.region')).toBe('tool_call lookup_policy · region');
    expect(requestPathLabel(converse, '$.messages[1].content[0].toolResult.content[0].json.limit')).toBe('tool_result lookup_policy · limit');
    expect(requestPathLabel(converse, '$.toolConfig.tools[0].toolSpec.inputSchema')).toBe('tool definition lookup_policy · inputSchema');
  });

  it('keeps to whole segments: message 1 is not message 10, and the system prompt not systemInstruction', () => {
    const long = { messages: Array.from({ length: 11 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` })) };
    expect(requestPathLabel(long, '$.messages[10].content')).toBe('user message');
    expect(requestPathLabel(long, '$.messages[1].content')).toBe('assistant message');
    expect(requestPathLabel({ system: 'x', systemInstruction: { parts: [{ text: 'y' }] } }, '$.systemInstruction.parts[0].text')).toBe('system prompt');
    // A shape it doesn't know: the path, without the `$.`.
    expect(requestPathLabel({ prompt: 'x' }, '$.prompt')).toBe('prompt');
    expect(requestPathLabel('a string body', '$')).toBeNull();
  });
});

describe('compareRuns names what differs', () => {
  const addApi = (store: Store, run: RunRecord, callNo: number, body: unknown) => {
    const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: JSON.stringify(body), occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo, ...identity, origin: 'live', effect: null, requestRef: storeApiRequest(store, body), meta: { provider: 'anthropic' }, at: callNo });
    store.appendCallEnd(identity, { runId: run.runId, callNo, attempt: 0, responseRef: store.putJson({ ok: callNo }), outcome: 'ok', meta: {}, at: callNo + 1 });
  };

  it('labels a model request’s difference by what it points at, and a tool input’s by its tool', () => {
    const store = Store.open(':memory:');
    const a = store.createRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    const b = store.createRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    const changed = structuredClone(anthropic);
    changed.messages[2].content = [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"approval":"tier2","refund_limit":100}' }];
    addApi(store, a, 1, anthropic);
    addApi(store, b, 1, changed);
    const c = compareRuns(store, a, store.getCalls(a.runId), b, store.getCalls(b.runId));
    expect(c.firstRequestDifference?.diff).toEqual([{ path: '$.messages[2].content[0].content', op: 'changed', before: '{"approval":"tier2"}', after: '{"approval":"tier2","refund_limit":100}', what: 'tool_result lookup_policy' }]);

    const x = store.createRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    const y = store.createRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    for (const [run, amount] of [[x, 240], [y, 100]] as const) {
      const identity = { kind: 'tool' as const, name: 'issue_refund', fingerprint: String(amount), occurrence: 1 };
      store.appendCallStart({ runId: run.runId, callNo: 1, ...identity, origin: 'live', effect: 'write', requestRef: store.putJson({ amount }), meta: {}, at: 1 });
    }
    const t = compareRuns(store, x, store.getCalls(x.runId), y, store.getCalls(y.runId));
    expect(t.firstRequestDifference?.diff?.[0]).toMatchObject({ path: '$.amount', what: 'issue_refund · amount' });
    store.close();
  });
});

describe('pathSetByCode', () => {
  it('tells what a patch or a config change changes from what a run came to, by the path alone', () => {
    for (const path of ['$.system', '$.system[0].text', '$.model', '$.tools[1].description', '$.instructions', '$.systemInstruction.parts[0].text', '$.system_instruction', '$.toolConfig.tools[0]', '$.tool_choice']) expect(pathSetByCode(path), path).toBe(true);
    for (const path of ['$', '$.metadata.user_id', '$.messages[0].content', '$.messages[3].content[0].text', '$.temperature', '$.systems', '$.input[0]']) expect(pathSetByCode(path), path).toBe(false);
  });

  it('takes Chat Completions’ first message for its system prompt, as Anthropic’s is the user’s', () => {
    expect(pathSetByCode('$.messages[0].content', 'POST /v1/chat/completions')).toBe(true);
    expect(pathSetByCode('$.messages[10].content', 'POST /v1/chat/completions')).toBe(false);
    expect(pathSetByCode('$.messages[0].content', 'POST /v1/messages')).toBe(false);
  });
});
