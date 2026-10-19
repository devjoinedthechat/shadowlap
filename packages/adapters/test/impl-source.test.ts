import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { withEffects } from '../src/ai-sdk.js';
import { withEffect as withAnthropicEffect } from '../src/anthropic.js';
import { withEffect as withLangChainEffect } from '../src/langchain.js';
import { withEffect as withMastraEffect, withEffectV0 as withMastraEffectV0 } from '../src/mastra.js';
import { withEffect as withOpenAIAgentsEffect } from '../src/openai-agents.js';

/**
 * The adapters wrap the function they are given, and their wrapper reads the same for every tool. A
 * replay compares the hash of the tool's source with the recording's to warn that the tool changed,
 * so the hash must be the given function's.
 */

let store: Store;
let sidecar: Sidecar;

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

const sha = (fn: unknown) => createHash('sha256').update(String(fn)).digest('hex');

type Impl = (input: unknown, ...rest: unknown[]) => Promise<{ policy: string }>;
/** One tool through one adapter, its implementation the function given, called as the framework would. */
type Adapter = (impl: Impl) => (input: { id: string }) => Promise<unknown>;

const adapters: Record<string, Adapter> = {
  'ai-sdk': (impl) => {
    const tools = withEffects({ read_policy: { execute: impl } }, { read_policy: 'read' });
    return (input) => tools.read_policy.execute!(input, { toolCallId: 'c1' }) as Promise<unknown>;
  },
  'openai-agents': (impl) => {
    const def = withOpenAIAgentsEffect({ name: 'read_policy', execute: impl }, 'read');
    return (input) => def.execute(input, {}) as Promise<unknown>;
  },
  mastra: (impl) => {
    const def = withMastraEffect({ id: 'read_policy', execute: impl as (input: never) => unknown }, 'read');
    return (input) => (def.execute as Impl)(input, {});
  },
  'mastra 0.x': (impl) => {
    const def = withMastraEffectV0({ id: 'read_policy', execute: impl }, 'read');
    return (input) => def.execute!({ context: input }) as Promise<unknown>;
  },
  anthropic: (impl) => {
    const def = withAnthropicEffect({ name: 'read_policy', run: impl }, 'read');
    return (input) => def.run(input) as Promise<unknown>;
  },
  // @langchain/core's tool(): a DynamicStructuredTool keeps the function in `func`, and its _call calls it.
  langchain: (impl) => {
    const instance = {
      name: 'read_policy',
      func: impl,
      async _call(this: { func: Impl }, input: unknown) {
        return this.func(input);
      },
    };
    const wrapped = withLangChainEffect(instance, 'read');
    return (input) => (wrapped as unknown as { _call: (i: unknown) => Promise<unknown> })._call(input);
  },
  // A StructuredTool subclass: its own _call is the tool.
  'langchain subclass': (impl) => {
    const wrapped = withLangChainEffect({ name: 'read_policy', _call: impl }, 'read');
    return (input) => (wrapped as unknown as { _call: (i: unknown) => Promise<unknown> })._call(input);
  },
};

describe('a tool changed since its recording', () => {
  for (const [adapter, wrap] of Object.entries(adapters)) {
    it(`${adapter}: is hashed by the function given, and the replay warns when it changed`, async () => {
      const v1: Impl = async (_input) => ({ policy: 'v1' });
      const v2: Impl = async (_input) => ({ policy: 'v2, refunds within 30 days' });
      const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
      activate(rec.runId);
      expect(await wrap(v1)({ id: 'p1' })).toEqual({ policy: 'v1' });
      sidecar.endRun(rec.runId, 'completed');
      const hash = store.getCalls(rec.runId)[0]!.meta.implHash;
      // The adapters' own wrappers are the same for every tool; the user's function is not.
      expect(hash).toBe(sha(v1));

      const same = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '.' } });
      activate(same.runId);
      await wrap(v1)({ id: 'p1' });
      expect(sidecar.endRun(same.runId, 'completed').summary.warnings).toEqual([]);

      const changed = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '.' } });
      activate(changed.runId);
      expect(await wrap(v2)({ id: 'p1' })).toEqual({ policy: 'v1' });
      const { summary } = sidecar.endRun(changed.runId, 'completed');
      expect(summary.warnings).toContain('read_policy changed since the recording; pass --live-tool read_policy to run it live');
      deactivate();
    });
  }
});
