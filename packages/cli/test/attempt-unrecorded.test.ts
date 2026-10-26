import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UnrecordedTool } from '@shadowlap/engine';

/**
 * A fork's model answers live, and can ask for a tool the agent runs itself, unwrapped: that write
 * runs for real in the attempt, and nothing stubs it, whatever the command fences of the writes it
 * records. So each attempt names what it ran unrecorded, on its line and in the JSON, and the command
 * says it once after them, never only "writes stubbed". The recording itself called no such tool, so
 * nothing refused it up front.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sl-attempt-unrecorded-')));
const effects = join(dir, 'effects.log');
// The agent runs every tool the model asks for itself, and logs each run: the side effect.
writeFileSync(
  join(dir, 'agent.mjs'),
  `import { appendFileSync } from 'node:fs';
const base = process.env.ANTHROPIC_BASE_URL;
const messages = [{ role: 'user', content: 'go' }];
for (let i = 0; i < 10; i++) {
  const r = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 64, messages }) });
  const reply = await r.json();
  messages.push({ role: 'assistant', content: reply.content });
  const uses = reply.content.filter((b) => b.type === 'tool_use');
  if (!uses.length) break;
  messages.push({ role: 'user', content: uses.map((u) => { appendFileSync(process.env.EFFECTS, u.name + '\\n'); return { type: 'tool_result', tool_use_id: u.id, content: 'ok' }; }) });
}
process.exit(Number(process.env.AGENT_EXIT ?? '0'));
`,
);

// The recording's conversation gets a plain answer; every later one, a fork's, is asked to send_email first.
let conversations = 0;
let n = 0;
const model: Server = createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    const j = JSON.parse(body || '{}') as { model?: string; messages?: Array<{ role: string }> };
    const turns = (j.messages ?? []).filter((m) => m.role === 'assistant').length;
    if (turns === 0) conversations++;
    const ask = conversations > 1 && turns === 0;
    const content = ask ? [{ type: 'tool_use', id: `toolu_${++n}`, name: 'send_email', input: { to: 'customer@example.com' } }] : [{ type: 'text', text: 'done' }];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `msg_${++n}`, type: 'message', role: 'assistant', model: j.model, content, stop_reason: ask ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
  });
});

let env: NodeJS.ProcessEnv;
let runId: string;
const ran = () => (existsSync(effects) ? readFileSync(effects, 'utf8').split('\n').filter((l) => l === 'send_email').length : 0);
function shadowlap(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

beforeAll(async () => {
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  const keep = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|OPENAI_|SHADOWLAP_)/.test(k)));
  env = { ...keep, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_HOME: join(dir, 'home'), SHADOWLAP_UPSTREAM_ANTHROPIC: `http://127.0.0.1:${(model.address() as AddressInfo).port}`, EFFECTS: effects, AGENT_EXIT: '1' };
  const rec = await shadowlap(['run', '--', process.execPath, 'agent.mjs']);
  runId = /Recorded (\w{26})/.exec(rec.stderr)?.[1] ?? '';
  expect(runId, rec.stderr).not.toBe('');
}, 60_000);
afterAll(async () => {
  await new Promise((resolve) => model.close(resolve));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('an attempt whose live model calls a tool the agent runs unwrapped', () => {
  it("is named on blame's attempt lines, in its JSON, and once after its report", async () => {
    const before = ran();
    const r = await shadowlap(['blame', runId, '--attempts', '2', '--passes', '1', '--json']);
    expect(r.code, r.stderr).not.toBe(2);
    // It ran for real in every attempt that forked, and nothing stubbed it.
    const ranInBlame = ran() - before;
    expect(ranInBlame).toBeGreaterThan(0);
    expect(r.stderr).toMatch(/attempt \d+ {2}.* · send_email ran for real, unrecorded/);
    expect(r.stderr).toContain('! The model called a tool Shadowlap did not record: the attempts ran it for real, and nothing stubbed it');
    expect(r.stderr).toMatch(/send_email {2}\d+ calls? in \d+ of \d+ attempts · "send" changes something/);
    expect(r.stderr).toContain("To have it recorded, and a write stubbed after a fork as the others are, wrap it where your agent runs it: tool('send_email', { effect: 'write' }, fn) with @shadowlap/sdk");
    const json = JSON.parse(r.stdout) as { probes: Array<{ runs: Array<{ unrecordedTools?: UnrecordedTool[] }> }> };
    const named = json.probes.flatMap((x) => x.runs).filter((a) => a.unrecordedTools?.some((t) => t.name === 'send_email'));
    expect(named.length).toBeGreaterThan(0);
    expect(named.reduce((sum, a) => sum + a.unrecordedTools!.find((t) => t.name === 'send_email')!.count, 0)).toBe(ranInBlame);
  }, 120_000);

  it('is named for every attempt of replay --repeat, not the first alone', async () => {
    const before = ran();
    const r = await shadowlap(['replay', runId, '--repeat', '2', '--diverge-at', '1', '--summary-json', 'repeat.json']);
    expect(ran() - before).toBe(2);
    expect(r.stderr).toContain('send_email  2 calls in 2 of 2 attempts');
    const summary = JSON.parse(readFileSync(join(dir, 'repeat.json'), 'utf8')) as { attempts: Array<{ unrecordedTools: UnrecordedTool[] }> };
    expect(summary.attempts.map((a) => a.unrecordedTools.map((t) => `${t.name}:${t.count}`))).toEqual([['send_email:1'], ['send_email:1']]);
  }, 120_000);
});
