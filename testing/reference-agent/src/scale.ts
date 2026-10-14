#!/usr/bin/env node
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { Store, summarizeRun } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { tool } from '@shadowlap/sdk';
import { message, startMockAnthropic, text, toolUse } from '@shadowlap-testing/mock-anthropic';

/**
 * Scale: a long run with a conversation that grows every turn, recorded through a real sidecar
 * into a file-backed store and then replayed. Reports wall time, store size and the cost of
 * reading the run back. `node testing/reference-agent/dist/scale.js [modelCalls] [kbPerToolResult]`
 */
const N = Number(process.argv[2] ?? 300);
const KB = Number(process.argv[3] ?? 2);
const payload = 'lorem ipsum '.repeat(Math.ceil((KB * 1024) / 12)).slice(0, KB * 1024);

const mock = await startMockAnthropic({
  script: (ctx) => ({
    message:
      ctx.assistantTurns < N - 1
        ? message([toolUse('read_file', { path: `notes/${ctx.assistantTurns}.md` })], { input_tokens: 500 + ctx.assistantTurns * 600, output_tokens: 30 })
        : message([text('Done.')], { stop_reason: 'end_turn', input_tokens: 500 + ctx.assistantTurns * 600, output_tokens: 10 }),
  }),
  eventDelayMs: () => 0,
});
const dir = mkdtempSync(join(tmpdir(), 'shadowlap-scale-'));
const dbPath = join(dir, 'shadowlap.db');
const store = Store.open(dbPath);
const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
const readFile = tool('read_file', { effect: 'read' }, async ({ path }: { path: string }) => ({ path, content: payload }));

async function agent(runId: string): Promise<{ modelCalls: number; lastRequestBytes: number }> {
  process.env.SHADOWLAP_URL = sidecar.url;
  process.env.SHADOWLAP_RUN_ID = runId;
  const client = new Anthropic({ apiKey: 'k', baseURL: `${sidecar.url}/anthropic`, defaultHeaders: { 'x-shadowlap-run': runId }, maxRetries: 0 });
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'Read every note.' }];
  let modelCalls = 0;
  let lastRequestBytes = 0;
  for (;;) {
    lastRequestBytes = Buffer.byteLength(JSON.stringify(messages));
    const res = await client.messages.create({ model: 'claude-opus-5', max_tokens: 64, messages, tools: [{ name: 'read_file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }] });
    modelCalls++;
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (uses.length === 0) return { modelCalls, lastRequestBytes };
    messages.push({ role: 'assistant', content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const u of uses) results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(await readFile(u.input as { path: string })) });
    messages.push({ role: 'user', content: results });
  }
}

const ms = (t0: bigint) => Number(process.hrtime.bigint() - t0) / 1e6;
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

let t = process.hrtime.bigint();
const rec = sidecar.startRun({ mode: 'record', command: { argv: ['scale'], cwd: '.' } });
const r = await agent(rec.runId);
const recorded = sidecar.endRun(rec.runId, 'completed');
const recordMs = ms(t);
const requestBytesTotal = mock.requests.reduce((n, q) => n + Buffer.byteLength(JSON.stringify(q.body)), 0);
store.close();
const storeBytes = statSync(dbPath).size + (statSync(`${dbPath}-wal`, { throwIfNoEntry: false })?.size ?? 0);

const store2 = Store.open(dbPath);
t = process.hrtime.bigint();
const calls = store2.getCalls(rec.runId);
const readMs = ms(t);
t = process.hrtime.bigint();
summarizeRun(recorded.run, calls);
const summarizeMs = ms(t);
store2.close();

// Replay through a fresh sidecar on the same store (the sidecar re-fingerprints the parent under the current normalizers).
const store3 = Store.open(dbPath);
const sidecar2 = await Sidecar.start({ store: store3, upstreams: { anthropic: 'http://127.0.0.1:1' } });
process.env.SHADOWLAP_URL = sidecar2.url;
const before = mock.requests.length;
t = process.hrtime.bigint();
const rep = sidecar2.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['scale'], cwd: '.' } });
const startMs = ms(t);
const client2 = new Anthropic({ apiKey: 'k', baseURL: `${sidecar2.url}/anthropic`, defaultHeaders: { 'x-shadowlap-run': rep.runId }, maxRetries: 0 });
void client2;
const oldUrl = sidecar.url;
// Re-run the same agent against the second sidecar.
Object.defineProperty(sidecar, 'url', { value: sidecar2.url });
await agent(rep.runId);
Object.defineProperty(sidecar, 'url', { value: oldUrl });
const replayed = sidecar2.endRun(rep.runId, 'completed');
const replayMs = ms(t);

process.stdout.write(
  [
    `model calls ${r.modelCalls}, tool calls ${recorded.summary.byKind.tool}, ${KB} KB per tool result, last request ${mb(r.lastRequestBytes)}, requests total ${mb(requestBytesTotal)}`,
    `record   ${(recordMs / 1000).toFixed(2)} s  (${(recordMs / (r.modelCalls + recorded.summary.byKind.tool)).toFixed(1)} ms per call incl. the mock)`,
    `store    ${mb(storeBytes)} on disk for ${mb(requestBytesTotal)} of requests (${(requestBytesTotal / storeBytes).toFixed(0)}× dedup by per-message blobs)`,
    `read     getCalls ${readMs.toFixed(0)} ms, summarizeRun ${summarizeMs.toFixed(0)} ms for ${calls.length} calls`,
    `replay   start (re-fingerprint parent) ${startMs.toFixed(0)} ms, whole replay ${(replayMs / 1000).toFixed(2)} s, ${replayed.summary.byOrigin.replayed}/${replayed.summary.total} replayed, ${mock.requests.length - before} upstream requests, divergence ${replayed.summary.divergence ? `at #${replayed.summary.divergence.callNo}` : 'none'}`,
  ].join('\n') + '\n',
);

await sidecar2.close();
await sidecar.close();
await mock.close();
store3.close();
rmSync(dir, { recursive: true, force: true });
