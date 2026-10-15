import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { mapArgv } from '../src/bisect.js';

/**
 * `shadowlap bisect` through the CLI, on a scratch git repository with a tiny agent: one model call,
 * its system prompt read from a file. Its history: a README edit or two, then a commit that asks for
 * brevity (the golden recorded before it diverges from there on), then one that prints a draft
 * marker (an output check fails from there on). The mock plays the model while recording; every
 * replay after that is offline.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

const AGENT = `import { readFileSync } from 'node:fs';
const system = readFileSync(new URL('./prompt.txt', import.meta.url), 'utf8').trim();
const marker = readFileSync(new URL('./marker.txt', import.meta.url), 'utf8').trim();
const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model: 'small-model', max_tokens: 64, system, messages: [{ role: 'user', content: 'Summarize ticket T-1.' }] }),
});
const body = await res.json();
if (!res.ok) {
  console.error(JSON.stringify(body));
  process.exit(1);
}
console.log(marker + body.content.map((b) => b.text ?? '').join(''));
`;

let mock: MockServer;
let project: string;
const rev: Record<string, string> = {};
let recordedRun = '';

const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
function commit(name: string, files: Record<string, string>, author = 'Test'): void {
  for (const [f, content] of Object.entries(files)) writeFileSync(join(project, f), content);
  sh('git', ['add', '.']);
  sh('git', ['-c', `user.name=${author}`, 'commit', '-q', '-m', name]);
  rev[name] = sh('git', ['rev-parse', '--short', 'HEAD']);
}

function shadowlap(args: string[]): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: project, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out, stdout }));
  });
}

beforeAll(async () => {
  mock = await startMockAnthropic({ script: () => ({ message: message([text('Ticket summarized.')]) }) });
  project = join(fileURLToPath(new URL('.', import.meta.url)), `.tmp-bisect-${process.pid}`);
  rmSync(project, { recursive: true, force: true });
  mkdirSync(project);
  sh('git', ['init', '-q', '-b', 'main']);
  sh('git', ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(project, '.gitignore'), '.shadowlap/\n');
  commit('Start the ticket agent', { 'agent.mjs': AGENT, 'prompt.txt': 'You summarize support tickets.\n', 'marker.txt': '\n', 'README.md': 'Ticket agent\n' });
  const recorded = await shadowlap(['run', '--', process.execPath, 'agent.mjs']);
  expect(recorded.code, recorded.out).toBe(0);
  recordedRun = /recording run (\w{26})/.exec(recorded.out)![1]!;
  expect((await shadowlap(['pack', recordedRun, 'goldens/summary'])).code).toBe(0);
  commit('Describe the agent', { 'README.md': 'Ticket agent: one model call.\n' });
  commit('Add usage', { 'README.md': 'Ticket agent: one model call.\n\nnode agent.mjs\n' });
  commit('Ask for brevity', { 'prompt.txt': 'You summarize support tickets. Be brief.\n' }, 'Ravi');
  commit('Mention the prompt', { 'README.md': 'Ticket agent: one model call; the prompt is prompt.txt.\n' });
  const second = await shadowlap(['run', '--', process.execPath, 'agent.mjs']);
  expect((await shadowlap(['pack', /recording run (\w{26})/.exec(second.out)![1]!, 'goldens/brief'])).code).toBe(0);
  commit('Mark summaries as drafts', { 'marker.txt': 'DRAFT: \n' }, 'Jonas');
});
afterAll(async () => {
  await mock.close();
  rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('shadowlap bisect', () => {
  it('names the first commit where a golden diverges, at 0 tokens, and cleans up its worktrees', async () => {
    const hits = mock.requests.length;
    const r = await shadowlap(['bisect', 'goldens/summary', '--good', rev['Start the ticket agent']!]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`▸ goldens/summary · good ${rev['Start the ticket agent']} · bad ${rev['Mark summaries as drafts']} · 5 commits apart`);
    expect(r.out).toContain(`replay at ${rev['Add usage']}  replayed clean`);
    expect(r.out).toContain(`replay at ${rev['Ask for brevity']}  ✗ diverged at call 1 (api POST /v1/messages) · $.system`);
    expect(r.stdout).toMatch(new RegExp(`✓ first bad commit ${rev['Ask for brevity']} · Ask for brevity · Ravi · \\d{4}-\\d{2}-\\d{2}`));
    expect(r.stdout).toContain('diverged at call 1 (api POST /v1/messages) · $.system · 4 replays · 0 tokens · 0 upstream requests');
    expect(mock.requests.length, 'replays never reach the model').toBe(hits);
    // Every worktree is gone, from git and from disk.
    expect(sh('git', ['worktree', 'list']).split('\n')).toHaveLength(1);
    expect(readdirSync(join(project, '.shadowlap', 'bisect'))).toEqual([]);
    expect(sh('git', ['status', '--porcelain']), 'nothing left in the working tree').toBe('');
    const store = Store.open(join(project, '.shadowlap', 'shadowlap.db'));
    expect(store.listEvents({ kinds: ['bisect.found'] })[0]).toMatchObject({ ref: 'goldens/summary', data: { good: rev['Start the ticket agent'], bad: rev['Mark summaries as drafts'], first: { rev: rev['Ask for brevity'], subject: 'Ask for brevity', author: 'Ravi' }, replays: 4, tokens: 0, upstreamRequests: 0 } });
    store.close();
  });

  it('finds the commit where an outcome check starts failing, for a run in the store, as JSON', async () => {
    const r = await shadowlap(['bisect', 'goldens/brief', '--good', rev['Mention the prompt']!, '--expect', '{"output":{"excludes":"DRAFT"}}', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as { outcome: string; first: { short: string; why: string }; steps: Array<{ short: string; ok: boolean; result: string }>; commits: number; tokens: number };
    expect(report).toMatchObject({ outcome: 'found', commits: 1, tokens: 0, first: { short: rev['Mark summaries as drafts'], why: 'check failed: output doesn\'t include "DRAFT", but found in the output' } });
    expect(report.steps.map((s) => [s.short, s.ok])).toEqual([[rev['Mark summaries as drafts'], false], [rev['Mention the prompt'], true]]);

    const byRun = await shadowlap(['bisect', recordedRun.slice(0, 12), '--good', rev['Start the ticket agent']!, '--bad', rev['Mention the prompt']!]);
    expect(byRun.code, byRun.out).toBe(0);
    expect(byRun.stdout).toContain(`first bad commit ${rev['Ask for brevity']} · Ask for brevity`);
  });

  it('says when there is nothing to find, or the good commit already fails', async () => {
    const passes = await shadowlap(['bisect', 'goldens/summary', '--good', rev['Start the ticket agent']!, '--bad', rev['Add usage']!]);
    expect(passes.code).toBe(1);
    expect(passes.stdout).toContain(`no first bad commit: it passes at ${rev['Add usage']}, so there is nothing to find`);
    const fails = await shadowlap(['bisect', 'goldens/summary', '--good', rev['Ask for brevity']!]);
    expect(fails.code).toBe(1);
    expect(fails.stdout).toContain(`no first bad commit: it already fails at ${rev['Ask for brevity']}: diverged at call 1`);
    const backwards = await shadowlap(['bisect', 'goldens/summary', '--good', rev['Mention the prompt']!, '--bad', rev['Describe the agent']!]);
    expect(backwards.code).toBe(1);
    expect(backwards.out).toContain('is not an ancestor of --bad');
    const unknown = await shadowlap(['bisect', 'goldens/nothing', '--good', 'HEAD~1']);
    expect(unknown.out).toContain('goldens/nothing is neither a golden');
    expect(sh('git', ['worktree', 'list']).split('\n')).toHaveLength(1);
  });
});

describe('the command at each commit', () => {
  it('runs files from the worktree, and executables only the working tree has from there', () => {
    const root = join(project, 'repo');
    const m = { root, worktree: join(root, '.shadowlap', 'bisect', 'run-x', 'abc1234'), cwd: root, worktreeCwd: join(root, '.shadowlap', 'bisect', 'run-x', 'abc1234') };
    expect(mapArgv(['node', 'agent.mjs'], m)).toEqual(['node', 'agent.mjs']);
    expect(mapArgv(['node', join(root, 'dist', 'agent.js')], m)).toEqual(['node', join(m.worktree, 'dist', 'agent.js')]);
    expect(mapArgv([join(root, '.venv', 'bin', 'python'), 'agent.py'], m)).toEqual([join(root, '.venv', 'bin', 'python'), 'agent.py']);
    expect(mapArgv(['node', '/elsewhere/agent.js'], m)).toEqual(['node', '/elsewhere/agent.js']);
    expect(existsSync(m.worktree)).toBe(false);
  });
});
