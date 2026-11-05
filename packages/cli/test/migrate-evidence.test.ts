import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, toolUse, type MockServer, type Script } from '@shadowlap-testing/mock-anthropic';
import type { DecisionsReport } from '@shadowlap/engine';
import { formatMigrate, type MigrateReport } from '../src/migrate.js';

/**
 * What `migrate` may and may not say on the evidence it has. The agent reads an order and the policy,
 * then writes (refund-agent.mjs); these models answer it:
 *
 * - The old model reads the policy, then escalates, as the policy says.
 * - `mock-same` answers as the old model does.
 * - `mock-note` escalates with a note: a write with other arguments, and every attempt passes.
 * - `mock-skips-read` looks up the customer instead of the policy, and refunds without having read it.
 *   Asked in the recorded run's state it has the policy and escalates, so only a read changes there.
 * - `mock-broken-note` escalates with a note where it has the policy, and otherwise goes as
 *   `mock-skips-read` goes: a preview flags it, and every attempt fails.
 * - `mock-terse` answers a lookup in other words.
 * - `mock-reads-more` reads the customer as well: one more step than the recording, and every attempt passes.
 *
 * `gone` turns the old model away, as a provider does once a model retires. `drifted` has it refund:
 * it still answers, and its runs no longer pass.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./refund-agent.mjs', import.meta.url));
const OLD = 'claude-sonnet-4-5-20250929';
const REFUND_CHECKS = { tools: { issue_refund: 0, escalate: '>= 1' } };

let gone = false;
let drifted = false;

const script: Script = ({ request }) => {
  const model = request.model;
  const asked = JSON.stringify(request.messages);
  const opts = { model, input_tokens: 1000, output_tokens: 40 };
  const say = (...blocks: Parameters<typeof message>[0]) => ({ message: message(blocks, opts) });
  if (gone && model === OLD) return { status: 404, body: { type: 'error', error: { type: 'not_found_error', message: `model: ${model}` } } };
  if (asked.includes('Look up order')) return asked.includes('ORDER') ? say(text(model === 'mock-terse' ? 'A1: 240.' : 'Order A1 is 240, and it shipped.')) : say(toolUse('lookup_order', { id: 'A1' }));
  if (/"name":"(escalate|issue_refund)"/.test(asked)) return say(text('Done.'));
  if (!asked.includes('ORDER')) return say(toolUse('lookup_order', { id: 'A1' }));
  const hasPolicy = asked.includes('POLICY');
  if (model === 'mock-skips-read' || model === 'mock-broken-note') {
    if (hasPolicy) return say(toolUse('escalate', model === 'mock-broken-note' ? { id: 'A1', note: 'over the limit' } : { id: 'A1' }));
    return say(asked.includes('CUSTOMER') ? toolUse('issue_refund', { id: 'A1', amount: 240 }) : toolUse('lookup_customer', { id: 'C9' }));
  }
  if (model === 'mock-reads-more' && !asked.includes('CUSTOMER')) return say(toolUse('lookup_customer', { id: 'C9' }));
  if (!hasPolicy) return say(toolUse('lookup_policy', { topic: 'refunds' }));
  if (drifted && model === OLD) return say(toolUse('issue_refund', { id: 'A1', amount: 240 }));
  return say(toolUse('escalate', model === 'mock-note' ? { id: 'A1', note: 'over the limit' } : { id: 'A1' }));
};

let mock: MockServer;
let cwd: string;
let db: string;

function shadowlap(args: string[]): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], {
      cwd,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_HOME: join(cwd, 'home'), ANTHROPIC_API_KEY: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => ((out += d.toString()), (stdout += d.toString())));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out, stdout }));
  });
}

const json = <T,>(r: { stdout: string; out: string }): T => {
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new Error(`not JSON:\n${r.out}`);
  }
};

async function golden(name: string, task: string): Promise<string> {
  const rec = await shadowlap(['run', '--', process.execPath, 'agent.mjs', task]);
  expect(rec.code, rec.out).toBe(0);
  const runId = /Recorded (\w{26})|recording run (\w{26})/.exec(rec.out)!;
  const id = runId[1] ?? runId[2];
  const packed = await shadowlap(['pack', id, `goldens/${name}`]);
  expect(packed.code, packed.out).toBe(0);
  return id;
}

const migrate = async (to: string, ...specs: string[]) => {
  const r = await shadowlap(['migrate', '--to', to, '-y', '--json', ...specs]);
  return { code: r.code, out: r.out, report: json<MigrateReport>(r) };
};

beforeAll(async () => {
  mock = await startMockAnthropic({ script, eventDelayMs: () => 0, models: [OLD, 'mock-same'] });
  cwd = mkdtempSync(join(tmpdir(), 'sl-migrate-evidence-'));
  db = join(cwd, '.shadowlap', 'shadowlap.db');
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  // The agent's own file finds the SDKs from the repository; the project reads its model from its config.
  writeFileSync(join(cwd, 'agent.mjs'), `await import(${JSON.stringify(pathToFileURL(AGENT).href)});\n`);
  writeFileSync(join(cwd, 'agent.config.json'), `{\n  "model": "${OLD}"\n}\n`);
  writeFileSync(
    join(cwd, 'shadowlap.config.json'),
    JSON.stringify({
      // A wider margin keeps a run in fewer pairs, which is all a test needs of it.
      verify: { margin: 0.3 },
      mcp: { effects: { lookup_order: 'read', lookup_policy: 'read', lookup_customer: 'read', issue_refund: 'write', escalate: 'write' } },
      tests: {
        'goldens/refund': { fork: true, expect: REFUND_CHECKS },
        'goldens/lookup-checked': { fork: true, expect: { answer: { includes: 'shipped' } } },
      },
    }),
  );
  writeFileSync(join(cwd, '.gitignore'), '.shadowlap/\nhome/\n');
  mkdirSync(join(cwd, 'goldens'), { recursive: true });
  await golden('refund', 'refund');
  await golden('lookup', 'lookup');
  await golden('lookup-checked', 'lookup');
  git('add', '.');
  git('commit', '-q', '-m', 'agent');
}, 120_000);

afterAll(async () => {
  await mock.close();
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

beforeEach(() => {
  gone = false;
  drifted = false;
});

describe('a baseline that says nothing', () => {
  it('fails a model that fails every attempt once the old model is gone, and says it had no baseline', async () => {
    gone = true;
    const { code, out, report } = await migrate('mock-broken-note', 'goldens/refund');
    expect(code, out).toBe(1);
    expect(report.passes.runs).toEqual([expect.objectContaining({ golden: 'goldens/refund', verdict: 'failed', outcome: 'broken', verified: true })]);
    expect(report.passes.runs[0].tally?.passes).toBe(0);
    expect(report.passes.runs[0].tally?.baseline ?? null).toBeNull();
    expect(report.warnings.join('\n')).toMatch(/could not ask its model: HTTP 404/);
    expect(formatMigrate(report)).toContain('breaks runs');
  }, 120_000);

  it('passes a model that keeps the run by its gate alone once the old model is gone', async () => {
    gone = true;
    const { code, out, report } = await migrate('mock-note', 'goldens/refund');
    expect(code, out).toBe(0);
    expect(report.passes.runs).toEqual([expect.objectContaining({ verdict: 'passed', outcome: 'kept', verified: true })]);
    expect(report.passes.runs[0].tally?.baseline ?? null).toBeNull();
    expect(report.passes.runs[0].tally?.rule).toMatch(/^gate:/);
    expect(report.warnings.join('\n')).toMatch(/could not ask its model/);
  }, 120_000);

  it('keeps no run to a baseline that passes nothing, though its model still answers', async () => {
    drifted = true;
    const { code, out, report } = await migrate('mock-broken-note', 'goldens/refund');
    expect(code, out).toBe(1);
    expect(report.passes.runs).toEqual([expect.objectContaining({ verdict: 'failed', outcome: 'broken' })]);
    expect(report.warnings.join('\n')).toMatch(/the baseline passed only 0 of \d+/);
  }, 120_000);
});

describe('what a preview cannot clear', () => {
  it('runs a changed read end to end, where its steps look the same in the recorded state', async () => {
    const { code, out, report } = await migrate('mock-skips-read', 'goldens/refund');
    expect(code, out).toBe(1);
    expect(report.changes.flagged).toBe(0);
    expect(report.decisions.counts[3]).toBeGreaterThan(0);
    expect(report.passes.runs).toEqual([expect.objectContaining({ verdict: 'failed', outcome: 'broken', verified: true })]);
    expect(formatMigrate(report)).toContain('breaks runs');
  }, 120_000);

  it('runs a run that writes end to end, however alike its steps look', async () => {
    const { code, out, report } = await migrate('mock-same', 'goldens/refund');
    expect(code, out).toBe(0);
    expect(report.decisions.counts[1] + report.decisions.counts[2] + report.decisions.counts[3] + report.decisions.counts[4]).toBe(0);
    expect(report.passes.runs).toEqual([expect.objectContaining({ verdict: 'passed', outcome: 'kept', verified: true })]);
    expect(formatMigrate(report)).toContain('1 of 1 run verified end to end');
    expect(report.pullRequest.body).toContain('1 of 1 run verified end to end');
  }, 120_000);

  it('runs text-only changes end to end when a check reads what the preview does not', async () => {
    const { code, out, report } = await migrate('mock-terse', 'goldens/lookup-checked');
    expect(code, out).toBe(1);
    expect(report.passes.runs).toEqual([expect.objectContaining({ verdict: 'failed', outcome: 'broken', verified: true })]);
  }, 120_000);

  it('counts what a run costs end to end, which the recorded steps do not show', async () => {
    const { code, out, report } = await migrate('mock-reads-more', 'goldens/refund');
    expect(code, out).toBe(0);
    expect(report.costs.tokensPerRun.after).toBe(report.costs.tokensPerRun.before);
    expect(report.costs.endToEnd?.recorded.inputTokens).toBe(4000);
    expect(report.costs.endToEnd?.now.inputTokens).toBe(5000);
    expect(formatMigrate(report)).toContain('end to end   4,000 → 5,000 input tokens (+25%)');
    expect(report.pullRequest.body).toContain('End to end: 4,000 → 5,000 input tokens (+25%)');
  }, 120_000);

  it('says it did not run end to end a run that writes nothing, has no check and decides the same', async () => {
    const { code, out, report } = await migrate('mock-same', 'goldens/lookup');
    expect(code, out).toBe(0);
    expect(report.passes.runs).toEqual([expect.objectContaining({ verdict: 'passed', outcome: 'unchanged', verified: false })]);
    const printed = formatMigrate(report);
    expect(printed).toContain('decided the same in the preview');
    expect(printed).toContain('0 of 1 run verified end to end');
    expect(printed).not.toContain('keeps every run');
  }, 120_000);

  it('decisions --then-verify takes the same runs, and --strict still fails only on a write, stop or judged change', async () => {
    const then = await shadowlap(['decisions', 'goldens/refund', '--model', 'mock-skips-read', '--then-verify', '--json', '-y']);
    expect(then.code, then.out).toBe(1);
    const report = json<DecisionsReport>(then);
    expect(report.flagged).toEqual([]);
    expect(report.toVerify).toHaveLength(1);
    expect(report.verify?.runs).toEqual([expect.objectContaining({ outcome: 'broken' })]);
    const strict = await shadowlap(['decisions', 'goldens/refund', '--model', 'mock-skips-read', '--strict', '--json']);
    expect(strict.code, strict.out).toBe(0);
  }, 120_000);

  it('decisions --verify verifies what the session could not clear', async () => {
    const asked = await shadowlap(['decisions', 'goldens/refund', '--model', 'mock-skips-read', '--json']);
    const session = json<DecisionsReport>(asked).decisionsId!;
    const r = await shadowlap(['decisions', '--verify', session, '-y']);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('broken');
  }, 120_000);
});
