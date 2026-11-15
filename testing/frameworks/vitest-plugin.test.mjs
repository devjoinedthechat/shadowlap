// @shadowlap/test through real Vitest (globalSetup and setupFiles) and node:test (--import
// @shadowlap/test/register): tests record on their first run, replay offline after that, fail with
// the divergence when a request changes, and work with Vitest running files in parallel workers.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { REPO_MODULES, removeTempProject, tempProject } from '../temp-project.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const VITEST = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));

describe('@shadowlap/test', () => {
  let mock;
  let hits = 0;
  // The key each request carried.
  const keys = [];
  let project;
  before(async () => {
    mock = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hits++;
        keys.push(req.headers['x-api-key']);
        const text = JSON.parse(body).messages[0].content;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `msg_${hits}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: `echo: ${text}` }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
      });
    });
    await new Promise((r) => mock.listen(0, '127.0.0.1', r));
    // In the temporary folder, below links to the SDKs installed here and then to the repository's
    // packages: what a project inside this folder would find.
    project = tempProject('sl-vitest-project-', [join(HERE, 'node_modules'), REPO_MODULES]);
    cpSync(join(HERE, 'vitest-project'), project, { recursive: true });
  });
  after(async () => {
    await new Promise((r) => mock.close(r));
    removeTempProject(project);
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

  it('Vitest: a test not wrapped with recorded() calls its model and tools directly, before and after a recorded one', async () => {
    const model = `http://127.0.0.1:${mock.address().port}`;
    const mixed = (env) => run([VITEST, 'run', '--config', 'vitest.mixed.config.mjs'], { ANTHROPIC_BASE_URL: model, SHADOWLAP_UPSTREAM_ANTHROPIC: model, ...env });
    const hitsBefore = hits;
    const first = await mixed({});
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /Tests\s+3 passed/);
    assert.ok(existsSync(recording('mixed.check.mjs', 'a-recorded-test')), first.out);
    assert.equal(hits - hitsBefore, 6); // two calls each: the recorded test's through shadowlap, the others' direct
    // Replayed: the recorded test calls nothing, the others still call the model themselves.
    const again = await mixed({ CI: 'true' });
    assert.equal(again.code, 0, again.out);
    assert.equal(hits - hitsBefore, 10);
    // Alone, as when it is the only test picked.
    const alone = await run([VITEST, 'run', '--config', 'vitest.mixed.config.mjs', '-t', 'after a recorded one'], { ANTHROPIC_BASE_URL: model, SHADOWLAP_UPSTREAM_ANTHROPIC: model });
    assert.equal(alone.code, 0, alone.out);
    assert.match(alone.out, /1 passed/);
  });

  it('Vitest and node:test: a client built the default way replays with no key in the environment', async () => {
    const vitestKeys = (env) => run([VITEST, 'run', '--config', 'vitest.keys.config.mjs'], env);
    const nodeKeys = (env) => run(['--import', '@shadowlap/test/register', '--test', 'node-keys.fixture.mjs'], env);
    const recording = { ANTHROPIC_API_KEY: 'sk-recording', KEY_BEFORE: 'sk-recording' };
    const first = await vitestKeys(recording);
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /Tests\s+2 passed/);
    const firstNode = await nodeKeys(recording);
    assert.equal(firstNode.code, 0, firstNode.out);
    assert.deepEqual(keys.slice(-2), ['sk-recording', 'sk-recording']);
    // In CI without secrets: a recorded test's client gets a placeholder while it runs, and nothing is sent.
    const hitsBefore = hits;
    const ci = { ANTHROPIC_API_KEY: '', KEY_BEFORE: '', CI: 'true', SHADOWLAP_UPSTREAM_ANTHROPIC: 'http://127.0.0.1:9' };
    const again = await vitestKeys(ci);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /Tests\s+2 passed/);
    const node = await nodeKeys(ci);
    assert.equal(node.code, 0, node.out);
    assert.equal(hits, hitsBefore);
    assert.ok(!keys.includes('shadowlap-offline-replay-placeholder'));
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
