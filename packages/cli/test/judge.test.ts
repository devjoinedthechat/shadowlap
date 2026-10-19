import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JUDGE_SCOPE, runOutcome, Store, type CallRecord } from '@shadowlap/engine';
import { judgeRequests, startMockAnthropic, withJudge, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from '@shadowlap-testing/reference-agent';
import { departures, fields, keys } from './json-shapes.js';

/**
 * Judge checks through the CLI, on the reference agent (11 model calls, ending in an email to
 * team@example.com and "Done. Summary: …"). The mock plays the agent's model and its judge: the
 * judge says yes unless the answer it reads says the summary was not emailed, which is what the
 * agent answers when its system prompt says "Never send email.".
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');
const AGENT = ['node', join(ROOT, 'testing', 'reference-agent', 'dist', 'main.js')];

let mock: MockServer;
let work: string;
let recording: string;

const judge = (over: Record<string, unknown> = {}) => ({ name: 'summarizes', question: 'Does the final answer summarize what the research found?', of: 'answer', model: 'claude-haiku-4-5', ...over });

beforeAll(async () => {
  mock = await startMockAnthropic({
    eventDelayMs: () => 0,
    script: withJudge(
      (q) => (q.material.includes('not emailed') ? { verdict: 'no', reason: 'it says only that the summary was not emailed' } : { verdict: 'yes', reason: `it reads: ${q.material.slice(0, 40)}` }),
      (ctx) => {
        if (JSON.stringify(ctx.request.system ?? '').includes('Never send email.') && ctx.assistantTurns === 9) {
          return { message: { id: `msg_final_${ctx.requestNo}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Done. Summary kept here, not emailed.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } };
        }
        return referenceScript(ctx);
      },
    ),
  });
  work = mkdtempSync(join(tmpdir(), 'sl-judge-'));
  config({});
  const r = await shadowlap(['run', '--summary-json', 'run.json', '--', ...AGENT]);
  expect(r.code, r.out).toBe(0);
  recording = (JSON.parse(readFileSync(join(work, 'run.json'), 'utf8')) as { summary: { runId: string } }).summary.runId;
}, 60_000);
afterAll(async () => {
  await mock.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function config(tests: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
  writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ normalize: [], redact: [], ...extra, tests }));
}

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: work,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_GUARD: 'off', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

type Result = { ok: boolean; failure: string | null; message: string | null; runId: string; runs: Array<{ runId: string; ok: boolean; verdict: string }>; upstreamRequests: number; judge: Record<string, unknown> | null; checks: Array<{ status?: string; reason?: string; detail: string | null; judge?: { source: string | null; verdict: string | null; cost: number | null; callNo?: number } }> };

async function test(golden: string, extra: string[] = [], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; result: Result; report: Record<string, unknown> }> {
  const report = join(work, `report-${Math.random().toString(36).slice(2)}.json`);
  const r = await shadowlap(['test', golden, '--json', report, ...extra], env);
  const parsed = JSON.parse(readFileSync(report, 'utf8')) as { results: Result[] };
  return { ...r, result: parsed.results[0]!, report: parsed };
}

/** The judge calls a pack holds. */
const packedJudgeCalls = (golden: string) =>
  readFileSync(join(work, golden, 'calls.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CallRecord)
    .filter((c) => c.meta.scope === JUDGE_SCOPE);

function storeCalls(runId: string): CallRecord[] {
  const store = Store.open(join(work, '.shadowlap', 'shadowlap.db'));
  try {
    return store.getCalls(runId);
  } finally {
    store.close();
  }
}

describe('a golden with a judge check', () => {
  it('is judged once, live, when it is packed, and keeps the judge call in the pack', async () => {
    config({ 'goldens/judged': { expect: { judge: [judge()] } } });
    const asked = judgeRequests(mock.requests).length;
    const r = await shadowlap(['pack', recording, 'goldens/judged']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('judged 1 check for the pack');
    expect(r.out).toContain('✓ judge "summarizes" answers yes · it reads: Done. Summary: recorded runs replay dete (judged live,');
    expect(judgeRequests(mock.requests).length).toBe(asked + 1);
    const [call] = packedJudgeCalls('goldens/judged');
    expect(call).toMatchObject({ kind: 'api', origin: 'live', meta: { scope: JUDGE_SCOPE, judge: { check: 'summarizes' } } });
    // The judge read the final answer, at temperature 0, with the verdict's schema.
    const q = judgeRequests(mock.requests).at(-1)!;
    expect(q.material).toBe('Done. Summary: recorded runs replay deterministically; forks fence writes.');
    expect(q.request).toMatchObject({ model: 'claude-haiku-4-5', temperature: 0, output_config: { format: { type: 'json_schema' } } });
  }, 60_000);

  it('replays offline twice with no upstream request, and the same verdict from the recording both times', async () => {
    const sent = mock.requests.length;
    const first = await test('goldens/judged');
    const second = await test('goldens/judged');
    for (const r of [first, second]) {
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('1 passed, 0 failed · 0 upstream requests');
      expect(r.out).toContain('(judged from the recording, free)');
      expect(r.result).toMatchObject({ ok: true, upstreamRequests: 0, judge: { calls: 1, replayed: 1, live: 0, upstreamRequests: 0, spent: 0 } });
      expect(r.result.checks[0]).toMatchObject({ status: 'passed', judge: { verdict: 'yes', source: 'recording', cost: 0 } });
    }
    expect(second.result.checks[0]!.reason).toBe(first.result.checks[0]!.reason);
    // The JSON shapes the reference lists.
    expect(departures('testResult', first.result)).toEqual({ missing: [], extra: [] });
    expect(keys(first.result.judge)).toEqual(fields('summaryJudge'));
    expect(keys(first.result.checks[0]!.judge)).toEqual(fields('checkJudge'));
    expect(mock.requests.length).toBe(sent);
    // The replay holds its judge call, answered from the recording (the newer session keeps its own).
    expect(storeCalls(second.result.runId).filter((c) => c.meta.scope === JUDGE_SCOPE).map((c) => c.origin)).toEqual(['replayed']);
    // And it is the agent's run as recorded: a judge's calls are no difference between them.
    const diff = await shadowlap(['diff', recording, second.result.runId]);
    expect(diff.code, diff.out).toBe(0);
  }, 60_000);

  it('asks the judge live when it forks, and records the judge call in the fork', async () => {
    config({ 'goldens/judged': { fork: true, expect: { judge: [judge()] } } });
    const asked = judgeRequests(mock.requests).length;
    const r = await test('goldens/judged', [], { AGENT_SYSTEM_SUFFIX: 'Never send email.' });
    // The fork's answer says it did not email: the judge, asked about it live, says no.
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('✗ judge "summarizes" answers yes: the judge answered no · it says only that the summary was not emailed (judged live,');
    expect(judgeRequests(mock.requests).length).toBe(asked + 1);
    expect(judgeRequests(mock.requests).at(-1)!.material).toBe('Done. Summary kept here, not emailed.');
    expect(r.result).toMatchObject({ ok: false, failure: 'check', judge: { calls: 1, live: 1, replayed: 0, upstreamRequests: 1 } });
    expect(r.result.checks[0]).toMatchObject({ status: 'failed', reason: 'it says only that the summary was not emailed', judge: { verdict: 'no', source: 'live' } });
    const calls = storeCalls(r.result.runId);
    const judged = calls.filter((c) => c.meta.scope === JUDGE_SCOPE);
    expect(judged).toHaveLength(1);
    expect(judged[0]).toMatchObject({ origin: 'live', callNo: r.result.checks[0]!.judge!.callNo, end: { outcome: 'ok' } });
    // The fork is the agent's: its replay forked at the prompt, and the judge was never its divergence.
    expect(r.out).toContain('Forked at call 3');
  }, 60_000);

  it('is inconclusive offline when the golden holds no verdict for it, and never passes', async () => {
    config({ 'goldens/judged': { expect: { judge: [judge({ name: 'polite', question: 'Is the final answer polite?' })] } } });
    const sent = mock.requests.length;
    const r = await test('goldens/judged');
    expect(r.code).toBe(1);
    // Amber, not red: no check of the agent's failed, yet it never passes, so the run fails.
    expect(r.out).toContain('? judged: check inconclusive: judge "polite" answers yes, but not judged: no recorded verdict and the test runs offline');
    expect(r.out).toContain('    ? judge "polite" answers yes: inconclusive · not judged: no recorded verdict and the test runs offline');
    expect(r.out).toContain('0 passed, 0 failed, 1 inconclusive (failing the run: --inconclusive warn lets them through) · 0 upstream requests');
    expect(r.result).toMatchObject({ ok: false, verdict: 'inconclusive', failure: 'inconclusive', upstreamRequests: 0, judge: null });
    // Its one attempt is inconclusive too, never failed: it didn't pass (ok), and its verdict says why.
    expect(r.result.runs).toEqual([{ runId: r.result.runId, ok: false, verdict: 'inconclusive' }]);
    expect(r.result.checks[0]).toMatchObject({ status: 'inconclusive', detail: 'not judged: no recorded verdict and the test runs offline', judge: { verdict: null, source: null } });
    // Nothing was sent, and nothing of a call no one answered is kept in the replay.
    expect(mock.requests.length).toBe(sent);
    expect(storeCalls(r.result.runId).filter((c) => c.meta.scope === JUDGE_SCOPE)).toEqual([]);
    expect(r.report).toMatchObject({ passed: 0, failed: 1, inconclusive: 1 });
    // The run reads inconclusive, as the Runs list shows it: no failure of the agent's, and nothing for blame.
    const store = Store.open(join(work, '.shadowlap', 'shadowlap.db'));
    try {
      expect(runOutcome(store.getRun(r.result.runId)!, { calls: 30 })).toEqual({ kind: 'inconclusive', check: 'judge "polite" answers yes' });
    } finally {
      store.close();
    }
  }, 60_000);

  it('keeps a verdict it lacks with --update, judged on what the clean replay printed, and answers from it offline after', async () => {
    config({ 'goldens/judged': { expect: { judge: [judge({ name: 'reports', question: 'Does the output report the agent\'s final text?', of: 'output' })] } } });
    const asked = judgeRequests(mock.requests).length;
    const u = await test('goldens/judged', ['--update']);
    expect(u.code, u.out).toBe(0);
    expect(u.out).toContain('↻ keeping the verdict of reports in goldens/judged: asking the judge live');
    expect(u.out).toContain('kept in goldens/judged');
    expect(u.out).toContain('(judged)');
    expect(judgeRequests(mock.requests).length).toBe(asked + 1);
    // What it read is the agent's stdout: the result it prints.
    expect(judgeRequests(mock.requests).at(-1)!.material).toMatch(/^\{"finalText":"Done\. Summary: recorded runs replay deterministically; forks fence writes\.",/);
    expect(packedJudgeCalls('goldens/judged').map((c) => c.meta.judge?.check)).toEqual(['summarizes', 'reports']);
    const r = await test('goldens/judged');
    expect(r.code, r.out).toBe(0);
    expect(r.result).toMatchObject({ upstreamRequests: 0, judge: { replayed: 1, live: 0 } });
    expect(r.result.checks[0]).toMatchObject({ status: 'passed', judge: { source: 'recording' } });
  }, 90_000);

  it('reads the run with the project\'s redaction rules applied, and says so', async () => {
    config({ 'goldens/run': { expect: { judge: [judge({ name: 'emailed', question: 'Did the agent email the team a summary?', of: 'run' })] } } }, { redact: [{ pattern: 'email', replace: '<email>' }] });
    const r = await shadowlap(['pack', recording, 'goldens/run']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('read with 1 redaction rule applied');
    const q = judgeRequests(mock.requests).at(-1)!;
    expect(q.material).toContain('assistant called send_email (write) with {"body":"Replay works.","subject":"Research summary","to":"<email>"}');
    expect(q.material).not.toContain('team@example.com');
    expect(q.request.messages[0]!.content).toContain('masked here too');
    // Its replay reads the run the same way, so the verdict comes from the recording.
    const t = await test('goldens/run');
    expect(t.code, t.out).toBe(0);
    expect(t.result.checks[0]).toMatchObject({ status: 'passed', judge: { source: 'recording', redactions: 1 } });
  }, 60_000);

  it('is not judged when packed with no way to ask the judge, and the pack says how to get the verdict', async () => {
    // Packed again, the recording answers what it was asked before, and asks nothing.
    config({ 'goldens/again': { expect: { judge: [judge()] } } });
    const before = mock.requests.length;
    const again = await shadowlap(['pack', recording, 'goldens/again']);
    expect(again.out).toContain('(judged from the recording, free)');
    expect(mock.requests.length).toBe(before);
    expect(packedJudgeCalls('goldens/again').map((c) => c.meta.judge?.check)).toContain('summarizes');
    // A question the recording was never asked: the verdict the first pack left in it doesn't answer it.
    config({ 'goldens/nokey': { expect: { judge: [judge({ name: 'brief', question: 'Is the final answer one sentence?' })] } } });
    const sent = mock.requests.length;
    const r = await shadowlap(['pack', recording, 'goldens/nokey'], { SHADOWLAP_UPSTREAM_ANTHROPIC: '', ANTHROPIC_BASE_URL: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('inconclusive · not judged: no recorded verdict and no key for anthropic (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN)');
    expect(r.out).toContain('shadowlap test goldens/nokey --update');
    expect(mock.requests.length).toBe(sent);
    // Nothing was asked, so nothing of it is in the pack; the verdicts the recording holds for other checks are.
    expect(packedJudgeCalls('goldens/nokey').map((c) => c.meta.judge?.check)).not.toContain('brief');
  }, 60_000);

  it('judges a replay given the check with --expect, from the recording when clean and live when it forks', async () => {
    const expect_ = JSON.stringify({ judge: [judge()] });
    const clean = await shadowlap(['replay', recording, '--expect', expect_, '--summary-json', 'clean.json']);
    expect(clean.code, clean.out).toBe(0);
    const c = JSON.parse(readFileSync(join(work, 'clean.json'), 'utf8')) as { summary: { judge: Record<string, unknown> }; checks: Result['checks'] };
    expect(c.checks[0]).toMatchObject({ status: 'passed', judge: { source: 'recording' } });
    expect(c.summary.judge).toMatchObject({ calls: 1, replayed: 1, upstreamRequests: 0 });
    expect(keys(c.summary)).toEqual([...fields('summary'), 'judge'].sort());
    expect(keys(c.summary.judge)).toEqual(fields('summaryJudge'));
    const fork = await shadowlap(['replay', recording, '--expect', expect_, '--summary-json', 'fork.json'], { AGENT_SYSTEM_SUFFIX: 'Never send email.' });
    expect(fork.code).toBe(1);
    expect(fork.out).toContain('✗ judge "summarizes" answers yes, but the judge answered no · it says only that the summary was not emailed (judged live,');
    const f = JSON.parse(readFileSync(join(work, 'fork.json'), 'utf8')) as { summary: { judge: Record<string, unknown> }; checks: Result['checks'] };
    expect(f.checks[0]).toMatchObject({ status: 'failed', judge: { source: 'live' } });
    expect(f.summary.judge).toMatchObject({ calls: 1, live: 1, upstreamRequests: 1 });
  }, 60_000);

  it('refuses a judge check it cannot read before anything runs', async () => {
    config({ 'goldens/judged': { expect: { judge: [{ name: 'x', question: 'Q?', model: 'llama-3' }] } } });
    const r = await shadowlap(['test', 'goldens/judged']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('tests["goldens/judged"].expect.judge[0].model must name a model a judge can be asked through');
  });
});
