import Anthropic from '@anthropic-ai/sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { proposeNormalizers, Store } from '@shadowlap/engine';
import { now, tool } from '@shadowlap/sdk';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { Sidecar } from '../src/index.js';

/**
 * A recording made on one day, replayed on another: "today" in the prompt differs, and must still
 * match. Only Date is faked, so the network keeps working.
 */
let mock: MockServer;
beforeAll(async () => {
  mock = await startMockAnthropic({ script: (ctx) => ({ message: message([text(`turn ${ctx.assistantTurns}`)]) }) });
});
afterAll(() => mock.close());
afterEach(() => vi.useRealTimers());

const day = (iso: string) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
};

async function run(sidecar: Sidecar, runId: string, system: string) {
  const client = new Anthropic({ apiKey: 'k', baseURL: sidecar.envFor(runId).ANTHROPIC_BASE_URL, maxRetries: 0 });
  await client.messages.create({ model: 'claude-opus-5', max_tokens: 16, system, messages: [{ role: 'user', content: `triage, requested at ${Date.now()}` }] }).catch(() => undefined);
  return sidecar.endRun(runId, 'completed').summary;
}

describe('dates near a run start match across days', () => {
  it('replays a recording from June in September, and still forks on a date that really changed', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
    day('2026-06-01T09:00:00Z');
    const recorded = sidecar.startRun({ mode: 'record', command: { argv: ['a'], cwd: '.' } });
    await run(sidecar, recorded.runId, 'Today is Monday, June 1, 2026 (2026-06-01). Report on sales since 2026-05-01.');

    day('2026-09-17T15:00:00Z');
    const hits = mock.requests.length;
    const same = sidecar.startRun({ mode: 'replay', parentRunId: recorded.runId, command: { argv: ['a'], cwd: '.' } });
    const clean = await run(sidecar, same.runId, 'Today is Thursday, September 17, 2026 (2026-09-17). Report on sales since 2026-05-01.');
    expect(clean.divergence).toBeNull();
    expect(mock.requests.length).toBe(hits);

    const changed = sidecar.startRun({ mode: 'replay', parentRunId: recorded.runId, command: { argv: ['a'], cwd: '.' } });
    const forked = await run(sidecar, changed.runId, 'Today is Thursday, September 17, 2026 (2026-09-17). Report on sales since 2026-08-01.');
    expect(forked.divergence).toMatchObject({ type: 'request_changed', callNo: 1 });
    // Only the change that matters is reported: the dates that are "today" in each run are not.
    expect(forked.divergence!.diff).toEqual([{ path: '$.system', op: 'changed', before: 'Today is <date> (<date>). Report on sales since 2026-05-01.', after: 'Today is <date> (<date>). Report on sales since 2026-08-01.' }]);
    await sidecar.close();
    store.close();
  });

  it('matches dates exactly with clock "exact", and re-fingerprints recordings made under the other mode', async () => {
    const store = Store.open(':memory:');
    const exact = await Sidecar.start({ store, upstreams: { anthropic: mock.url }, clock: 'exact' });
    day('2026-06-01T09:00:00Z');
    const recorded = exact.startRun({ mode: 'record', command: { argv: ['a'], cwd: '.' } });
    await run(exact, recorded.runId, 'Today is 2026-06-01.');
    day('2026-06-02T09:00:00Z');
    const replay = exact.startRun({ mode: 'replay', parentRunId: recorded.runId, command: { argv: ['a'], cwd: '.' } });
    const forked = await run(exact, replay.runId, 'Today is 2026-06-02.');
    expect(forked.divergence?.hints?.[0]?.normalizer).toMatchObject({ pattern: 'iso-date' });
    await exact.close();

    // The same recording, replayed by a sidecar in the default mode: its stored fingerprints were
    // computed exactly, so they are recomputed against the recording's own start.
    const auto = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
    const again = auto.startRun({ mode: 'replay', parentRunId: recorded.runId, command: { argv: ['a'], cwd: '.' } });
    expect((await run(auto, again.runId, 'Today is 2026-06-02.')).divergence).toBeNull();
    await auto.close();
    store.close();
  });

  it('replays clean days later when the replay serves the recording\'s dates back: a tool result and now()', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
    const saved = { ...process.env };
    Object.assign(process.env, sidecar.envFor());
    // A ticket created twenty minutes before the call, as most APIs return one.
    const getTicket = tool('get_ticket', { effect: 'read' }, async ({ id }: { id: string }) => ({ id, created_at: new Date(Date.now() - 20 * 60_000).toISOString() }));
    const agent = async (runId: string, extra = '') => {
      process.env.SHADOWLAP_RUN_ID = runId;
      const today = new Date(await now()).toISOString().slice(0, 10);
      const ticket = await getTicket({ id: 'T-7' });
      const client = new Anthropic({ apiKey: 'k', baseURL: sidecar.envFor(runId).ANTHROPIC_BASE_URL, maxRetries: 0 });
      await client.messages.create({ model: 'claude-opus-5', max_tokens: 16, system: `Today is ${today}.${extra}`, messages: [{ role: 'user', content: JSON.stringify(ticket) }] });
      return sidecar.endRun(runId, 'completed').summary;
    };
    try {
      day('2026-06-01T09:00:00Z');
      const recorded = sidecar.startRun({ mode: 'record', command: { argv: ['a'], cwd: '.' } });
      await agent(recorded.runId);
      const hits = mock.requests.length;
      for (const later of ['2026-06-03T09:00:00Z', '2026-09-17T15:00:00Z']) {
        day(later);
        const replay = sidecar.startRun({ mode: 'replay', parentRunId: recorded.runId, command: { argv: ['a'], cwd: '.' } });
        const summary = await agent(replay.runId);
        expect(summary.divergence, later).toBeNull();
        expect(summary.byOrigin.replayed).toBe(3);
      }
      expect(mock.requests.length).toBe(hits);

      // A real change to the prompt still forks, and the report names only it, not the dates the
      // replay served back from the recording; calibrate proposes no rule that would hide it.
      const changed = sidecar.startRun({ mode: 'replay', parentRunId: recorded.runId, command: { argv: ['a'], cwd: '.' } });
      const forked = await agent(changed.runId, ' Never refund over 50 EUR.');
      expect(forked.divergence).toMatchObject({ type: 'request_changed', callNo: 3 });
      expect(forked.divergence!.diff).toEqual([{ path: '$.system', op: 'changed', before: 'Today is <date>.', after: 'Today is <date>. Never refund over 50 EUR.' }]);
    } finally {
      process.env = saved;
      await sidecar.close();
      store.close();
    }
  });
});

describe('calibrate and dates', () => {
  it('proposes no rule for a date that reads as "today" on one side only', () => {
    const d = { type: 'request_changed' as const, callNo: 2, kind: 'api' as const, name: 'POST /v1/messages', replayedBefore: 1, diff: [{ path: '$.system', op: 'changed' as const, before: 'Today is <date>.', after: 'Today is 2026-10-14.' }] };
    const step = proposeNormalizers(d);
    expect(step.proposals).toEqual([]);
    expect(step.unexplained.map((e) => e.path)).toEqual(['$.system']);
    // The same placeholders on both sides leave the rest to calibrate as before.
    const same = proposeNormalizers({ ...d, diff: [{ path: '$.system', op: 'changed', before: 'Today is <date>. Scratch: /tmp/agent-k2J9/', after: 'Today is <date>. Scratch: /tmp/agent-Qm01/' }] });
    expect(same.proposals.map((p) => p.normalizer.pattern)).toEqual(['/\\/tmp\\/agent-[A-Za-z0-9_]+/']);
  });
});
