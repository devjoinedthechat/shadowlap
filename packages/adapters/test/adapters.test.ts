import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { ShadowlapWriteBlocked } from '@shadowlap/sdk';
import { withEffects } from '../src/ai-sdk.js';
import { withEffect as withAnthropicEffect } from '../src/anthropic.js';
import { withEffect as withLangChainEffect } from '../src/langchain.js';
import { withEffect as withMastraEffect, withEffectV0 as withMastraEffectV0 } from '../src/mastra.js';
import { withEffect as withOpenAIAgentsEffect } from '../src/openai-agents.js';

/**
 * Framework-shaped fakes: the adapters type the shapes structurally, so these exercise exactly
 * what the real frameworks hand them, without installing the frameworks.
 */

let store: Store;
let sidecar: Sidecar;
const executed: string[] = [];

function activate(runId: string) {
  process.env.SHADOWLAP_URL = sidecar.url;
  process.env.SHADOWLAP_RUN_ID = runId;
}
function deactivate() {
  delete process.env.SHADOWLAP_URL;
  delete process.env.SHADOWLAP_RUN_ID;
}

beforeAll(async () => {
  store = Store.open(':memory:');
  sidecar = await Sidecar.start({ store });
});
afterAll(async () => {
  deactivate();
  await sidecar.close();
  store.close();
});

// A pretend agent using every adapter once.
function buildTools() {
  const abort = new AbortController();
  const aiTools = withEffects(
    {
      search_web: {
        execute: async (input: unknown, options: unknown) => {
          executed.push('search_web');
          return { results: [`${(input as { query: string }).query} #1`], signalSeen: (options as { abortSignal?: AbortSignal }).abortSignal === abort.signal };
        },
      },
      client_only: {},
    },
    { search_web: 'read', client_only: 'pure' },
  );
  const openaiTool = withOpenAIAgentsEffect(
    {
      name: 'fetch_page',
      execute: async (input: unknown, context: unknown) => {
        executed.push('fetch_page');
        return { url: (input as { url: string }).url, hasContext: context !== undefined };
      },
    },
    'read',
  );
  const mastraTool = withMastraEffect(
    {
      id: 'read_file',
      execute: async (input: { path: string }, context: { requestContext?: unknown }) => {
        executed.push('read_file');
        return { path: input.path, runtime: context?.requestContext !== undefined };
      },
    },
    'pure',
  );
  const anthropicTool = withAnthropicEffect(
    {
      name: 'send_email',
      run: async (input: unknown) => {
        executed.push('send_email');
        return { sent: true, to: (input as { to: string }).to };
      },
    },
    { effect: 'write', onFork: () => ({ sent: false, suppressed: true }) },
  );
  // The shape of a @langchain/core tool: invoke unwraps a ToolCall and calls _call with the parsed arguments.
  const lcInstance = {
    name: 'lookup',
    async _call(args: unknown, _runManager?: unknown, config?: unknown) {
      executed.push('lookup');
      return { found: (args as { id: string }).id, config: config !== undefined };
    },
    async invoke(input: unknown, config?: unknown) {
      const args = (input as { type?: string }).type === 'tool_call' ? (input as { args: unknown }).args : input;
      return this._call(args, undefined, config);
    },
  };
  const lcTool = withLangChainEffect(lcInstance, 'read');
  return { abort, aiTools, openaiTool, mastraTool, anthropicTool, lcTool };
}

async function runAgent(tools: ReturnType<typeof buildTools>) {
  const out: Record<string, unknown> = {};
  out.search = await tools.aiTools.search_web.execute({ query: 'replay' }, { abortSignal: tools.abort.signal, toolCallId: 'x' });
  out.page = await tools.openaiTool.execute({ url: 'https://example.com/a' }, { runContext: {} });
  out.file = await tools.mastraTool.execute({ path: 'notes.md' }, { requestContext: {} });
  out.lookup = await tools.lcTool.invoke({ type: 'tool_call', name: 'lookup', args: { id: '42' }, id: 'call_random_1' }, { tags: [] });
  try {
    out.email = await tools.anthropicTool.run({ to: 'team@example.com' });
  } catch (err) {
    out.email = err instanceof ShadowlapWriteBlocked ? 'blocked' : String(err);
  }
  return out;
}

describe('framework adapters', () => {
  let recording: string;
  let recorded: Record<string, unknown>;

  it('are passthroughs when Shadowlap is inactive', async () => {
    deactivate();
    executed.length = 0;
    const out = await runAgent(buildTools());
    expect(executed).toEqual(['search_web', 'fetch_page', 'read_file', 'lookup', 'send_email']);
    expect(out.search).toMatchObject({ signalSeen: true });
    expect(out.email).toEqual({ sent: true, to: 'team@example.com' });
  });

  it('record only the input, with framework context passed through', async () => {
    const run = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
    activate(run.runId);
    executed.length = 0;
    recorded = await runAgent(buildTools());
    sidecar.endRun(run.runId, 'completed');
    recording = run.runId;
    expect(executed).toHaveLength(5);
    expect(recorded.search).toMatchObject({ signalSeen: true });
    expect(recorded.page).toMatchObject({ hasContext: true });
    expect(recorded.file).toMatchObject({ runtime: true });
    expect(recorded.lookup).toMatchObject({ config: true });

    const calls = store.getCalls(run.runId);
    expect(calls.map((c) => [c.name, c.effect])).toEqual([
      ['search_web', 'read'],
      ['fetch_page', 'read'],
      ['read_file', 'pure'],
      ['lookup', 'read'],
      ['send_email', 'write'],
    ]);
    const args = calls.map((c) => store.getJson<{ args: unknown }>(c.requestRef!)!.args);
    expect(args).toEqual([{ query: 'replay' }, { url: 'https://example.com/a' }, { path: 'notes.md' }, { id: '42' }, { to: 'team@example.com' }]);
    expect(JSON.stringify(args)).not.toContain('call_random_1'); // the ToolCall id is not part of the identity
  });

  it('replay without executing, and fence the write after a fork', async () => {
    const replay = sidecar.startRun({ mode: 'replay', parentRunId: recording, command: { argv: ['agent'], cwd: '.' } });
    activate(replay.runId);
    executed.length = 0;
    const out = await runAgent(buildTools());
    const { summary } = sidecar.endRun(replay.runId, 'completed');
    expect(summary.divergence).toBeNull();
    expect(executed).toEqual([]);
    expect(out.search).toMatchObject({ results: ['replay #1'] });
    expect(out.email).toEqual({ sent: true, to: 'team@example.com' }); // the recorded result, not a new send

    // A changed query diverges at the first call; the write is then blocked.
    const fork = sidecar.startRun({ mode: 'replay', parentRunId: recording, command: { argv: ['agent'], cwd: '.' } });
    activate(fork.runId);
    executed.length = 0;
    const tools = buildTools();
    await tools.aiTools.search_web.execute({ query: 'different' }, { abortSignal: tools.abort.signal });
    let email: unknown;
    try {
      email = await tools.anthropicTool.run({ to: 'team@example.com' });
    } catch (err) {
      email = err instanceof ShadowlapWriteBlocked ? 'blocked' : err;
    }
    const forked = sidecar.endRun(fork.runId, 'completed').summary;
    expect(forked.divergence?.type).toBe('request_changed');
    expect(email).toBe('blocked');
    expect(executed).toEqual(['search_web']);

    // With --writes stub the onFork value comes back.
    const stubbed = sidecar.startRun({ mode: 'replay', parentRunId: recording, command: { argv: ['agent'], cwd: '.' }, replay: { writes: 'stub' } });
    activate(stubbed.runId);
    const t2 = buildTools();
    await t2.aiTools.search_web.execute({ query: 'different' }, {});
    expect(await t2.anthropicTool.run({ to: 'team@example.com' })).toEqual({ sent: false, suppressed: true });
    sidecar.endRun(stubbed.runId, 'completed');
    deactivate();
  });

  it('record a Mastra tool an agent calls under its key in the agent’s tools, and one called elsewhere under its id', async () => {
    const def = withMastraEffect({ id: 'get-weather', execute: async (input: { city: string }, _context?: unknown) => ({ city: input.city, sky: 'clear' }) }, 'read');
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
    activate(rec.runId);
    // As Mastra's tool builder passes it for an agent's call: the agent's handles, and a writer named by the key.
    await def.execute({ city: 'Oslo' }, { agent: { agentId: 'weather', toolCallId: 'call_1', messages: [] }, writer: { name: 'weatherTool' } });
    // A workflow step, or your own code: no agent, so the id.
    await def.execute({ city: 'Bergen' }, { workflow: { workflowId: 'w' }, writer: { name: 'step' } });
    await def.execute({ city: 'Tromsø' });
    sidecar.endRun(rec.runId, 'completed');
    expect(store.getCalls(rec.runId).map((c) => c.name)).toEqual(['weatherTool', 'get-weather', 'get-weather']);
    deactivate();
  });

  it('support the Mastra 0.x execute({ context }) shape with withEffectV0', async () => {
    const def = withMastraEffectV0(
      {
        id: 'legacy_read',
        execute: async ({ context, runtimeContext }: { context: unknown; runtimeContext?: unknown }) => {
          executed.push('legacy_read');
          return { path: (context as { path: string }).path, runtime: runtimeContext !== undefined };
        },
      },
      'read',
    );
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
    activate(rec.runId);
    executed.length = 0;
    expect(await def.execute({ context: { path: 'a.md' }, runtimeContext: {} })).toEqual({ path: 'a.md', runtime: true });
    sidecar.endRun(rec.runId, 'completed');
    expect(store.getJson<{ args: unknown }>(store.getCalls(rec.runId)[0].requestRef!)).toEqual({ args: { path: 'a.md' } });
    const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '.' } });
    activate(rep.runId);
    executed.length = 0;
    expect(await def.execute({ context: { path: 'a.md' }, runtimeContext: {} })).toEqual({ path: 'a.md', runtime: true });
    expect(sidecar.endRun(rep.runId, 'completed').summary.divergence).toBeNull();
    expect(executed).toEqual([]);
    deactivate();
  });

  it('name an OpenAI Agents tool as tool() names it to the model, from its name or its function', async () => {
    const spaced = withOpenAIAgentsEffect({ name: 'lookup order', execute: async (input: unknown) => input }, 'read');
    const unnamed = withOpenAIAgentsEffect({ execute: async function refund_order(input: unknown) { return input; } }, 'write');
    // tool() takes the name from the definition: the wrapper's function has none to fall back on.
    expect([spaced.name, unnamed.name]).toEqual(['lookup_order', 'refund_order']);
    const [anonymous] = [async () => 1]; // a function with no name, which tool() refuses too
    expect(() => withOpenAIAgentsEffect({ execute: anonymous }, 'read')).toThrow(/has no name/);
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
    activate(rec.runId);
    await spaced.execute({ order_id: 'A-1' });
    await unnamed.execute({ order_id: 'A-1' });
    sidecar.endRun(rec.runId, 'completed');
    deactivate();
    expect(store.getCalls(rec.runId).map((c) => c.name)).toEqual(['lookup_order', 'refund_order']);
  });

  it('refuse something that is not a LangChain tool', () => {
    expect(() => withLangChainEffect({ name: 'x', invoke: async () => 1 } as never, 'read')).toThrow(/not a LangChain tool/);
  });

  it('require an effect for every executable tool', () => {
    expect(() => withEffects({ a: { execute: async () => 1 }, b: { execute: async () => 2 } }, { a: 'read' } as never)).toThrow(/missing for b/);
    expect(() => withOpenAIAgentsEffect({ name: 'x', execute: async () => 1 }, 'sometimes' as never)).toThrow(/effect must be/);
  });
});
