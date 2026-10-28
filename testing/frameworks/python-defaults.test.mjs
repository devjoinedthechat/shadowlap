// Python frameworks on the model client each builds when given none, run by the real CLI as a user
// runs them: `shadowlap run -- python agent.py`, with nothing in the agent naming Shadowlap's address.
// Strands' BedrockModel, Agno's OpenAIResponses, Microsoft Agent Framework's OpenAIChatClient (the
// Responses API), LlamaIndex's OpenAI LLM and smolagents' CodeAgent. Each asks a scripted model API to
// research QUERY and email the team: a recording with both tools run, a strict replay with the
// upstream unreachable that runs no tool, and a fork on another QUERY where the email is blocked, the
// framework hands the refusal to its model, and the run completes.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { Store } from '../../packages/engine/dist/index.js';
import { startMockOpenAI, toolCall, turn } from '../mock-openai/dist/index.js';
import { AWS, startCloudMock } from './cloud-mock.mjs';
import { toolTrace } from './harness.mjs';
import { findPython } from './python.mjs';

const CLI = fileURLToPath(new URL('../../packages/cli/bin/shadowlap.js', import.meta.url));
const agentPath = (name) => fileURLToPath(new URL(`./defaults/${name}`, import.meta.url));

// The scripted conversation, read from what it holds rather than its turns: search, then email, then answer.
const asked = (conversation) => /Research (\S+?) and email/.exec(JSON.stringify(conversation))?.[1] ?? 'nothing';
const searched = (conversation) => /#1/.test(JSON.stringify(conversation));
const emailed = (conversation) => /sent to|blocked|failed/i.test(JSON.stringify(conversation));
const answer = (conversation) => `Emailed the team about ${asked(conversation)}.`;
/** The next turn, as tool calls or text. */
function next(conversation) {
  if (!searched(conversation)) return { tool: ['search_web', { query: asked(conversation) }] };
  if (!emailed(conversation)) return { tool: ['send_email', { to: 'team@example.com', body: `found ${asked(conversation)} #1` }] };
  return { text: answer(conversation) };
}

/** Bedrock Converse, answered in its own shape, through the cloud mock (which checks every SigV4 signature). */
async function bedrockModel() {
  let n = 0;
  const mock = await startCloudMock({
    converse: (body) => {
      const t = next(body.messages);
      return t.tool ? { content: [{ toolUse: { toolUseId: `tooluse_${++n}`, name: t.tool[0], input: t.tool[1] } }], stopReason: 'tool_use' } : { content: [{ text: t.text }], stopReason: 'end_turn' };
    },
  });
  return { mock, upstream: { SHADOWLAP_UPSTREAM_BEDROCK: mock.url }, count: () => mock.stats.requests, env: { AWS_ACCESS_KEY_ID: AWS.accessKeyId, AWS_SECRET_ACCESS_KEY: AWS.secretAccessKey, AWS_REGION: AWS.region, AWS_EC2_METADATA_DISABLED: 'true' } };
}

/** OpenAI's Chat Completions and Responses APIs. */
async function openaiModel() {
  const asTurn = (t) => (t.tool ? turn(null, { tool_calls: [toolCall(...t.tool)] }) : turn(t.text));
  const mock = await startMockOpenAI({
    script: ({ request }) => ({ turn: asTurn(next(request.messages)) }),
    responses: ({ context }) => ({ turn: asTurn(next(context)) }),
  });
  return { mock, upstream: { SHADOWLAP_UPSTREAM_OPENAI: mock.url }, count: () => mock.requests.length + mock.otherRequests.length, env: { OPENAI_API_KEY: 'sk-placeholder' } };
}

const CASES = [
  {
    name: 'Strands Agents on its default BedrockModel (ConverseStream through boto3)',
    module: 'strands',
    script: 'strands_default.py',
    model: bedrockModel,
    client: 'BedrockModel',
    provider: 'bedrock',
    refused: (value) => assert.ok(value.results.some((r) => r.status === 'error' && /blocked/.test(r.content.join(' '))), JSON.stringify(value.results)),
  },
  {
    name: 'Agno on its default OpenAIResponses (the Responses API, chained by previous_response_id)',
    module: 'agno, openai',
    script: 'agno_default.py',
    model: openaiModel,
    client: 'OpenAIResponses',
    provider: 'openai',
    // Agno reports each run to os-api.agno.com unless told not to: a connection outside Shadowlap.
    env: { AGNO_TELEMETRY: 'false' },
    refused: (value) => assert.ok(value.results.some((r) => /blocked/.test(r.result)), JSON.stringify(value.results)),
  },
  {
    name: 'Microsoft Agent Framework on OpenAIChatClient (the Responses API)',
    module: 'agent_framework.openai',
    script: 'agent_framework_default.py',
    model: openaiModel,
    client: 'OpenAIChatClient',
    provider: 'openai',
    // Agent Framework hands its model a failed function without the exception's details, unless asked to.
    refused: (value) => assert.ok(value.results.some((r) => /^Error: Function failed/.test(r.result)), JSON.stringify(value.results)),
  },
  {
    name: "LlamaIndex on its default LLM (llama-index-llms-openai's OpenAI, which ignores OPENAI_BASE_URL)",
    module: 'llama_index.core, llama_index.llms.openai',
    script: 'llamaindex_default.py',
    model: openaiModel,
    client: 'OpenAI',
    provider: 'openai',
    refused: (value) => assert.ok(value.results.some((r) => r.name === 'send_email' && r.is_error && /blocked/.test(r.output)), JSON.stringify(value.results)),
  },
];

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'sl-py-defaults-'));
});
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

for (const c of CASES) {
  const PYTHON = findPython(c.module);
  describe(c.name, { skip: PYTHON ? false : `no Python with ${c.module} (set SHADOWLAP_PYTHON)` }, () => {
    let model;
    let db;
    let recordedRun;
    let recorded;
    before(async () => {
      model = await c.model();
      db = join(dir, `${CASES.indexOf(c)}.db`);
    });
    after(() => model.mock.close());

    // In the test's own folder: run and replay keep their active-run file in the one they run in.
    const shadowlap = async (args, extra) => {
      const env = { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', ...model.env, ...c.env, ...extra };
      for (const k of Object.keys(env)) if (/^(OPENAI|ANTHROPIC)_BASE_URL$|^SHADOWLAP_(URL|RUN_ID)$/.test(k)) delete env[k];
      try {
        const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, '--db', db, ...args], { cwd: dir, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
        return { code: 0, out: stdout + stderr, stdout };
      } catch (err) {
        return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}`, stdout: err.stdout ?? '' };
      }
    };
    const printed = (stdout) => JSON.parse(stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop());
    const callsOf = (runId) => {
      const store = Store.open(db);
      try {
        return { calls: store.getCalls(runId), latest: store.listRuns(1)[0] };
      } finally {
        store.close();
      }
    };
    const unreachable = () => Object.fromEntries(Object.keys(model.upstream).map((k) => [k, 'http://127.0.0.1:9']));

    it(`records the ${c.client}'s calls and both tools, with nothing in the agent pointing it at Shadowlap`, async () => {
      const r = await shadowlap(['run', '--', PYTHON, agentPath(c.script)], { ...model.upstream, QUERY: 'shadowlap' });
      assert.equal(r.code, 0, r.out);
      assert.doesNotMatch(r.out, /bypasses Shadowlap/);
      recorded = printed(r.stdout);
      assert.equal(recorded.model, c.client);
      assert.match(recorded.answer, /Emailed the team about shadowlap\./);
      assert.deepEqual(recorded.executed, ['search_web', 'send_email']);
      recordedRun = /recording run (\w{26})/.exec(r.out)[1];
      const { calls } = callsOf(recordedRun);
      const api = calls.filter((x) => x.kind === 'api');
      assert.equal(api.length, 3, JSON.stringify(calls.map((x) => x.name)));
      assert.ok(api.every((x) => x.origin === 'live' && x.end?.outcome === 'ok' && x.meta.provider === c.provider), JSON.stringify(api.map((x) => [x.name, x.meta.provider, x.end?.outcome])));
      assert.deepEqual(toolTrace(calls), ['search_web:read:live:ok', 'send_email:write:live:ok']);
      assert.equal(model.count(), 3);
    });

    it('replays strictly with the upstream unreachable: no model request, no tool run', async () => {
      const sent = model.count();
      const r = await shadowlap(['replay', recordedRun, '--strict'], { ...unreachable(), QUERY: 'shadowlap' });
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /Replay clean: 5\/5 calls replayed \(3 api, 2 tool\), 0 upstream requests/);
      const replayed = printed(r.stdout);
      assert.deepEqual(replayed.executed, []);
      assert.equal(replayed.answer, recorded.answer);
      assert.equal(model.count(), sent);
    });

    it('forks at the first model call on another request, blocks the email, and completes', async () => {
      const r = await shadowlap(['replay', recordedRun], { ...model.upstream, QUERY: 'replays' });
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /Diverged at call 1/);
      const fork = printed(r.stdout);
      assert.match(fork.answer, /Emailed the team about replays\./);
      assert.deepEqual(fork.executed, ['search_web']);
      const { calls, latest } = callsOf(recordedRun);
      assert.ok(calls.length && latest.runId !== recordedRun);
      assert.deepEqual(toolTrace(callsOf(latest.runId).calls), ['search_web:read:live:ok', 'send_email:write:blocked:error']);
      c.refused(fork);
    });
  });
}
