// docs/decisions.md shows what `shadowlap decisions` and `migrate` print on the reference agent: a model
// switch on its golden, the prompt the working tree sends, a migration, and a prompt that rewords the
// final answer a judge check reads. Readers match their own output against these, so they must be
// real. This records the reference agent on a Claude model that retires, packs it as goldens/research
// in a project whose config names that model, runs the commands the page shows against the mock, and
// finds each sample's lines in what they print, run and session ids masked; the judged sample runs in
// a project of its own, whose golden has the judge check. The retirement notice says how many days
// are left, which changes every day: its line is masked too, and the engine's tests hold its words.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockAnthropic, withJudge, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from '@shadowlap-testing/reference-agent';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');
const AGENT = join(ROOT, 'testing', 'reference-agent', 'dist', 'main.js');
const PAGE = readFileSync(join(ROOT, 'docs', 'decisions.md'), 'utf8');

/** The page's fenced blocks, in order. */
const blocks = [...PAGE.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((m) => m[1]);

/** The output block the page shows after the block that runs `command`. */
function sampleAfter(command: string): string {
  const at = blocks.findIndex((b) => b.includes(command));
  if (at < 0 || !blocks[at + 1]) throw new Error(`no sample after "${command}"`);
  return blocks[at + 1];
}

/** Run and session ids differ on every run, and a retirement's days left on every day. */
const mask = (text: string) =>
  text
    .replace(/\b(mg|dc)-[0-9A-HJKMNP-TV-Z]{26}\b/g, '$1-<id>')
    .replace(/\b01[0-9A-HJKMNP-TV-Z]{8,24}\b/g, '<run>')
    .replace(/^.*claude-sonnet-4-5-20250929 (retires|was retired) on the Claude API.*$/gm, '<retirement notice>')
    .replace(/[ \t]+$/gm, '')
    .trim();

/** Whether `part`'s lines appear one after another in `whole`. */
const within = (whole: string, part: string) => `\n${whole}\n`.includes(`\n${part}\n`);

let mock: MockServer;
let dir: string;
let judged: string;
const printed: Record<'model' | 'prompt' | 'migrate' | 'judged', string> = { model: '', prompt: '', migrate: '', judged: '' };

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}, cwd: string = dir): Promise<{ code: number | null; stdout: string; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_HOME: join(dir, 'home'), AGENT_MODEL: 'claude-sonnet-4-5-20250929', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let out = '';
    child.stdout.on('data', (d: Buffer) => ((stdout += d.toString()), (out += d.toString())));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, stdout, out }));
  });
}

beforeAll(async () => {
  // The judge says whether what it reads still says that forks fence writes.
  mock = await startMockAnthropic({ script: withJudge((q) => (q.material.includes('forks fence writes') ? { verdict: 'yes', reason: 'It says that forks fence writes.' } : { verdict: 'no', reason: 'It no longer says that forks fence writes.' }), referenceScript), eventDelayMs: () => 0 });
  dir = mkdtempSync(join(tmpdir(), 'sl-decisions-samples-'));
  // A project that names its model in a file of its own, for migrate's config change.
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  writeFileSync(join(dir, 'agent.config.json'), '{\n  "model": "claude-sonnet-4-5-20250929"\n}\n');
  writeFileSync(join(dir, '.gitignore'), '.shadowlap/\nhome/\n');
  git('add', '.');
  git('commit', '-q', '-m', 'agent');
  const rec = await shadowlap(['run', '--', process.execPath, AGENT]);
  expect(rec.code, rec.out).toBe(0);
  const runId = /recording run (\w{26})/.exec(rec.out)![1];
  mkdirSync(join(dir, 'goldens'));
  const packed = await shadowlap(['pack', runId, 'goldens/research']);
  expect(packed.code, packed.out).toBe(0);
  const model = await shadowlap(['decisions', 'goldens/*', '--model', 'claude-haiku-4-5']);
  const prompt = await shadowlap(['decisions', runId.slice(0, 10), '--from-code'], { AGENT_SYSTEM_SUFFIX: 'Do not email the summary.' });
  const migrate = await shadowlap(['migrate', '--to', 'claude-haiku-4-5']);
  // A golden whose final answer a judge check reads, in a project of its own.
  judged = join(dir, 'judged');
  mkdirSync(join(judged, 'goldens'), { recursive: true });
  writeFileSync(join(judged, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/research': { expect: { judge: [{ name: 'fences', question: 'Does the final answer say that forks fence writes?', of: 'answer', model: 'claude-haiku-4-5' }] } } } }));
  const judgedRun = await shadowlap(['run', '--', process.execPath, AGENT], {}, judged);
  expect(judgedRun.code, judgedRun.out).toBe(0);
  const judgedPack = await shadowlap(['pack', /recording run (\w{26})/.exec(judgedRun.out)![1], 'goldens/research'], {}, judged);
  expect(judgedPack.code, judgedPack.out).toBe(0);
  const short = await shadowlap(['decisions', 'goldens/research', '--from-code'], { AGENT_SYSTEM_SUFFIX: 'Keep the final answer short.' }, judged);
  for (const [r, name] of [[model, 'decisions --model'], [prompt, 'decisions --from-code'], [migrate, 'migrate'], [short, 'decisions --from-code, judged']] as const) expect(r.code, `${name}\n${r.out}`).toBe(0);
  Object.assign(printed, { model: model.stdout, prompt: prompt.stdout, migrate: migrate.stdout, judged: short.stdout });
}, 180_000);

afterAll(async () => {
  await mock?.close();
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('docs/decisions.md shows what the commands print', () => {
  it('a model switch on a golden: every line of the report', () => {
    const sample = mask(sampleAfter('shadowlap decisions goldens/* --model claude-haiku-4-5'));
    expect(mask(printed.model)).toBe(sample);
  });

  it('the prompt in the working tree: the report as it starts', () => {
    const sample = mask(sampleAfter('shadowlap decisions 01M58VT1J5 --from-code'));
    expect(within(mask(printed.prompt), sample), `the page shows:\n${sample}\n\nthe CLI prints:\n${mask(printed.prompt)}`).toBe(true);
  });

  it('a prompt that rewords the final answer a judge check reads: the report as it starts', () => {
    const sample = mask(sampleAfter('shadowlap decisions goldens/research --from-code'));
    expect(within(mask(printed.judged), sample), `the page shows:\n${sample}\n\nthe CLI prints:\n${mask(printed.judged)}`).toBe(true);
  });

  it('a migration: its four blocks and the config change', () => {
    const sample = mask(sampleAfter('shadowlap migrate --to claude-haiku-4-5'));
    expect(within(mask(printed.migrate), sample), `the page shows:\n${sample}\n\nthe CLI prints:\n${mask(printed.migrate)}`).toBe(true);
  });
});
