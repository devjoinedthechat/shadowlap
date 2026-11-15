// Shared by the tests of a Python framework's own agent loop on a real model client, run by the real
// CLI as a user runs it: `shadowlap run -- python agent.py` (an agent in ./loops), with nothing in the
// agent naming shadowlap's address. The agent asks a scripted OpenAI API to research QUERY and email
// the team: a recording with both tools run, a strict replay with the upstream unreachable that runs
// no tool, and a fork on another QUERY where the email is blocked, the framework hands the refusal to
// its model, and the run completes. One framework to a file: node --test's timeout holds a whole file.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { Store } from '../../packages/engine/dist/index.js';
import { startMockOpenAI, toolCall, turn } from '../mock-openai/dist/index.js';
import { toolTrace } from './harness.mjs';
import { findPython } from './python.mjs';

const CLI = fileURLToPath(new URL('../../packages/cli/bin/shadowlap.js', import.meta.url));
const agentPath = (name) => fileURLToPath(new URL(`./loops/${name}`, import.meta.url));

// The scripted conversation, read from what it holds rather than its turns: search, then email, then
// answer. Each tool is called by the name the framework gave the model, found in the request.
const asked = (conversation) => /Research (\S+?) and email/.exec(JSON.stringify(conversation))?.[1] ?? 'nothing';
const searched = (conversation) => /#1/.test(JSON.stringify(conversation));
const emailed = (conversation) => /sent to|blocked/i.test(JSON.stringify(conversation));
const toolNamed = (tools, word) => (tools ?? []).map((t) => t.function?.name ?? t.name).find((n) => n?.includes(word)) ?? word;
function next(conversation, tools) {
  if (!searched(conversation)) return turn(null, { tool_calls: [toolCall(toolNamed(tools, 'search'), { query: asked(conversation) })] });
  if (!emailed(conversation)) return turn(null, { tool_calls: [toolCall(toolNamed(tools, 'email'), { to: 'team@example.com', body: `found ${asked(conversation)} #1` })] });
  return turn(`Emailed the team about ${asked(conversation)}.`);
}

/** OpenAI's Chat Completions and Responses APIs; every request the model got, as the conversation it read. */
async function openaiModel() {
  const read = [];
  const mock = await startMockOpenAI({
    script: ({ request }) => (read.push(request.messages), { turn: next(request.messages, request.tools) }),
    responses: ({ request, context }) => (read.push(context), { turn: next(context, request.tools) }),
  });
  return { mock, read, count: () => mock.requests.length + mock.otherRequests.length };
}


/**
 * The three tests for one framework's agent. `module` is what the Python must import; `script` the
 * agent in ./loops; `client` the model client it reports building; `tools` the names the framework
 * gives its model for the search and the email; `env` what else the agent needs; `refused(value,
 * read)` checks the framework handed the refusal to its model, from the agent's summary or from the
 * model's last request.
 */
export function agentLoopTests(c) {
  const PYTHON = findPython(c.module);
  const [search, email] = c.tools;
  describe(c.name, { skip: PYTHON ? false : `no Python with ${c.module} (set SHADOWLAP_PYTHON)` }, () => {
    let model;
    let dir;
    let db;
    let recordedRun;
    let recorded;
    before(async () => {
      model = await openaiModel();
      dir = mkdtempSync(join(tmpdir(), 'sl-py-loop-'));
      mkdirSync(join(dir, 'home'));
      db = join(dir, 'shadowlap.db');
    });
    after(async () => {
      await model.mock.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });

    // In the test's own folder: run and replay keep their active-run file in the one they run in.
    const shadowlap = async (args, extra) => {
      // A home of the test's own, for what a framework keeps there (CrewAI: a database of its last kickoff).
      const env = { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', OPENAI_API_KEY: 'sk-placeholder', HOME: join(dir, 'home'), ...c.env, ...extra };
      for (const k of Object.keys(env)) if (/^(OPENAI|ANTHROPIC)_(BASE_URL|API_BASE)$|^SHADOWLAP_(URL|RUN_ID)$/.test(k)) delete env[k];
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

    it(`records the ${c.client}'s calls and both tools, with nothing in the agent pointing it at shadowlap`, async () => {
      const r = await shadowlap(['run', '--', PYTHON, agentPath(c.script)], { SHADOWLAP_UPSTREAM_OPENAI: model.mock.url, QUERY: 'shadowlap' });
      assert.equal(r.code, 0, r.out);
      assert.doesNotMatch(r.out, /bypasses shadowlap|did not record/);
      recorded = printed(r.stdout);
      assert.equal(recorded.model, c.client);
      assert.match(recorded.answer, /Emailed the team about shadowlap\./);
      assert.deepEqual(recorded.executed, ['search_web', 'send_email']);
      recordedRun = /recording run (\w{26})/.exec(r.out)[1];
      const { calls } = callsOf(recordedRun);
      const api = calls.filter((x) => x.kind === 'api');
      assert.equal(api.length, 3, JSON.stringify(calls.map((x) => x.name)));
      assert.ok(api.every((x) => x.origin === 'live' && x.end?.outcome === 'ok' && x.meta.provider === 'openai'), JSON.stringify(api.map((x) => [x.name, x.meta.provider, x.end?.outcome])));
      assert.deepEqual(toolTrace(calls), [`${search}:read:live:ok`, `${email}:write:live:ok`]);
      assert.equal(model.count(), 3);
    });

    it('replays strictly with the upstream unreachable: no model request, no tool run', async () => {
      const sent = model.count();
      const r = await shadowlap(['replay', recordedRun, '--strict'], { SHADOWLAP_UPSTREAM_OPENAI: 'http://127.0.0.1:9', QUERY: 'shadowlap' });
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /Replay clean: 5\/5 calls replayed \(3 api, 2 tool\), 0 upstream requests/);
      const replayed = printed(r.stdout);
      assert.deepEqual(replayed.executed, []);
      assert.equal(replayed.answer, recorded.answer);
      assert.equal(model.count(), sent);
    });

    it('forks at the first model call on another request, blocks the email, and the model reads the refusal and answers', async () => {
      const r = await shadowlap(['replay', recordedRun], { SHADOWLAP_UPSTREAM_OPENAI: model.mock.url, QUERY: 'replays' });
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /Diverged at call 1/);
      const fork = printed(r.stdout);
      assert.match(fork.answer, /Emailed the team about replays\./);
      assert.deepEqual(fork.executed, ['search_web']);
      const { latest } = callsOf(recordedRun);
      assert.notEqual(latest.runId, recordedRun);
      assert.deepEqual(toolTrace(callsOf(latest.runId).calls), [`${search}:read:live:ok`, `${email}:write:blocked:error`]);
      // The model's last request held the refusal, and it answered from it.
      assert.match(JSON.stringify(model.read.at(-1)), /write tool \w+ blocked after divergence/);
      c.refused(fork, model.read.at(-1));
    });
  });
}
