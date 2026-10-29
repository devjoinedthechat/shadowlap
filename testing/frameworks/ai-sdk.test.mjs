// The Vercel AI SDK: generateText with its own mock model, tools wrapped by withEffects, run through
// the SDK's real tool loop (input parsing, execute(input, options), tool-result parts).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { generateText, stepCountIs, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { withEffects } from '../../packages/adapters/dist/ai-sdk.js';
import { startHarness, toolTrace } from './harness.mjs';

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

/** Step 1: search. Step 2: email, once the results are in. Step 3: done. The query comes from the scenario. */
function model(query) {
  let step = 0;
  const call = (id, toolName, input) => ({ content: [{ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) }], finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage, warnings: [] });
  return new MockLanguageModelV4({
    doGenerate: async () => {
      step++;
      if (step === 1) return call('call_1', 'search_web', { query });
      if (step === 2) return call('call_2', 'send_email', { to: 'team@example.com' });
      return { content: [{ type: 'text', text: 'Done.' }], finishReason: { unified: 'stop', raw: 'end_turn' }, usage, warnings: [] };
    },
  });
}
const toolOutputs = (result) => result.steps.flatMap((s) => s.content.filter((p) => p.type === 'tool-result').map((p) => p.output));

describe('Vercel AI SDK (ai) with @shadowlap/adapters/ai-sdk', () => {
  let h;
  const executed = [];
  before(async () => (h = await startHarness()));
  after(() => h.close());

  const tools = () =>
    withEffects(
      {
        search_web: tool({
          description: 'Search the web',
          inputSchema: z.object({ query: z.string() }),
          execute: async ({ query }, options) => {
            executed.push('search_web');
            assert.equal(typeof options.toolCallId, 'string'); // the options object still reaches the implementation
            return { results: [`${query} #1`] };
          },
        }),
        send_email: tool({
          description: 'Send an email',
          inputSchema: z.object({ to: z.string() }),
          execute: async ({ to }) => {
            executed.push('send_email');
            return { sent: true, to };
          },
        }),
      },
      { search_web: 'read', send_email: 'write' },
    );

  const agent = (query) => generateText({ model: model(query), tools: tools(), prompt: 'Research and email the team.', stopWhen: stepCountIs(4) });

  let recorded;
  it('records both tool calls through generateText', async () => {
    recorded = await h.record(() => agent('shadowlap'));
    assert.equal(recorded.error, undefined, recorded.error?.stack);
    assert.deepEqual(executed, ['search_web', 'send_email']);
    assert.deepEqual(toolTrace(recorded.calls), ['search_web:read:live:ok', 'send_email:write:live:ok']);
    assert.equal(recorded.value.text, 'Done.');
    assert.deepEqual(toolOutputs(recorded.value), [{ results: ['shadowlap #1'] }, { sent: true, to: 'team@example.com' }]);
    // Only the input is recorded: the SDK's options object (tool call id, messages, abort signal) is not.
    const req = h.store.getJson(recorded.calls.find((c) => c.name === 'search_web').requestRef);
    assert.deepEqual(req, { args: { query: 'shadowlap' } });
  });

  it('replays both from the recording without executing them', async () => {
    executed.length = 0;
    const replay = await h.replay(recorded, () => agent('shadowlap'));
    assert.equal(replay.error, undefined, replay.error?.stack);
    assert.deepEqual(executed, []);
    assert.equal(replay.summary.divergence, null);
    assert.deepEqual(toolOutputs(replay.value), [{ results: ['shadowlap #1'] }, { sent: true, to: 'team@example.com' }]);
  });

  it('forks on changed input and blocks the email; the SDK surfaces it as a tool error', async () => {
    executed.length = 0;
    const fork = await h.replay(recorded, () => agent('replay'));
    assert.equal(fork.error, undefined, fork.error?.stack);
    assert.deepEqual(executed, ['search_web']);
    assert.equal(fork.summary.divergence?.name, 'search_web');
    assert.deepEqual(toolTrace(fork.calls), ['search_web:read:live:ok', 'send_email:write:blocked:error']);
    const errors = fork.value.steps.flatMap((s) => s.content.filter((p) => p.type === 'tool-error'));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].toolName, 'send_email');
    assert.match(String(errors[0].error?.message ?? errors[0].error), /blocked/);
  });
});

/** Asks for the weather in Oslo once, then answers. */
function weatherModel() {
  let step = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      step++;
      if (step === 1) return { content: [{ type: 'tool-call', toolCallId: 'call_w', toolName: 'weather', input: JSON.stringify({ city: 'Oslo' }) }], finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage, warnings: [] };
      return { content: [{ type: 'text', text: 'Cold.' }], finishReason: { unified: 'stop', raw: 'end_turn' }, usage, warnings: [] };
    },
  });
}
const ask = (tools) => generateText({ model: weatherModel(), tools, prompt: 'Weather in Oslo?', stopWhen: stepCountIs(3) });

describe('a changed tool behind withEffects', () => {
  let h;
  before(async () => (h = await startHarness()));
  after(() => h.close());

  it('warns on replay when the tool\'s execute changed since the recording', async () => {
    const policy = (execute) => withEffects({ weather: tool({ description: 'Weather', inputSchema: z.object({ city: z.string() }), execute }) }, { weather: 'read' });
    const recorded = await h.record(() => ask(policy(async ({ city }) => ({ city, tempC: 7 }))));
    assert.equal(recorded.error, undefined, recorded.error?.stack);
    const same = await h.replay(recorded, () => ask(policy(async ({ city }) => ({ city, tempC: 7 }))));
    assert.deepEqual(same.summary.warnings, []);
    const changed = await h.replay(recorded, () => ask(policy(async ({ city }) => ({ city, tempC: 7, feelsLikeC: 3 }))));
    assert.ok(changed.summary.warnings.includes('weather changed since the recording; pass --live-tool weather to run it live'), changed.summary.warnings.join('\n'));
  });
});

describe('Vercel AI SDK streaming tools (async *execute) with withEffects', () => {
  let h;
  before(async () => (h = await startHarness()));
  after(() => h.close());

  let runs = 0;
  const weather = () =>
    tool({
      description: 'The weather in a city',
      inputSchema: z.object({ city: z.string() }),
      async *execute({ city }) {
        runs++;
        yield { status: 'loading' };
        yield { status: 'done', city, tempC: 7 };
      },
    });
  const shown = (result) => result.steps.flatMap((s) => s.content.filter((p) => p.type === 'tool-result' && !p.preliminary).map((p) => p.output));

  it('shows the model the stream\'s final value in production, as the bare tool does', async () => {
    const saved = process.env.SHADOWLAP_URL;
    delete process.env.SHADOWLAP_URL;
    try {
      const bare = await ask({ weather: weather() });
      const wrapped = await ask(withEffects({ weather: weather() }, { weather: 'read' }));
      assert.deepEqual(shown(bare), [{ status: 'done', city: 'Oslo', tempC: 7 }]);
      assert.deepEqual(shown(wrapped), shown(bare));
    } finally {
      if (saved !== undefined) process.env.SHADOWLAP_URL = saved;
    }
  });

  it('records every value it yields, and replays them without running the tool', async () => {
    runs = 0;
    const recorded = await h.record(() => ask(withEffects({ weather: weather() }, { weather: 'read' })));
    assert.equal(recorded.error, undefined, recorded.error?.stack);
    assert.deepEqual(toolTrace(recorded.calls), ['weather:read:live:ok']);
    assert.deepEqual(shown(recorded.value), [{ status: 'done', city: 'Oslo', tempC: 7 }]);
    const call = recorded.calls.find((c) => c.name === 'weather');
    // Every value in order, the preliminary one too, so a replay yields them again (sdk.md, streaming tools).
    assert.deepEqual(h.store.getJson(call.end.responseRef), { result: { shadowlap_stream: [{ status: 'loading' }, { status: 'done', city: 'Oslo', tempC: 7 }] } });
    assert.equal(runs, 1);

    const replay = await h.replay(recorded, () => ask(withEffects({ weather: weather() }, { weather: 'read' })));
    assert.equal(replay.error, undefined, replay.error?.stack);
    assert.equal(replay.summary.divergence, null);
    assert.deepEqual(shown(replay.value), [{ status: 'done', city: 'Oslo', tempC: 7 }]);
    assert.equal(runs, 1);
  });
});
