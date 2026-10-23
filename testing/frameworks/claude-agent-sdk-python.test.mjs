// The Claude Agent SDK for Python with Shadowlap's fence, end to end: query() runs the Claude Code CLI
// the SDK bundles, whose model calls go through the sidecar (ANTHROPIC_BASE_URL) to a scripted
// Anthropic API, and whose built-in tools (Read, Write, Edit, Bash) the hooks record and fence. A
// recording changes the project; a replay of it sends no model request and leaves the project as it
// was; a fork refuses every write.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { message, startMockAnthropic, text, toolUse } from '../mock-anthropic/dist/index.js';
import { startHarness, toolTrace } from './harness.mjs';
import { findPython } from './python.mjs';

const PYTHON = findPython('claude_agent_sdk');
const SCRIPT = fileURLToPath(new URL('./claude_agent_sdk_agent.py', import.meta.url));

describe('Claude Agent SDK (Python) with shadowlap.adapters.claude_agent_sdk', { skip: PYTHON ? false : 'no Python with claude-agent-sdk (set SHADOWLAP_PYTHON)' }, () => {
  const base = mkdtempSync(join(tmpdir(), 'shadowlap-claude-code-'));
  const project = join(base, 'project');
  const notes = join(project, 'notes.txt');
  let h;
  let mock;
  /** The project as it is before the agent runs: every run starts from it, at the same path. */
  const reset = () => {
    rmSync(project, { recursive: true, force: true });
    mkdirSync(join(project, 'sub'), { recursive: true });
    writeFileSync(notes, 'hello world\n');
  };
  before(async () => {
    mock = await startMockAnthropic({
      script: ({ assistantTurns }) => ({
        message: [
          message([toolUse('Read', { file_path: notes })], { stop_reason: 'tool_use' }),
          message([toolUse('Write', { file_path: join(project, 'report.md'), content: 'draft\n' })], { stop_reason: 'tool_use' }),
          message([toolUse('Edit', { file_path: notes, old_string: 'world', new_string: 'there' })], { stop_reason: 'tool_use' }),
          message([toolUse('Bash', { command: 'echo side-effect >> effects.log && cd sub && pwd', description: 'Leave a mark' })], { stop_reason: 'tool_use' }),
          message([toolUse('Bash', { command: 'echo failing >> effects.log; exit 3', description: 'Fail' })], { stop_reason: 'tool_use' }),
          message([text('done')], { stop_reason: 'end_turn' }),
        ][Math.min(assistantTurns, 5)],
      }),
    });
    // Claude Code names its session in every request: masked, as docs/frameworks.md says to.
    h = await startHarness({ upstreams: { anthropic: mock.url }, normalizers: [{ kind: 'api', path: '$.metadata.user_id', replace: '<session>' }] });
  });
  after(async () => {
    await h.close();
    await mock.close();
    rmSync(base, { recursive: true, force: true });
  });

  // Async on purpose: the sidecar serves from this event loop.
  const agent = (prompt) => async () => {
    reset();
    const env = { ...process.env, PROJECT: project, PROMPT: prompt, CLAUDE_CONFIG_DIR: join(base, 'config'), HOME: join(base, 'home') };
    const { stdout } = await promisify(execFile)(PYTHON, [SCRIPT], { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
    return JSON.parse(stdout.trim().split('\n').pop());
  };

  let recorded;
  it('records Claude Code\'s model calls and built-in tools, which change the project', async () => {
    recorded = await h.record(agent('Do the scripted thing.'));
    assert.equal(recorded.error, undefined, recorded.error?.stack);
    assert.deepEqual(toolTrace(recorded.calls), ['Read:read:live:ok', 'Write:write:live:ok', 'Edit:write:live:ok', 'Bash:write:live:ok', 'Bash:write:live:error']);
    assert.equal(recorded.calls.filter((c) => c.kind === 'api').length, 6);
    assert.equal(recorded.value.files['report.md'], 'draft\n');
    assert.equal(recorded.value.files['notes.txt'], 'hello there\n');
    assert.match(recorded.value.files['effects.log'], /side-effect/);
  });

  it('replays with no model request, and leaves the project as it was', async () => {
    const before = mock.requests.length;
    const replay = await h.replay(recorded, agent('Do the scripted thing.'));
    assert.equal(replay.error, undefined, replay.error?.stack);
    assert.equal(replay.summary.divergence, null, JSON.stringify(replay.summary.divergence));
    assert.equal(replay.summary.byOrigin.replayed, 11);
    assert.equal(mock.requests.length, before);
    assert.deepEqual(replay.value.files, { 'notes.txt': 'hello world\n' });
  });

  it('forks at the first model call when the prompt changes, and refuses every write', async () => {
    const fork = await h.replay(recorded, agent('Do the scripted thing, quickly.'));
    assert.equal(fork.error, undefined, fork.error?.stack);
    assert.equal(fork.summary.divergence?.callNo, 1);
    assert.deepEqual(fork.value.files, { 'notes.txt': 'hello world\n' });
    assert.equal(fork.calls.filter((c) => c.kind === 'tool' && c.effect === 'write').every((c) => c.origin === 'blocked'), true);
  });
});
