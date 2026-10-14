// The dashboard at scale: builds a store with one long run (default 5,000 calls) and many shorter
// ones (default 500 runs in all), starts the dashboard on it, and times the API calls a browser
// makes. `--serve` keeps the dashboard running so the UI can be tried by hand.
//
//   npm run build && node scripts/dashboard-scale.mjs [--calls 5000] [--runs 500] [--serve]
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintApi, fingerprintTool, sha256, Store, storeApiRequest } from '../packages/engine/dist/index.js';
import { startDashboard } from '../packages/dashboard/dist/index.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const CALLS = arg('calls', 5000);
const RUNS = arg('runs', 500);
const serve = process.argv.includes('--serve');
const dir = mkdtempSync(join(tmpdir(), 'shadowlap-dashboard-scale-'));
const dbPath = join(dir, 'shadowlap.db');
const store = Store.open(dbPath);

const SYSTEM = 'You are a research agent. Use the tools, then write a report.';
const TOOLS = [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }];
const sse = (events) => Buffer.from(events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join(''));

/** Appends an agent loop of `turns` model calls with a tool call after each; the context keeps the last 40 messages. */
function recordRun(run, turns, { origin = () => 'live', startAt = 0 } = {}) {
  const messages = [{ role: 'user', content: 'Read the notes and write a report.' }];
  let callNo = 0;
  let at = run.startedAt;
  store.transaction(() => {
    for (let t = 0; t < turns; t++) {
      const body = { model: 'claude-opus-5', max_tokens: 1024, stream: true, system: SYSTEM, tools: TOOLS, messages: messages.slice(-40) };
      const requestRef = storeApiRequest(store, body);
      const { fingerprint } = fingerprintApi({ method: 'POST', path: '/v1/messages', headers: {}, body }, [], []);
      const last = t === turns - 1;
      const text = last ? 'Here is the report.' : `Reading note ${t}.`;
      const events = [
        ['message_start', { message: { id: `msg_${t}`, model: 'claude-opus-5', usage: { input_tokens: 800 + Math.min(t, 40) * 120, output_tokens: 1 } } }],
        ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { index: 0, delta: { type: 'text_delta', text } }],
        ['content_block_stop', { index: 0 }],
        ...(last
          ? []
          : [
              ['content_block_start', { index: 1, content_block: { type: 'tool_use', id: `tu_${t}`, name: 'read_file', input: {} } }],
              ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: `notes/${t}.md` }) } }],
              ['content_block_stop', { index: 1 }],
            ]),
        ['message_delta', { delta: { stop_reason: last ? 'end_turn' : 'tool_use' }, usage: { output_tokens: 40 } }],
        ['message_stop', {}],
      ];
      const bytes = sse(events);
      const responseRef = store.putBlob(bytes);
      callNo++;
      const n = callNo;
      const identity = { kind: 'api', name: 'POST /v1/messages', fingerprint, occurrence: 1 };
      store.appendCallStart({ runId: run.runId, callNo: n, ...identity, origin: n >= startAt ? origin(n) : 'replayed', effect: null, requestRef, meta: { provider: 'anthropic', model: 'claude-opus-5' }, at: (at += 5) });
      store.appendCallEnd(identity, { runId: run.runId, callNo: n, attempt: 0, responseRef, outcome: 'ok', meta: { status: 200, latencyMs: 900, bytes: bytes.length, stopReason: last ? 'end_turn' : 'tool_use', model: 'claude-opus-5', usage: { inputTokens: 800 + Math.min(t, 40) * 120, outputTokens: 40 }, headers: { 'content-type': 'text/event-stream' }, chunks: events.map((_, i) => [0, i * 30]) }, at: (at += 900) });
      messages.push({ role: 'assistant', content: [{ type: 'text', text }, ...(last ? [] : [{ type: 'tool_use', id: `tu_${t}`, name: 'read_file', input: { path: `notes/${t}.md` } }])] });
      if (last || callNo >= CALLS_FOR(run)) break;

      const args = { path: `notes/${t}.md` };
      const result = { path: args.path, content: `Note ${t}: ${'findings '.repeat(60)}` };
      callNo++;
      const tool = { kind: 'tool', name: 'read_file', fingerprint: fingerprintTool('read_file', args, []).fingerprint, occurrence: 1 };
      store.appendCallStart({ runId: run.runId, callNo, ...tool, origin: callNo >= startAt ? origin(callNo) : 'replayed', effect: 'read', requestRef: store.putJson({ args }), meta: {}, at: (at += 1) });
      store.appendCallEnd(tool, { runId: run.runId, callNo, attempt: 0, responseRef: store.putJson(result), outcome: 'ok', meta: { latencyMs: 2 }, at: (at += 2) });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${t}`, content: JSON.stringify(result) }] });
    }
  });
  store.endRun(run.runId, 'completed', at);
  return callNo;
}
const limits = new Map();
const CALLS_FOR = (run) => limits.get(run.runId) ?? Infinity;

const t0 = performance.now();
const command = { argv: ['node', 'agent.js'], cwd: '/work' };
const big = store.createRun({ mode: 'record', command, startedAt: Date.now() - 86_400_000 });
limits.set(big.runId, CALLS);
const bigCalls = recordRun(big, Math.ceil(CALLS / 2));
// The rest: recordings of 30 calls, each with a couple of forks.
let made = 1;
const recordings = [];
while (made < RUNS) {
  const rec = store.createRun({ mode: 'record', command, startedAt: Date.now() - 3_600_000 + made * 1000 });
  limits.set(rec.runId, 30);
  recordRun(rec, 15);
  recordings.push(rec);
  made++;
  for (let f = 0; f < 2 && made < RUNS; f++, made++) {
    const fork = store.createRun({ mode: 'replay', parentRunId: rec.runId, command, startedAt: Date.now() - 3_600_000 + made * 1000 });
    limits.set(fork.runId, 30);
    const at = 11 + f * 6;
    recordRun(fork, 15, { startAt: at, origin: () => 'live' });
    store.setDivergence(fork.runId, { type: 'request_changed', callNo: at, kind: 'api', name: 'POST /v1/messages', replayedBefore: at - 1, counterpart: { runId: rec.runId, callNo: at }, diff: [{ path: '$.system', op: 'changed', before: SYSTEM, after: `${SYSTEM} Be brief.` }] });
  }
}
const built = performance.now() - t0;
const size = statSync(dbPath).size;

const dash = await startDashboard({ store, dbPath, port: 0 });
const time = async (label, path) => {
  const s = performance.now();
  const res = await fetch(`${dash.url}/api/${path}`, { headers: { 'x-shadowlap-token': dash.token } });
  const body = await res.text();
  const ms = performance.now() - s;
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${body.slice(0, 200)}`);
  return { label, ms, kb: body.length / 1024 };
};
const rows = [];
rows.push(await time(`run list (${RUNS} runs)`, 'runs'));
rows.push(await time('run list, second request', 'runs'));
rows.push(await time(`run with ${bigCalls} calls`, `runs/${big.runId}`));
rows.push(await time(`last model call of that run`, `runs/${big.runId}/calls/${bigCalls % 2 === 0 ? bigCalls - 1 : bigCalls}`));
rows.push(await time('a tool call in the middle', `runs/${big.runId}/calls/${Math.floor(bigCalls / 2) + (Math.floor(bigCalls / 2) % 2 === 0 ? 0 : 1)}`));
rows.push(await time('compare the long run with itself', `compare?a=${big.runId}&b=${big.runId}`));
const rec = recordings[recordings.length - 1];
rows.push(await time('a 30-call run', `runs/${rec.runId}`));

process.stdout.write(`store: ${made} runs, ${bigCalls} calls in the long run, ${(size / 1024 / 1024).toFixed(1)} MB, built in ${(built / 1000).toFixed(1)} s\n\n`);
process.stdout.write('| Request | Time | Response |\n|---|---|---|\n');
for (const r of rows) process.stdout.write(`| ${r.label} | ${r.ms.toFixed(0)} ms | ${r.kb.toFixed(0)} KB |\n`);

if (serve) {
  process.stdout.write(`\n${dash.runUrl(big.runId)}\nCtrl-C stops\n`);
  await new Promise((r) => process.once('SIGINT', r));
}
await dash.close();
store.close();
rmSync(dir, { recursive: true, force: true });
