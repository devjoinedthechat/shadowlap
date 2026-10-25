import { describe, expect, it } from 'vitest';
import { promptOf, promptParts, samePrompt, withoutEarlierThinking, withoutPrompt, withPrompt } from '../src/prompt.js';

/**
 * The prompt `--prompt-from` matches requests without, swapped instead: a recorded request asked again
 * with the prompt and tools another request carries, in each provider's shape.
 */

describe('withPrompt: the same request with another prompt and tools', () => {
  it('Anthropic: system and tools, cache breakpoints in the messages kept', () => {
    const recorded = { model: 'claude-opus-5', system: [{ type: 'text', text: 'Old.', cache_control: { type: 'ephemeral' } }], tools: [{ name: 'a' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }], max_tokens: 1024 };
    const code = { model: 'claude-opus-5', system: 'New.', tools: [{ name: 'a' }, { name: 'b' }], messages: [{ role: 'user', content: 'other' }], max_tokens: 2048 };
    const swapped = withPrompt(recorded, promptOf(code)) as Record<string, unknown>;
    expect(swapped).toEqual({ model: 'claude-opus-5', system: 'New.', tools: [{ name: 'a' }, { name: 'b' }], messages: recorded.messages, max_tokens: 1024 });
    expect(Object.keys(swapped)).toEqual(['model', 'system', 'tools', 'messages', 'max_tokens']);
    expect(withoutPrompt(swapped)).toEqual(withoutPrompt(recorded));
  });

  it('Bedrock Converse: system and toolConfig', () => {
    const recorded = { system: [{ text: 'Old.' }], toolConfig: { tools: [{ toolSpec: { name: 'a' } }] }, messages: [{ role: 'user', content: [{ text: 'hi' }] }], inferenceConfig: { maxTokens: 512 } };
    const swapped = withPrompt(recorded, promptOf({ system: [{ text: 'New.' }], toolConfig: { tools: [{ toolSpec: { name: 'b' } }] }, messages: [] }));
    expect(swapped).toEqual({ system: [{ text: 'New.' }], toolConfig: { tools: [{ toolSpec: { name: 'b' } }] }, messages: recorded.messages, inferenceConfig: { maxTokens: 512 } });
  });

  it('OpenAI Chat Completions: the system and developer messages the conversation starts with', () => {
    const recorded = { model: 'gpt-5', messages: [{ role: 'system', content: 'Old.' }, { role: 'user', content: 'hi' }, { role: 'system', content: 'A reminder at step 3.' }, { role: 'assistant', content: 'ok' }], tools: [{ type: 'function', function: { name: 'a' } }] };
    const code = { model: 'gpt-5', messages: [{ role: 'developer', content: 'New.' }, { role: 'system', content: 'Also.' }, { role: 'user', content: 'other' }], tools: [] };
    const swapped = withPrompt(recorded, promptOf(code)) as { messages: unknown[]; tools: unknown[] };
    expect(swapped.messages).toEqual([{ role: 'developer', content: 'New.' }, { role: 'system', content: 'Also.' }, { role: 'user', content: 'hi' }, { role: 'system', content: 'A reminder at step 3.' }, { role: 'assistant', content: 'ok' }]);
    expect(swapped.tools).toEqual([]);
  });

  it('OpenAI Responses: instructions, and instruction items in input', () => {
    const recorded = { model: 'gpt-5', instructions: 'Old.', input: [{ role: 'user', content: 'hi' }], tools: [] };
    const swapped = withPrompt(recorded, promptOf({ instructions: 'New.', input: [{ role: 'developer', content: 'Be brief.' }, { role: 'user', content: 'x' }], tools: [{ type: 'function', name: 'f' }] }));
    expect(swapped).toEqual({ model: 'gpt-5', instructions: 'New.', input: [{ role: 'developer', content: 'Be brief.' }, { role: 'user', content: 'hi' }], tools: [{ type: 'function', name: 'f' }] });
    // A prompt the new code no longer sends is left out.
    expect(withPrompt(recorded, promptOf({ input: [] }))).toEqual({ model: 'gpt-5', input: [{ role: 'user', content: 'hi' }] });
  });

  it('Gemini: systemInstruction, tools and toolConfig, in either spelling', () => {
    const recorded = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], systemInstruction: { parts: [{ text: 'Old.' }] }, generationConfig: { temperature: 0 } };
    const swapped = withPrompt(recorded, promptOf({ system_instruction: { parts: [{ text: 'New.' }] }, tools: [{ functionDeclarations: [{ name: 'f' }] }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } }, contents: [] }));
    expect(swapped).toEqual({ contents: recorded.contents, generationConfig: { temperature: 0 }, system_instruction: { parts: [{ text: 'New.' }] }, tools: [{ functionDeclarations: [{ name: 'f' }] }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } });
  });

  it('tells a changed prompt from one that moved only a cache breakpoint', () => {
    const a = promptOf({ system: [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }], tools: [{ name: 't' }] });
    const b = promptOf({ system: [{ type: 'text', text: 'S' }], tools: [{ name: 't' }] });
    expect(samePrompt(a, b)).toBe(true);
    expect(samePrompt(a, promptOf({ system: 'S2', tools: [{ name: 't' }] }))).toBe(false);
    expect(promptParts(promptOf({ system: [{ type: 'text', text: 'You are a research agent.' }], tools: [{ name: 'search_web' }, { type: 'function', function: { name: 'f' } }, { functionDeclarations: [{ name: 'g' }] }] }))).toEqual({ instructions: 'You are a research agent.', tools: ['search_web', 'f', 'g'] });
  });
});

describe('withoutEarlierThinking', () => {
  it("takes out Anthropic's thinking blocks from earlier assistant turns, keeping a turn that holds nothing else", () => {
    const body = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'redacted_thinking', data: 'x' }, { type: 'tool_use', id: '1', name: 'a', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'r' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'only', signature: 's' }] },
      ],
    };
    const { body: out, removed } = withoutEarlierThinking(body);
    expect(removed).toBe(2);
    expect((out as typeof body).messages[1]).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'a', input: {} }] });
    expect((out as typeof body).messages[3]).toEqual(body.messages[3]);
  });

  it('takes out Converse reasoning, Responses reasoning items, Chat reasoning_content and Gemini thought parts', () => {
    expect(withoutEarlierThinking({ messages: [{ role: 'assistant', content: [{ reasoningContent: { reasoningText: { text: 'r' } } }, { text: 'a' }] }] })).toEqual({ body: { messages: [{ role: 'assistant', content: [{ text: 'a' }] }] }, removed: 1 });
    expect(withoutEarlierThinking({ input: [{ role: 'user', content: 'hi' }, { type: 'reasoning', encrypted_content: 'e' }, { type: 'function_call', name: 'f' }] })).toEqual({ body: { input: [{ role: 'user', content: 'hi' }, { type: 'function_call', name: 'f' }] }, removed: 1 });
    expect(withoutEarlierThinking({ messages: [{ role: 'assistant', content: 'a', reasoning_content: 'r' }] })).toEqual({ body: { messages: [{ role: 'assistant', content: 'a' }] }, removed: 1 });
    const gemini = { contents: [{ role: 'model', parts: [{ text: 'thinking', thought: true }, { functionCall: { name: 'f', args: {} }, thoughtSignature: 'sig' }] }] };
    expect(withoutEarlierThinking(gemini)).toEqual({ body: { contents: [{ role: 'model', parts: [{ functionCall: { name: 'f', args: {} }, thoughtSignature: 'sig' }] }] }, removed: 1 });
  });

  it('keeps the last assistant turn its thinking in manual mode, which requires that turn to begin with it', () => {
    const turn = (n: number) => ({ role: 'assistant', content: [{ type: 'thinking', thinking: `t${n}`, signature: `s${n}` }, { type: 'tool_use', id: `${n}`, name: 'a', input: {} }] });
    const result = (n: number) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `${n}`, content: 'r' }] });
    const body = { model: 'claude-sonnet-4-5', thinking: { type: 'enabled', budget_tokens: 1024 }, messages: [{ role: 'user', content: 'hi' }, turn(1), result(1), turn(2), result(2)] };
    const { body: out, removed } = withoutEarlierThinking(body);
    expect(removed).toBe(1);
    expect((out as typeof body).messages[1].content).toEqual([{ type: 'tool_use', id: '1', name: 'a', input: {} }]);
    expect((out as typeof body).messages[3]).toEqual(turn(2));
    // Claude through Converse takes the budget in its model fields; adaptive thinking has no such rule.
    const converse = { additionalModelRequestFields: { thinking: { type: 'enabled', budget_tokens: 1024 } }, messages: [{ role: 'assistant', content: [{ reasoningContent: { reasoningText: { text: 'r' } } }, { text: 'a' }] }] };
    expect(withoutEarlierThinking(converse)).toEqual({ body: converse, removed: 0 });
    expect(withoutEarlierThinking({ ...body, thinking: { type: 'adaptive' } }).removed).toBe(2);
  });

  it("sends a Responses item that followed the reasoning taken out by its content, not by the stored item's id", () => {
    const body = { input: [{ role: 'user', content: 'hi' }, { id: 'rs_1', type: 'reasoning', encrypted_content: 'e' }, { id: 'fc_1', type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: 'ok' }, { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }] };
    expect(withoutEarlierThinking(body).body).toEqual({ input: [{ role: 'user', content: 'hi' }, { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: 'ok' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }] });
  });

  it('leaves a request without reasoning as it is', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] };
    expect(withoutEarlierThinking(body)).toEqual({ body, removed: 0 });
  });
});
