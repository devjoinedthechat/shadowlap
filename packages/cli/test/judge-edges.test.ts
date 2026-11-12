import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { trackInGit } from './tracked.js';
import { JUDGE_NOT_ASKED, JUDGE_SCOPE, Store, type CallRecord, type StoredCheck } from '@shadowlap/engine';
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
let answeredTwice = 0;
/** How often each question that answers, then turns away every request, has been asked. */
const asks: Record<string, number> = {};
let agent: string[];
let counter = 0;
/** How many times the agent of variant `alt` has answered: it issues the refund, then declines it, in turn. */
let alternated = 0;

const answers: Record<string, () => string> = {
  a: () => 'Refund issued on 2026-10-20.',
  b: () => 'Refund issued on 2026-12-01.',
  c: () => 'Refund declined.',
  card: () => 'Refund issued to card SECRET42.',
  plain: () => 'Refund issued.',
  n: () => `Refund ${++counter} issued.`,
  alt: () => (++alternated % 2 ? 'Refund issued.' : 'Refund declined.'),
};

beforeAll(async () => {
  mock = await startMockAnthropic({
    eventDelayMs: () => 0,
    script: withJudge(
      (q) => {
        // A judge whose provider turns every request away: no verdict, so the check can't be decided.
        if (q.question.includes('unreachable')) return { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'the judge model is not available' } } };
        // One that answers twice, and turns away every request after.
        if (q.question.includes('(twice)')) return ++answeredTwice <= 2 ? { verdict: 'yes', reason: 'it issues the refund' } : { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'the judge model is not available' } } };
        // One that answers once, no or yes, and turns away every request after.
        const once = /\((no|yes) once\)/.exec(q.question)?.[1];
        if (once) {
          asks[once] = (asks[once] ?? 0) + 1;
          if (asks[once] > 1) return { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'the judge model is not available' } } };
          return once === 'no' ? { verdict: 'no', reason: 'it reads the refund as not issued' } : { verdict: 'yes', reason: 'it issues the refund' };
        }
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
        return { message: message([text((answers[variant] ?? answers.a)())], { stop_reason: 'end_turn', model: 'claude-opus-5', input_tokens: 50, output_tokens: 10 }) };
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

type Result = {
  ok: boolean;
  verdict: string;
  failure: string | null;
  message: string | null;
  runId: string;
  runs: Array<{ runId: string; ok: boolean; verdict: string }>;
  attempts: { total: number; passed: number; inconclusive?: number; required: number | null } | null;
  gate: { decision: string; sentence: string } | null;
  upstreamRequests: number;
  checks: Array<{ status?: string; reason?: string; detail: string | null; judge?: { source: string | null; verdict: string | null } }>;
};

async function test(golden: string, extra: string[] = [], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; result: Result }> {
  const report = join(work, `report-${++counter}.json`);
  const r = await shadowlap(['test', golden, '--json', report, ...extra], env);
  return { ...r, result: (JSON.parse(readFileSync(report, 'utf8')) as { results: Result[] }).results[0] };
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
    // A fresh clone: the store is gone, and the golden comes in from its pack, committed.
    rmSync(join(work, '.shadowlap'), { recursive: true, force: true });
    trackInGit(work, 'goldens/fresh');
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
    expect(v.runs[0].runs).toEqual([expect.objectContaining({ passed: false, verdict: 'inconclusive' })]);
    expect(v.runs[0].undecided).toMatch(/^judge "issued" answers yes, but it is inconclusive: not judged: the judge's call failed: HTTP 400/);
    expect(v.reasons).toEqual([expect.stringMatching(new RegExp(`^good run ${rec.slice(0, 10)} inconclusive: attempt 1 could not be judged: judge "issued" answers yes`))]);
    expect(r.code).toBe(3);
    // shadowlap show on the attempt says so too.
    expect((await shadowlap(['show', v.runs[0].runs[0].runId])).stdout).toContain('an attempt of shadowlap verify, replaying a good run: inconclusive, a check could not be decided');
    const text = await shadowlap(['verify', '--keeps', rec, '--expect', unanswered, '--attempts', '3', '--passes', '3', '--set', 'max_tokens=99'], { VARIANT: 'plain' });
    expect(text.out).toMatch(/attempt 1 {2}\? judge "issued" answers yes, but it is inconclusive: not judged/);
    expect(text.out).toContain('! Incomplete');
    expect(text.out).not.toMatch(/broken|Rejected|✗ judge/);
    // Under its gate, the run's line gives no tally: the gate decided nothing.
    const gated = await shadowlap(['verify', '--keeps', rec, '--expect', unanswered, '--set', 'max_tokens=99'], { VARIANT: 'plain' });
    expect(gated.out).toMatch(new RegExp(`^ {2}good {6}${rec.slice(0, 10)} {2}inconclusive$`, 'm'));
    expect(gated.out).not.toContain('0 of 0');
  }, 120_000);
});

describe('a gated golden whose attempt a judge could not answer', () => {
  it('is inconclusive for the check, never for a gate that ran out of attempts, in JUnit and the Markdown report', async () => {
    const twice = [judge({ question: 'Did the agent issue the refund? (twice)' })];
    config({ tests: { 'goldens/twice': { fork: true, gate: { good: 0.6, bad: 0.4, risk: 0.2, max: 4 }, expect: { judge: twice } } } });
    const rec = await record({ VARIANT: 'plain' });
    // Packing asks the judge once; the first attempt, which forks, asks it again; the second can't be judged.
    expect((await shadowlap(['pack', rec, 'goldens/twice'])).code).toBe(0);
    const junit = join(work, `junit-${++counter}.xml`);
    const markdown = join(work, `summary-${++counter}.md`);
    const t = await test('goldens/twice', ['--junit', junit, '--markdown', markdown], { VARIANT: 'n' });
    expect(t.code, t.out).toBe(3);
    expect(t.result).toMatchObject({ verdict: 'inconclusive', failure: 'inconclusive' });
    // Its gate decided nothing: the check is why it is inconclusive, and no report says otherwise.
    const xml = readFileSync(junit, 'utf8');
    expect(xml).toContain(`<failure message="check inconclusive: judge &quot;issued&quot; answers yes, but not judged: the judge's call failed: HTTP 400`);
    expect(xml).toContain('attempt 1  ✓ passed\nattempt 2  ? check inconclusive');
    expect(xml).not.toContain('undecided');
    const md = readFileSync(markdown, 'utf8');
    expect(md).toContain('Inconclusive means a check could not be decided');
    expect(md).not.toMatch(/neither verdict holds|More attempts settle a gate/);
    // Nor does the JSON, nor the result the store keeps: there is no gate verdict, and no word that is no verdict.
    expect(t.result).toMatchObject({ gate: null, attempts: { total: 2, passed: 1, inconclusive: 1, required: null } });
    expect(t.result.runs.map((r) => r.verdict)).toEqual(['passed', 'inconclusive']);
    expect(JSON.stringify(t.result)).not.toContain('undecided');
    const store = Store.open(join(work, '.shadowlap', 'shadowlap.db'));
    try {
      const kept = store.listTestResults({ golden: 'goldens/twice', limit: 1 })[0];
      expect(kept.data).toMatchObject({ verdict: 'inconclusive', attempts: { total: 2, passed: 1, inconclusive: 1 } });
      expect(kept.data?.gate).toBeUndefined();
    } finally {
      store.close();
    }
  }, 120_000);
});

describe('a repeated golden whose attempt a judge could not answer after its count was settled', () => {
  it('failed when the attempts before it already lost the count, whatever --inconclusive says', async () => {
    const lost = [judge({ question: 'Did the agent issue the refund? (no once)' })];
    // Packed before its judge check was added, so only the test's attempts ask the judge: the first is told no, the second can't be judged.
    config({ tests: { 'goldens/lost': { fork: true } } });
    const rec = await record({ VARIANT: 'plain' });
    expect((await shadowlap(['pack', rec, 'goldens/lost'])).code).toBe(0);
    config({ tests: { 'goldens/lost': { fork: true, repeat: 3, passes: 3, expect: { judge: lost } } } });
    const junit = join(work, `junit-${++counter}.xml`);
    const t = await test('goldens/lost', ['--inconclusive', 'warn', '--junit', junit], { VARIANT: 'n' });
    expect(t.code, t.out).toBe(1);
    expect(t.result).toMatchObject({ ok: false, verdict: 'failed', failure: 'check', attempts: { total: 2, passed: 0, inconclusive: 1, required: 3 } });
    expect(t.result.message).toBe('0 of 2 attempts passed, 1 inconclusive, 3 needed. Attempt 1: check failed: judge "issued" answers yes, but the judge answered no');
    // Each attempt by its own verdict: the one that could not be judged is never failed.
    expect(t.result.runs.map((r) => r.verdict)).toEqual(['failed', 'inconclusive']);
    expect(t.out).toMatch(/✗ lost: 0 of 2 attempts passed, 1 inconclusive, 3 needed/);
    expect(t.out).toMatch(/attempt 1 {2}✗ check failed: judge "issued" answers yes, but the judge answered no[^\n]*\n {4}attempt 2 {2}\? check inconclusive: judge "issued" answers yes, but not judged: the judge's call failed: HTTP 400/);
    expect(t.out).toContain('0 passed, 1 failed');
    // A failure in JUnit too, never skipped as an inconclusive one would be under --inconclusive warn.
    const xml = readFileSync(junit, 'utf8');
    expect(xml).toContain('<failure message="0 of 2 attempts passed, 1 inconclusive, 3 needed. Attempt 1: check failed');
    expect(xml).not.toContain('<skipped');
  }, 120_000);

  it('passed when the attempts before it already met the count', async () => {
    const met = [judge({ question: 'Did the agent issue the refund? (yes once)' })];
    config({ tests: { 'goldens/met': { fork: true } } });
    const rec = await record({ VARIANT: 'plain' });
    expect((await shadowlap(['pack', rec, 'goldens/met'])).code).toBe(0);
    config({ tests: { 'goldens/met': { fork: true, repeat: 3, passes: 1, expect: { judge: met } } } });
    const t = await test('goldens/met', [], { VARIANT: 'n' });
    expect(t.code, t.out).toBe(0);
    expect(t.result).toMatchObject({ ok: true, verdict: 'passed', failure: null, message: null, attempts: { total: 2, passed: 1, inconclusive: 1, required: 1 } });
    expect(t.result.runs.map((r) => r.verdict)).toEqual(['passed', 'inconclusive']);
    expect(t.out).toMatch(/✓ met: .*1\/2 attempts passed \(1 inconclusive\)/);
    expect(t.out).toContain('1 passed, 0 failed');
  }, 120_000);
});

describe('a blame probe whose attempt a judge could not answer', () => {
  it('is inconclusive, never lost: the search is inconclusive at the first model call', async () => {
    config({});
    // Each answer differs (Refund 1 issued., Refund 2 issued.): the replay as recorded reads the recorded one, which the judge answers.
    const rec = await record({ VARIANT: 'n' });
    const expect_ = JSON.stringify({ judge: [judge({ question: 'Did the agent issue the refund? (first answer only)' })] });
    const b = await shadowlap(['blame', rec, '--expect', expect_, '--attempts', '2', '--passes', '1', '--concurrency', '1', '--json'], { VARIANT: 'n' });
    // No verdict: inconclusive, exit status 3.
    expect(b.code, b.out).toBe(3);
    const blame = JSON.parse(b.stdout) as { outcome: string; confidence: string; probes: Array<{ callNo: number; rescued: boolean; decision?: string; undecided?: string | null; runs: Array<{ passed: boolean; verdict?: string }> }> };
    expect(blame).toMatchObject({ outcome: 'unrescuable', confidence: 'low' });
    expect(blame.probes).toEqual([expect.objectContaining({ callNo: 1, rescued: false, decision: 'inconclusive', undecided: expect.stringMatching(/^judge "issued" answers yes, but it is inconclusive: not judged: the judge's call failed: HTTP 400/) })]);
    // It stopped at the attempt it could not judge, which is no failure.
    expect(blame.probes[0].runs).toEqual([expect.objectContaining({ passed: false, verdict: 'inconclusive' })]);
    const text = await shadowlap(['blame', rec, '--expect', expect_, '--attempts', '2', '--passes', '1', '--concurrency', '1'], { VARIANT: 'n' });
    expect(text.code, text.out).toBe(3);
    expect(text.out).toContain('? Inconclusive at the first model call');
    expect(text.out).toContain('Resampled from the first model call, #1: an attempt could not be judged: judge "issued" answers yes, but it is inconclusive');
    expect(text.out).toMatch(/inconclusive · an attempt not judged/);
    expect(text.out).not.toMatch(/Not rescued from any model call|lost · |✗ judge/);
    // What the run keeps of it says so, and shadowlap show reads it: inconclusive, never "not rescued".
    const store = Store.open(join(work, '.shadowlap', 'shadowlap.db'));
    try {
      expect(store.getRun(rec)!.meta?.blame).toMatchObject({ outcome: 'unrescuable', unsettled: true });
    } finally {
      store.close();
    }
    const shown = (await shadowlap(['show', rec])).stdout;
    expect(shown).toContain('blame: inconclusive at the first model call');
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
    // And it says so before it starts: one model call, so one probe and no check of a call it pins.
    expect(b.out).toMatch(/: 1 model call\n/);
    expect(b.out).toContain('at most 1 probe and 1 attempt; every call before a probe replays');
    const scoped = await shadowlap(['blame', rec, '--expect', JSON.stringify({ judge: [judge({ question: 'Was the refund declined?' })] }), '--scope', 'nope', '--json']);
    expect(scoped.code).not.toBe(0);
    expect(scoped.out).toContain('made no model calls in scope nope (it used no scopes)');
    expect(scoped.out).not.toContain(JUDGE_SCOPE);
  }, 120_000);
});

describe('a golden that may fork, whose attempt fails a check other than its judge', () => {
  /** The checks an attempt's run kept. */
  function keptChecks(runId: string): StoredCheck[] {
    const store = Store.open(join(work, '.shadowlap', 'shadowlap.db'));
    try {
      return store.getRun(runId)?.meta?.checks ?? [];
    } finally {
      store.close();
    }
  }
  const judgeCalls = (runId: string) => storeCalls(runId).filter((c) => c.meta.scope === JUDGE_SCOPE);

  it('asks its judge only in the attempts that passed their other checks, and counts only those asks', async () => {
    // Packed before its checks were added, so only the test's attempts ask the judge.
    config({ tests: { 'goldens/half': { fork: true } } });
    const rec = await record({ VARIANT: 'plain' });
    expect((await shadowlap(['pack', rec, 'goldens/half'])).code).toBe(0);
    config({ tests: { 'goldens/half': { fork: true, repeat: 4, passes: 4, expect: { answer: { includes: ['issued'] }, judge: [judge({})] } } } });
    const before = asked();
    // The agent issues the refund in attempts 1 and 3, and declines it in 2 and 4.
    alternated = 0;
    const t = await test('goldens/half', [], { VARIANT: 'alt' });
    expect(t.code, t.out).toBe(1);
    expect(asked() - before).toBe(2);
    expect(t.result.runs.map((r) => r.verdict)).toEqual(['passed', 'failed', 'passed', 'failed']);
    // The attempts that failed their answer check asked nothing: their judge is not applicable, with why, at no cost.
    for (const r of [t.result.runs[1]!, t.result.runs[3]!]) {
      expect(judgeCalls(r.runId)).toEqual([]);
      expect(keptChecks(r.runId).find((c) => c.judge)).toMatchObject({ status: 'not-applicable', ok: true, detail: JUDGE_NOT_ASKED, judge: { verdict: null, source: null, cost: null } });
    }
    // Those that passed it asked live, and got a verdict.
    for (const r of [t.result.runs[0]!, t.result.runs[2]!]) {
      expect(judgeCalls(r.runId)).toHaveLength(1);
      expect(keptChecks(r.runId).find((c) => c.judge)).toMatchObject({ status: 'passed', judge: { verdict: 'yes', source: 'live' } });
    }
    // An attempt's line says what failed alone: the judge it didn't ask is neither inconclusive nor failed.
    expect(t.result.message).toBe('2 of 4 attempts passed, 4 needed. Attempt 2: check failed: final answer includes "issued", but not found in the final answer');
    expect(t.out).toMatch(/attempt 2 {2}✗ check failed: final answer includes "issued", but not found in the final answer\n/);
    expect(t.out).not.toMatch(/; 1 (inconclusive|more check failed)/);
    // The shown attempt's own checks: its judge wasn't asked there, though attempts 1 and 3 asked it.
    expect(t.out).toContain(`– judge "issued" answers yes: not applicable · ${JUDGE_NOT_ASKED}`);
    // The counts add up the asks made: four agent requests, and two judge calls.
    const result = t.result as Result & { judge: { calls: number; live: number } | null };
    expect(result.judge).toMatchObject({ calls: 2, live: 2 });
    expect(result.upstreamRequests).toBe(6);
  }, 120_000);

  it('reads not asked: no attempt passed its other checks, where every attempt failed another check', async () => {
    config({ tests: { 'goldens/none': { fork: true } } });
    const rec = await record({ VARIANT: 'plain' });
    expect((await shadowlap(['pack', rec, 'goldens/none'])).code).toBe(0);
    config({ tests: { 'goldens/none': { fork: true, repeat: 2, passes: 2, expect: { answer: { includes: ['issued'] }, judge: [judge({})] } } } });
    const junit = join(work, `junit-${++counter}.xml`);
    const markdown = join(work, `summary-${++counter}.md`);
    const before = asked();
    const t = await test('goldens/none', ['--junit', junit, '--markdown', markdown], { VARIANT: 'c' });
    // It fails on its answer check, never inconclusive, and asks no judge.
    expect(t.code, t.out).toBe(1);
    expect(asked()).toBe(before);
    expect(t.result).toMatchObject({ verdict: 'failed', failure: 'check', upstreamRequests: 2 });
    const line = 'judge "issued" answers yes: not applicable · not asked: no attempt passed its other checks';
    expect(t.out).toContain(`    – ${line}\n`);
    const result = t.result as Result & { judge: unknown };
    expect(result.judge).toBeNull();
    expect(t.result.checks.find((c) => c.judge)).toMatchObject({ status: 'not-applicable', ok: true, detail: 'not asked: no attempt passed its other checks', judge: { verdict: null, source: null } });
    // Each attempt's own run keeps why it didn't ask.
    for (const r of t.result.runs) expect(keptChecks(r.runId).find((c) => c.judge)).toMatchObject({ status: 'not-applicable', detail: JUDGE_NOT_ASKED });
    const md = readFileSync(markdown, 'utf8');
    expect(md).toContain(`- ➖ ${line}`);
    expect(md).not.toContain('Inconclusive means');
    // JUnit's details, as the terminal prints them, after its failure's line.
    expect(readFileSync(junit, 'utf8')).toContain(`<failure message="0 of 2 attempts passed, 2 needed. Attempt 1: check failed: final answer includes &quot;issued&quot;, but not found in the final answer"><![CDATA[✗ final answer includes "issued": not found in the final answer\n– ${line}\n`);
    // The store keeps the result as the reports print it, for the dashboard's Show as printed.
    const store = Store.open(join(work, '.shadowlap', 'shadowlap.db'));
    try {
      const kept = store.listTestResults({ golden: 'goldens/none', limit: 1 })[0];
      expect(kept?.data?.checks?.find((c) => c.judge)).toMatchObject({ status: 'not-applicable', detail: 'not asked: no attempt passed its other checks' });
    } finally {
      store.close();
    }
  }, 120_000);
});
