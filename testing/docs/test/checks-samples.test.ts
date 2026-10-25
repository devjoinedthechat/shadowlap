// docs/checks.md shows what the CLI prints for checks on calls and conditions: a replay that breaks a
// calls rule, shadowlap test with a when rule that held, did not hold and was broken, shadowlap check
// over recordings with labels, and doctor naming a misspelt tool. Readers match their own output
// against these, so they must be real. This records the page's refund agent (checks/agent.mjs) with
// the mock model playing each decision, packs three goldens, runs each command and compares, with run
// ids and token counts masked. When the CLI's words change, the failure shows what it prints now.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext } from '@shadowlap-testing/mock-anthropic';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');
const AGENT = fileURLToPath(new URL('./checks/agent.mjs', import.meta.url));
const page = readFileSync(join(ROOT, 'docs', 'checks.md'), 'utf8');

/** What the model decides once it has looked the order up: refund this much, or escalate. */
let decision: { refund: number } | 'escalate' = 'escalate';

function script(ctx: ScriptContext) {
  const order = /order (\S+)\./.exec(JSON.stringify(ctx.request.messages[0]?.content ?? ''))?.[1] ?? 'A-1042';
  if (ctx.assistantTurns === 0) return { message: message([text('Looking the order up.'), toolUse('lookup_order', { order_id: order }, `toolu_lookup_${ctx.requestNo}`)]) };
  if (ctx.assistantTurns === 1) {
    return decision === 'escalate'
      ? { message: message([text('Above the limit.'), toolUse('escalate', { reason: 'refund above $100' }, `toolu_escalate_${ctx.requestNo}`)]) }
      : { message: message([text('Refunding.'), toolUse('issue_refund', { order_id: order, amount: decision.refund }, `toolu_refund_${ctx.requestNo}`)]) };
  }
  return { message: message([text('Done.')]) };
}

/** Run ids and token counts differ from run to run: mask them, in the page and in what the CLI printed alike. */
const mask = (s: string) =>
  s
    .replace(/\b01[0-9A-HJKMNP-TV-Z]{8,24}/g, '<run>')
    .replace(/\b[\d.]+k? input tokens/g, '<n> input tokens')
    .replace(/[ \t]+$/gm, '')
    .trim();

/** The fenced block after the line that starts with `lead`: the first, or the `nth` counting from 0. */
function sample(lead: string, nth = 0): string {
  const from = page.indexOf(`\n${lead}`);
  if (from < 0) throw new Error(`docs/checks.md has no line starting "${lead}"`);
  const blocks = [...page.slice(from).matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)];
  if (!blocks[nth]) throw new Error(`docs/checks.md has no code block ${nth + 1} after "${lead}"`);
  return blocks[nth][1];
}

/** Whether `part`'s lines appear one after another in `whole`. A sample with nothing in it shows nothing. */
function within(whole: string, part: string, squeeze = (x: string) => x): boolean {
  if (!mask(part)) throw new Error('the sample is empty');
  return `\n${squeeze(mask(whole))}\n`.includes(`\n${squeeze(mask(part))}\n`);
}

/** doctor pads its names to the longest it prints, which depends on the shell it runs in. */
const columns = (s: string) => s.replace(/ {2,}/g, '  ');

let mock: MockServer;
let dir: string;
interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}
const ran: Record<string, Ran> = {};
const runs: Record<string, string> = {};

/** Runs the CLI in the project. Not spawnSync: the mock model answers from this process. */
function cli(args: string[]): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: dir,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_HOME: join(dir, 'home'), CI: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function record(name: string, order: string, decide: typeof decision): Promise<void> {
  decision = decide;
  const r = await cli(['run', '--summary-json', `${name}.json`, '--', 'node', AGENT, order]);
  if (r.code !== 0) throw new Error(r.stdout + r.stderr);
  runs[name] = (JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as { summary: { runId: string } }).summary.runId;
}

const config = (tests: unknown) => writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify({ tests }, null, 2));
const RULE = { calls: [{ tool: 'issue_refund', after: 'lookup_order', args: { amount: { '<=': '@lookup_order.result.total' } } }] };
const ESCALATE = { when: [{ if: { tool: 'lookup_order', result: { total: { '>': 100 } } }, then: { tools: { escalate: '>= 1', issue_refund: 0 } } }] };

describe.skipIf(process.platform === 'win32')('the output docs/checks.md shows', () => {
  beforeAll(async () => {
    mock = await startMockAnthropic({ script, eventDelayMs: () => 0 });
    dir = mkdtempSync(join(tmpdir(), 'shadowlap-checks-samples-'));
    // Oldest first, as shadowlap check lists them newest first: a refund above the total, labelled
    // bug; an escalation, labelled good; a refund within the limit; another escalation.
    await record('bug', 'A-1042', { refund: 240 });
    await record('good', 'A-1042', 'escalate');
    await record('small', 'B-7', { refund: 40 });
    await record('latest', 'A-1042', 'escalate');
    for (const [run, label] of [['bug', 'bug'], ['good', 'good']] as const) {
      const r = await cli(['label', runs[run], label]);
      if (r.code !== 0) throw new Error(r.stdout + r.stderr);
    }
    for (const [run, golden] of [['bug', 'refund-over-limit'], ['good', 'refund-escalated'], ['small', 'refund-in-limit']] as const) {
      const r = await cli(['pack', runs[run], join('goldens', golden)]);
      if (r.code !== 0) throw new Error(r.stdout + r.stderr);
    }
    // Doctor first, while the store holds the four recordings alone.
    config({ 'goldens/refund-in-limit': { expect: { calls: [{ tool: 'issue_refund', after: 'lookup_orders' }] } } });
    ran.doctor = await cli(['doctor']);
    writeFileSync(join(dir, 'refund-rule.json'), JSON.stringify(RULE));
    ran.replay = await cli(['replay', runs.bug, '--expect', '@refund-rule.json']);
    ran.check = await cli(['check', '--expect', '@refund-rule.json']);
    config({ 'goldens/refund-*': { expect: { ...RULE, ...ESCALATE } } });
    ran.test = await cli(['test', join('goldens', 'refund-escalated'), join('goldens', 'refund-in-limit'), join('goldens', 'refund-over-limit')]);
  }, 120_000);
  afterAll(async () => {
    await mock?.close();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('shows the failure of a calls rule as shadowlap replay reports it', () => {
    expect(ran.replay.code, ran.replay.stdout + ran.replay.stderr).toBe(1);
    const shown = sample('A rule needs `after`, `args` or both.');
    expect(within(ran.replay.stdout + ran.replay.stderr, shown), `docs/checks.md shows another report than shadowlap replay gives:\n${ran.replay.stderr}`).toBe(true);
  });

  it('shows shadowlap test with a when rule as it prints it', () => {
    expect(ran.test.code, ran.test.stdout + ran.test.stderr).toBe(1);
    const shown = sample('- Each check under `then` is reported on its own');
    expect(within(ran.test.stdout, shown), `docs/checks.md shows other lines than shadowlap test prints:\n${ran.test.stdout}`).toBe(true);
  });

  it('shows shadowlap check as it prints it', () => {
    expect(ran.check.code, ran.check.stdout + ran.check.stderr).toBe(1);
    const shown = sample('```sh\nshadowlap check --expect @refund-rule.json', 1);
    expect(within(ran.check.stdout, shown), `docs/checks.md shows another report than shadowlap check prints:\n${ran.check.stdout}`).toBe(true);
  });

  it('shows doctor naming a misspelt tool as it prints it', () => {
    const shown = sample('`shadowlap doctor` holds the rules');
    expect(within(ran.doctor.stdout, shown, columns), `docs/checks.md shows other lines than shadowlap doctor prints:\n${ran.doctor.stdout}`).toBe(true);
  });
});
