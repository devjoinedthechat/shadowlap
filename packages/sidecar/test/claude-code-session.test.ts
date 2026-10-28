import { randomBytes, randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromClaudeCode, loadApiRequest, Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { Sidecar } from '../src/index.js';

/**
 * A model call Claude Code makes carries its session, machine and account in `metadata.user_id`, new
 * in every session. A recording of it replays clean in the next session and on another machine, with
 * no normalizer configured; another agent's user_id still counts.
 */
let mock: MockServer;
beforeAll(async () => {
  mock = await startMockAnthropic({ script: () => ({ message: message([text('done')]) }) });
});
afterAll(() => mock.close());

/** The identifier Claude Code sends, for a fresh session on `device`. */
const claudeCode = (device: string) => JSON.stringify({ device_id: device, account_uuid: '', session_id: randomUUID() });

/** One model call as Claude Code makes it (its headers too), in `runId`, and the run's summary. */
async function ask(sidecar: Sidecar, runId: string, userId: string, system = "You are Claude Code, Anthropic's official CLI for Claude.") {
  const client = new Anthropic({
    apiKey: 'k',
    baseURL: sidecar.envFor(runId).ANTHROPIC_BASE_URL,
    maxRetries: 0,
    defaultHeaders: { 'user-agent': 'claude-cli/2.1.309 (external, sdk-ts)', 'x-app': 'cli', 'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14' },
  });
  await client.messages.create({ model: 'claude-opus-5', max_tokens: 64, system, messages: [{ role: 'user', content: 'Fix the failing test.' }], metadata: { user_id: userId } });
  return sidecar.endRun(runId, 'completed').summary;
}

describe('a Claude Code session in metadata.user_id', () => {
  it('replays from the recording in a new session on another machine, with no normalizer', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
    try {
      const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
      await ask(sidecar, rec.runId, claudeCode(randomBytes(32).toString('hex')));
      const sent = mock.requests.length;
      const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '.' } });
      const summary = await ask(sidecar, rep.runId, claudeCode(randomBytes(32).toString('hex')));
      expect(summary.divergence).toBeNull();
      expect(summary.byOrigin.replayed).toBe(1);
      expect(mock.requests.length).toBe(sent);
      // Stored as sent: the mask is matching's alone.
      const [call] = store.getCalls(rep.runId);
      expect((loadApiRequest(store, call.requestRef!) as { metadata: { user_id: string } }).metadata.user_id).toMatch(/"session_id":"[0-9a-f-]{36}"/);
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('is no change a fork reports, when the prompt changed as well: no hint to mask it', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
    try {
      const device = randomBytes(32).toString('hex');
      const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
      await ask(sidecar, rec.runId, claudeCode(device));
      const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '.' } });
      const { divergence } = await ask(sidecar, rep.runId, claudeCode(device), 'You are Claude Code, terse.');
      expect(divergence).toMatchObject({ type: 'request_changed', callNo: 1 });
      expect(divergence!.diff!.map((e) => e.path)).toContain('$.system');
      expect((divergence!.hints ?? []).filter((h) => h.normalizer?.path === '$.metadata.user_id')).toEqual([]);
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it("keeps on the run that its model calls came with Claude Code's user agent, which tells its built-ins apart", async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
    let open = true;
    try {
      // Claude Code's user agent, with a user_id that is no session of Claude Code's: the user agent says it.
      const cc = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
      await ask(sidecar, cc.runId, randomUUID());
      // Another agent on the same SDK, which sends its own user agent.
      const plain = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
      const client = new Anthropic({ apiKey: 'k', baseURL: sidecar.envFor(plain.runId).ANTHROPIC_BASE_URL, maxRetries: 0 });
      await client.messages.create({ model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: 'Fix the failing test.' }], metadata: { user_id: randomUUID() } });
      sidecar.endRun(plain.runId, 'completed');
      await sidecar.close();
      open = false;
      expect(store.getRun(cc.runId)?.meta?.claudeCode).toBe(true);
      expect(fromClaudeCode(store, cc.runId)).toBe(true);
      expect(store.getRun(plain.runId)?.meta?.claudeCode).toBeUndefined();
      expect(fromClaudeCode(store, plain.runId)).toBe(false);
    } finally {
      if (open) await sidecar.close();
      store.close();
    }
  });

  it("leaves another agent's user_id to count: a new UUID each run diverges", async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
    try {
      const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
      await ask(sidecar, rec.runId, randomUUID());
      const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '.' } });
      const { divergence } = await ask(sidecar, rep.runId, randomUUID());
      expect(divergence).toMatchObject({ type: 'request_changed', callNo: 1 });
      expect(divergence!.diff!.map((e) => e.path)).toEqual(['$.metadata.user_id']);
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});
