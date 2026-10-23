// @shadowlap/test through real Jest (globalSetup, globalTeardown and its test environment), with a
// CommonJS suite as Jest runs one by default, and an ES module file under its ES module support: tests
// record on their first run, replay offline after that in parallel workers, and fail with the
// divergence when a request changes.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const JEST = join(HERE, 'node_modules', 'jest', 'bin', 'jest.js');

describe('@shadowlap/test with Jest', { skip: existsSync(JEST) ? false : 'jest is not installed here (npm ci in testing/frameworks)' }, () => {
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
    project = mkdtempSync(join(HERE, '.tmp-jest-'));
    cpSync(join(HERE, 'jest-project'), project, { recursive: true });
  });
  after(async () => {
    await new Promise((r) => mock.close(r));
    rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const model = () => `http://127.0.0.1:${mock.address().port}`;
  function jest(env = {}, config = 'jest.config.cjs') {
    return new Promise((resolve) => {
      const full = { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', TOOL_LOG: join(project, 'tools.log'), SHADOWLAP_UPSTREAM_ANTHROPIC: model(), ...env };
      for (const k of ['CI', 'SHADOWLAP_RECORD', 'SHADOWLAP_URL', 'SHADOWLAP_RUN_ID', 'ANTHROPIC_BASE_URL', 'SHADOWLAP_TEST_HOST', 'NODE_OPTIONS', 'JEST_WORKER_ID']) if (!(k in env)) delete full[k];
      execFile(process.execPath, [JEST, '--config', config, '--maxWorkers=2', '--ci=false'], { cwd: project, env: full, encoding: 'utf8', timeout: 180_000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: stdout + stderr }));
    });
  }
  const recording = (...parts) => join(project, '__recordings__', ...parts, 'run.json');
  const toolRuns = () => (existsSync(join(project, 'tools.log')) ? readFileSync(join(project, 'tools.log'), 'utf8').trim().split('\n').filter(Boolean).length : 0);

  it('records each wrapped test beside its file, named after the test, the client made at import included', async () => {
    const r = await jest({ DIRECT_MODEL: model() });
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(recording('agent.spec.cjs', 'the-triage-agent-triages-the-inbox')), r.out);
    assert.ok(existsSync(recording('agent.spec.cjs', 'answers-one-item')));
    for (const n of [2, 3, 4]) assert.ok(existsSync(recording('second.spec.cjs', `answers-item-${n}`)));
    // Five recorded model calls, and the unrecorded test's own.
    assert.equal(hits, 6);
    assert.equal(toolRuns(), 3);
  });

  it('replays offline in parallel workers, with no model request and no tool run', async () => {
    const [hitsBefore, toolsBefore] = [hits, toolRuns()];
    const r = await jest({ SHADOWLAP_UPSTREAM_ANTHROPIC: 'http://127.0.0.1:9', CI: 'true' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Tests:\s+6 passed/);
    assert.equal(hits, hitsBefore);
    assert.equal(toolRuns(), toolsBefore);
  });

  it('records and replays an ES module test file, under Jest\'s ES module support', async () => {
    const esm = (env) => jest({ NODE_OPTIONS: '--experimental-vm-modules', ...env }, 'jest.esm.config.cjs');
    const hitsBefore = hits;
    const first = await esm({});
    assert.equal(first.code, 0, first.out);
    assert.ok(existsSync(recording('esm.spec.mjs', 'answers-as-an-ES-module')), first.out);
    assert.equal(hits - hitsBefore, 1);
    const again = await esm({ SHADOWLAP_UPSTREAM_ANTHROPIC: 'http://127.0.0.1:9', CI: 'true' });
    assert.equal(again.code, 0, again.out);
    assert.equal(hits - hitsBefore, 1);
  });

  it('fails a test whose request changed, with the diff', async () => {
    const r = await jest({ PROMPT: 'goodbye', SHADOWLAP_UPSTREAM_ANTHROPIC: 'http://127.0.0.1:9' });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /ShadowlapReplayDiverged: diverged from its recording at call 1 \(tool lookup\)/);
    assert.match(r.out, /- "hello"/);
    assert.match(r.out, /\+ "goodbye"/);
    assert.match(r.out, /Tests:\s+1 failed, 5 passed/);
  });
});
