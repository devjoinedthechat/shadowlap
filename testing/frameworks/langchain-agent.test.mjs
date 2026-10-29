// LangChain / LangGraph end to end, through shadowlap run: a chat model class (ChatOpenAI on Chat
// Completions, ChatAnthropic on the Messages API) with no base URL or key in its code, in LangChain's
// own agent loop, createAgent from langchain and LangGraph's prebuilt createReactAgent, with tools
// made by tool() and wrapped by withEffect. Its model calls must reach a scripted API through the
// sidecar, a clean replay send nothing upstream and run no tool, and a fork run the read again and
// block the write while the agent answers: both loops' ToolNode hands the model the refusal as the
// tool's message by default. Invoked and streamed (streamMode "messages", which streams the model's
// tokens), each loop on each model once.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { message, startMockAnthropic, text, toolUse } from '../mock-anthropic/dist/index.js';
import { startMockOpenAI, toolCall, turn } from '../mock-openai/dist/index.js';

const CLI = fileURLToPath(new URL('../../packages/cli/bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./langchain-agent.mjs', import.meta.url));
const ANSWER = 'Refunded 240 on A-1042.';

/** The tool the model asks for after `done` turns of its own: look the order up, refund it, then answer. */
const step = (done) => (done === 0 ? ['lookup_order', { order_id: 'A-1042' }] : done === 1 ? ['refund_order', { order_id: 'A-1042', amount: 240 }] : null);

describe('LangChain agents (createAgent, createReactAgent) on ChatOpenAI and ChatAnthropic, through shadowlap run', () => {
  let openai;
  let anthropic;
  let cwd;
  let env;
  before(async () => {
    openai = await startMockOpenAI({
      script: ({ assistantTurns }) => {
        const next = step(assistantTurns);
        return { turn: next ? turn(null, { tool_calls: [toolCall(...next)] }) : turn(ANSWER) };
      },
    });
    anthropic = await startMockAnthropic({
      script: ({ assistantTurns }) => {
        const next = step(assistantTurns);
        return { message: next ? message([toolUse(...next)]) : message([text(ANSWER)]) };
      },
    });
    cwd = mkdtempSync(join(tmpdir(), 'sl-langchain-agent-'));
    env = { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' };
    for (const k of Object.keys(env)) {
      if (/_(BASE_URL|API_KEY|API_BASE|API_URL)$/.test(k) || k === 'SHADOWLAP_URL' || k.startsWith('SHADOWLAP_UPSTREAM_') || k.startsWith('OPENAI_') || k.startsWith('ANTHROPIC_')) delete env[k];
      else if (k.startsWith('LANGSMITH_') || k.startsWith('LANGCHAIN_') || ['LC_AGENT', 'LC_MODEL', 'LC_RUN', 'TICKET', 'NODE_ENV'].includes(k)) delete env[k];
    }
  });
  after(async () => {
    await openai.close();
    await anthropic.close();
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
  const roundTrip = async ({ agent, model, run }) => {
    const mock = model === 'openai' ? openai : anthropic;
    const api = model === 'openai' ? 'POST /v1/chat/completions' : 'POST /v1/messages';
    const live =
      model === 'openai'
        ? { OPENAI_API_KEY: 'placeholder-key-for-the-mock', SHADOWLAP_UPSTREAM_OPENAI: openai.url }
        : { ANTHROPIC_API_KEY: 'placeholder-key-for-the-mock', SHADOWLAP_UPSTREAM_ANTHROPIC: anthropic.url };
    const agentEnv = { LC_AGENT: agent, LC_MODEL: model, LC_RUN: run };
    const sent = mock.requests.length;
    const recorded = await shadowlap(['run', '--', process.execPath, AGENT], { ...live, ...agentEnv });
    assert.equal(recorded.code, 0, recorded.out);
    const answered = printed(recorded);
    assert.deepEqual(answered, {
      text: ANSWER,
      outputs: [
        { name: 'lookup_order', status: 'success', content: JSON.stringify({ order_id: 'A-1042', amount: 240 }) },
        { name: 'refund_order', status: 'success', content: JSON.stringify({ refunded: true, order_id: 'A-1042', amount: 240 }) },
      ],
      executed: ['lookup_order', 'refund_order'],
    });
    assert.match(recorded.out, /Recorded \w+: 5 calls \(3 api, 2 tool\), 3 upstream requests/);
    assert.equal(mock.requests.length, sent + 3);
    // Streamed when the agent streams: the model's tokens come back as server-sent events.
    assert.ok(mock.requests.slice(sent).every((r) => (r.body.stream ?? false) === (run === 'stream')), JSON.stringify(mock.requests.slice(sent).map((r) => r.body.stream)));
    const runId = runIdOf(recorded.out, 'recording');
    assert.deepEqual(await timeline(runId), [`api ${api} live ok`, 'tool lookup_order live ok', `api ${api} live ok`, 'tool refund_order live ok', `api ${api} live ok`]);

    // No key and no upstream: the recording answers, and nothing goes out.
    const replay = await shadowlap(['replay', runId, '--strict'], agentEnv);
    assert.equal(replay.code, 0, replay.out);
    assert.deepEqual(printed(replay), { ...answered, executed: [] });
    assert.match(replay.out, /Replay clean: 5\/5 calls replayed \(3 api, 2 tool\), 0 upstream requests/);
    assert.equal(mock.requests.length, sent + 3);

    const fork = await shadowlap(['replay', runId], { ...live, ...agentEnv, TICKET: 'Refund order A-1042, please.' });
    assert.equal(fork.code, 0, fork.out);
    assert.match(fork.out, /Forked at call 1: .*1 write blocked/);
    const forked = printed(fork);
    assert.deepEqual(forked.executed, ['lookup_order']);
    assert.equal(forked.text, ANSWER);
    // ToolNode catches the refusal and gives it to the model as the tool's message, and the run goes
    // on to its answer. LangGraph's ToolNode marks that message an error; createAgent's gives it no
    // status, as it does any tool error.
    const refusal = forked.outputs[1];
    assert.equal(refusal.name, 'refund_order');
    assert.match(refusal.content, /write tool refund_order blocked after divergence/);
    assert.equal(refusal.status, agent === 'react' ? 'error' : undefined);
    assert.deepEqual(await timeline(runIdOf(fork.out, 'replaying')), [`api ${api} live ok`, 'tool lookup_order live ok', `api ${api} live ok`, 'tool refund_order blocked error', `api ${api} live ok`]);
  };

  it('createAgent on ChatOpenAI, invoked: records, replays clean, and a fork blocks the write while the agent answers', () => roundTrip({ agent: 'create', model: 'openai', run: 'invoke' }));

  it('createAgent on ChatAnthropic, streamed: the same', () => roundTrip({ agent: 'create', model: 'anthropic', run: 'stream' }));

  it('createReactAgent on ChatOpenAI, streamed: the same', () => roundTrip({ agent: 'react', model: 'openai', run: 'stream' }));

  it('createReactAgent on ChatAnthropic, invoked: the same', () => roundTrip({ agent: 'react', model: 'anthropic', run: 'invoke' }));
});
