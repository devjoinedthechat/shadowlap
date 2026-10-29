import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { judgeAnswer, judgeQuestion, message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext } from '@shadowlap-testing/mock-anthropic';
import { formatChecks } from '../src/golden-test.js';
import { safe, safeLines } from '../src/ui.js';

/**
 * What `shadowlap test` prints for a failed golden goes to a CI job's log as it is: the GitHub
 * Action runs it with the job's own output, and the runner reads a line whose text starts with `::`
 * as a workflow command (`stop-commands` silences every command after it, an annotation can be
 * forged). A judge's reason is a model's words, and what the agent printed is the agent's: neither
 * starts a line of its own there, through a line break or a bare carriage return.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./support-agent.mjs', import.meta.url));
const REASON = 'It refunded without asking.\n::stop-commands::tok\n::error file=src/agent.ts,line=1,title=Shadowlap::forged\n and ##[error]forged too';
const SAID = 'Done.\r::stop-commands::tok\r\n::warning::from the agent, ##[error]and mid-line';

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

function shadowlap(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', join(work, 'store.db'), ...args], {
      cwd: work,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_HOME: join(work, 'home'), ...env },
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
      `✗ ${label}: the judge answered no · It refunded without asking.\\n::stop-commands::tok\\n::error file=src/agent.ts,line=1,title=Shadowlap::forged\\n and #\\x23[error]forged too (judged from the recording, free)\n` +
        '✗ judge "tone" answers yes: the judge answered no · Polite.\\x0d::add-mask::tok (judged from the recording, free)',
    );
  });

  it('writes a recorded string that would start a line with a command so it does not, IPv6 left alone', () => {
    expect(safe('::stop-commands::tok')).toBe(':\\x3astop-commands::tok');
    expect(safe('    ::add-mask::tok')).toBe('    :\\x3aadd-mask::tok');
    expect(commandsIn(`    ${safe('::error file=a.ts::forged')}`)).toEqual([]);
    expect(safe('::1 answered')).toBe('::1 answered');
    // Lines of text: escaped where nothing else keeps a line from starting a command; behind the bar, as printed.
    const text = 'Done.\n::stop-commands::tok\r  ::error::forged';
    expect(safeLines(text, '    ')).toBe('    Done.\n    :\\x3astop-commands::tok\n      :\\x3aerror::forged\n');
    expect(safeLines(text, '    │ ')).toBe('    │ Done.\n    │ ::stop-commands::tok\n    │   ::error::forged\n');
    expect(commandsIn(safeLines(text, '    ') + safeLines(text, '    │ '))).toEqual([]);
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
    expect(r.out).toContain('    │ Done.\n    │ ::stop-commands::tok\n    │ ::warning::from the agent, #\\x23[error]and mid-line\n');
  }, 60_000);

  it("keeps a failure's details from starting a workflow command: what an agent that never started printed is among them", async () => {
    const recorded = await shadowlap(['run', '--summary-json', 'refused.json', '--', process.execPath, AGENT]);
    expect(recorded.code, recorded.out).toBe(0);
    const runId = (JSON.parse(readFileSync(join(work, 'refused.json'), 'utf8')) as { summary: { runId: string } }).summary.runId;
    expect((await shadowlap(['pack', runId, 'goldens/refused'])).code).toBe(0);
    // The replay's Node refuses Shadowlap's preload, as a Node before 18.18 does, and prints more after it.
    const refuse = join(work, 'refuse.cjs');
    writeFileSync(refuse, `if ((process.argv[1] ?? '').endsWith('support-agent.mjs')) { process.stderr.write('node: --import is not allowed in NODE_OPTIONS\\n::stop-commands::tok\\r  ::error::forged\\n'); process.exit(9); }\n`);
    const r = await shadowlap(['test', 'goldens/refused'], { NODE_OPTIONS: `--require "${refuse.replace(/\\/g, '/')}"` });
    expect(r.code, r.out).toBe(1);
    // Each line of what it printed escaped where the details show it, a bare CR ending one too.
    expect(r.out).toContain('    node: --import is not allowed in NODE_OPTIONS\n    :\\x3astop-commands::tok\n      :\\x3aerror::forged\n');
    expect(commandsIn(r.out)).toEqual([]);
  }, 60_000);

  // A folder's name can hold a line break where the system allows one (Windows doesn't), and a pull request can add the folder.
  it.skipIf(process.platform === 'win32')("keeps a golden's folder name from starting a workflow command, in its lines, its annotation and the summary", async () => {
    const recorded = await shadowlap(['run', '--summary-json', 'named.json', '--', process.execPath, AGENT]);
    expect(recorded.code, recorded.out).toBe(0);
    const runId = (JSON.parse(readFileSync(join(work, 'named.json'), 'utf8')) as { summary: { runId: string } }).summary.runId;
    const golden = 'goldens/named\n::error::x';
    expect((await shadowlap(['pack', runId, golden])).code).toBe(0);
    // A check it fails, so that it has an annotation of its own.
    writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ tests: { [golden]: { expect: { tools: { issue_refund: 0 } } } } }));
    const summary = join(work, 'summary.md');
    const r = await shadowlap(['test', golden, '--annotations', '--markdown', summary]);
    expect(r.code, r.out).toBe(1);
    // Named as every line names a golden, by its folder under goldens/, the line break written \\n.
    expect(r.out).toContain('✗ named\\n::error::x: check failed');
    expect(r.out).toContain('[shadowlap] replaying run ');
    expect(r.out).toContain(' for goldens/named\\n::error::x\n');
    // The one command is the annotation the test writes, its title the name with its line break escaped.
    expect(commandsIn(r.out)).toEqual([expect.stringMatching(/^::error file=goldens\/named%0A%3A%3Aerror%3A%3Ax\/run\.json,title=Shadowlap%3A named%0A%3A%3Aerror%3A%3Ax::/)]);
    // No line starts with the name's own command, in the log or in the job's summary, where the name keeps its line.
    const md = readFileSync(summary, 'utf8');
    expect([...r.out.split('\n'), ...md.split('\n')].filter((l) => /^\s*::error::x/.test(l))).toEqual([]);
    expect(md).toContain('| ❌ | `named ::error::x` |');
  }, 60_000);
});
