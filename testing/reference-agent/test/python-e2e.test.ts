import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type RunRecord } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { startMockAnthropic, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { EXPECTED_MODEL_CALLS, EXPECTED_TOOL_CALLS, EXPECTED_TOTAL_CALLS, referenceScript } from '../src/index.js';
import { pythonCommand } from '../../python-with.mjs';

/**
 * The reference scenario in Python: the real `anthropic` package (streaming) and the Python SDK,
 * as a subprocess → sidecar → mock. Record, clean replay, fork with the write fenced.
 * Needs a Python ≥ 3.9 with `anthropic` importable (SHADOWLAP_PYTHON overrides the interpreter).
 */
const SCRIPT = fileURLToPath(new URL('../python/agent.py', import.meta.url));
const CLI = fileURLToPath(new URL('../../../packages/cli/bin/shadowlap.js', import.meta.url));

/** The key a request carried, in whichever header the installed SDK sent it: `x-api-key` from anthropic 1.x, a bearer token from 2.0 on. */
const keySent = (headers: Record<string, string | undefined>) => headers['x-api-key'] ?? headers.authorization?.replace(/^Bearer /, '');

const PYTHON = pythonCommand('anthropic');

interface Result {
  finalText: string;
  modelCalls: number;
  toolCalls: number;
  toolErrors: string[];
  startedAt: number;
  requestId: string;
}

describe.skipIf(!PYTHON)('Python reference agent', () => {
  let mock: MockServer;
  let store: Store;
  let sidecar: Sidecar;
  let parent: RunRecord;
  let recorded: Result;

  beforeAll(async () => {
    mock = await startMockAnthropic({ script: referenceScript });
    store = Store.open(':memory:');
    sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
  });
  afterAll(async () => {
    await sidecar.close();
    await mock.close();
    store.close();
  });

  // Async on purpose: the sidecar serves from this event loop.
  async function runAgent(run: RunRecord, extraEnv: Record<string, string> = {}): Promise<Result> {
    const env = { ...process.env, ...sidecar.envFor(run.runId), ANTHROPIC_API_KEY: 'test-key', PYTHONUNBUFFERED: '1', AGENT_DATE: '2026-09-16', ...extraEnv };
    const { stdout } = await promisify(execFile)(PYTHON!, [SCRIPT], { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout.trim().split('\n').pop()!) as Result;
  }

  it('records the streaming run: 11 model calls, 17 tool calls, clock and uuid', async () => {
    parent = sidecar.startRun({ mode: 'record', command: { argv: ['python', 'agent.py'], cwd: '/' } });
    recorded = await runAgent(parent);
    const { summary, sdks } = sidecar.endRun(parent.runId, 'completed');
    expect(recorded.modelCalls).toBe(EXPECTED_MODEL_CALLS);
    expect(recorded.toolCalls).toBe(EXPECTED_TOOL_CALLS);
    expect(recorded.toolErrors).toEqual([]);
    expect(recorded.finalText).toContain('Done');
    expect(summary.total).toBe(EXPECTED_TOTAL_CALLS);
    expect(summary.byKind).toMatchObject({ api: EXPECTED_MODEL_CALLS, tool: EXPECTED_TOOL_CALLS, clock: 1, random: 1 });
    expect(summary.upstreamRequests).toBe(EXPECTED_MODEL_CALLS);
    expect(sdks).toEqual(['python']);
    expect(mock.requests).toHaveLength(EXPECTED_MODEL_CALLS);
    expect(keySent(mock.requests[0].headers)).toBe('test-key');
    expect(JSON.stringify(store.getCalls(parent.runId))).not.toContain('test-key');
  });

  it('replays with zero upstream requests and the same output', async () => {
    const before = mock.requests.length;
    const run = sidecar.startRun({ mode: 'replay', parentRunId: parent.runId, command: { argv: ['python', 'agent.py'], cwd: '/' } });
    const result = await runAgent(run);
    const { summary } = sidecar.endRun(run.runId, 'completed');
    expect(summary.divergence).toBeNull();
    expect(summary.byOrigin.replayed).toBe(EXPECTED_TOTAL_CALLS);
    expect(mock.requests).toHaveLength(before);
    // Recorded clock and uuid: the replay sees the same values, so the conversation is byte-identical.
    expect(result).toEqual(recorded);
  });

  it('forks when the date in the system prompt changes and blocks the email', async () => {
    const run = sidecar.startRun({ mode: 'replay', parentRunId: parent.runId, command: { argv: ['python', 'agent.py'], cwd: '/' } });
    const result = await runAgent(run, { AGENT_DATE: '2026-09-17' });
    const { summary } = sidecar.endRun(run.runId, 'completed');
    expect(summary.divergence).toMatchObject({ type: 'request_changed', callNo: 3, name: 'POST /v1/messages', replayedBefore: 2 });
    expect(summary.divergence?.diff?.[0]).toMatchObject({ path: '$.system', op: 'changed' });
    expect(summary.divergence?.hints?.[0]?.message).toMatch(/date/);
    expect(summary.byOrigin.blocked).toBe(1);
    expect(result.toolErrors).toEqual(['send_email: ShadowlapWriteBlocked']);
    expect(result.requestId).toBe(recorded.requestId); // uuid replayed before the fork
  });

  it('forks when AGENT_SYSTEM_SUFFIX adds to the system prompt, as the quickstart does with the TypeScript agent', async () => {
    const run = sidecar.startRun({ mode: 'replay', parentRunId: parent.runId, command: { argv: ['python', 'agent.py'], cwd: '/' } });
    const result = await runAgent(run, { AGENT_SYSTEM_SUFFIX: 'Be brief.' });
    const { summary } = sidecar.endRun(run.runId, 'completed');
    expect(summary.divergence).toMatchObject({ type: 'request_changed', callNo: 3, name: 'POST /v1/messages', replayedBefore: 2 });
    expect(summary.divergence?.diff?.[0]).toMatchObject({ path: '$.system', op: 'changed' });
    expect(JSON.stringify(summary.divergence?.diff?.[0])).toContain('Today is 2026-09-16. Be brief.');
    expect(summary.byOrigin.blocked).toBe(1);
    expect(result.toolErrors).toEqual(['send_email: ShadowlapWriteBlocked']);
  });
});

describe.skipIf(!PYTHON)("the key the Python SDK sends, in whichever header it sends it", () => {
  it('reaches the provider, and never the store, a pack of the run or its exports', async () => {
    const mock = await startMockAnthropic({ script: referenceScript });
    const dir = mkdtempSync(join(tmpdir(), 'sl-python-key-'));
    const KEY = 'sk-ant-python-key-0123456789';
    try {
      const env = { ...process.env, ANTHROPIC_API_KEY: KEY, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', PYTHONUNBUFFERED: '1', AGENT_DATE: '2026-09-16' };
      const shadowlap = (args: string[]) => promisify(execFile)(process.execPath, [CLI, '--db', join(dir, 'store.db'), ...args], { cwd: dir, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      const recorded = await shadowlap(['run', '--', PYTHON!, SCRIPT]);
      const runId = /Recorded (\w{26})/.exec(recorded.stderr)?.[1] ?? '';
      expect(runId, recorded.stderr).not.toBe('');
      expect(mock.requests).toHaveLength(EXPECTED_MODEL_CALLS);
      expect(mock.requests.map((r) => keySent(r.headers))).toEqual(Array(EXPECTED_MODEL_CALLS).fill(KEY));
      await shadowlap(['pack', runId, join(dir, 'pack')]);
      await shadowlap(['export', 'har', runId, join(dir, 'run.har')]);
      await shadowlap(['export', 'html', runId, join(dir, 'run.html')]);
      await shadowlap(['export', 'otel', runId, '--out', join(dir, 'trace.json')]);
      await shadowlap(['export', 'dataset', runId, '--calls', 'model', '--out', join(dir, 'dataset.jsonl')]);
      const files = (readdirSync(dir, { recursive: true }) as string[]).map((f) => join(dir, f)).filter((f) => statSync(f).isFile());
      // The store with its journal, the pack's run, calls and blobs, and each export.
      expect(files.map((f) => f.slice(dir.length + 1).split(/[\\/]/)[0])).toEqual(expect.arrayContaining(['store.db', 'pack', 'run.har', 'run.html', 'trace.json', 'dataset.jsonl']));
      expect(files.filter((f) => readFileSync(f).includes(KEY))).toEqual([]);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});
