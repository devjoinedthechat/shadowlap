import Anthropic from '@anthropic-ai/sdk';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type RunRecord, type RunSummary } from '@shadowlap/engine';
import { Sidecar, type StartRunInput } from '@shadowlap/sidecar';
import { startMockAnthropic, type MockServer, type Script } from '@shadowlap-testing/mock-anthropic';
import { EXPECTED_MODEL_CALLS, EXPECTED_TOOL_CALLS, EXPECTED_TOTAL_CALLS, referenceScript, runAgent, type AgentOptions, type AgentResult } from '../src/index.js';

/**
 * The fidelity suite, in-process: the real Anthropic SDK (streaming) → sidecar → mock API.
 * Proves record → clean replay (zero upstream requests) → fork with fenced writes, plus retries,
 * concurrency, effect classes and normalizers.
 */

const command = { argv: ['node', 'reference-agent'], cwd: '/' };
const outbox = join(mkdtempSync(join(tmpdir(), 'fp-e2e-')), 'outbox.jsonl');
const outboxLines = () => (existsSync(outbox) ? readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).length : 0);

interface Ran {
  run: RunRecord;
  summary: RunSummary;
  result: AgentResult;
}

let script: Script = referenceScript;
let mock: MockServer;
let store: Store;
let sidecar: Sidecar;
let client: Anthropic;

async function ran(sc: Sidecar, input: StartRunInput, agent: Partial<AgentOptions> = {}): Promise<Ran> {
  const run = sc.startRun(input);
  process.env.SHADOWLAP_URL = sc.url;
  process.env.SHADOWLAP_RUN_ID = run.runId;
  try {
    const result = await runAgent({ client, outbox, ...agent });
    const { summary } = sc.endRun(run.runId, 'completed');
    return { run, summary, result };
  } finally {
    delete process.env.SHADOWLAP_URL;
    delete process.env.SHADOWLAP_RUN_ID;
  }
}

beforeAll(async () => {
  mock = await startMockAnthropic({ script: (ctx) => script(ctx) });
  store = Store.open(':memory:');
  // Dates match exactly here, so these tests don't depend on the day they run (clock.test.ts covers `auto`).
  sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url }, clock: 'exact' });
  client = new Anthropic({ apiKey: 'test-key', baseURL: `${sidecar.url}/anthropic`, maxRetries: 2 });
});

afterAll(async () => {
  await sidecar.close();
  await mock.close();
  store.close();
});

describe('reference agent: record, replay, fork', () => {
  let recording: Ran;

  it('records a full streaming run through the proxy', async () => {
    recording = await ran(sidecar, { mode: 'record', command });
    expect(mock.requests).toHaveLength(EXPECTED_MODEL_CALLS);
    expect(recording.result.modelCalls).toBe(EXPECTED_MODEL_CALLS);
    expect(recording.result.toolCalls).toBe(EXPECTED_TOOL_CALLS);
    expect(recording.result.toolErrors).toEqual([]);
    expect(recording.result.finalText).toContain('Done.');
    expect(outboxLines()).toBe(1); // the write tool really ran while recording

    const s = recording.summary;
    expect(s.total).toBe(EXPECTED_TOTAL_CALLS);
    expect(s.byKind).toMatchObject({ api: EXPECTED_MODEL_CALLS, tool: EXPECTED_TOOL_CALLS });
    expect(s.byOrigin.live).toBe(EXPECTED_TOTAL_CALLS);
    expect(s.upstreamRequests).toBe(EXPECTED_MODEL_CALLS);
    expect(s.divergence).toBeNull();

    const calls = store.getCalls(recording.run.runId);
    for (const c of calls) {
      expect(c.end?.outcome).toBe('ok');
      expect(c.requestRef).toBeTruthy();
    }
    const api = calls.filter((c) => c.kind === 'api');
    expect(api.every((c) => (c.end?.meta.usage?.inputTokens ?? 0) > 0)).toBe(true);
    expect(api.every((c) => (c.end?.meta.chunks?.length ?? 0) > 5)).toBe(true); // streamed, with event timing
    expect(api.every((c) => c.end?.meta.headers?.['content-type']?.includes('text/event-stream'))).toBe(true);
    expect(api.every((c) => c.end?.meta.model === 'claude-opus-5' && (c.end?.meta.bytes ?? 0) > 0)).toBe(true);
    expect(api.map((c) => c.end?.meta.stopReason)).toEqual([...Array(EXPECTED_MODEL_CALLS - 1).fill('tool_use'), 'end_turn']);
    expect(s.cost.spent).toBeGreaterThan(0); // priced from claude-opus-5
    expect(s.cost.unknownModels).toEqual([]);
    expect(JSON.stringify(calls)).not.toContain('test-key'); // credentials never stored
  });

  it('replays with zero upstream requests and identical output, under different interleavings', async () => {
    const before = mock.requests.length;
    for (let i = 0; i < 3; i++) {
      const replay = await ran(sidecar, { mode: 'replay', parentRunId: recording.run.runId, command });
      expect(mock.requests).toHaveLength(before);
      expect(replay.summary.divergence).toBeNull();
      expect(replay.summary.byOrigin.replayed).toBe(EXPECTED_TOTAL_CALLS);
      expect(replay.summary.upstreamRequests).toBe(0);
      expect(replay.summary.notReached).toEqual([]);
      expect(replay.summary.tokensNotRespent.inputTokens).toBeGreaterThan(10_000);
      expect(replay.summary.cost.saved).toBeGreaterThan(0);
      expect(replay.summary.cost.spent).toBe(0);
      expect(replay.result.finalText).toBe(recording.result.finalText);
      expect(replay.result.startedAt).toBe(recording.result.startedAt); // clock replayed
      expect(replay.result.requestId).toBe(recording.result.requestId); // uuid replayed
      expect(replay.result.toolErrors).toEqual([]);
      expect(outboxLines()).toBe(1); // the write tool never executed
    }
  });

  it('forks at the first model call when the system prompt changes, and blocks the write', async () => {
    const before = mock.requests.length;
    const fork = await ran(sidecar, { mode: 'replay', parentRunId: recording.run.runId, command }, { systemSuffix: 'Be extremely brief.' });
    const d = fork.summary.divergence!;
    expect(d.type).toBe('request_changed');
    expect(d.callNo).toBe(3); // 1 = now(), 2 = uuid(), 3 = first model call
    expect(d.replayedBefore).toBe(2);
    expect(d.counterpart).toEqual({ runId: recording.run.runId, callNo: 3 });
    expect(d.diff).toEqual([{ path: '$.system', op: 'changed', before: expect.stringContaining('research agent'), after: expect.stringContaining('Be extremely brief.') }]);
    expect(fork.run.parentRunId).toBe(recording.run.runId);
    expect(store.getRun(fork.run.runId)?.divergence?.callNo).toBe(3); // persisted at divergence time

    expect(mock.requests.length - before).toBe(EXPECTED_MODEL_CALLS); // the whole suffix ran live
    expect(fork.summary.byOrigin.blocked).toBe(1);
    expect(outboxLines()).toBe(1);
    expect(fork.result.toolErrors).toEqual([expect.stringContaining('send_email: ShadowlapWriteBlocked')]);
    expect(fork.result.finalText).toBe(recording.result.finalText); // the mock script is the same

    // After divergence: pure calls replay when identical, reads run live.
    const calls = store.getCalls(fork.run.runId);
    const after = calls.filter((c) => c.callNo > 3 && c.kind === 'tool');
    expect(after.filter((c) => c.name === 'read_file').map((c) => c.origin)).toEqual(Array(6).fill('replayed'));
    expect(after.filter((c) => c.name === 'search_web' || c.name === 'fetch_page').every((c) => c.origin === 'live')).toBe(true);
    expect(fork.summary.notReached.length).toBeGreaterThan(0);
  });

  it('forks late when only a late request changes, replaying the whole prefix', async () => {
    const before = mock.requests.length;
    const fork = await ran(sidecar, { mode: 'replay', parentRunId: recording.run.runId, command }, { lateChange: true });
    const d = fork.summary.divergence!;
    expect(d.type).toBe('request_changed');
    expect(d.kind).toBe('api');
    // 2 misc + 5 model calls + the tool calls of turns 0–4 (2+2+1+2+2) were replayed first.
    expect(d.replayedBefore).toBe(2 + 5 + 9);
    expect(d.diff?.some((e) => e.op === 'added' && /^\$\.messages\[\d+\]$/.test(e.path))).toBe(true);
    expect(mock.requests.length - before).toBe(EXPECTED_MODEL_CALLS - 5);
    expect(fork.summary.byOrigin.blocked).toBe(1);
  });

  it('stubs writes with --writes stub and returns the onFork value', async () => {
    const fork = await ran(sidecar, { mode: 'replay', parentRunId: recording.run.runId, command, replay: { writes: 'stub' } }, { systemSuffix: 'x' });
    expect(fork.summary.byOrigin.stubbed).toBe(1);
    expect(fork.result.toolErrors).toEqual([]);
    expect(outboxLines()).toBe(1);
    const email = store.getCalls(fork.run.runId).find((c) => c.name === 'send_email')!;
    expect(store.getJson(email.end!.responseRef!)).toEqual({ result: { sent: false, suppressed: true, to: 'team@example.com' } });
  });

  it('overrides a tool result and forks at the next model call', async () => {
    const before = mock.requests.length;
    const parentCalls = store.getCalls(recording.run.runId);
    const target = parentCalls.find((c) => c.kind === 'tool' && c.name === 'read_file')!; // in the first parallel pair
    const fork = await ran(sidecar, {
      mode: 'replay',
      parentRunId: recording.run.runId,
      command,
      replay: { overrides: new Map([[target.callNo, { path: 'notes.md', content: 'OVERRIDDEN NOTES' }]]) },
    });
    const calls = store.getCalls(fork.run.runId);
    const overridden = calls.find((c) => c.origin === 'overridden')!;
    expect(overridden.name).toBe('read_file');
    expect(store.getJson(overridden.end!.responseRef!)).toEqual({ result: { path: 'notes.md', content: 'OVERRIDDEN NOTES' } });
    expect(overridden.end?.meta.overriddenFrom).toBe(target.callNo);

    const d = fork.summary.divergence!;
    expect(d.type).toBe('request_changed');
    expect(d.kind).toBe('api');
    expect(d.callNo).toBe(6); // now, uuid, api, 2 parallel tools, then the model call that sees the new result
    expect(d.replayedBefore).toBe(5);
    expect(d.diff?.some((e) => e.op === 'changed' && String(e.after).includes('OVERRIDDEN NOTES'))).toBe(true);
    expect(mock.requests.length - before).toBe(EXPECTED_MODEL_CALLS - 1);
    expect(fork.summary.byOrigin.overridden).toBe(1);
    expect(fork.summary.byOrigin.blocked).toBe(1);
  });

  it('injects an instruction at a model call and keeps it in every later request', async () => {
    const before = mock.requests.length;
    const parentApi = store.getCalls(recording.run.runId).filter((c) => c.kind === 'api');
    const second = parentApi[1]; // the 2nd model call: after the first parallel tool pair
    const fork = await ran(sidecar, {
      mode: 'replay',
      parentRunId: recording.run.runId,
      command,
      interventions: { inject: { atCall: second.callNo, text: 'Prefer sources from 2026.', as: 'system' } },
    });
    const d = fork.summary.divergence!;
    expect(d.type).toBe('request_changed');
    expect(d.callNo).toBe(6);
    expect(d.replayedBefore).toBe(5);
    expect(d.diff).toEqual([{ path: '$.messages[3]', op: 'added', after: { role: 'system', content: 'Prefer sources from 2026.' } }]);

    // Every request from the injection point on carries the message at the same position.
    const sent = mock.requests.slice(before).map((r) => r.body.messages);
    expect(sent).toHaveLength(EXPECTED_MODEL_CALLS - 1);
    for (const messages of sent) {
      expect(messages[3]).toEqual({ role: 'system', content: 'Prefer sources from 2026.' });
      expect(messages.filter((m) => m.role === 'system')).toHaveLength(1);
    }
    // The fork's own recording holds the request as sent, injection included.
    const forkApi = store.getCalls(fork.run.runId).filter((c) => c.kind === 'api');
    const stored = store.getJson<{ messages: string[] }>(forkApi[1].requestRef!)!;
    expect(store.getJson(stored.messages[3])).toEqual({ role: 'system', content: 'Prefer sources from 2026.' });
    expect(fork.summary.byOrigin.blocked).toBe(1);
  });

  it('patches request parameters from a model call on', async () => {
    const before = mock.requests.length;
    const parentApi = store.getCalls(recording.run.runId).filter((c) => c.kind === 'api');
    const fork = await ran(sidecar, {
      mode: 'replay',
      parentRunId: recording.run.runId,
      command,
      interventions: { set: { fromCall: parentApi[2].callNo, fields: { max_tokens: 2048, model: 'claude-opus-5-patched' } } },
    });
    const d = fork.summary.divergence!;
    expect(d.callNo).toBe(parentApi[2].callNo);
    expect(d.diff).toEqual(expect.arrayContaining([{ path: '$.max_tokens', op: 'changed', before: 1024, after: 2048 }, { path: '$.model', op: 'changed', before: 'claude-opus-5', after: 'claude-opus-5-patched' }]));
    const sent = mock.requests.slice(before);
    expect(sent).toHaveLength(EXPECTED_MODEL_CALLS - 2);
    expect(sent.every((r) => r.body.max_tokens === 2048 && r.body.model === 'claude-opus-5-patched')).toBe(true);
  });

  it('forces a tool live with --live-tool and reports a forced divergence', async () => {
    const before = mock.requests.length;
    const fork = await ran(sidecar, { mode: 'replay', parentRunId: recording.run.runId, command, replay: { liveTools: new Set(['search_web']) } });
    const d = fork.summary.divergence!;
    expect(d.type).toBe('forced');
    expect(d.name).toBe('search_web');
    expect([3, 4]).toContain(d.replayedBefore); // its parallel sibling may have arrived first
    expect(mock.requests.length - before).toBe(EXPECTED_MODEL_CALLS - 1); // model call 1 replayed, the rest live
  });

  it('collapses SDK retries into one call and replays without retrying', async () => {
    let failed = false;
    script = (ctx) => {
      if (ctx.requestNo === mock.requests.length && ctx.assistantTurns === 2 && !failed) {
        failed = true;
        return { status: 429, headers: { 'retry-after-ms': '1' }, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } };
      }
      return referenceScript(ctx);
    };
    try {
      const rec = await ran(sidecar, { mode: 'record', command });
      expect(failed).toBe(true);
      expect(rec.summary.total).toBe(EXPECTED_TOTAL_CALLS);
      expect(rec.summary.upstreamRequests).toBe(EXPECTED_MODEL_CALLS + 1);
      const retried = store.getCalls(rec.run.runId).find((c) => c.attempts.length > 0)!;
      expect(retried.attempts[0].meta.status).toBe(429);
      expect(retried.attempts[0].meta.retryable).toBe(true);
      expect(retried.end?.outcome).toBe('ok');

      const before = mock.requests.length;
      const replay = await ran(sidecar, { mode: 'replay', parentRunId: rec.run.runId, command });
      expect(replay.summary.divergence).toBeNull();
      expect(mock.requests).toHaveLength(before);
      // The SDK was answered at once, never with the 429: it asked once for each call, so nothing
      // waited out a backoff.
      const replayed = store.getCalls(replay.run.runId);
      expect(replayed).toHaveLength(EXPECTED_TOTAL_CALLS);
      expect(replayed.filter((c) => c.attempts.length > 0)).toEqual([]);
    } finally {
      script = referenceScript;
    }
  });

  it('replays an error response as the same SDK error', async () => {
    script = (ctx) => (ctx.assistantTurns === 1 ? { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'scripted failure' } } } : referenceScript(ctx));
    try {
      const run = sidecar.startRun({ mode: 'record', command });
      process.env.SHADOWLAP_URL = sidecar.url;
      process.env.SHADOWLAP_RUN_ID = run.runId;
      await expect(runAgent({ client, outbox })).rejects.toBeInstanceOf(Anthropic.BadRequestError);
      sidecar.endRun(run.runId, 'failed');

      const before = mock.requests.length;
      const replay = sidecar.startRun({ mode: 'replay', parentRunId: run.runId, command });
      process.env.SHADOWLAP_RUN_ID = replay.runId;
      await expect(runAgent({ client, outbox })).rejects.toBeInstanceOf(Anthropic.BadRequestError);
      const { summary } = sidecar.endRun(replay.runId, 'failed');
      expect(summary.divergence).toBeNull();
      expect(mock.requests).toHaveLength(before);
    } finally {
      script = referenceScript;
      delete process.env.SHADOWLAP_URL;
      delete process.env.SHADOWLAP_RUN_ID;
    }
  });

  it('normalizers make ambient dates match, even when added after the recording', async () => {
    const rec = await ran(sidecar, { mode: 'record', command }, { date: '2026-09-15' });
    const drift = await ran(sidecar, { mode: 'replay', parentRunId: rec.run.runId, command }, { date: '2026-09-16' });
    expect(drift.summary.divergence?.type).toBe('request_changed');
    expect(drift.summary.divergence?.hints?.[0]?.normalizer).toEqual({ kind: 'api', path: '$.system', pattern: 'iso-date', replace: '<DATE>' });

    const normalized = await Sidecar.start({ store, upstreams: { anthropic: mock.url }, clock: 'exact', normalizers: [{ kind: 'api', path: '$.system', pattern: 'iso-date', replace: '<DATE>' }] });
    const client2 = new Anthropic({ apiKey: 'test-key', baseURL: `${normalized.url}/anthropic` });
    const saved = client;
    client = client2;
    try {
      const before = mock.requests.length;
      const clean = await ran(normalized, { mode: 'replay', parentRunId: rec.run.runId, command }, { date: '2026-09-16' });
      expect(clean.summary.divergence).toBeNull();
      expect(clean.summary.byOrigin.replayed).toBe(EXPECTED_TOTAL_CALLS);
      expect(mock.requests).toHaveLength(before);
    } finally {
      client = saved;
      await normalized.close();
    }
  });

  it('replays a redacted pack cleanly by applying its redaction rules as normalizers', async () => {
    const { packRun, unpackRun } = await import('@shadowlap/engine');
    const { mkdtempSync } = await import('node:fs');
    // The reference agent's requests contain the request id (a UUID) and the team's email address.
    const dir = join(mkdtempSync(join(tmpdir(), 'fp-redacted-')), 'pack');
    const rules = [
      { pattern: 'email', replace: '<EMAIL>' },
      { pattern: 'uuid', replace: '<UUID>' },
    ];
    packRun(store, recording.run.runId, dir, { redact: rules });
    const other = Store.open(':memory:');
    const { imported } = unpackRun(other, dir);
    expect(JSON.stringify(other.getCalls(imported[0]).map((c) => other.getJson(c.requestRef!)))).not.toContain('team@example.com');

    const sc = await Sidecar.start({ store: other, upstreams: { anthropic: mock.url } });
    const client2 = new Anthropic({ apiKey: 'test-key', baseURL: `${sc.url}/anthropic` });
    const saved = client;
    client = client2;
    try {
      const before = mock.requests.length;
      const replay = await ran(sc, { mode: 'replay', parentRunId: imported[0], command });
      expect(replay.summary.divergence).toBeNull();
      expect(replay.summary.byOrigin.replayed).toBe(EXPECTED_TOTAL_CALLS);
      expect(mock.requests).toHaveLength(before);
      // Served responses are the redacted ones.
      expect(replay.result.finalText).toBe(recording.result.finalText);
    } finally {
      client = saved;
      await sc.close();
      other.close();
    }
  });

  it('warns when a replayed tool implementation changed', async () => {
    // A different implementation of read_file with the same name and effect.
    const { tool } = await import('@shadowlap/sdk');
    const changed = tool('read_file', { effect: 'pure' }, async ({ path }: { path: string }) => ({ path, content: 'CHANGED' }));
    const run = sidecar.startRun({ mode: 'replay', parentRunId: recording.run.runId, command });
    process.env.SHADOWLAP_URL = sidecar.url;
    process.env.SHADOWLAP_RUN_ID = run.runId;
    try {
      await (await import('@shadowlap/sdk')).now('start');
      await (await import('@shadowlap/sdk')).uuid('request');
      // Consume the first model call so the next tool call is matched, not diverged.
      await client.messages.stream({ model: 'claude-opus-5', max_tokens: 1024, system: 'You are a research agent. Use the tools, then email a summary.', tools: (await import('../src/index.js')).TOOLS, messages: [{ role: 'user', content: `Research request ${recording.result.requestId}: investigate replay for agents and report back.` }] }).finalMessage();
      const r = await changed({ path: 'notes.md' });
      expect(r).toEqual({ path: 'notes.md', content: expect.stringContaining('shadowlap') }); // served from the recording
      const { summary } = sidecar.endRun(run.runId, 'completed');
      expect(summary.warnings).toEqual([expect.stringContaining('read_file changed since the recording; pass --live-tool read_file')]);
    } finally {
      delete process.env.SHADOWLAP_URL;
      delete process.env.SHADOWLAP_RUN_ID;
    }
  });
});
