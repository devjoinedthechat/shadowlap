import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { proposeNormalizers, Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { Sidecar } from '../src/index.js';

/**
 * A model call whose only change is a header its fingerprint includes forks, as documented, and the
 * report says which header changed instead of an empty diff.
 */
let mock: MockServer;
beforeAll(async () => {
  mock = await startMockAnthropic({ script: () => ({ message: message([text('ok')]) }) });
});
afterAll(() => mock.close());

describe('a changed fingerprinted header', () => {
  it('shows in the divergence report, and calibrate names it instead of proposing a rule', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
    const call = async (runId: string, beta: string) => {
      const client = new Anthropic({ apiKey: 'k', baseURL: sidecar.envFor(runId).ANTHROPIC_BASE_URL, maxRetries: 0, defaultHeaders: { 'anthropic-beta': beta } });
      await client.messages.create({ model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] });
      return sidecar.endRun(runId, 'completed').summary;
    };
    try {
      const rec = sidecar.startRun({ mode: 'record', command: { argv: ['a'], cwd: '.' } });
      await call(rec.runId, 'token-efficient-tools-2025-02-19');
      const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['a'], cwd: '.' } });
      const { divergence } = await call(rep.runId, 'interleaved-thinking-2025-05-14');
      expect(divergence).toMatchObject({ type: 'request_changed', callNo: 1 });
      expect(divergence!.diff).toEqual([{ path: 'headers.anthropic-beta', op: 'changed', before: 'token-efficient-tools-2025-02-19', after: 'interleaved-thinking-2025-05-14' }]);
      expect(divergence!.hints?.map((h) => h.message).join('\n')).toMatch(/anthropic-beta header is part of what makes a model call the same call/);
      expect(divergence!.hints?.some((h) => h.normalizer)).toBeFalsy();
      expect(store.getRun(rep.runId)!.divergence!.diff).toHaveLength(1);
      const step = proposeNormalizers(divergence!);
      expect(step.proposals).toEqual([]);
      expect(step.unexplained.map((e) => e.path)).toEqual(['headers.anthropic-beta']);
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});
