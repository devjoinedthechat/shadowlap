// @shadowlap/test through real Vitest (globalSetup and setupFiles) and node:test (--import
// @shadowlap/test/register): tests record on their first run, replay offline after that, fail with
// the divergence when a request changes, and work with Vitest running files in parallel workers.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const VITEST = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));

describe('@shadowlap/test', () => {
  let mock;
  let hits = 0;
  let project;
  before(async () => {
    mock = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hits++;
        const text = JSON.parse(body).messages[0].content;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `msg_${hits}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: `echo: ${text}` }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
      });
    });
    await new Promise((r) => mock.listen(0, '127.0.0.1', r));
    // Inside this directory, so the project resolves the SDKs installed here and the workspace packages above.
    project = mkdtempSync(join(HERE, '.tmp-vitest-'));
    cpSync(join(HERE, 'vitest-project'), project, { recursive: true });
  });
  after(async () => {
    await new Promise((r) => mock.close(r));
    rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  function run(argv, env = {}) {
    return new Promise((resolve) => {
      const full = { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', TOOL_LOG: join(project, 'tools.log'), SHADOWLAP_UPSTREAM_ANTHROPIC: `http://127.0.0.1:${mock.address().port}`, ...env };
      for (const k of ['CI', 'SHADOWLAP_RECORD', 'SHADOWLAP_URL', 'SHADOWLAP_RUN_ID', 'ANTHROPIC_BASE_URL', 'SHADOWLAP_TEST_HOST', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT']) if (!(k in env)) delete full[k];
      execFile(process.execPath, argv, { cwd: project, env: full, encoding: 'utf8', timeout: 180_000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: stdout + stderr }));
    });
  }
  const vitest = (env) => run([VITEST, 'run', '--config', 'vitest.config.mjs'], env);
  const recording = (...parts) => join(project, '__recordings__', ...parts, 'run.json');
  const toolRuns = () => (existsSync(join(project, 'tools.log')) ? readFileSync(join(project, 'tools.log'), 'utf8').trim().split('\n').filter(Boolean).length : 0);

  it('Vitest: records each wrapped test beside its file, named after the test', async () => {
    const r = await vitest({});
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(recording('agent.spec.mjs', 'the-triage-agent-triages-the-inbox')), r.out);
    assert.ok(existsSync(recording('agent.spec.mjs', 'answers-one-item')));
    for (const n of [2, 3, 4]) assert.ok(existsSync(recording('second.spec.mjs', `answers-item-${n}`)));
    assert.equal(hits, 5);
    assert.equal(toolRuns(), 2);
  });

  it('Vitest: replays offline in parallel workers, with no model request and no tool execution', async () => {
    const [hitsBefore, toolsBefore] = [hits, toolRuns()];
    const r = await vitest({ SHADOWLAP_UPSTREAM_ANTHROPIC: 'http://127.0.0.1:9', CI: 'true' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Tests\s+5 passed/);
    assert.equal(hits, hitsBefore);
    assert.equal(toolRuns(), toolsBefore);
  });

  it('Vitest: fails a test whose request changed, with the diff', async () => {
    const r = await vitest({ PROMPT: 'goodbye', SHADOWLAP_UPSTREAM_ANTHROPIC: 'http://127.0.0.1:9' });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /ShadowlapReplayDiverged: diverged from its recording at call 1 \(tool lookup\)/);
    assert.match(r.out, /- "hello"/);
    assert.match(r.out, /\+ "goodbye"/);
    assert.match(r.out, /Tests\s+1 failed \| 4 passed/);
  });

  it('node:test with --import @shadowlap/test/register: records, then replays offline', async () => {
    const argv = ['--import', '@shadowlap/test/register', '--test', 'node-agent.fixture.mjs'];
    const first = await run(argv, {});
    assert.equal(first.code, 0, first.out);
    assert.ok(existsSync(recording('node-agent', 'answers')), first.out);
    const hitsBefore = hits;
    const again = await run(argv, { SHADOWLAP_UPSTREAM_ANTHROPIC: 'http://127.0.0.1:9' });
    assert.equal(again.code, 0, again.out);
    assert.equal(hits, hitsBefore);
  });
});
