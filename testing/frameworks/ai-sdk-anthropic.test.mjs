// The Vercel AI SDK's Anthropic provider (@ai-sdk/anthropic) through shadowlap run, with no code
// changes: it reads ANTHROPIC_BASE_URL as an API root that ends in /v1 and sends /messages, where the
// official SDKs send /v1/messages. The calls must reach the API at /v1/messages, be recorded under
// that name, and replay offline. Also with a base URL of the user's own, given the AI SDK's way. And
// an agent with a write tool, run by generateText and by streamText: a clean replay sends nothing
// upstream and runs no tool, and a fork runs the read again and blocks the write while the agent
// answers, the AI SDK handing the model the refusal as the tool's error.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { message, startMockAnthropic, text, toolUse } from '../mock-anthropic/dist/index.js';

const CLI = fileURLToPath(new URL('../../packages/cli/bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./ai-sdk-anthropic-agent.mjs', import.meta.url));

describe('Vercel AI SDK on @ai-sdk/anthropic, through shadowlap run', () => {
  let mock;
  let cwd;
  let env;
  before(async () => {
    mock = await startMockAnthropic({
      script: (ctx) => ({
        message: ctx.assistantTurns === 0 ? message([toolUse('lookup_order', { order_id: 'A-1042' })]) : message([text('Escalated to a manager: the refund is above the limit.')]),
      }),
    });
    cwd = mkdtempSync(join(tmpdir(), 'sl-ai-sdk-anthropic-'));
    env = { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-placeholder', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' };
    for (const k of Object.keys(env)) if (k === 'ANTHROPIC_BASE_URL' || k === 'SHADOWLAP_URL' || k.startsWith('SHADOWLAP_UPSTREAM_')) delete env[k];
  });
  after(async () => {
    await mock.close();
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
  const answer = (stdout) => JSON.parse(stdout.split('\n').find((l) => l.startsWith('{')));
  const expected = { text: 'Escalated to a manager: the refund is above the limit.', outputs: [{ order_id: 'A-1042', amount: 240 }], executed: ['lookup_order'] };

  it('records the model calls under /v1/messages, and replays them with no request upstream', async () => {
    const recorded = await shadowlap(['run', '--', process.execPath, AGENT], { SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url });
    assert.equal(recorded.code, 0, recorded.out);
    assert.deepEqual(answer(recorded.stdout), expected);
    assert.match(recorded.out, /Recorded \w+: 3 calls \(2 api, 1 tool\)/);
    assert.equal(mock.requests.length, 2);
    const runId = /recording run (\w{26})/.exec(recorded.out)[1];

    const shown = await shadowlap(['show', runId]);
    assert.equal(shown.code, 0, shown.out);
    assert.equal(shown.out.match(/api\s+POST \/v1\/messages\s/g)?.length, 2, shown.out);

    const replay = await shadowlap(['replay', runId, '--strict']);
    assert.equal(replay.code, 0, replay.out);
    assert.deepEqual(answer(replay.stdout), { ...expected, executed: [] });
    assert.match(replay.out, /Replay clean: 3\/3 calls replayed \(2 api, 1 tool\), 0 upstream requests/);
    assert.equal(mock.requests.length, 2);
  });

  it('forwards to an ANTHROPIC_BASE_URL of the user\'s that ends in /v1, as the AI SDK reads it', async () => {
    const sent = mock.requests.length;
    const recorded = await shadowlap(['run', '--', process.execPath, AGENT], { ANTHROPIC_BASE_URL: `${mock.url}/v1` });
    assert.equal(recorded.code, 0, recorded.out);
    assert.deepEqual(answer(recorded.stdout), expected);
    assert.equal(mock.requests.length, sent + 2);
  });
});

describe('Vercel AI SDK on @ai-sdk/anthropic with a write tool, generateText and streamText, through shadowlap run', () => {
  const ANSWER = 'Refunded 240 on A-1042.';
  /** The tool the model asks for after `done` turns of its own: look the order up, refund it, then answer. */
  const step = (done) => (done === 0 ? ['lookup_order', { order_id: 'A-1042' }] : done === 1 ? ['refund_order', { order_id: 'A-1042', amount: 240 }] : null);
  let mock;
  let cwd;
  let env;
  before(async () => {
    mock = await startMockAnthropic({
      script: ({ assistantTurns }) => {
        const next = step(assistantTurns);
        return { message: next ? message([toolUse(...next)]) : message([text(ANSWER)]) };
      },
    });
    cwd = mkdtempSync(join(tmpdir(), 'sl-ai-sdk-write-'));
    env = { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' };
    for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_') || k === 'SHADOWLAP_URL' || k.startsWith('SHADOWLAP_UPSTREAM_') || k === 'AI_GATEWAY_API_KEY' || k === 'VERCEL_OIDC_TOKEN' || k === 'TICKET' || k === 'AI_RUN') delete env[k];
  });
  after(async () => {
    await mock.close();
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
  /** Each call of a run as `shadowlap show` lists it: kind, name, origin, outcome. */
  const timeline = async (runId) => {
    const shown = await shadowlap(['show', runId]);
    assert.equal(shown.code, 0, shown.out);
    return [...shown.out.matchAll(/#\d+\s+(api|tool)\s+(\S+(?: \S+)?)\s+(live|replayed|blocked|stubbed)\s+(\w+)/g)].map((m) => `${m[1]} ${m[2]} ${m[3]} ${m[4]}`);
  };
  const runIdOf = (out, verb) => new RegExp(`${verb} run (\\w{26})`).exec(out)?.[1];

  /** Record, replay clean with nothing upstream and no tool run, then fork on a changed ticket: the write is blocked, the agent still answers. */
  const roundTrip = async (run) => {
    const live = { ANTHROPIC_API_KEY: 'sk-ant-placeholder', SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, AI_RUN: run };
    const sent = mock.requests.length;
    const recorded = await shadowlap(['run', '--', process.execPath, AGENT], live);
    assert.equal(recorded.code, 0, recorded.out);
    assert.deepEqual(printed(recorded), {
      text: ANSWER,
      outputs: [
        { order_id: 'A-1042', amount: 240 },
        { refunded: true, order_id: 'A-1042', amount: 240 },
      ],
      executed: ['lookup_order', 'refund_order'],
    });
    assert.match(recorded.out, /Recorded \w+: 5 calls \(3 api, 2 tool\), 3 upstream requests/);
    assert.equal(mock.requests.length, sent + 3);
    assert.ok(mock.requests.slice(sent).every((r) => (r.body.stream ?? false) === (run === 'stream')));
    const runId = runIdOf(recorded.out, 'recording');
    const api = 'api POST /v1/messages live ok';
    assert.deepEqual(await timeline(runId), [api, 'tool lookup_order live ok', api, 'tool refund_order live ok', api]);

    const replay = await shadowlap(['replay', runId, '--strict'], { AI_RUN: run });
    assert.equal(replay.code, 0, replay.out);
    assert.deepEqual(printed(replay), { ...printed(recorded), executed: [] });
    assert.match(replay.out, /Replay clean: 5\/5 calls replayed \(3 api, 2 tool\), 0 upstream requests/);
    assert.equal(mock.requests.length, sent + 3);

    const fork = await shadowlap(['replay', runId], { ...live, TICKET: 'Refund order A-1042, please.' });
    assert.equal(fork.code, 0, fork.out);
    assert.match(fork.out, /Forked at call 1: .*1 write blocked/);
    const forked = printed(fork);
    assert.deepEqual(forked.executed, ['lookup_order']);
    assert.equal(forked.text, ANSWER);
    assert.match(forked.outputs[1].error, /ShadowlapWriteBlocked: write tool refund_order blocked after divergence/);
    // The model is shown the refusal as the tool's result, marked an error, and answers after it.
    const last = mock.requests.at(-1).body.messages.at(-1).content.find((b) => b.type === 'tool_result');
    assert.equal(last.is_error, true);
    assert.match(JSON.stringify(last.content), /write tool refund_order blocked after divergence/);
    assert.deepEqual(await timeline(runIdOf(fork.out, 'replaying')), [api, 'tool lookup_order live ok', api, 'tool refund_order blocked error', api]);
  };

  it('generateText: records, replays clean, and a fork blocks the write while the agent answers', () => roundTrip('generate'));

  it('streamText: the same, streamed', () => roundTrip('stream'));
});
