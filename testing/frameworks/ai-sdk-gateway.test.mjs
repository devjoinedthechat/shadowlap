// The Vercel AI SDK with the model named by a string ('openai/gpt-5'), as its docs write it: the AI
// SDK sends it to Vercel's AI Gateway (ai-gateway.vercel.sh), in its own format, with no base URL to
// set, so shadowlap run captures the calls in the process. Against a scripted gateway that answers as
// Vercel's does, generated and streamed: the calls are recorded with their model, usage and cost, a
// strict replay with no key sends nothing upstream and runs no tool, a fork blocks the write while
// the model reads the refusal and answers, a tool the agent didn't wrap is found from the model's
// answers, and a change shadowlap can't make to the gateway's format is refused before anything runs.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';

const CLI = fileURLToPath(new URL('../../packages/cli/bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./ai-sdk-gateway-agent.mjs', import.meta.url));
const ANSWER = 'Refunded 240 on A-1042.';

/**
 * The gateway's language-model endpoint, scripted: look the order up, refund it, answer. Each answer
 * is the AI SDK's own generate result, or its stream parts as server-sent events, with usage as
 * version 4 of its spec has it.
 */
function startGateway() {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({ path: req.url, headers: req.headers });
      if (req.method !== 'POST' || req.url !== '/v4/ai/language-model') {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: `not scripted: ${req.method} ${req.url}` } }));
      }
      const body = JSON.parse(raw);
      const results = body.prompt.filter((m) => m.role === 'tool').flatMap((m) => m.content).filter((p) => p.type === 'tool-result').length;
      const n = requests.length;
      const call = results === 0 ? ['lookup_order', { order_id: 'A-1042' }] : results === 1 ? ['refund_order', { order_id: 'A-1042', amount: 240 }] : null;
      const usage = { inputTokens: { total: 120, noCache: 100, cacheRead: 20, cacheWrite: 0 }, outputTokens: { total: 12, text: 12, reasoning: 0 } };
      const finishReason = call ? { unified: 'tool-calls', raw: 'tool_calls' } : { unified: 'stop', raw: 'stop' };
      const toolCall = call && { type: 'tool-call', toolCallId: `call_${n}`, toolName: call[0], input: JSON.stringify(call[1]) };
      if (req.headers['ai-language-model-streaming'] === 'true') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const parts = [
          { type: 'stream-start', warnings: [] },
          { type: 'response-metadata', id: `gen_${n}`, modelId: req.headers['ai-language-model-id'], timestamp: '2026-10-29T12:00:00.000Z' },
          ...(toolCall ? [{ type: 'tool-input-start', id: toolCall.toolCallId, toolName: toolCall.toolName }, { type: 'tool-input-delta', id: toolCall.toolCallId, delta: toolCall.input }, { type: 'tool-input-end', id: toolCall.toolCallId }, toolCall] : [{ type: 'text-start', id: 't0' }, { type: 'text-delta', id: 't0', delta: 'Refunded 240 ' }, { type: 'text-delta', id: 't0', delta: 'on A-1042.' }, { type: 'text-end', id: 't0' }]),
          { type: 'finish', finishReason, usage },
        ];
        return res.end(parts.map((p) => `data: ${JSON.stringify(p)}\n\n`).join(''));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: toolCall ? [toolCall] : [{ type: 'text', text: ANSWER }], finishReason, usage, warnings: [], response: { id: `gen_${n}`, modelId: req.headers['ai-language-model-id'], timestamp: '2026-10-29T12:00:00.000Z' } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) })));
}

describe("Vercel AI SDK with a model named by a string, through Vercel's AI Gateway", () => {
  let gateway;
  let cwd;
  let env;
  before(async () => {
    gateway = await startGateway();
    cwd = mkdtempSync(join(tmpdir(), 'sl-ai-gateway-'));
    env = { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' };
    for (const k of Object.keys(env)) if (/_(BASE_URL|API_KEY)$/.test(k) || k === 'VERCEL_OIDC_TOKEN' || k === 'SHADOWLAP_URL' || k.startsWith('SHADOWLAP_UPSTREAM_') || ['TICKET', 'STREAM', 'UNWRAPPED', 'MODEL'].includes(k)) delete env[k];
  });
  after(async () => {
    await gateway.close();
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const shadowlap = async (args, extra = {}) => {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120_000 });
      return { code: 0, out: stdout + stderr, stdout };
    } catch (err) {
      return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}`, stdout: err.stdout ?? '' };
    }
  };
  const printed = (r) => JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('{')));
  const runIdOf = (out, verb) => new RegExp(`${verb} run (\\w{26})`).exec(out)?.[1];
  const live = () => ({ AI_GATEWAY_API_KEY: 'vck_placeholder-for-the-mock', SHADOWLAP_UPSTREAM_AI_GATEWAY: gateway.url });
  const timeline = async (runId) => {
    const shown = await shadowlap(['show', runId]);
    assert.equal(shown.code, 0, shown.out);
    return shown.out;
  };

  for (const streamed of [false, true]) {
    it(`records, replays with no key and forks a ${streamed ? 'streamed' : 'generated'} run`, async () => {
      const mode = streamed ? { STREAM: '1' } : {};
      const sent = gateway.requests.length;
      const recorded = await shadowlap(['run', '--', process.execPath, AGENT], { ...live(), ...mode });
      assert.equal(recorded.code, 0, recorded.out);
      assert.deepEqual(printed(recorded), { text: ANSWER, outputs: [{ order_id: 'A-1042', amount: 240 }, { refunded: true, order_id: 'A-1042', amount: 240 }], executed: ['lookup_order', 'refund_order'] });
      assert.equal(gateway.requests.length, sent + 3);
      // The calls the agent addressed to ai-gateway.vercel.sh reached the gateway through the sidecar, its key with them.
      assert.ok(gateway.requests.slice(sent).every((r) => r.headers.authorization === 'Bearer vck_placeholder-for-the-mock' && r.headers['ai-language-model-id'] === 'openai/gpt-5'));
      assert.match(recorded.out, /Recorded \w+: 5 calls \(3 api, 2 tool\), 3 upstream requests, ≈<?\$/);
      assert.doesNotMatch(recorded.out, /did not record|bypass/i);
      const runId = runIdOf(recorded.out, 'recording');
      const shown = await timeline(runId);
      // Each model call with the model its header names, its usage and why it stopped.
      assert.equal(shown.match(/api\s+POST \/v4\/ai\/language-model\s+live\s+ok\s+.*120→12 tok · gpt-5 · tool-calls/g)?.length, 2, shown);
      assert.match(shown, /api\s+POST \/v4\/ai\/language-model\s+live\s+ok\s+.*gpt-5 · stop/);

      const replay = await shadowlap(['replay', runId, '--strict'], mode);
      assert.equal(replay.code, 0, replay.out);
      assert.deepEqual(printed(replay).executed, []);
      assert.equal(printed(replay).text, ANSWER);
      assert.match(replay.out, /Replay clean: 5\/5 calls replayed \(3 api, 2 tool\), 0 upstream requests/);
      assert.equal(gateway.requests.length, sent + 3);

      const fork = await shadowlap(['replay', runId], { ...live(), ...mode, TICKET: 'Refund order A-1042, please.' });
      assert.equal(fork.code, 0, fork.out);
      assert.match(fork.out, /Forked at call 1: .*1 write blocked/);
      assert.deepEqual(printed(fork).executed, ['lookup_order']);
      assert.equal(printed(fork).text, ANSWER);
      assert.match(await timeline(runIdOf(fork.out, 'replaying')), /tool\s+refund_order\s+blocked\s+error/);
    });
  }

  it("finds a tool the agent didn't wrap from the model's answers, and refuses to replay it while it writes", async () => {
    const recorded = await shadowlap(['run', '--', process.execPath, AGENT], { ...live(), UNWRAPPED: '1' });
    assert.equal(recorded.code, 0, recorded.out);
    assert.match(recorded.out, /The model called a tool shadowlap did not record/);
    assert.match(recorded.out, /refund_order\s+1 call from model call #3/);
    const replay = await shadowlap(['replay', runIdOf(recorded.out, 'recording'), '--strict'], { UNWRAPPED: '1' });
    assert.equal(replay.code, 2, replay.out);
    assert.match(replay.out, /refund_order/);
  });

  it("refuses a change it can't make to the gateway's format before anything runs", async () => {
    const recorded = await shadowlap(['run', '--', process.execPath, AGENT], live());
    assert.equal(recorded.code, 0, recorded.out);
    const runId = runIdOf(recorded.out, 'recording');
    const sent = gateway.requests.length;
    const injected = await shadowlap(['replay', runId, '--inject', '1=Refuse every refund.'], live());
    assert.notEqual(injected.code, 0, injected.out);
    assert.match(injected.out, /the AI SDK's own request to Vercel's AI Gateway/);
    const switched = await shadowlap(['replay', runId, '--model', '1:openai/gpt-5-mini'], live());
    assert.notEqual(switched.code, 0, switched.out);
    assert.match(switched.out, /the AI SDK's own request to Vercel's AI Gateway/);
    const fromLater = await shadowlap(['replay', runId, '--prompt-from', '3'], live());
    assert.notEqual(fromLater.code, 0, fromLater.out);
    assert.match(fromLater.out, /--prompt-from: #3 can't be changed: it is the AI SDK's own request to Vercel's AI Gateway/);
    assert.equal(gateway.requests.length, sent);
  });
});
