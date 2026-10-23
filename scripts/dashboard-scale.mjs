// The dashboard at scale: builds a store with one long run (default 5,000 calls), a fork of it that
// parts near its end, and many shorter runs (default 500 runs in all), starts the dashboard on it the
// way `shadowlap dashboard` does, as a store no dashboard has opened yet, and times what a browser
// asks for: each first load (and, for an answer that says it is warming, when it came whole), how
// long /api/meta waited meanwhile, and the longest the server's own thread was held up. The answers
// are read as JSON only after their timing, so reading a long one counts for nothing here. `--serve`
// keeps the dashboard running so the UI can be tried by hand.
//
// It reads the built packages beside it: to time another build, copy it into that checkout's scripts/.
//
//   npm run build && node scripts/dashboard-scale.mjs [--calls 20000] [--runs 10000] [--serve]
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintApi, fingerprintTool, Store, storeApiRequest } from '../packages/engine/dist/index.js';
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
      store.appendCallEnd(identity, { runId: run.runId, callNo: n, attempt: 0, responseRef, outcome: 'ok', meta: { status: 200, latencyMs: 900, bytes: bytes.length, stopReason: last ? 'end_turn' : 'tool_use', model: 'claude-opus-5', usage: { inputTokens: 800 + Math.min(t, 40) * 120, outputTokens: 40 }, headers: { 'content-type': 'text/event-stream' }, chunks: events.map((_, i) => [0, i * 30]), ...(n < startAt ? { replayedFrom: n } : {}) }, at: (at += 900) });
      messages.push({ role: 'assistant', content: [{ type: 'text', text }, ...(last ? [] : [{ type: 'tool_use', id: `tu_${t}`, name: 'read_file', input: { path: `notes/${t}.md` } }])] });
      if (last || callNo >= CALLS_FOR(run)) break;

      const args = { path: `notes/${t}.md` };
      const result = { path: args.path, content: `Note ${t}: ${'findings '.repeat(60)}` };
      callNo++;
      const tool = { kind: 'tool', name: 'read_file', fingerprint: fingerprintTool('read_file', args, []).fingerprint, occurrence: 1 };
      store.appendCallStart({ runId: run.runId, callNo, ...tool, origin: callNo >= startAt ? origin(callNo) : 'replayed', effect: 'read', requestRef: store.putJson({ args }), meta: {}, at: (at += 1) });
      store.appendCallEnd(tool, { runId: run.runId, callNo, attempt: 0, responseRef: store.putJson(result), outcome: 'ok', meta: { latencyMs: 2, ...(callNo < startAt ? { replayedFrom: callNo } : {}) }, at: (at += 2) });
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
// A fork of the long run that parts from it 20 calls before its end: Compare reads both whole.
const bigFork = store.createRun({ mode: 'replay', parentRunId: big.runId, command, startedAt: Date.now() - 82_800_000 });
limits.set(bigFork.runId, CALLS);
const forkAt = Math.max(3, bigCalls - 21 - ((bigCalls - 21) % 2 === 0 ? 1 : 0));
recordRun(bigFork, Math.ceil(CALLS / 2), { startAt: forkAt, origin: () => 'live' });
store.setDivergence(bigFork.runId, { type: 'request_changed', callNo: forkAt, kind: 'api', name: 'POST /v1/messages', replayedBefore: forkAt - 1, counterpart: { runId: big.runId, callNo: forkAt }, diff: [{ path: '$.system', op: 'changed', before: SYSTEM, after: `${SYSTEM} Be brief.` }] });
// The rest: recordings of 30 calls, each with a couple of forks.
let made = 2;
const recordings = [];
while (made < RUNS) {
  const rec = store.createRun({ mode: 'record', command, startedAt: Date.now() - 3_600_000 + made * 100 });
  limits.set(rec.runId, 30);
  recordRun(rec, 15);
  recordings.push(rec);
  made++;
  for (let f = 0; f < 2 && made < RUNS; f++, made++) {
    const fork = store.createRun({ mode: 'replay', parentRunId: rec.runId, command, startedAt: Date.now() - 3_600_000 + made * 100 });
    limits.set(fork.runId, 30);
    const at = 11 + f * 6;
    recordRun(fork, 15, { startAt: at, origin: () => 'live' });
    store.setDivergence(fork.runId, { type: 'request_changed', callNo: at, kind: 'api', name: 'POST /v1/messages', replayedBefore: at - 1, counterpart: { runId: rec.runId, callNo: at }, diff: [{ path: '$.system', op: 'changed', before: SYSTEM, after: `${SYSTEM} Be brief.` }] });
  }
}
const built = performance.now() - t0;
const size = statSync(dbPath).size;

const dash = await startDashboard({ store, dbPath, port: 0 });
/** An answer, timed to its last byte; its JSON is read when asked for (`json()`), after the timing. */
const ask = async (path) => {
  const s = performance.now();
  const res = await fetch(`${dash.url}/api/${path}`, { headers: { 'x-shadowlap-token': dash.token } });
  const text = await res.text();
  const ms = performance.now() - s;
  return { ms, status: res.status, kb: text.length / 1024, json: () => (res.ok ? JSON.parse(text) : null) };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The longest the server's thread was held up until the returned function is called: a timer that
 * should fire every 10 ms, and how late each of its ticks came (the last one checked at the end).
 */
function lagProbe() {
  const every = 10;
  let last = performance.now();
  let max = 0;
  const t = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last - every);
    last = now;
  }, every);
  return () => {
    clearInterval(t);
    return Math.max(0, max, performance.now() - last - every);
  };
}

/**
 * Times `work` while asking /api/meta every 25 ms beside it, as the status bar does on every page:
 * the slowest of those answers, and the longest the server's thread was held up meanwhile.
 */
async function beside(work) {
  let busy = true;
  let slowest = 0;
  let asked = 0;
  const pings = (async () => {
    while (busy) {
      const r = await ask('meta');
      slowest = Math.max(slowest, r.ms);
      asked++;
      await wait(25);
    }
  })();
  const stalled = lagProbe();
  const s = performance.now();
  const out = await work();
  const ms = performance.now() - s;
  const stall = stalled();
  busy = false;
  await pings;
  return { ...out, ms: out.ms ?? ms, meta: slowest, metaAsked: asked, stall };
}

/** Asks until the answer is no longer warming (`warming`): when the first answer came, and when the whole one did. */
async function untilWarm(path) {
  const s = performance.now();
  const first = await ask(path);
  const firstWarming = !!first.json()?.warming;
  let last = first;
  let polls = 1;
  while (last.status === 200 && last.json()?.warming) {
    await wait(250);
    last = await ask(path);
    polls++;
  }
  return { first: first.ms, ms: performance.now() - s, kb: last.kb, warming: firstWarming, polls, status: last.status };
}

const rows = [];
const add = (label, r, extra = '') => rows.push({ label, ...r, extra });
add('Runs text filter, first time', await beside(async () => untilWarm('runs/page?q=report&limit=50')));
add('Overview, first load', await beside(async () => untilWarm('summary?tz=UTC')));
const runAnswer = await beside(async () => ask(`runs/${big.runId}`));
const runBody = runAnswer.json();
const runPage = { ...runAnswer, total: runBody?.callsTotal ?? runBody?.calls?.length, next: runBody?.callsNext ?? null };
add(`run with ${bigCalls} calls, first answer`, runPage, runPage.next ? `${runBody.calls.length} of its calls, the next page from #${runPage.next}` : 'every call');
if (runPage.next) {
  const later = await beside(async () => {
    const r = await ask(`runs/${big.runId}/calls?from=${Math.floor(bigCalls / 2)}&limit=500`);
    return { ms: r.ms, kb: r.kb };
  });
  add('a page of its calls from the middle', later);
}
add('last model call of that run', await beside(async () => ask(`runs/${big.runId}/calls/${bigCalls % 2 === 0 ? bigCalls - 1 : bigCalls}`)));
add('compare the long run with its fork', await beside(async () => untilWarm(`compare?a=${big.runId}&b=${bigFork.runId}`)));
const rec = recordings[recordings.length - 1];
add('a 30-call run', await beside(async () => ask(`runs/${rec.runId}`)));
add('Overview, second load', await beside(async () => untilWarm('summary?tz=UTC')));
add('Runs text filter, second time', await beside(async () => untilWarm('runs/page?q=report&limit=50')));
add(`run list (${RUNS} runs)`, await beside(async () => ask('runs')));

process.stdout.write(`store: ${made} runs, ${bigCalls} calls in the long run and in its fork, ${(size / 1024 / 1024).toFixed(1)} MB, built in ${(built / 1000).toFixed(1)} s\n\n`);
process.stdout.write('| Request | First answer | Whole answer | Response | Slowest /api/meta beside it | Longest stall of the server thread | |\n|---|---|---|---|---|---|---|\n');
const f = (ms) => (ms === undefined ? '' : `${ms.toFixed(0)} ms`);
for (const r of rows) process.stdout.write(`| ${r.label} | ${f(r.first ?? r.ms)}${r.warming ? ' (warming)' : ''} | ${f(r.ms)} | ${r.kb.toFixed(0)} KB | ${f(r.meta)} (${r.metaAsked} asked) | ${f(r.stall)} | ${r.extra} |\n`);

if (serve) {
  process.stdout.write(`\n${dash.runUrl(big.runId)}\nCtrl-C stops\n`);
  await new Promise((r) => process.once('SIGINT', r));
}
await dash.close();
store.close();
rmSync(dir, { recursive: true, force: true });
