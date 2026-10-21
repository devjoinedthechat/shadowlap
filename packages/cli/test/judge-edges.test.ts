import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JUDGE_SCOPE, Store, type CallRecord } from '@shadowlap/engine';
import { judgeRequests, message, startMockAnthropic, text, withJudge, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { departures } from './json-shapes.js';

/**
 * Judge checks at their edges, through the CLI, on a one-call agent: a value that changes every run
 * where the judge reads it, a reason that quotes what a rule added later masks, a golden that came
 * from its pack, a run that failed, and the places that count the agent's calls (blame, verify,
 * `replay --repeat`). The agent asks once and prints the answer; what it answers depends on its
 * variant, and the judge answers from what it reads.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');

const AGENT_SOURCE = `
const base = process.env.ANTHROPIC_BASE_URL.replace(/\\/$/, '');
const variant = process.env.VARIANT ?? 'a';
const stamp = process.env.STAMP ? \` Ticket opened \${process.env.STAMP}.\` : '';
const res = await fetch(\`\${base}/v1/messages\`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'placeholder', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 100, system: \`You are a refund agent. Variant \${variant}.\${stamp}\`, messages: [{ role: 'user', content: 'Refund order 7' }] }),
});
const body = await res.json();
if (!res.ok) {
  console.error(JSON.stringify(body));
  process.exit(2);
}
const answer = body.content.map((b) => b.text ?? '').join('');
process.stdout.write(answer + (process.env.PRINT_AT ? \` (at \${new Date().toISOString()})\` : '') + '\\n');
process.exit(Number(process.env.EXIT ?? 0));
`;

let mock: MockServer;
let work: string;
let firstRead: string | undefined;
let agent: string[];
let counter = 0;

const answers: Record<string, () => string> = {
  a: () => 'Refund issued on 2026-10-20.',
  b: () => 'Refund issued on 2026-12-01.',
  c: () => 'Refund declined.',
  card: () => 'Refund issued to card SECRET42.',
  plain: () => 'Refund issued.',
  n: () => `Refund ${++counter} issued.`,
};

beforeAll(async () => {
  mock = await startMockAnthropic({
    eventDelayMs: () => 0,
    script: withJudge(
      (q) => {
        // A judge whose provider turns every request away: no verdict, so the check can't be decided.
        if (q.question.includes('unreachable')) return { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'the judge model is not available' } } };
        // One that answers about the first answer it reads, and turns away any other.
        if (q.question.includes('first answer only')) {
          firstRead ??= q.material;
          return q.material === firstRead ? { verdict: 'no', reason: 'it reads the recorded answer' } : { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'the judge model is not available' } } };
        }
        if (q.question.includes('card')) return { verdict: 'yes', reason: `it names ${/SECRET\d+/.exec(q.material)?.[0] ?? 'no card'}` };
        if (q.question.includes('2026-10-20')) return q.material.includes('2026-10-20') ? { verdict: 'yes', reason: 'it names 2026-10-20' } : { verdict: 'no', reason: 'it names another date' };
        return q.material.includes('declined') ? { verdict: 'no', reason: 'it declines the refund' } : { verdict: 'yes', reason: 'it issues the refund' };
      },
      (ctx) => {
        const variant = /Variant (\w+)\./.exec(JSON.stringify(ctx.request.system ?? ''))?.[1] ?? 'a';
        return { message: message([text((answers[variant] ?? answers.a!)())], { stop_reason: 'end_turn', model: 'claude-opus-5', input_tokens: 50, output_tokens: 10 }) };
      },
    ),
  });
  work = mkdtempSync(join(tmpdir(), 'sl-judge-edges-'));
  writeFileSync(join(work, 'agent.mjs'), AGENT_SOURCE);
  agent = ['node', join(work, 'agent.mjs')];
});
afterAll(async () => {
  await mock.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function config(c: Record<string, unknown>): void {
  writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ normalize: [], redact: [], ...c }));
}

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: work,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', SHADOWLAP_GUARD: 'off', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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

/** Records the agent and returns the run id. */
async function record(env: NodeJS.ProcessEnv = {}, expectCode = 0): Promise<string> {
  const file = `run-${++counter}.json`;
  const r = await shadowlap(['run', '--summary-json', file, '--', ...agent], env);
  expect(r.code, r.out).toBe(expectCode);
  return (JSON.parse(readFileSync(join(work, file), 'utf8')) as { summary: { runId: string } }).summary.runId;
}

type Result = { ok: boolean; verdict: string; failure: string | null; runId: string; upstreamRequests: number; checks: Array<{ status?: string; reason?: string; detail: string | null; judge?: { source: string | null; verdict: string | null } }> };

async function test(golden: string, extra: string[] = [], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; result: Result }> {
  const report = join(work, `report-${++counter}.json`);
  const r = await shadowlap(['test', golden, '--json', report, ...extra], env);
  return { ...r, result: (JSON.parse(readFileSync(report, 'utf8')) as { results: Result[] }).results[0]! };
}

const judge = (over: Record<string, unknown>) => ({ name: 'issued', question: 'Did the agent issue the refund?', of: 'answer', model: 'claude-haiku-4-5', ...over });
const asked = () => judgeRequests(mock.requests).length;

function storeCalls(runId: string): CallRecord[] {
  const store = Store.open(join(work, '.shadowlap', 'shadowlap.db'));
  try {
    return store.getCalls(runId);
  } finally {
    store.close();
  }
}

/** Every file under a folder, as text. */
function allText(dir: string): string {
  return readdirSync(dir)
    .map((f) => join(dir, f))
    .map((p) => (statSync(p).isDirectory() ? allText(p) : readFileSync(p).toString('latin1')))
    .join('\n');
}

describe('a judge reads what replay matching reads', () => {
  it('is asked live when a fork\'s answer differs only in a value a normalizer masks for matching', async () => {
    const date = [judge({ name: 'date', question: 'Does the reply say the refund was issued on 2026-10-20?' })];
    config({ normalize: [{ kind: 'api', pattern: 'iso-date', replace: '<date>' }], tests: { 'goldens/date': { fork: true, expect: { judge: date } } } });
    const run = await record();
    const pack = await shadowlap(['pack', run, 'goldens/date']);
    expect(pack.out).toContain('✓ judge "date" answers yes · it names 2026-10-20 (judged live,');
    const before = asked();
    // The fork's prompt differs, so it forks; its answer differs only in a date the normalizer masks.
    const t = await test('goldens/date', [], { VARIANT: 'b' });
    expect(t.code, t.out).toBe(1);
    expect(asked()).toBe(before + 1);
    expect(judgeRequests(mock.requests).at(-1)!.material).toBe('Refund issued on 2026-12-01.');
    expect(t.result.checks[0]).toMatchObject({ status: 'failed', reason: 'it names another date', judge: { verdict: 'no', source: 'live' } });
    // So is a replay given the check.
    const r = await shadowlap(['replay', run, '--expect', JSON.stringify({ judge: date })], { VARIANT: 'b' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('judge "date" answers yes, but the judge answered no · it names another date (judged live,');
    expect(asked()).toBe(before + 2);
  }, 90_000);

  it('reads the run with the values a normalizer masks masked, so a clean replay is judged from the recording', async () => {
    const run = [judge({ of: 'run' })];
    config({ normalize: [{ kind: 'api', path: '$.system', pattern: '/Ticket opened [^.]+\\./', replace: 'Ticket opened <t>.' }], tests: { 'goldens/run': { expect: { judge: run } } } });
    const rec = await record({ STAMP: '04:01:07' });
    const pack = await shadowlap(['pack', rec, 'goldens/run']);
    expect(pack.code, pack.out).toBe(0);
    expect(pack.out).toContain('values that change every run masked');
    expect(judgeRequests(mock.requests).at(-1)!.material).toContain('system: You are a refund agent. Variant a. Ticket opened <t>.');
    const before = mock.requests.length;
    for (const stamp of ['05:00:00', '06:30:00']) {
      const t = await test('goldens/run', [], { STAMP: stamp });
      expect(t.code, t.out).toBe(0);
      expect(t.out).toContain('1 passed, 0 failed · 0 upstream requests');
      expect(t.result.checks[0]).toMatchObject({ status: 'passed', judge: { source: 'recording' } });
    }
    expect(mock.requests.length).toBe(before);
  }, 90_000);

  it('reads the output with the dates near the run\'s start masked, so a time it prints never keeps a golden unjudged', async () => {
    const out = [judge({ name: 'printed', question: 'Does the output report the refund?', of: 'output' })];
    config({ tests: { 'goldens/out': { expect: { judge: out } } } });
    const env = { PRINT_AT: '1', VARIANT: 'plain' };
    const rec = await record(env);
    const pack = await shadowlap(['pack', rec, 'goldens/out']);
    expect(pack.out).toContain('a recording keeps no output, so printed is judged on what a replay prints: record its verdict with shadowlap test goldens/out --update');
    const unjudged = await test('goldens/out', [], env);
    expect(unjudged.result).toMatchObject({ ok: false, verdict: 'inconclusive' });
    const update = await test('goldens/out', ['--update'], env);
    expect(update.code, update.out).toBe(0);
    expect(update.out).toContain('kept in goldens/out');
    expect(judgeRequests(mock.requests).at(-1)!.material).toBe('Refund issued. (at <datetime>)\n');
    const before = mock.requests.length;
    // A second later it prints another time: still the same material, judged from the recording.
    await new Promise((r) => setTimeout(r, 1100));
    const t = await test('goldens/out', [], env);
    expect(t.code, t.out).toBe(0);
    expect(t.result).toMatchObject({ verdict: 'passed', upstreamRequests: 0 });
    expect(t.result.checks[0]).toMatchObject({ status: 'passed', judge: { source: 'recording' } });
    expect(mock.requests.length).toBe(before);
  }, 120_000);
});

describe('a judge\'s reason', () => {
  it('is masked in a pack and an HTML export made after a rule was added, as the check\'s detail is', async () => {
    config({});
    const rec = await record({ VARIANT: 'card' });
    const r = await shadowlap(['replay', rec, '--expect', JSON.stringify({ judge: [judge({ name: 'card', question: 'Does the reply name the card?' })] }), '--summary-json', 'card.json'], { VARIANT: 'card' });
    expect(r.code, r.out).toBe(0);
    const replay = (JSON.parse(readFileSync(join(work, 'card.json'), 'utf8')) as { summary: { runId: string } }).summary.runId;
    expect(r.out).toContain('judge "card" answers yes · it names SECRET42');
    // Before sharing, the project adds a rule, as pack advises.
    config({ redact: [{ pattern: '/SECRET[0-9]+/', replace: '<CARD>' }] });
    const pack = await shadowlap(['pack', replay, 'shared/card']);
    expect(pack.code, pack.out).toBe(0);
    const packed = allText(join(work, 'shared', 'card'));
    expect(packed).not.toContain('SECRET42');
    expect(packed).toContain('it names <CARD>');
    const html = await shadowlap(['export', 'html', replay, 'card.html']);
    expect(html.code, html.out).toBe(0);
    const page = readFileSync(join(work, 'card.html'), 'utf8');
    expect(page).not.toContain('SECRET42');
    expect(page).toContain('it names <CARD>');
  }, 90_000);
});

describe('what a judge cost', () => {
  it('is counted as spent here for a golden that came from its pack, by test --update and by pack', async () => {
    config({ tests: { 'goldens/fresh': {} } });
    const rec = await record();
    expect((await shadowlap(['pack', rec, 'goldens/fresh'])).code).toBe(0);
    // A fresh clone: the store is gone, and the golden comes in from its pack.
    rmSync(join(work, '.shadowlap'), { recursive: true, force: true });
    expect((await test('goldens/fresh')).code).toBe(0);
    config({ tests: { 'goldens/fresh': { expect: { judge: [judge({})] } } } });
    const before = asked();
    const update = await test('goldens/fresh', ['--update']);
    expect(update.code, update.out).toBe(0);
    expect(asked()).toBe(before + 1);
    expect(update.out).toMatch(/kept in goldens\/fresh · judge: 1 call · 1 live \([^)]*\) · 1 upstream request/);
    expect(update.out).toContain('1 passed, 0 failed · 1 upstream request');
    config({ tests: { 'goldens/fresh': { expect: { judge: [judge({ name: 'polite', question: 'Is the reply polite?' })] } } } });
    const again = await shadowlap(['pack', rec, 'goldens/fresh']);
    expect(again.out).toMatch(/judged 1 check for the pack \(1 call · 1 live \([^)]*\) · 1 upstream request\)/);
  }, 120_000);

  it('is asked nothing for a run that failed, which no replay of it is judged by either', async () => {
    config({ tests: { 'goldens/failed': { expect: { judge: [judge({})] } } } });
    const rec = await record({ EXIT: '3' }, 3);
    const before = asked();
    const pack = await shadowlap(['pack', rec, 'goldens/failed']);
    expect(pack.code, pack.out).toBe(0);
    expect(pack.out).toContain('no judge asked for the pack: the run did not complete (its agent exited with an error), and no replay of it is judged');
    expect(asked()).toBe(before);
    expect(storeCalls(rec).filter((c) => c.meta.scope === JUDGE_SCOPE)).toEqual([]);
  }, 60_000);

  it('is reported apart in blame and verify JSON, and counts against their budgets', async () => {
    config({ prices: { 'claude-haiku-4-5': { input: 1000, output: 5000 }, 'claude-opus-5': { input: 1, output: 1 } } });
    const rec = await record({ VARIANT: 'c' });
    const expect_ = JSON.stringify({ judge: [judge({})] });
    const before = asked();
    const b = await shadowlap(['blame', rec, '--expect', expect_, '--attempts', '1', '--json'], { VARIANT: 'c' });
    const blame = JSON.parse(b.stdout) as { judge: { spent: number; upstreamRequests: number } | null; cost: { spent: number }; modelCalls: number };
    expect(blame.judge!.upstreamRequests).toBe(asked() - before);
    expect(blame.judge!.spent).toBeGreaterThan(0.4);
    // The agent's spend is the agent's alone.
    expect(blame.cost.spent).toBeLessThan(0.01);
    expect(blame.modelCalls).toBe(1);
    expect(departures('blame', blame)).toEqual({ missing: [], extra: [] });
    const v = await shadowlap(['verify', '--fixes', rec, '--expect', expect_, '--attempts', '1', '--passes', '1', '--set', 'max_tokens=99', '--json'], { VARIANT: 'c' });
    const verify = JSON.parse(v.stdout) as { judge: { spent: number; upstreamRequests: number } | null; cost: { spent: number } };
    expect(verify.judge).toMatchObject({ upstreamRequests: 1 });
    expect(verify.judge!.spent).toBeGreaterThan(0.4);
    expect(departures('verify', verify)).toEqual({ missing: [], extra: [] });
    // A budget the judge alone spends stops verify before a second attempt.
    const capped = await shadowlap(['verify', '--fixes', rec, '--expect', expect_, '--attempts', '3', '--passes', '1', '--set', 'max_tokens=99', '--budget', '0.1', '--json'], { VARIANT: 'c' });
    const stopped = JSON.parse(capped.stdout) as { cost: { attempts: number }; stopReason: string | null };
    expect(stopped.cost.attempts).toBe(1);
    expect(stopped.stopReason).toContain('budget');
  }, 120_000);
});

describe('an attempt a judge could not answer', () => {
  it('is inconclusive in verify, never a failure that rejects the change', async () => {
    config({});
    const rec = await record({ VARIANT: 'plain' });
    const unanswered = JSON.stringify({ judge: [judge({ question: 'Did the agent issue the refund? (unreachable)' })] });
    const r = await shadowlap(['verify', '--keeps', rec, '--expect', unanswered, '--attempts', '3', '--passes', '3', '--set', 'max_tokens=99', '--json'], { VARIANT: 'plain' });
    const v = JSON.parse(r.stdout) as { verdict: string; reasons: string[]; runs: Array<{ outcome: string; passes: number; attempts: number; runs: Array<{ runId: string; passed: boolean; verdict?: string; failures: string[] }>; undecided?: string | null }> };
    // The good run's attempt said nothing of the change: it is neither kept nor broken, and no attempt
    // after it could say more, so verify stops there and the change is not settled.
    expect(v.verdict).toBe('incomplete');
    expect(v.runs[0]).toMatchObject({ outcome: 'inconclusive', passes: 0, attempts: 1 });
    expect(v.runs[0]!.runs).toEqual([expect.objectContaining({ passed: false, verdict: 'inconclusive' })]);
    expect(v.runs[0]!.undecided).toMatch(/^judge "issued" answers yes, but it is inconclusive: not judged: the judge's call failed: HTTP 400/);
    expect(v.reasons).toEqual([expect.stringMatching(new RegExp(`^good run ${rec.slice(0, 10)} inconclusive: attempt 1 could not be judged: judge "issued" answers yes`))]);
    expect(r.code).toBe(1);
    // shadowlap show on the attempt says so too.
    expect((await shadowlap(['show', v.runs[0]!.runs[0]!.runId])).stdout).toContain('an attempt of shadowlap verify, replaying a good run: inconclusive, a check could not be decided');
    const text = await shadowlap(['verify', '--keeps', rec, '--expect', unanswered, '--attempts', '3', '--passes', '3', '--set', 'max_tokens=99'], { VARIANT: 'plain' });
    expect(text.out).toMatch(/attempt 1 {2}\? judge "issued" answers yes, but it is inconclusive: not judged/);
    expect(text.out).toContain('! Incomplete');
    expect(text.out).not.toMatch(/broken|Rejected|✗ judge/);
  }, 120_000);
});

describe('a blame probe whose attempt a judge could not answer', () => {
  it('is inconclusive, never lost: the search is not settled from the first model call', async () => {
    config({});
    // Each answer differs (Refund 1 issued., Refund 2 issued.): the replay as recorded reads the recorded one, which the judge answers.
    const rec = await record({ VARIANT: 'n' });
    const expect_ = JSON.stringify({ judge: [judge({ question: 'Did the agent issue the refund? (first answer only)' })] });
    const b = await shadowlap(['blame', rec, '--expect', expect_, '--attempts', '2', '--passes', '1', '--concurrency', '1', '--json'], { VARIANT: 'n' });
    const blame = JSON.parse(b.stdout) as { outcome: string; confidence: string; probes: Array<{ callNo: number; rescued: boolean; decision?: string; undecided?: string | null; runs: Array<{ passed: boolean; verdict?: string }> }> };
    expect(blame).toMatchObject({ outcome: 'unrescuable', confidence: 'low' });
    expect(blame.probes).toEqual([expect.objectContaining({ callNo: 1, rescued: false, decision: 'inconclusive', undecided: expect.stringMatching(/^judge "issued" answers yes, but it is inconclusive: not judged: the judge's call failed: HTTP 400/) })]);
    // It stopped at the attempt it could not judge, which is no failure.
    expect(blame.probes[0]!.runs).toEqual([expect.objectContaining({ passed: false, verdict: 'inconclusive' })]);
    const text = await shadowlap(['blame', rec, '--expect', expect_, '--attempts', '2', '--passes', '1', '--concurrency', '1'], { VARIANT: 'n' });
    expect(text.out).toContain('? Not settled from the first model call');
    expect(text.out).toContain('Resampled from the first model call, #1: an attempt could not be judged: judge "issued" answers yes, but it is inconclusive');
    expect(text.out).toMatch(/inconclusive · an attempt not judged/);
    expect(text.out).not.toMatch(/Not rescued from any model call|lost · |✗ judge/);
    // What the run keeps of it says so, and shadowlap show reads it: not settled, never "not rescued".
    const store = Store.open(join(work, '.shadowlap', 'shadowlap.db'));
    try {
      expect(store.getRun(rec)!.meta?.blame).toMatchObject({ outcome: 'unrescuable', unsettled: true });
    } finally {
      store.close();
    }
    const shown = (await shadowlap(['show', rec])).stdout;
    expect(shown).toContain('blame: not settled from the first model call');
    expect(shown).not.toContain('not rescued');
  }, 120_000);
});

describe('a judge\'s calls are never the agent\'s', () => {
  it('in replay --repeat\'s count of final answers, blame\'s steps and the scopes blame names', async () => {
    config({ tests: { 'goldens/steps': { expect: { judge: [judge({})] } } } });
    const rec = await record();
    // A recording that holds a judge call: packed with its check.
    expect((await shadowlap(['pack', rec, 'goldens/steps'])).code).toBe(0);
    expect(storeCalls(rec).filter((c) => c.meta.scope === JUDGE_SCOPE)).toHaveLength(1);
    const expect_ = JSON.stringify({ judge: [judge({})] });
    const r = await shadowlap(['replay', rec, '--repeat', '3', '--expect', expect_, '--summary-json', 'rep.json'], { VARIANT: 'n' });
    expect(r.out).toContain('Final model responses: 3 different');
    expect((JSON.parse(readFileSync(join(work, 'rep.json'), 'utf8')) as { report: { distinctFinalResponses: number } }).report.distinctFinalResponses).toBe(3);
    // Blamed, the recording's one model call of the agent's is the only step: the judge's is none.
    const b = await shadowlap(['blame', rec, '--expect', JSON.stringify({ judge: [judge({ pass: 'no' })] }), '--attempts', '1', '--json']);
    const blame = JSON.parse(b.stdout) as { modelCalls: number; probes: Array<{ callNo: number }> };
    expect(blame.modelCalls).toBe(1);
    expect(blame.probes.map((p) => p.callNo)).toEqual([1]);
    const scoped = await shadowlap(['blame', rec, '--expect', JSON.stringify({ judge: [judge({ question: 'Was the refund declined?' })] }), '--scope', 'nope', '--json']);
    expect(scoped.code).not.toBe(0);
    expect(scoped.out).toContain('made no model calls in scope nope (it used no scopes)');
    expect(scoped.out).not.toContain(JUDGE_SCOPE);
  }, 120_000);
});
