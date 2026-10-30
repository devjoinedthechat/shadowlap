// The docs show what the CLI prints when a replay diverges: docs/ci.md the output of `shadowlap test`,
// docs/troubleshooting.md the report `shadowlap replay` gives, and docs/normalizers-and-redaction.md its
// hint. Readers match their own output against these, so they must be real. This records an agent that
// puts a new UUID in every request's metadata, packs it beside the reference agent's golden, runs both
// commands, and compares, with run ids and UUIDs masked. When the CLI's words change, the failure shows
// what it prints now.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockAnthropic, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from '@shadowlap-testing/reference-agent';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');
const page = (name: string) => readFileSync(join(ROOT, 'docs', name), 'utf8');

/** One request, with a new UUID in its metadata every run; what the CI sample's failing recording does. */
const AGENT = `import { randomUUID } from 'node:crypto';
const res = await fetch(\`\${process.env.ANTHROPIC_BASE_URL}/v1/messages\`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY ?? 'none', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 256, metadata: { user_id: randomUUID() }, messages: [{ role: 'user', content: 'Summarize the thread.' }] }),
});
const body = await res.text();
if (!res.ok) {
  console.error(\`summarize-thread: \${res.status} \${body}\`);
  process.exit(1);
}
console.log(JSON.parse(body).content[0].text ?? '');
`;

/** Run ids and UUIDs differ on every run: mask them, in the docs and in what the CLI printed alike. */
const mask = (text: string) =>
  text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\b01[0-9A-HJKMNP-TV-Z]{8,24}/g, '<run>')
    .replace(/[ \t]+$/gm, '')
    .trim();

/** The first fenced block after the line that starts with `lead` (or the page's first block). */
function sample(text: string, lead?: string): string {
  const from = lead ? text.indexOf(`\n${lead}`) : 0;
  if (from < 0) throw new Error(`no line starting "${lead}"`);
  const m = /^```[^\n]*\n([\s\S]*?)^```/m.exec(text.slice(from));
  if (!m) throw new Error(`no code block after "${lead}"`);
  return m[1];
}

/** Whether `part`'s lines appear one after another in `whole`. */
const within = (whole: string, part: string) => `\n${whole}\n`.includes(`\n${part}\n`);

let mock: MockServer;
let dir: string;
interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}
let tested: Ran;
let replayed: Ran;

/** Runs the CLI in the project. Not spawnSync: the mock model answers from this process. */
function cli(args: string[]): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: dir,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', CI: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(process.platform === 'win32')('the output the docs show', () => {
  beforeAll(async () => {
    mock = await startMockAnthropic({ script: referenceScript });
    dir = mkdtempSync(join(tmpdir(), 'shadowlap-samples-'));
    writeFileSync(join(dir, 'summarize.mjs'), AGENT);
    const recorded = await cli(['run', '--', 'node', 'summarize.mjs']);
    if (recorded.code !== 0) throw new Error(recorded.stdout + recorded.stderr);
    const [run] = JSON.parse((await cli(['ls', '--json'])).stdout) as Array<{ runId: string }>;
    const packed = await cli(['pack', run.runId, join('goldens', 'summarize-thread')]);
    if (packed.code !== 0) throw new Error(packed.stdout + packed.stderr);
    // The reference agent's golden runs `node testing/reference-agent/dist/main.js` from the project.
    cpSync(join(ROOT, 'testing', 'golden', 'reference-agent'), join(dir, 'goldens', 'triage-inbox'), { recursive: true });
    // Committed, as a project holds its goldens: a pack from elsewhere that it doesn't track asks first.
    for (const args of [['init', '-q'], ['add', 'goldens']]) execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    symlinkSync(join(ROOT, 'testing'), join(dir, 'testing'), 'dir');
    // goldens/* as a shell expands it.
    tested = await cli(['test', join('goldens', 'summarize-thread'), join('goldens', 'triage-inbox')]);
    replayed = await cli(['replay', run.runId]);
  }, 120_000);
  afterAll(async () => {
    await mock?.close();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  // shadowlap test prints its report on stdout; replay leaves stdout to the agent and reports on stderr.
  it('in docs/ci.md is what shadowlap test prints', () => {
    expect(tested.code, tested.stdout + tested.stderr).toBe(1);
    const shown = sample(page('ci.md'), 'It prints this when one agent puts a fresh UUID');
    expect(mask(shown), `docs/ci.md shows something else than shadowlap test prints:\n${tested.stdout}`).toBe(mask(tested.stdout));
  });

  it('in docs/troubleshooting.md is the report shadowlap replay gives', () => {
    expect(replayed.code, replayed.stdout + replayed.stderr).toBe(0);
    const shown = sample(page('troubleshooting.md'));
    expect(within(mask(replayed.stderr), mask(shown)), `docs/troubleshooting.md opens with something else than shadowlap replay prints:\n${replayed.stderr}`).toBe(true);
  });

  it('in docs/normalizers-and-redaction.md is the hint that report gives', () => {
    const shown = sample(page('normalizers-and-redaction.md'), 'When a divergence is only a date');
    expect(within(replayed.stderr, shown.replace(/\n$/, '')), `docs/normalizers-and-redaction.md shows another hint than shadowlap replay prints:\n${replayed.stderr}`).toBe(true);
  });
});
