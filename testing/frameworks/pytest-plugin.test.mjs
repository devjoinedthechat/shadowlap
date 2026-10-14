// The pytest plugin (@pytest.mark.shadowlap), through real pytest: tests record on their first run,
// replay offline after that, fail with the divergence when a request changes, and keep working with
// pytest-xdist workers. The model client is created at import, before Shadowlap starts, so only
// in-process capture can record it. Needs a Python with pytest, pytest-xdist and anthropic.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { findPython } from './python.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PYTHON = findPython('pytest, xdist, anthropic');

describe('pytest plugin', { skip: PYTHON ? false : 'no Python with pytest, pytest-xdist and anthropic (set SHADOWLAP_PYTHON)' }, () => {
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
    project = mkdtempSync(join(tmpdir(), 'fp-pytest-'));
    cpSync(fileURLToPath(new URL('./pytest-project/test_agent.py', import.meta.url)), join(project, 'test_agent.py'));
  });
  after(async () => {
    await new Promise((r) => mock.close(r));
    rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const upstream = () => `http://127.0.0.1:${mock.address().port}`;
  // An installed shadowlap (or a build's egg-info on the path) registers the plugin through its entry point.
  const PYTHONPATH = join(ROOT, 'sdks', 'python');
  const autoloaded = () => execFileSync(PYTHON, ['-c', "from importlib.metadata import entry_points; print(any(e.value == 'shadowlap.pytest_plugin' for e in entry_points(group='pytest11')))"], { env: { ...process.env, PYTHONPATH }, encoding: 'utf8' }).trim() === 'True';
  function pytest(args, env = {}) {
    return new Promise((resolve) => {
      const full = { ...process.env, PYTHONPATH, SHADOWLAP_CLI: join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js'), SHADOWLAP_TELEMETRY: '0', TOOL_LOG: join(project, 'tools.log'), SHADOWLAP_UPSTREAM_ANTHROPIC: upstream(), ...env };
      for (const k of ['CI', 'SHADOWLAP_RECORD', 'SHADOWLAP_URL', 'SHADOWLAP_RUN_ID', 'ANTHROPIC_BASE_URL']) if (!(k in env)) delete full[k];
      execFile(PYTHON, ['-m', 'pytest', ...(autoloaded() ? [] : ['-p', 'shadowlap.pytest_plugin']), '-p', 'no:cacheprovider', '-q', ...args], { cwd: project, env: full, encoding: 'utf8', timeout: 180_000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: stdout + stderr }));
    });
  }
  const recording = (name) => join(project, '__recordings__', 'test_agent', name);
  const toolRuns = () => (existsSync(join(project, 'tools.log')) ? readFileSync(join(project, 'tools.log'), 'utf8').trim().split('\n').filter(Boolean).length : 0);

  it('records each marked test on its first run, next to the test, and saves nothing for a failing one', async () => {
    const r = await pytest(['test_agent.py', '-k', 'not fails'], {});
    assert.equal(r.code, 0, r.out);
    for (const name of ['test_triage', 'test_parametrized-1', 'test_parametrized-2']) assert.ok(existsSync(join(recording(name), 'run.json')), `${name}\n${r.out}`);
    assert.equal(hits, 3);
    assert.equal(toolRuns(), 3);

    const failing = await pytest(['test_agent.py', '-k', 'fails'], {});
    assert.equal(failing.code, 1, failing.out);
    assert.ok(!existsSync(recording('test_fails_while_recording')), 'a failed test leaves no recording');
    assert.match(failing.out, /the test failed, so its recording was not saved/);
  });

  it('replays offline: no model request, no tool execution, even with the model unreachable', async () => {
    const [hitsBefore, toolsBefore] = [hits, toolRuns()];
    const r = await pytest(['test_agent.py', '-k', 'not fails'], { SHADOWLAP_UPSTREAM_ANTHROPIC: 'http://127.0.0.1:9', CI: 'true' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /4 passed, 1 deselected/);
    assert.equal(hits, hitsBefore);
    assert.equal(toolRuns(), toolsBefore);
  });

  it('fails a test whose request changed, with the diff and how to record it again', async () => {
    const r = await pytest(['test_agent.py::test_triage'], { PROMPT: 'goodbye', SHADOWLAP_UPSTREAM_ANTHROPIC: 'http://127.0.0.1:9' });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /diverged from its recording at call \d+ \(tool lookup\)/);
    assert.match(r.out, /"hello"/);
    assert.match(r.out, /"goodbye"/);
    assert.match(r.out, /SHADOWLAP_RECORD=all/);
  });

  it('records again with SHADOWLAP_RECORD=all, and only replays with none (the default in CI)', async () => {
    const again = await pytest(['test_agent.py::test_triage'], { PROMPT: 'goodbye', SHADOWLAP_RECORD: 'all' });
    assert.equal(again.code, 0, again.out);
    const replay = await pytest(['test_agent.py::test_triage'], { PROMPT: 'goodbye', SHADOWLAP_UPSTREAM_ANTHROPIC: 'http://127.0.0.1:9' });
    assert.equal(replay.code, 0, replay.out);

    const missing = await pytest(['test_agent.py', '-k', 'fails'], { CI: 'true', MAKE_IT_PASS: '1' });
    assert.equal(missing.code, 1, missing.out);
    assert.match(missing.out, /no recording at __recordings__\/test_agent\/test_fails_while_recording/);
  });

  it('replays with pytest-xdist workers, each on its own slot', async () => {
    const hitsBefore = hits;
    const r = await pytest(['test_agent.py', '-k', 'not fails', '-n', '2'], { PROMPT: 'goodbye', SHADOWLAP_UPSTREAM_ANTHROPIC: 'http://127.0.0.1:9' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /4 passed/);
    assert.equal(hits, hitsBefore);
  });
});
