import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { judgeAnswer, judgeQuestion, message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext } from '@shadowlap-testing/mock-anthropic';
import { formatChecks } from '../src/golden-test.js';

/**
 * What `shadowlap test` prints for a failed golden goes to a CI job's log as it is: the GitHub
 * Action runs it with the job's own output, and the runner reads a line whose text starts with `::`
 * as a workflow command (`stop-commands` silences every command after it, an annotation can be
 * forged). A judge's reason is a model's words, and what the agent printed is the agent's: neither
 * starts a line of its own there, through a line break or a bare carriage return.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./support-agent.mjs', import.meta.url));
const REASON = 'It refunded without asking.\n::stop-commands::tok\n::error file=src/agent.ts,line=1,title=Shadowlap::forged\n';
const SAID = 'Done.\r::stop-commands::tok\r\n::warning::from the agent';

function script(ctx: ScriptContext) {
  const q = judgeQuestion(ctx.request);
  if (q) return { message: judgeAnswer({ verdict: 'no', reason: REASON }, q.model) };
  if (ctx.assistantTurns === 0) return { message: message([toolUse('lookup_order', { order_id: 'A-1042' }, `toolu_lookup_${ctx.requestNo}`)]) };
  if (ctx.assistantTurns === 1) return { message: message([toolUse('issue_refund', { order_id: 'A-1042', amount: 240 }, `toolu_refund_${ctx.requestNo}`)]) };
  return { message: message([text(SAID)], { stop_reason: 'end_turn' }) };
}

/** The lines a GitHub Actions runner reads as workflow commands: past the white space it trims, `::`, or `##[` anywhere in the line. */
const commandsIn = (out: string) => out.split(/\r\n|\r|\n/).filter((l) => /^[\s\u0085]*::/.test(l) || l.includes('##['));

let mock: MockServer;
let work: string;

function shadowlap(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', join(work, 'store.db'), ...args], {
      cwd: work,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_HOME: join(work, 'home') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

beforeAll(async () => {
  mock = await startMockAnthropic({ script, eventDelayMs: () => 0 });
  work = mkdtempSync(join(tmpdir(), 'sl-test-log-'));
});
afterAll(async () => {
  await mock.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('what shadowlap test prints of a failed golden, in a CI log', () => {
  it("keeps a check's words on its line: a judge's reason, a model's, can break it", () => {
    // A judge check that failed, as a verdict a pack keeps it or a judge answered it.
    const label = 'judge "policy" answers yes';
    const failed = { ok: false, status: 'failed' as const, label, detail: 'the judge answered no', reason: REASON, source: 'recording' as const, judge: { name: 'policy', model: 'claude-haiku-4-5', of: 'answer' as const, verdict: 'no' as const, source: 'recording' as const, cost: 0, redactions: 0, cut: 0 } };
    const printed = formatChecks([failed, { ...failed, label: 'judge "tone" answers yes', reason: 'Polite.\r::add-mask::tok' }]);
    expect(printed.split('\n')).toHaveLength(2);
    expect(commandsIn(printed)).toEqual([]);
    expect(printed).toBe(
      `✗ ${label}: the judge answered no · It refunded without asking.\\n::stop-commands::tok\\n::error file=src/agent.ts,line=1,title=Shadowlap::forged\\n (judged from the recording, free)\n` +
        '✗ judge "tone" answers yes: the judge answered no · Polite.\\x0d::add-mask::tok (judged from the recording, free)',
    );
  });

  it("keeps what the agent printed from starting a workflow command, past a bare carriage return too", async () => {
    const recorded = await shadowlap(['run', '--summary-json', 'run.json', '--', process.execPath, AGENT]);
    expect(recorded.code, recorded.out).toBe(0);
    const runId = (JSON.parse(readFileSync(join(work, 'run.json'), 'utf8')) as { summary: { runId: string } }).summary.runId;
    expect((await shadowlap(['pack', runId, 'goldens/planted'])).code).toBe(0);
    writeFileSync(
      join(work, 'shadowlap.config.json'),
      JSON.stringify({ tests: { 'goldens/planted': { expect: { tools: { issue_refund: 0 }, judge: [{ name: 'policy', question: 'Did the agent follow the refund policy?', model: 'claude-haiku-4-5' }] } } } }),
    );
    // Online, so the judge is asked too, and answers no with the reason above.
    const r = await shadowlap(['test', 'goldens/planted', '--online']);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('judge "policy" answers yes: the judge answered no · It refunded without asking.');
    // Nothing in all it printed is a command; what the agent printed is each line after the bar.
    expect(commandsIn(r.out)).toEqual([]);
    expect(r.out).toContain('    │ Done.\n    │ ::stop-commands::tok\n    │ ::warning::from the agent\n');
  }, 60_000);
});
