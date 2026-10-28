// Mastra end to end, through shadowlap run: a real Agent on Mastra's model router, with no base URL or
// key in its code, and tools wrapped by withEffect that the agent knows by their keys in `tools`, not
// their ids, as Mastra's own template has them. Its model calls must reach a scripted provider API
// through the sidecar, its tool calls be recorded under the names the model called, a clean replay
// send nothing upstream and run no tool, and a fork run the read again and block the write while the
// agent answers. On OpenAI (Responses API, OPENAI_BASE_URL), Anthropic (ANTHROPIC_BASE_URL, streamed)
// and Google (captured in the process; the key in GOOGLE_GENERATIVE_AI_API_KEY, as Mastra reads it),
// and a workflow whose steps are the tools.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { message, startMockAnthropic, text, toolUse } from '../mock-anthropic/dist/index.js';
import { functionCall, startMockGemini, turn as geminiTurn } from '../mock-gemini/dist/index.js';
import { startMockOpenAI, toolCall, turn } from '../mock-openai/dist/index.js';

const CLI = fileURLToPath(new URL('../../packages/cli/bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./mastra-agent.mjs', import.meta.url));
const ANSWER = 'Refunded 240 on A-1042.';

/** The tool the model asks for after `done` tool results: look the order up, refund it, then answer. */
const step = (done) => (done === 0 ? ['lookupOrder', { order_id: 'A-1042' }] : done === 1 ? ['refundOrder', { order_id: 'A-1042', amount: 240 }] : null);

describe('Mastra Agent and workflow through shadowlap run', () => {
  let openai;
  let anthropic;
  let gemini;
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
    anthropic = await startMockAnthropic({
      script: (ctx) => {
        const next = step(ctx.assistantTurns);
        return { message: next ? message([toolUse(...next)]) : message([text(ANSWER)]) };
      },
    });
    gemini = await startMockGemini({
      script: ({ request }) => {
        const next = step(request.contents.flatMap((c) => c.parts).filter((p) => p.functionResponse).length);
        return { turn: next ? geminiTurn(null, { functionCalls: [functionCall(...next)] }) : geminiTurn(ANSWER) };
      },
    });
    cwd = mkdtempSync(join(tmpdir(), 'sl-mastra-'));
    env = { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' };
    for (const k of Object.keys(env)) if (/_(BASE_URL|API_KEY)$/.test(k) || k === 'SHADOWLAP_URL' || k.startsWith('SHADOWLAP_UPSTREAM_') || k.startsWith('MASTRA_') || k === 'TICKET') delete env[k];
  });
  after(async () => {
    await Promise.all([openai.close(), anthropic.close(), gemini.close()]);
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
  const roundTrip = async ({ provider, upstream, key, model, api, run = 'generate' }) => {
    const live = { [key]: 'placeholder-key-for-the-mock', [`SHADOWLAP_UPSTREAM_${provider}`]: upstream, MASTRA_MODEL: model, MASTRA_RUN: run };
    const recorded = await shadowlap(['run', '--', process.execPath, AGENT], live);
    assert.equal(recorded.code, 0, recorded.out);
    assert.deepEqual(printed(recorded), { text: ANSWER, outputs: [{ order_id: 'A-1042', amount: 240 }, { refunded: true, order_id: 'A-1042', amount: 240 }], executed: ['lookup-order', 'refund-order'] });
    assert.match(recorded.out, /Recorded \w+: 5 calls \(3 api, 2 tool\), 3 upstream requests/);
    assert.doesNotMatch(recorded.out, /did not record/);
    const runId = runIdOf(recorded.out, 'recording');
    // Recorded under the names the model called them by, the agent's keys, so a replay finds them.
    assert.deepEqual(await timeline(runId), [`api ${api} live ok`, 'tool lookupOrder live ok', `api ${api} live ok`, 'tool refundOrder live ok', `api ${api} live ok`]);

    // No key and no upstream: the recording answers, and the replay gets a placeholder in the variable the recording held its key in.
    const replay = await shadowlap(['replay', runId, '--strict'], { MASTRA_MODEL: model, MASTRA_RUN: run });
    assert.equal(replay.code, 0, replay.out);
    assert.deepEqual(printed(replay).executed, []);
    assert.equal(printed(replay).text, ANSWER);
    assert.match(replay.out, /Replay clean: 5\/5 calls replayed \(3 api, 2 tool\), 0 upstream requests/);

    const fork = await shadowlap(['replay', runId], { ...live, TICKET: 'Refund order A-1042, please.' });
    assert.equal(fork.code, 0, fork.out);
    assert.match(fork.out, /Forked at call 1: .*1 write blocked/);
    assert.deepEqual(printed(fork).executed, ['lookup-order']);
    assert.equal(printed(fork).text, ANSWER);
    assert.deepEqual((await timeline(runIdOf(fork.out, 'replaying'))).filter((c) => c.startsWith('tool')), ['tool lookupOrder live ok', 'tool refundOrder blocked error']);
  };

  it('on OpenAI: the Responses API through OPENAI_BASE_URL', () => roundTrip({ provider: 'OPENAI', upstream: openai.url, key: 'OPENAI_API_KEY', model: 'openai/gpt-5', api: 'POST /v1/responses' }));

  it('on Anthropic, streamed: Messages through ANTHROPIC_BASE_URL', () => roundTrip({ provider: 'ANTHROPIC', upstream: anthropic.url, key: 'ANTHROPIC_API_KEY', model: 'anthropic/claude-opus-5', api: 'POST /v1/messages', run: 'stream' }));

  it('on Google: captured in the process, its key in GOOGLE_GENERATIVE_AI_API_KEY', () =>
    roundTrip({ provider: 'GEMINI', upstream: gemini.url, key: 'GOOGLE_GENERATIVE_AI_API_KEY', model: 'google/gemini-2.5-flash', api: 'POST /v1beta/models/gemini-2.5-flash:generateContent' }));

  it('in a workflow: steps made from the tools are recorded by id, replayed without running, and a fork blocks the write step', async () => {
    const recorded = await shadowlap(['run', '--', process.execPath, AGENT], { MASTRA_RUN: 'workflow' });
    assert.equal(recorded.code, 0, recorded.out);
    assert.deepEqual(printed(recorded), { status: 'success', result: { refunded: true, order_id: 'A-1042', amount: 240 }, executed: ['lookup-order', 'refund-order'] });
    const runId = runIdOf(recorded.out, 'recording');
    assert.deepEqual(await timeline(runId), ['tool lookup-order live ok', 'tool refund-order live ok']);

    const replay = await shadowlap(['replay', runId, '--strict'], { MASTRA_RUN: 'workflow' });
    assert.equal(replay.code, 0, replay.out);
    assert.deepEqual(printed(replay), { status: 'success', result: { refunded: true, order_id: 'A-1042', amount: 240 }, executed: [] });

    // No model to tell: the blocked write fails its step, and the workflow says so.
    const fork = await shadowlap(['replay', runId], { MASTRA_RUN: 'workflow', TICKET: 'Refund order A-2000.' });
    assert.equal(fork.code, 0, fork.out);
    assert.equal(printed(fork).status, 'failed');
    assert.deepEqual(printed(fork).executed, ['lookup-order']);
    assert.match(fork.out, /ShadowlapWriteBlocked: write tool refund-order blocked after divergence/);
  });
});
