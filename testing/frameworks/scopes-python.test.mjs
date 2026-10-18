// shadowlap.scope() in Python: two asyncio tasks send the same request at once, recorded in one order and
// replayed in the other, each getting its own recorded answer. The scope reaches the sidecar through
// the base URL the Anthropic client was pointed at.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { findPython } from './python.mjs';

const CLI = fileURLToPath(new URL('../../packages/cli/bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./scopes_agent.py', import.meta.url));
const PYTHON = findPython('anthropic');

describe('shadowlap.scope() from Python asyncio tasks', { skip: PYTHON ? false : 'no Python with anthropic (set SHADOWLAP_PYTHON)' }, () => {
  let mock;
  let hits = 0;
  let cwd;
  before(async () => {
    mock = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hits++;
        const first = JSON.parse(body).messages.length === 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `m${hits}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: first ? `plan ${hits}` : 'done' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 2 } }));
      });
    });
    await new Promise((r) => mock.listen(0, '127.0.0.1', r));
    cwd = mkdtempSync(join(tmpdir(), 'fp-scopes-py-'));
  });
  after(() => {
    mock.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  const shadowlap = async (args, env = {}) => {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: `http://127.0.0.1:${mock.address().port}`, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', ...env }, encoding: 'utf8', timeout: 120_000 });
      return { code: 0, out: stdout + stderr, stdout };
    } catch (err) {
      return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}`, stdout: err.stdout ?? '' };
    }
  };

  it('replays each task its own answers in the other order', async () => {
    const recorded = await shadowlap(['run', '--', PYTHON, AGENT]);
    assert.equal(recorded.code, 0, recorded.out);
    const runId = /recording run (\w{26})/.exec(recorded.out)[1];
    const before = hits;
    const replay = await shadowlap(['replay', runId, '--strict'], { ORDER: 'reverse' });
    assert.equal(replay.code, 0, replay.out);
    assert.match(replay.out, /Replay clean: 4\/4 calls replayed/);
    assert.equal(hits, before);
    const line = (s) => JSON.parse(s.split('\n').find((l) => l.startsWith('["')));
    assert.deepEqual(line(replay.stdout), line(recorded.stdout));
  });

  it('takes scopes of any name: beyond Latin-1, or with a percent sign', async () => {
    const names = { NAMES: '東京の天気/Kraków-łódź,50% off' };
    const recorded = await shadowlap(['run', '--', PYTHON, AGENT], names);
    assert.equal(recorded.code, 0, recorded.out);
    const runId = /recording run (\w{26})/.exec(recorded.out)[1];
    const replay = await shadowlap(['replay', runId, '--strict'], { ...names, ORDER: 'reverse' });
    assert.equal(replay.code, 0, replay.out);
    assert.match(replay.out, /Replay clean: 4\/4 calls replayed/);
    const line = (s) => JSON.parse(s.split('\n').find((l) => l.startsWith('["')));
    assert.deepEqual(line(replay.stdout), line(recorded.stdout));
    assert.match(line(recorded.stdout)[0], /^東京の天気\/Kraków-łódź: plan/);
  });
});
