// Pydantic AI: a real Agent run by FunctionModel, tools registered with @agent.tool over the Shadowlap
// Python @tool decorator (exclude=("ctx",)), as a subprocess against an in-process sidecar.
// Needs a Python with pydantic-ai-slim; SHADOWLAP_PYTHON picks the interpreter.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { startHarness, toolTrace } from './harness.mjs';

const SCRIPT = fileURLToPath(new URL('./pydantic_ai_agent.py', import.meta.url));

function findPython() {
  for (const cmd of [process.env.SHADOWLAP_PYTHON, 'python3', 'python'].filter(Boolean)) {
    try {
      execFileSync(cmd, ['-c', 'import pydantic_ai'], { stdio: 'ignore' });
      return cmd;
    } catch {
      // next
    }
  }
  return null;
}
const PYTHON = findPython();

describe('Pydantic AI with the Shadowlap Python SDK', { skip: PYTHON ? false : 'no Python with pydantic_ai (set SHADOWLAP_PYTHON)' }, () => {
  let h;
  before(async () => (h = await startHarness()));
  after(() => h.close());

  // Async on purpose: the sidecar serves from this event loop.
  const agent = (query) => async () => {
    const { stdout } = await promisify(execFile)(PYTHON, [SCRIPT], { env: { ...process.env, QUERY: query }, encoding: 'utf8' });
    return JSON.parse(stdout.trim().split('\n').pop());
  };

  let recorded;
  it('records both tools; the RunContext is excluded from the recorded arguments', async () => {
    recorded = await h.record(agent('shadowlap'));
    assert.equal(recorded.error, undefined, recorded.error?.stack);
    assert.equal(recorded.value.error, null);
    assert.deepEqual(recorded.value.executed, ['search_web', 'send_email']);
    assert.match(recorded.value.output, /shadowlap #1/);
    assert.match(recorded.value.output, /ops/); // deps reached the tool through ctx
    assert.deepEqual(toolTrace(recorded.calls), ['search_web:read:live:ok', 'send_email:write:live:ok']);
    assert.deepEqual(h.store.getJson(recorded.calls.find((c) => c.name === 'search_web').requestRef), { args: { query: 'shadowlap' } });
  });

  it('replays without executing either tool', async () => {
    const replay = await h.replay(recorded, agent('shadowlap'));
    assert.equal(replay.error, undefined, replay.error?.stack);
    assert.equal(replay.summary.divergence, null);
    assert.deepEqual(replay.value.executed, []);
    assert.equal(replay.value.output, recorded.value.output);
  });

  it('forks on a changed query and blocks the email', async () => {
    const fork = await h.replay(recorded, agent('replay'));
    assert.equal(fork.error, undefined, fork.error?.stack);
    assert.deepEqual(fork.value.executed, ['search_web']);
    assert.match(fork.value.error, /^ShadowlapWriteBlocked/);
    assert.deepEqual(toolTrace(fork.calls), ['search_web:read:live:ok', 'send_email:write:blocked:error']);
  });
});
