import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';

/**
 * A golden committed on macOS or Linux and checked out by a git that converts line endings (Git for
 * Windows' default core.autocrlf=true) still passes: a pack carries a .gitattributes that keeps git
 * from converting it, and a golden committed before packs did is read back as it was committed.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

const AGENT = `const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model: 'small-model', max_tokens: 64, system: 'You answer in one line.\\nNo more.', messages: [{ role: 'user', content: 'Line one.\\nLine two.' }] }),
});
if (!res.ok) {
  console.error(await res.text());
  process.exit(1);
}
console.log((await res.json()).content[0].text);
`;

let mock: MockServer;
let root: string;
let project: string;
let clone: string;

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function shadowlap(cwd: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

/** The pack's files that hold a CR, as a checkout left them. */
function withCr(dir: string): string[] {
  const files = [...readdirSync(join(dir, 'blobs')).map((n) => join('blobs', n)), 'calls.jsonl', 'run.json'];
  return files.filter((f) => readFileSync(join(dir, f)).includes('\r'));
}

beforeAll(async () => {
  mock = await startMockAnthropic({ script: () => ({ message: message([text('One line.\nAnd another.')]) }) });
  root = mkdtempSync(join(tmpdir(), 'sl-crlf-'));
  project = join(root, 'project');
  clone = join(root, 'clone');
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  git(project, ['config', 'user.email', 'test@example.com']);
  git(project, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(project, '.gitignore'), '.shadowlap/\n');
  writeFileSync(join(project, 'agent.mjs'), AGENT);
  const recorded = await shadowlap(project, ['run', '--', process.execPath, 'agent.mjs']);
  expect(recorded.code, recorded.out).toBe(0);
  const runId = /recording run (\w{26})/.exec(recorded.out)![1]!;
  expect((await shadowlap(project, ['pack', runId, 'goldens/answer'])).code).toBe(0);
  // A golden packed before packs carried their .gitattributes.
  expect((await shadowlap(project, ['pack', runId, 'goldens/older'])).code).toBe(0);
  rmSync(join(project, 'goldens', 'older', '.gitattributes'));
  git(project, ['add', '.']);
  git(project, ['-c', 'user.name=Test', 'commit', '-q', '-m', 'Add the agent and its goldens']);
  execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=true', project, clone], { stdio: 'ignore' });
});
afterAll(async () => {
  await mock.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('a golden checked out by a git that converts line endings', () => {
  it('is written with a .gitattributes that keeps its bytes as they are', () => {
    expect(readFileSync(join(project, 'goldens', 'answer', '.gitattributes'), 'utf8')).toMatch(/^\* -text$/m);
    expect(withCr(join(clone, 'goldens', 'answer'))).toEqual([]);
    // Without it, the checkout converted the pack's text files.
    expect(withCr(join(clone, 'goldens', 'older')).length).toBeGreaterThan(0);
  });

  it('passes shadowlap test there, one committed before packs carried the file too', async () => {
    const r = await shadowlap(clone, ['test', 'goldens/*']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('✓ answer: 1/1 replayed');
    expect(r.out).toContain('✓ older: 1/1 replayed');
    expect(r.out).toContain('2 passed, 0 failed');
  });
});
