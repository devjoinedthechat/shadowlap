import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, toolUse, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { departures } from './json-shapes.js';

/**
 * Tools the model called that the run never recorded: an agent whose tools aren't wrapped runs
 * them unseen, and a replay, which serves the model's answers again, runs them again for real.
 * `run`, `replay` and `show` name them; `replay` and `test` refuse while one of them writes.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const DOCS = fileURLToPath(new URL('../../../docs/how-it-works.md', import.meta.url));
const dirs: string[] = [];
const fresh = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sl-unrecorded-')));
  dirs.push(d);
  return d;
};

/**
 * An agent on the Anthropic wire format whose tools run unwrapped: lookup_kb answers, and Bash
 * leaves a line in ran.txt each time it runs, so a replay that runs it again shows. Its first call is
 * a clock read through the sidecar, so the model calls are #2 to #4.
 */
const AGENT = `
import { appendFileSync } from 'node:fs';
const sidecar = process.env.SHADOWLAP_URL;
if (sidecar) await fetch(sidecar + '/v1/calls/resolve', { method: 'POST', headers: { 'content-type': 'application/json', 'x-shadowlap-run': process.env.SHADOWLAP_RUN_ID ?? '' }, body: JSON.stringify({ kind: 'clock', name: 'now', label: '' }) });
const tools = [{ name: 'lookup_kb', input_schema: { type: 'object' } }, { name: 'Bash', input_schema: { type: 'object' } }];
const messages = [{ role: 'user', content: 'Clean up the build.' }];
for (let turn = 0; turn < 5; turn++) {
  const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'test', 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 512, tools, messages }) });
  const reply = await res.json();
  messages.push({ role: 'assistant', content: reply.content });
  const uses = reply.content.filter((b) => b.type === 'tool_use');
  if (!uses.length) break;
  messages.push({ role: 'user', content: uses.map((u) => {
    if (u.name === 'Bash') appendFileSync('ran.txt', u.input.command + '\\n');
    return { type: 'tool_result', tool_use_id: u.id, content: u.name === 'Bash' ? 'ok' : 'Refunds above $100 need a manager.' };
  }) });
}
console.log('done');
`;

let mock: MockServer;
let project: string;
let runId: string;
let recorded: { code: number | null; out: string };
const ENV = () => ({ ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_HOME: join(project, 'home'), SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_GUARD: 'off' });
/** The CLI, run without blocking: the mock model it talks to answers from this process. */
function shadowlap(args: string[], cwd = project): Promise<{ code: number | null; out: string; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: ENV(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code, out: `${stdout}${stderr}`, stdout, stderr }));
  });
}
const ran = () => (existsSync(join(project, 'ran.txt')) ? readFileSync(join(project, 'ran.txt'), 'utf8').split('\n').filter(Boolean).length : 0);

beforeAll(async () => {
  mock = await startMockAnthropic({
    script: ({ assistantTurns }) => {
      if (assistantTurns === 0) return { message: message([toolUse('lookup_kb', { q: 'refunds' }), toolUse('lookup_kb', { q: 'limits' }), toolUse('lookup_kb', { q: 'managers' })]) };
      if (assistantTurns === 1) return { message: message(Array.from({ length: 14 }, (_, i) => toolUse('Bash', { command: `rm -rf build/${i}` }))) };
      return { message: message([text('The build is clean.')]) };
    },
    eventDelayMs: () => 0,
  });
  project = fresh();
  writeFileSync(join(project, 'agent.mjs'), AGENT);
  recorded = await shadowlap(['run', '--summary-json', 'summary.json', '--', process.execPath, 'agent.mjs']);
  runId = /Recorded (\w{26})/.exec(recorded.out)?.[1] ?? '';
}, 60_000);
afterAll(async () => {
  await mock?.close();
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
});

const TOOLS = [
  { name: 'lookup_kb', count: 3, firstCallNo: 2, effect: 'read', why: '"lookup" only looks' },
  { name: 'Bash', count: 14, firstCallNo: 3, effect: 'write', why: 'a built-in that writes' },
];

describe('a run whose model called tools Shadowlap never recorded', () => {
  it('names them at the end of run, as the docs show it, and in --summary-json', async () => {
    expect(recorded.code, recorded.out).toBe(0);
    expect(ran()).toBe(14);
    // The sample in how-it-works.md is this output, line for line.
    const docs = readFileSync(DOCS, 'utf8');
    const section = docs.slice(docs.indexOf('## Tools Shadowlap did not record'));
    const sample = /```\n([\s\S]*?)\n```/.exec(section)![1].split('\n');
    const lines = recorded.out.split('\n');
    const at = lines.indexOf(sample[0]);
    expect(at, recorded.out).toBeGreaterThan(-1);
    expect(lines.slice(at, at + sample.length)).toEqual(sample);
    const summary = JSON.parse(readFileSync(join(project, 'summary.json'), 'utf8')) as { unrecordedTools: unknown[] };
    expect(summary.unrecordedTools).toEqual(TOOLS);
    expect(departures('summaryJson', summary)).toEqual({ missing: [], extra: [] });
  });

  it('names them in show, above the timeline, and in show --json', async () => {
    const shown = await shadowlap(['show', runId]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('! not recorded: lookup_kb (3 calls from #2), Bash (14 calls from #3, writes) · a replay runs them for real, and refuses to while one writes');
    const json = JSON.parse((await shadowlap(['show', runId, '--json'])).stdout) as { unrecordedTools: unknown[] };
    expect(json.unrecordedTools).toEqual(TOOLS);
    for (const t of json.unrecordedTools) expect(departures('unrecordedTool', t)).toEqual({ missing: [], extra: [] });
  });

  it('refuses a replay that would run the write again, before anything runs, and says how to go on', async () => {
    const before = ran();
    const r = await shadowlap(['replay', runId]);
    expect(r.code, r.out).toBe(2);
    expect(r.stderr).toContain(`shadowlap: ${runId.slice(0, 10)} holds model calls of a tool Shadowlap never recorded, which writes: a replay serves the model's answers again, so it would run it again for real.`);
    expect(r.stderr).toContain('    Bash  14 calls from model call #3 · a built-in that writes');
    expect(r.stderr).toContain(`  Wrap it where your agent runs it, so Shadowlap records it and a replay serves it: tool('Bash', { effect: 'write' }, fn) with @shadowlap/sdk.`);
    expect(r.stderr).toContain(`declare it a read in shadowlap.config.json, "tools": { "unrecorded": { "Bash": "read" } }`);
    expect(r.stderr).toContain(`shadowlap replay ${runId} --allow-unrecorded Bash`);
    expect(r.stderr).not.toContain('lookup_kb');
    expect(ran()).toBe(before);
  });

  it('runs it again for real with --allow-unrecorded, and says so at the end', async () => {
    const before = ran();
    const r = await shadowlap(['replay', runId, '--allow-unrecorded', 'Bash', '--summary-json', 'replayed.json']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('✓ Replay clean');
    expect(ran()).toBe(before + 14);
    expect(r.out).toContain('! The model called 2 tools Shadowlap did not record: this replay ran them for real');
    expect((JSON.parse(readFileSync(join(project, 'replayed.json'), 'utf8')) as { unrecordedTools: unknown[] }).unrecordedTools).toEqual(TOOLS);
  });

  it('only names a tool the config declares a read', async () => {
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ tools: { unrecorded: { Bash: 'read' } } }));
    try {
      const r = await shadowlap(['replay', runId]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('Bash       14 calls from model call #3 · declared read in shadowlap.config.json');
    } finally {
      rmSync(join(project, 'shadowlap.config.json'));
    }
  });

  it('refuses a test session with a golden that would run it again, before any golden runs', async () => {
    expect((await shadowlap(['pack', runId, 'goldens/cleanup'])).code).toBe(0);
    const before = ran();
    const r = await shadowlap(['test', 'goldens/cleanup']);
    expect(r.code, r.out).toBe(2);
    expect(r.stderr).toContain('shadowlap: a golden holds model calls of a tool Shadowlap never recorded, which writes: a replay would run it again for real, so no golden was run.');
    expect(r.stderr).toContain('  goldens/cleanup\n    Bash  14 calls from model call #3 · a built-in that writes');
    expect(r.stderr).toContain('Or let the test run it: --allow-unrecorded Bash');
    expect(ran()).toBe(before);
    const allowed = await shadowlap(['test', 'goldens/cleanup', '--allow-unrecorded', 'Bash']);
    expect(allowed.code, allowed.out).toBe(0);
    expect(allowed.stderr).toContain('! goldens/cleanup: the model called lookup_kb (3 calls), Bash (14 calls), which Shadowlap never recorded: its replay runs them for real');
    expect(ran()).toBe(before + 14);
  }, 60_000);
});
