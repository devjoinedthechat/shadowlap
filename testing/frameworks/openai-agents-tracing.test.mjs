// The OpenAI Agents SDK for Python with its tracing on: a real Agent run by Runner against a
// scripted Responses API, through the real CLI, its trace export (the SDK's own exporter, batched
// and sent as the process exits) reaching the sidecar as telemetry. While recording, the export goes
// on and nothing of it is recorded or counted; a replay answers it with 204 itself, and stays clean
// although every export names new random ids. The exporter is pointed at the API root the agent's
// model calls use, as a project behind a gateway points it, so the export goes where they go: this
// test's provider. As the SDK ships, it posts to api.openai.com, which in-process capture names to
// the sidecar, and the sidecar sends it there, where the agent addressed it, rather than to the
// upstream set for the model calls; the sidecar's own tests cover that, since no test can stand in
// for api.openai.com.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { Store } from '../../packages/engine/dist/index.js';

const CLI = fileURLToPath(new URL('../../packages/cli/bin/shadowlap.js', import.meta.url));
const AGENTS = 'openai-agents==0.24.0';

/**
 * How to start a Python that imports the Agents SDK: SHADOWLAP_PYTHON or python3 when it has it,
 * else uv with the SDK pinned (the probe fills uv's cache; the agent then runs from it, offline).
 */
function agentsPython() {
  for (const cmd of [process.env.SHADOWLAP_PYTHON, 'python3'].filter(Boolean)) {
    try {
      execFileSync(cmd, ['-c', 'import agents'], { stdio: 'ignore' });
      return [cmd];
    } catch {
      // next
    }
  }
  try {
    execFileSync('uv', ['run', '--no-project', '--with', AGENTS, 'python', '-c', 'import agents'], { stdio: 'ignore', timeout: 300_000 });
    return ['uv', 'run', '--offline', '--no-project', '--with', AGENTS, 'python'];
  } catch {
    return null;
  }
}

const PYTHON = agentsPython();

// Tracing is on, as the SDK sets it, exported when the process exits: to the API root the model
// calls use (OPENAI_BASE_URL, which shadowlap run points at the sidecar) rather than api.openai.com.
const AGENT = `
import json, os
from agents import Agent, Runner, set_trace_processors
from agents.tracing.processors import BackendSpanExporter, BatchTraceProcessor

set_trace_processors([BatchTraceProcessor(BackendSpanExporter(endpoint=os.environ["OPENAI_BASE_URL"].rstrip("/") + "/traces/ingest"))])

agent = Agent(name="Support", instructions="Answer in one short sentence.", model="gpt-4.1")
result = Runner.run_sync(agent, os.environ["QUERY"])
print(json.dumps({"output": result.final_output}))
`;

/** The Responses API and the trace ingest endpoint, as the agent's provider; every request it gets, kept. */
async function startProvider() {
  const seen = [];
  let n = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ path: req.url, body: Buffer.concat(chunks).toString('utf8') });
      if (req.method === 'POST' && req.url === '/v1/traces/ingest') {
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'POST' && req.url === '/v1/responses') {
        n++;
        const answer = {
          id: `resp_${n}`,
          object: 'response',
          created_at: 1_760_000_000,
          status: 'completed',
          error: null,
          incomplete_details: null,
          instructions: null,
          max_output_tokens: null,
          model: 'gpt-4.1-2025-04-14',
          output: [{ type: 'message', id: `msg_${n}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Your order ships tomorrow.', annotations: [] }] }],
          parallel_tool_calls: true,
          previous_response_id: null,
          reasoning: { effort: null, summary: null },
          store: true,
          temperature: 1,
          text: { format: { type: 'text' } },
          tool_choice: 'auto',
          tools: [],
          top_p: 1,
          truncation: 'disabled',
          usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens: 6, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 26 },
          user: null,
          metadata: {},
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(answer));
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `no route ${req.method} ${req.url}` } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Run beside its store, in the test's own folder: run and replay keep their active-run file in the one they run in.
async function shadowlap(db, args, env) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, '--db', db, ...args], {
      cwd: dirname(db),
      env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', ...env },
      encoding: 'utf8',
      timeout: 180_000,
    });
    return { code: 0, out: stdout + stderr, stdout };
  } catch (err) {
    return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}`, stdout: err.stdout ?? '' };
  }
}

describe('OpenAI Agents SDK (Python) with tracing on', { skip: PYTHON ? false : `no Python with the Agents SDK (set SHADOWLAP_PYTHON, or install uv to get ${AGENTS})` }, () => {
  let provider;
  let dir;
  let db;
  let agent;
  let recorded;
  before(async () => {
    provider = await startProvider();
    dir = mkdtempSync(join(tmpdir(), 'sl-agents-tracing-'));
    db = join(dir, 'shadowlap.db');
    agent = join(dir, 'agent.py');
    writeFileSync(agent, AGENT);
  });
  after(async () => {
    await provider.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const env = () => ({ SHADOWLAP_UPSTREAM_OPENAI: provider.url, OPENAI_API_KEY: 'sk-test', QUERY: 'Where is my order?' });
  const traceExports = () => provider.seen.filter((s) => s.path === '/v1/traces/ingest');

  it('passes the trace export on while recording, and records the model calls alone', async () => {
    const summaryFile = join(dir, 'recorded.json');
    const r = await shadowlap(db, ['run', '--summary-json', summaryFile, '--', ...PYTHON, agent], env());
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /Your order ships tomorrow/);
    // The export reached the provider as it would have without Shadowlap: the trace and its spans.
    assert.ok(traceExports().length >= 1, `no trace export reached the provider:\n${r.out}`);
    assert.match(traceExports()[0].body, /"object":\s*"trace(\.span)?"/);
    recorded = JSON.parse(readFileSync(summaryFile, 'utf8')).summary;
    const store = Store.open(db);
    const calls = store.getCalls(recorded.runId);
    store.close();
    assert.deepEqual([...new Set(calls.map((c) => c.name))], ['POST /v1/responses']);
    assert.equal(recorded.total, calls.length);
    assert.equal(recorded.upstreamRequests, calls.length);
  });

  it('replays clean with nothing reaching the provider: Shadowlap answers the trace export itself', async () => {
    assert.ok(recorded, 'the recording above');
    const asked = provider.seen.length;
    const summaryFile = join(dir, 'replayed.json');
    const r = await shadowlap(db, ['replay', recorded.runId, '--strict', '--summary-json', summaryFile], env());
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /Your order ships tomorrow/);
    const replayed = JSON.parse(readFileSync(summaryFile, 'utf8')).summary;
    assert.equal(replayed.divergence, null);
    assert.equal(replayed.upstreamRequests, 0);
    assert.equal(replayed.total, recorded.total);
    assert.deepEqual(provider.seen.slice(asked).map((s) => s.path), [], 'nothing reached the provider, the trace export included');
  });
});
