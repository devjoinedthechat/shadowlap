import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
let briefRun = '';

const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
function commit(name: string, files: Record<string, string | null>, author = 'Test'): void {
  for (const [f, content] of Object.entries(files)) {
    if (content === null) rmSync(join(project, f));
    else writeFileSync(join(project, f), content);
  }
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
  mock = await startMockAnthropic({ script: (ctx) => ({ message: message([text(JSON.stringify(ctx.request.system ?? '').includes('Be brief') ? 'Short.' : 'Ticket summarized.')]) }) });
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
  // BROKEN makes the build step some tests give fail, at this commit only.
  commit('Add usage', { 'README.md': 'Ticket agent: one model call.\n\nnode agent.mjs\n', BROKEN: 'x\n' });
  commit('Ask for brevity', { 'prompt.txt': 'You summarize support tickets. Be brief.\n', BROKEN: null }, 'Ravi');
  commit('Mention the prompt', { 'README.md': 'Ticket agent: one model call; the prompt is prompt.txt.\n' });
  const second = await shadowlap(['run', '--', process.execPath, 'agent.mjs']);
  briefRun = /recording run (\w{26})/.exec(second.out)![1]!;
  expect((await shadowlap(['pack', briefRun, 'goldens/brief'])).code).toBe(0);
  commit('Mark summaries as drafts', { 'marker.txt': 'DRAFT: \n' }, 'Jonas');
  // A branch off 'Describe the agent' where the golden passes too, never merged.
  sh('git', ['checkout', '-q', '-b', 'side', rev['Describe the agent']!]);
  commit('Side note', { 'NOTES.md': 'side\n' });
  sh('git', ['checkout', '-q', 'main']);
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

  it('with --fork, finds where a run that failed a check started failing, going live from each fork', async () => {
    const hits = mock.requests.length;
    // The second recording, whose answer is "Short.", which the check rules out.
    const r = await shadowlap(['bisect', briefRun, '--good', rev['Start the ticket agent']!, '--bad', rev['Mention the prompt']!, '--expect', '{"answer":{"excludes":"Short"}}', '--fork', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as { first: { short: string; why: string }; upstreamRequests: number; tokens: number; steps: Array<{ short: string; ok: boolean; result: string }> };
    expect(report.first).toMatchObject({ short: rev['Ask for brevity'], why: 'check failed: final answer doesn\'t include "Short", but found in the final answer' });
    // Commits before the change diverge at the prompt and run live from there, so they cost what they cost.
    expect(report.steps.find((s) => s.short === rev['Start the ticket agent'])).toMatchObject({ ok: true, result: 'forked at call 1, 1 check passed' });
    expect(report.upstreamRequests).toBe(mock.requests.length - hits);
    expect(report.upstreamRequests).toBeGreaterThan(0);
    expect(report.tokens).toBeGreaterThan(0);
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
    expect(backwards.out).toContain(`--good ${rev['Mention the prompt']} comes after --bad ${rev['Describe the agent']}`);
    const unknown = await shadowlap(['bisect', 'goldens/nothing', '--good', 'HEAD~1']);
    expect(unknown.out).toContain('goldens/nothing is neither a golden');
    expect(sh('git', ['worktree', 'list']).split('\n')).toHaveLength(1);
  });
});

describe('commits bisect cannot test', () => {
  it('skips a commit that won\'t build and names it when the first bad commit could be it', async () => {
    const r = await shadowlap(['bisect', 'goldens/summary', '--good', rev['Start the ticket agent']!, '--build', 'test ! -f BROKEN', '--json']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`replay at ${rev['Add usage']}  – skipped: could not be built`);
    const report = JSON.parse(r.stdout) as { first: { short: string }; untested: Array<{ short: string; subject: string }>; steps: Array<{ short: string; skipped: boolean }> };
    expect(report.first.short).toBe(rev['Ask for brevity']);
    expect(report.untested).toEqual([expect.objectContaining({ short: rev['Add usage'], subject: 'Add usage' })]);
    expect(report.steps.find((x) => x.short === rev['Add usage'])!.skipped).toBe(true);
    const text = await shadowlap(['bisect', 'goldens/summary', '--good', rev['Start the ticket agent']!, '--build', 'test ! -f BROKEN']);
    expect(text.stdout).toContain(`or one just before it, which could not be tested: ${rev['Add usage']} (Add usage)`);
  });

  it('searches from where the histories meet when the good commit is on another branch', async () => {
    const r = await shadowlap(['bisect', 'goldens/summary', '--good', rev['Side note']!]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`--good ${rev['Side note']} is not an ancestor of --bad HEAD: searching from where their histories meet, ${rev['Describe the agent']}`);
    expect(r.stdout).toContain(`first bad commit ${rev['Ask for brevity']}`);
  });
});

// A shell build step that sleeps, so there is time to interrupt; Windows has no sleep.
describe.skipIf(process.platform === 'win32')('an interrupted bisect', () => {
  it('stops at Ctrl-C, concludes nothing from the replay it cut short, and removes its worktrees', async () => {
    const child = spawn(process.execPath, [CLI, 'bisect', 'goldens/summary', '--good', rev['Start the ticket agent']!, '--build', 'sleep 2'], { cwd: project, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    setTimeout(() => child.kill('SIGINT'), 1000);
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code, out).toBe(1);
    expect(out).toContain('no first bad commit: interrupted');
    expect(out).not.toContain('first bad commit ' + rev['Ask for brevity']);
    expect(sh('git', ['worktree', 'list']).split('\n')).toHaveLength(1);
    expect(readdirSync(join(project, '.shadowlap', 'bisect'))).toEqual([]);
  });
});

describe('a package this repository links into node_modules', () => {
  let repo = '';
  const at: Record<string, string> = {};
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const step = (name: string, files: Record<string, string>) => {
    for (const [f, content] of Object.entries(files)) {
      mkdirSync(join(repo, f, '..'), { recursive: true });
      writeFileSync(join(repo, f), content);
    }
    git(['add', '.']);
    git(['commit', '-q', '-m', name]);
    at[name] = git(['rev-parse', '--short', 'HEAD']);
  };
  const run = (args: string[]) =>
    new Promise<{ code: number | null; out: string; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd: repo, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let stdout = '';
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString();
        stdout += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      child.on('exit', (code) => resolve({ code, out, stdout }));
    });

  beforeAll(async () => {
    // A workspace package with the prompt, linked into node_modules as npm workspaces link one.
    repo = join(fileURLToPath(new URL('.', import.meta.url)), `.tmp-bisect-ws-${process.pid}`);
    rmSync(repo, { recursive: true, force: true });
    mkdirSync(repo);
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    const agent = AGENT.replace("const system = readFileSync(new URL('./prompt.txt', import.meta.url), 'utf8').trim();", "import { system } from '@acme/prompt';").replace("const marker = readFileSync(new URL('./marker.txt', import.meta.url), 'utf8').trim();", "const marker = '';").replace("import { readFileSync } from 'node:fs';\n", '');
    step('Start', { '.gitignore': '.shadowlap/\nnode_modules/\n', 'agent.mjs': agent, 'lib/prompt/package.json': JSON.stringify({ name: '@acme/prompt', type: 'module', exports: './index.mjs' }), 'lib/prompt/index.mjs': "export const system = 'You summarize support tickets.';\n" });
    mkdirSync(join(repo, 'node_modules', '@acme'), { recursive: true });
    symlinkSync(join('..', '..', 'lib', 'prompt'), join(repo, 'node_modules', '@acme', 'prompt'));
    const recorded = await run(['run', '--', process.execPath, 'agent.mjs']);
    expect(recorded.code, recorded.out).toBe(0);
    expect((await run(['pack', /recording run (\w{26})/.exec(recorded.out)![1]!, 'goldens/ws'])).code).toBe(0);
    step('Document it', { 'README.md': 'docs\n' });
    step('Ask for brevity in the package', { 'lib/prompt/index.mjs': "export const system = 'You summarize support tickets. Be brief.';\n" });
    step('More docs', { 'README.md': 'more docs\n' });
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

  it('replays each commit with its own copy of the package, not the working tree\'s', async () => {
    const r = await run(['bisect', 'goldens/ws', '--good', at['Start']!]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("node_modules is linked from your working tree, with this repository's own packages as they were at each commit");
    expect(r.stdout).toContain(`first bad commit ${at['Ask for brevity in the package']} · Ask for brevity in the package`);
    // The working tree's own node_modules is untouched.
    expect(lstatSync(join(repo, 'node_modules', '@acme', 'prompt')).isSymbolicLink()).toBe(true);
    expect(git(['worktree', 'list']).split('\n')).toHaveLength(1);
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
