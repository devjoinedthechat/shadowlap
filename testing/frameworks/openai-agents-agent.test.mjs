// The OpenAI Agents SDK end to end, through shadowlap run: a real Agent run by run() on the SDK's
// default provider (the Responses API) with no base URL or key in its code, and tools made by tool()
// over definitions wrapped by withEffect, one named by its definition and one by its function. Its
// model calls must reach a scripted Responses API through the sidecar, its tool calls be recorded
// under the names the model called, a clean replay send nothing upstream and run no tool, and a fork
// run the read again and block the write while the agent answers: the SDK hands the model the
// refusal as the tool's output. Run as it returns and streamed.
//
// The SDK's trace export is off while recording and forking (OPENAI_AGENTS_DISABLE_TRACING): it posts
// to api.openai.com, which no test can stand in for. A replay answers it itself, so the clean replay
// runs with it on.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { startMockOpenAI, toolCall, turn } from '../mock-openai/dist/index.js';

const CLI = fileURLToPath(new URL('../../packages/cli/bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./openai-agents-agent.mjs', import.meta.url));
const ANSWER = 'Refunded 240 on A-1042.';

/** The tool the model asks for after `done` tool results: look the order up, refund it, then answer. */
const step = (done) => (done === 0 ? ['lookup_order', { order_id: 'A-1042' }] : done === 1 ? ['refund_order', { order_id: 'A-1042', amount: 240 }] : null);

describe('OpenAI Agents SDK Agent run by run(), through shadowlap run', () => {
  let openai;
  let cwd;
  let env;
  before(async () => {
    openai = await startMockOpenAI({
      script: () => ({ turn: turn('unused') }),
      responses: ({ context }) => {
        const next = step(context.filter((i) => i.type === 'function_call_output').length);
        return { turn: next ? turn(null, { tool_calls: [toolCall(...next)] }) : turn(ANSWER) };
      },
    });
    cwd = mkdtempSync(join(tmpdir(), 'sl-openai-agents-'));
    env = { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' };
    for (const k of Object.keys(env)) if (/_(BASE_URL|API_KEY)$/.test(k) || k === 'SHADOWLAP_URL' || k.startsWith('SHADOWLAP_UPSTREAM_') || k.startsWith('OPENAI_') || k === 'TICKET' || k === 'AGENTS_RUN' || k === 'NODE_ENV') delete env[k];
  });
  after(async () => {
    await openai.close();
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
  /** What the agent printed: its JSON line. */
  const printed = (r) => JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('{')));
  /** Each call of a run as `shadowlap show` lists it: kind, name, origin, outcome. */
  const timeline = async (runId) => {
    const shown = await shadowlap(['show', runId]);
    assert.equal(shown.code, 0, shown.out);
    return [...shown.out.matchAll(/#\d+\s+(api|tool)\s+(\S+(?: \S+)?)\s+(live|replayed|blocked|stubbed)\s+(\w+)/g)].map((m) => `${m[1]} ${m[2]} ${m[3]} ${m[4]}`);
  };
  const runIdOf = (out, verb) => new RegExp(`${verb} run (\\w{26})`).exec(out)?.[1];

  /** Record, replay clean with nothing upstream and no tool run, then fork on a changed ticket: the write is blocked, the agent still answers. */
  const roundTrip = async (run) => {
    const live = { OPENAI_API_KEY: 'placeholder-key-for-the-mock', SHADOWLAP_UPSTREAM_OPENAI: openai.url, OPENAI_AGENTS_DISABLE_TRACING: '1', AGENTS_RUN: run };
    const sent = openai.otherRequests.length;
    const recorded = await shadowlap(['run', '--', process.execPath, AGENT], live);
    assert.equal(recorded.code, 0, recorded.out);
    assert.deepEqual(printed(recorded), {
      text: ANSWER,
      outputs: [
        { order_id: 'A-1042', amount: 240 },
        { refunded: true, order_id: 'A-1042', amount: 240 },
      ],
      called: ['lookup_order', 'refund_order'],
      executed: ['lookup_order', 'refund_order'],
    });
    assert.match(recorded.out, /Recorded \w+: 5 calls \(3 api, 2 tool\), 3 upstream requests/);
    assert.equal(openai.otherRequests.length, sent + 3);
    assert.ok(openai.otherRequests.slice(sent).every((r) => r.path === '/v1/responses' && r.body.stream === (run === 'stream')));
    const runId = runIdOf(recorded.out, 'recording');
    // Recorded under the names the model called: `lookup order` and the function refund_order are lookup_order and refund_order to it.
    assert.deepEqual(await timeline(runId), ['api POST /v1/responses live ok', 'tool lookup_order live ok', 'api POST /v1/responses live ok', 'tool refund_order live ok', 'api POST /v1/responses live ok']);

    // No key, no upstream, and the SDK's trace export on: the recording answers, and nothing goes out.
    const replay = await shadowlap(['replay', runId, '--strict'], { AGENTS_RUN: run });
    assert.equal(replay.code, 0, replay.out);
    assert.deepEqual(printed(replay), { ...printed(recorded), executed: [] });
    assert.match(replay.out, /Replay clean: 5\/5 calls replayed \(3 api, 2 tool\), 0 upstream requests/);
    assert.equal(openai.otherRequests.length, sent + 3);

    const fork = await shadowlap(['replay', runId], { ...live, TICKET: 'Refund order A-1042, please.' });
    assert.equal(fork.code, 0, fork.out);
    assert.match(fork.out, /Forked at call 1: .*1 write blocked/);
    const forked = printed(fork);
    assert.deepEqual(forked.executed, ['lookup_order']);
    assert.equal(forked.text, ANSWER);
    // The SDK gives the model the refusal as the tool's output, and the run goes on to its answer.
    assert.match(forked.outputs[1], /ShadowlapWriteBlocked: write tool refund_order blocked after divergence/);
    assert.deepEqual(await timeline(runIdOf(fork.out, 'replaying')), ['api POST /v1/responses live ok', 'tool lookup_order live ok', 'api POST /v1/responses live ok', 'tool refund_order blocked error', 'api POST /v1/responses live ok']);
  };

  it('run(agent, input): records, replays clean, and a fork blocks the write while the agent answers', () => roundTrip('generate'));

  it('run(agent, input, { stream: true }): the same, streamed', () => roundTrip('stream'));
});
