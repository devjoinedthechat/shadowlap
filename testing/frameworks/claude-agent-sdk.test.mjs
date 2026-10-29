// The Claude Agent SDK for TypeScript with @shadowlap/adapters/claude-agent-sdk, end to end: query()
// runs the Claude Code CLI the SDK brings, whose model calls go through the sidecar
// (ANTHROPIC_BASE_URL) to a scripted Anthropic API, and whose built-in tools (Read, Write, Edit, Bash)
// the hooks record and fence. A recording changes the project; a replay of it sends no model request
// and leaves the project as it was; a fork refuses every write. And the tools of an in-process MCP
// server (createSdkMcpServer), wrapped by withEffects: recorded under the names Claude Code calls
// them by, replayed without running, and a write blocked after a fork while the agent answers.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { message, startMockAnthropic, text, toolUse } from '../mock-anthropic/dist/index.js';
import { withEffects, withFence } from '../../packages/adapters/dist/claude-agent-sdk.js';
import { startHarness, toolTrace } from './harness.mjs';

describe('Claude Agent SDK (TypeScript) with @shadowlap/adapters/claude-agent-sdk', () => {
  const base = mkdtempSync(join(tmpdir(), 'shadowlap-claude-code-ts-'));
  // A home and a config folder that exist, as a person's do: Claude Code reads some settings (the
  // local file at a repository's root) only when its home folder is there.
  for (const dir of ['home', 'config']) mkdirSync(join(base, dir));
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
  const files = (dir = project) =>
    Object.fromEntries(readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? Object.entries(files(join(dir, name))) : [[relative(project, join(dir, name)), readFileSync(join(dir, name), 'utf8')]])));

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
    // Claude Code names its session in every request's metadata.user_id; matching masks it on its own.
    h = await startHarness({ upstreams: { anthropic: mock.url } });
  });
  after(async () => {
    await h.close();
    await mock.close();
    rmSync(base, { recursive: true, force: true });
  });

  const agent = (prompt) => async () => {
    reset();
    // The CLI this SDK brings signs in with ANTHROPIC_AUTH_TOKEN here; it reports no key from ANTHROPIC_API_KEY.
    const env = { ...process.env, ANTHROPIC_AUTH_TOKEN: 'test-key', CLAUDE_CONFIG_DIR: join(base, 'config'), HOME: join(base, 'home'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1' };
    const options = withFence({ cwd: project, model: 'claude-opus-4-8', env, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, settingSources: [], maxTurns: 12 }, { log: () => {} });
    let result = null;
    for await (const m of query({ prompt, options })) if (m.type === 'result') result = { is_error: m.is_error };
    return { result, files: files() };
  };

  let recorded;
  it('records Claude Code\'s model calls and built-in tools, which change the project', async () => {
    recorded = await h.record(agent('Do the scripted thing.'));
    assert.equal(recorded.error, undefined, recorded.error?.stack);
    assert.deepEqual(toolTrace(recorded.calls), ['Read:read:live:ok', 'Write:write:live:ok', 'Edit:write:live:ok', 'Bash:write:live:ok', 'Bash:write:live:error']);
    assert.equal(recorded.calls.filter((c) => c.kind === 'api').length, 6);
    assert.equal(recorded.value.files['report.md'], 'draft\n');
    assert.equal(recorded.value.files['notes.txt'], 'hello there\n');
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

describe('Claude Agent SDK (TypeScript): tools of an in-process MCP server wrapped by withEffects', () => {
  const base = mkdtempSync(join(tmpdir(), 'shadowlap-claude-mcp-ts-'));
  for (const dir of ['home', 'config', 'project']) mkdirSync(join(base, dir));
  const ANSWER = 'Refunded 240 on A-1042.';
  const executed = [];
  let h;
  let mock;
  before(async () => {
    mock = await startMockAnthropic({
      script: ({ assistantTurns }) => ({
        message: [
          message([toolUse('mcp__orders__lookup_order', { order_id: 'A-1042' })], { stop_reason: 'tool_use' }),
          message([toolUse('mcp__orders__issue_refund', { order_id: 'A-1042', amount: 240 })], { stop_reason: 'tool_use' }),
          message([text(ANSWER)], { stop_reason: 'end_turn' }),
        ][Math.min(assistantTurns, 2)],
      }),
    });
    h = await startHarness({ upstreams: { anthropic: mock.url } });
  });
  after(async () => {
    await h.close();
    await mock.close();
    rmSync(base, { recursive: true, force: true });
  });

  const tools = withEffects(
    'orders',
    [
      tool('lookup_order', 'Look up an order', { order_id: z.string() }, async ({ order_id }) => {
        executed.push('lookup_order');
        return { content: [{ type: 'text', text: JSON.stringify({ order_id, amount: 240 }) }] };
      }),
      tool('issue_refund', 'Refund an order', { order_id: z.string(), amount: z.number() }, async ({ order_id, amount }) => {
        executed.push('issue_refund');
        return { content: [{ type: 'text', text: `refunded ${amount} on ${order_id}` }] };
      }),
    ],
    { lookup_order: 'read', issue_refund: 'write' },
  );
  const agent = (prompt) => async () => {
    executed.length = 0;
    const env = { ...process.env, ANTHROPIC_AUTH_TOKEN: 'test-key', CLAUDE_CONFIG_DIR: join(base, 'config'), HOME: join(base, 'home'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1' };
    const orders = createSdkMcpServer({ name: 'orders', version: '1.0.0', tools });
    const options = withFence({ cwd: join(base, 'project'), model: 'claude-opus-4-8', env, mcpServers: { orders }, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, settingSources: [], maxTurns: 6 }, { log: () => {} });
    let result = null;
    for await (const m of query({ prompt, options })) if (m.type === 'result') result = { is_error: m.is_error, text: m.result ?? null };
    return { result, executed: [...executed] };
  };
  /** What the model was sent for each tool's result in the last request: its text, and whether it is an error. */
  const toolResults = () =>
    mock.requests
      .at(-1)
      .body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === 'tool_result')
      .map((b) => ({ text: (Array.isArray(b.content) ? b.content.map((c) => c.text).join('') : String(b.content)), is_error: b.is_error === true }));

  let recorded;
  it('records the tools under the names Claude Code calls them by', async () => {
    recorded = await h.record(agent('Refund order A-1042.'));
    assert.equal(recorded.error, undefined, recorded.error?.stack);
    assert.deepEqual(recorded.value, { result: { is_error: false, text: ANSWER }, executed: ['lookup_order', 'issue_refund'] });
    assert.deepEqual(toolTrace(recorded.calls), ['mcp__orders__lookup_order:read:live:ok', 'mcp__orders__issue_refund:write:live:ok']);
    assert.equal(recorded.calls.filter((c) => c.kind === 'api').length, 3);
  });

  it('replays with no model request and no tool run', async () => {
    const before = mock.requests.length;
    const replay = await h.replay(recorded, agent('Refund order A-1042.'));
    assert.equal(replay.error, undefined, replay.error?.stack);
    assert.equal(replay.summary.divergence, null, JSON.stringify(replay.summary.divergence));
    assert.deepEqual(replay.value, { result: { is_error: false, text: ANSWER }, executed: [] });
    assert.equal(mock.requests.length, before);
  });

  it('forks when the prompt changes: the read runs again, the write is blocked, and the model answers after reading the refusal', async () => {
    const fork = await h.replay(recorded, agent('Refund order A-1042, please.'));
    assert.equal(fork.error, undefined, fork.error?.stack);
    assert.equal(fork.summary.divergence?.callNo, 1);
    assert.deepEqual(fork.value, { result: { is_error: false, text: ANSWER }, executed: ['lookup_order'] });
    assert.deepEqual(toolTrace(fork.calls), ['mcp__orders__lookup_order:read:live:ok', 'mcp__orders__issue_refund:write:blocked:error']);
    const [, refusal] = toolResults();
    assert.equal(refusal.is_error, true);
    assert.match(refusal.text, /write tool mcp__orders__issue_refund blocked after divergence/);
  });
});
