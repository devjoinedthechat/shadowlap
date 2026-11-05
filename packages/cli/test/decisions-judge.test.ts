import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyCounts, judgeOpen, NO_TOKENS, Store, type DecisionJudge, type DecisionRun, type DecisionsReport } from '@shadowlap/engine';
import { judgeRequests, startMockAnthropic, withJudge, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from '@shadowlap-testing/reference-agent';
import { decisionsInconclusive } from '../src/commands/changes.js';
import { passesOf, type MigrateReport } from '../src/migrate.js';
import { departures } from './json-shapes.js';

/**
 * Text-only changes judged by the decision diff: the reference agent's golden carries judge checks
 * on its final answer and on its run, which say whether it tells the user that forks fence writes.
 * The mock plays the agent's model and its judge: `mock-terse` words the final answer without it,
 * `mock-wordy` with it in other words, `mock-mixed` one way and then the other (decision-rules.ts in
 * the reference agent), and the judge says yes only when what it reads says it.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('../../../testing/reference-agent/dist/main.js', import.meta.url));
/** Runs the agent, failing every third time (flaky-agent.mjs). */
const FLAKY = fileURLToPath(new URL('./flaky-agent.mjs', import.meta.url));
const ANSWER = { name: 'fences', question: 'Does the final answer say that forks fence writes?', of: 'answer', model: 'claude-haiku-4-5' };
const RUN = { name: 'run-fences', question: 'Does the agent tell the user that forks fence writes?', of: 'run', model: 'claude-haiku-4-5' };
const OUTPUT = { name: 'printed', question: 'Does what the agent printed say it is done?', of: 'output', model: 'claude-haiku-4-5' };
const FINAL_RECORDED = 'Done. Summary: recorded runs replay deterministically; forks fence writes.';
const FINAL_TERSE = 'Done. Recorded runs replay deterministically.';
/**
 * No way to reach OpenAI or Gemini, whatever this machine holds: an Anthropic judge is asked only
 * through the mock (SHADOWLAP_UPSTREAM_ANTHROPIC), and any other judge can't be asked at all.
 */
const NO_OTHER_PROVIDER = { OPENAI_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '', SHADOWLAP_UPSTREAM_OPENAI: '', SHADOWLAP_UPSTREAM_GEMINI: '', OPENAI_BASE_URL: '', GOOGLE_GEMINI_BASE_URL: '' };

let mock: MockServer;
let root: string;

beforeAll(async () => {
  mock = await startMockAnthropic({
    eventDelayMs: () => 0,
    script: withJudge((q) => (q.material.includes('forks fence writes') ? { verdict: 'yes', reason: 'it says that forks fence writes' } : { verdict: 'no', reason: 'it no longer says that forks fence writes' }), referenceScript),
  });
  root = mkdtempSync(join(tmpdir(), 'sl-decisions-judge-'));
}, 60_000);
afterAll(async () => {
  await mock.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/**
 * These tests are about how each request is shaped and answered, so a step is asked once unless a
 * test says otherwise: by default decisions also asks each step as recorded, three times a side (the
 * control arm, which decisions.test.ts covers).
 */
const once = (args: string[]): string[] => (args[0] === 'decisions' && !args.includes('--samples') && !args.includes('--verify') ? [...args, '--samples', '1'] : args);

function shadowlap(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', join(dir, 'store.db'), ...once(args)], {
      cwd: dir,
      env: { ...process.env, ...NO_OTHER_PROVIDER, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_HOME: join(dir, 'home'), ...env },
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

/**
 * A project whose golden, goldens/research, is judged by these checks; packed, so it holds the verdicts the judge could give.
 * `config` adds to shadowlap.config.json.
 */
async function project(name: string, judge: unknown[], config: Record<string, unknown> = {}): Promise<{ dir: string; runId: string; final: number }> {
  const dir = join(root, name);
  mkdirSync(join(dir, 'goldens'), { recursive: true });
  writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify({ ...config, tests: { 'goldens/research': { expect: { judge } } } }));
  const rec = await shadowlap(dir, ['run', '--', process.execPath, AGENT]);
  expect(rec.code, rec.out).toBe(0);
  const runId = /recording run (\w{26})/.exec(rec.out)![1];
  const packed = await shadowlap(dir, ['pack', runId, 'goldens/research']);
  expect(packed.code, packed.out).toBe(0);
  const store = Store.open(join(dir, 'store.db'));
  try {
    const final = store.getCalls(runId).filter((c) => c.kind === 'api' && c.meta.scope === undefined).at(-1)!.callNo;
    return { dir, runId, final };
  } finally {
    store.close();
  }
}

describe('a text-only change a judge check reads', () => {
  let p: Awaited<ReturnType<typeof project>>;
  beforeAll(async () => {
    p = await project('judged', [ANSWER, RUN, OUTPUT]);
  }, 120_000);

  it('is judged on the recorded words and the new ones, and ranks 2 when a check comes out otherwise', async () => {
    const asked = judgeRequests(mock.requests).length;
    const r = await shadowlap(p.dir, ['decisions', 'goldens/*', '--model', 'mock-terse', '--strict', '--json']);
    // --strict: a run with a rank 1 or 2 change fails CI, and a judged one is one.
    expect(r.code, r.out).toBe(1);
    const report = json<DecisionsReport>(r);
    expect(report.flagged).toEqual([p.runId]);
    expect(report.counts).toMatchObject({ 1: 0, 2: 1, 5: 0, same: 10 });
    const step = report.runs[0].decisions[0];
    expect(step).toMatchObject({ callNo: p.final, rank: 2, majority: 2, recorded: { stop: 'answer', text: FINAL_RECORDED }, now: { stop: 'answer', text: FINAL_TERSE } });
    expect(step.changes.map((c) => [c.rank, c.kind, c.before, c.after])).toEqual([
      [2, 'judge', 'passed', 'failed'],
      [2, 'judge', 'passed', 'failed'],
      [5, 'text', FINAL_RECORDED, FINAL_TERSE],
    ]);
    expect(step.changes[0].detail).toBe('judge "fences" fails what it says now, which passed as recorded');
    // Each check's verdict on both sides: the recorded words' from the golden's own judge call, free; the new words' live.
    const judged = step.judge!;
    expect(judged.map((j) => j.name)).toEqual(['fences', 'run-fences']);
    for (const j of judged) {
      expect(j).toMatchObject({ model: 'claude-haiku-4-5', pass: 'yes', changed: true, recorded: { status: 'passed', verdict: 'yes', source: 'recording', cost: 0 }, now: { status: 'failed', verdict: 'no', reason: 'it no longer says that forks fence writes', source: 'live' } });
      expect(j.now.cost).toBeGreaterThan(0);
      expect(j.now.request).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(judged[0].of).toBe('answer');
    expect(judged[1].of).toBe('run');
    // Only the new words were asked, each as the judge runtime asks: at temperature 0, for the verdict's schema.
    const sent = judgeRequests(mock.requests).slice(asked);
    expect(sent).toHaveLength(2);
    expect(sent[0].material).toBe(FINAL_TERSE);
    expect(sent[1].material).toContain(`assistant: ${FINAL_TERSE}`);
    expect(sent[1].material).not.toContain(FINAL_RECORDED);
    for (const q of sent) expect(q.request).toMatchObject({ model: 'claude-haiku-4-5', temperature: 0, output_config: { format: { type: 'json_schema' } } });
    // What judging cost, apart from asking.
    expect(report.judge).toMatchObject({ steps: 1, changed: 1, inconclusive: 0, upstreamRequests: 2, unknownModels: [] });
    expect(report.judge!.spent).toBeGreaterThan(0);
    expect(report.cost.upstreamRequests).toBe(11);
    expect(report.notes).toContain('A judge check of the runs reads the words of 1 text-only step: 1 came out otherwise for the new words (rank 2, as a changed stop is).');
    expect(report.notes).toContain('The judge check "printed" reads what the agent printed, which asking a model call again doesn\'t make: verify judges it end to end when it takes a run (--then-verify, migrate).');
    expect(step.samples).toEqual({ asked: 1, answered: 1, changed: 1, unjudged: 0, ranks: [2] });
    expect(report.notes.join('\n')).not.toMatch(/counted, not judged/);
    const shapes = [departures('decisions', report), departures('decisionsStep', step), departures('decisionsDifference', step.changes[0]), departures('decisionsJudge', judged[0]), departures('decisionsJudgeSide', judged[0].now), departures('decisionsJudged', report.judge)];
    expect(shapes.flatMap((x) => [...x.missing, ...x.extra])).toEqual([]);

    // Kept with the session, for the run's page.
    const store = Store.open(join(p.dir, 'store.db'));
    try {
      expect(store.decisionsOfRun(p.runId)[0]).toMatchObject({ sessionId: report.decisionsId, rank: 2 });
    } finally {
      store.close();
    }

    const text = await shadowlap(p.dir, ['decisions', 'goldens/*', '--model', 'mock-terse']);
    expect(text.code, text.out).toBe(0);
    expect(text.stdout).toContain('✗ 1 of 1 run is judged otherwise, under the model mock-terse');
    expect(text.stdout).toContain('1 changed, most: rank 2 (it stops, hands over or is judged differently)');
    expect(text.stdout).toMatch(new RegExp(`#${p.final} +step 11 +rank 2 +judge "fences" fails what it says now, which passed as recorded`));
    expect(text.stdout).toContain('judge "fences" passed → failed · it no longer says that forks fence writes (asked before and kept, free)');
    expect(text.stdout).toContain('judging: 0 upstream requests · free');
  }, 120_000);

  it('asks nothing again for the words it has a verdict for: the recording\'s, and those an earlier session kept', async () => {
    // A session of its own first, which asks what no session has kept yet.
    const first = await shadowlap(p.dir, ['decisions', 'goldens/*', '--model', 'mock-terse', '--json']);
    expect(first.code, first.out).toBe(0);
    const asked = judgeRequests(mock.requests).length;
    const r = await shadowlap(p.dir, ['decisions', 'goldens/*', '--model', 'mock-terse', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    expect(judgeRequests(mock.requests).length).toBe(asked);
    const judged = report.runs[0].decisions[0].judge!;
    expect(judged.map((j) => [j.recorded.source, j.now.source, j.now.cost, j.changed])).toEqual([
      ['recording', 'kept', 0, true],
      ['recording', 'kept', 0, true],
    ]);
    expect(report.judge).toMatchObject({ steps: 1, changed: 1, upstreamRequests: 0, spent: 0 });
  }, 120_000);

  it('stays text only when every check comes out as recorded', async () => {
    const r = await shadowlap(p.dir, ['decisions', 'goldens/*', '--model', 'mock-wordy', '--strict', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    expect(report.flagged).toEqual([]);
    expect(report.counts).toMatchObject({ 2: 0, 5: 1 });
    const step = report.runs[0].decisions[0];
    expect(step).toMatchObject({ rank: 5, changes: [{ kind: 'text' }] });
    expect(step.judge!.map((j) => [j.name, j.recorded.status, j.now.status, j.now.source, j.changed])).toEqual([
      ['fences', 'passed', 'passed', 'live', false],
      ['run-fences', 'passed', 'passed', 'live', false],
    ]);
    expect(report.notes).toContain('A judge check of the runs reads the words of 1 text-only step: every check came out as recorded.');
  }, 120_000);

  it("masks what the judge reads with the project's redaction rules before it is sent, and says so", async () => {
    const masked = await project('redacted', [ANSWER], { redact: [{ pattern: '/deterministically/', replace: '<masked>' }] });
    const asked = judgeRequests(mock.requests).length;
    const r = await shadowlap(masked.dir, ['decisions', 'goldens/*', '--model', 'mock-terse', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    // Only the new words were sent, masked: the recorded words' verdict is the golden's own, read the same way when it was packed.
    expect(judgeRequests(mock.requests).slice(asked).map((q) => q.material)).toEqual(['Done. Recorded runs replay <masked>.']);
    const step = report.runs[0].decisions[0];
    expect(step).toMatchObject({ rank: 2, now: { text: 'Done. Recorded runs replay <masked>.' } });
    expect(step.judge!.map((j) => [j.recorded.source, j.now.source, j.changed])).toEqual([['recording', 'live', true]]);
    expect(report.notes).toContain("The project's redaction rules masked the values this report shows, and what each judge check read, as they mask every export, pack and share link.");
    expect(r.stdout).not.toContain('deterministically');
  }, 120_000);

  it('judges a run from the store by the tests entry of the recording it comes from', async () => {
    // A test's replay of the golden, named by its id: its checks are the golden's, as a replay of it finds them.
    const results = join(p.dir, 'test.json');
    const tested = await shadowlap(p.dir, ['test', 'goldens/research', '--inconclusive', 'warn', '--json', results]);
    expect(tested.code, tested.out).toBe(0);
    const replay = (JSON.parse(readFileSync(results, 'utf8')) as { results: Array<{ runId: string }> }).results[0].runId;
    const r = await shadowlap(p.dir, ['decisions', replay, '--model', 'mock-terse', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    expect(report.flagged).toEqual([replay]);
    // The replay holds the judge's calls it was served from the recording: the recorded words' verdicts, free.
    expect(report.runs[0].decisions[0].judge!.map((j) => [j.name, j.recorded.source, j.recorded.status, j.now.status])).toEqual([
      ['fences', 'recording', 'passed', 'failed'],
      ['run-fences', 'recording', 'passed', 'failed'],
    ]);
  }, 120_000);

  it('hands a run a judge reads otherwise to verify, which judges it end to end', async () => {
    const r = await shadowlap(p.dir, ['decisions', 'goldens/*', '--model', 'mock-terse', '--then-verify', '--attempts', '1', '--json']);
    const report = json<DecisionsReport>(r);
    expect(r.code, r.out).toBe(1);
    expect(report.verify).toMatchObject({ verdict: 'rejected', runs: [{ runId: p.runId, role: 'good', outcome: 'broken', passes: 0, attempts: 1 }] });
    expect(report.verify!.reasons[0]).toContain('judge "fences" answers yes, but the judge answered no');
  }, 180_000);

  it("migrates with it: the judged change is what changes, verify breaks the run, and judging's cost is apart", async () => {
    const r = await shadowlap(p.dir, ['migrate', '--to', 'mock-terse', '-y', '--attempts', '1', '--json']);
    expect(r.code, r.out).toBe(1);
    const report = json<MigrateReport>(r);
    expect(report.changes.steps).toEqual([{ runId: p.runId, golden: 'goldens/research', callNo: p.final, rank: 2, detail: 'judge "fences" fails what it says now, which passed as recorded', recorded: expect.stringContaining('answers and stops'), now: expect.stringContaining('answers and stops'), arguments: [] }]);
    expect(report.passes.runs).toMatchObject([{ verdict: 'failed', outcome: 'broken', verified: true }]);
    // What judging cost is checking's too, apart from asking and verifying.
    expect(report.costs.checking.judge).toBe(report.decisions.judge!.spent);
    expect(report.pullRequest.body).toContain('and 1 of 1 run verified end to end');
    const text = await shadowlap(p.dir, ['migrate', '--to', 'mock-terse', '-y', '--attempts', '1']);
    expect(text.stdout).toMatch(/rank 2 +goldens\/research #\d+ +judge "fences" fails what it says now, which passed as recorded/);
    expect(text.stdout).toMatch(/checking it {2}\S+ asking, \S+ judging, \S+ verifying/);
  }, 180_000);
});

describe('a judge check that cannot be asked', () => {
  it('leaves the step text only and inconclusive, saying why, which fails the preview unless --inconclusive warn', async () => {
    // The judge is OpenAI's, and this machine has no key for it: neither the pack nor the preview can ask it.
    const p = await project('no-key', [{ ...ANSWER, model: 'gpt-5-mini' }], { redact: [{ pattern: '/deterministically/', replace: '<masked>' }] });
    const asked = judgeRequests(mock.requests).length;
    const r = await shadowlap(p.dir, ['decisions', 'goldens/*', '--model', 'mock-terse', '--json']);
    expect(r.code, r.out).toBe(3);
    const report = json<DecisionsReport>(r);
    const why = 'not judged: no recorded verdict and no key for openai (OPENAI_API_KEY)';
    const step = report.runs[0].decisions[0];
    expect(step).toMatchObject({ rank: 5, samples: { answered: 1, unjudged: 1 }, judge: [{ name: 'fences', changed: null, recorded: { status: 'inconclusive', verdict: null, reason: why, source: null }, now: { status: 'inconclusive', reason: why, source: null } }] });
    expect(report.flagged).toEqual([]);
    expect(report.judge).toMatchObject({ steps: 1, changed: 0, inconclusive: 1, upstreamRequests: 0 });
    expect(report.warnings).toContain('1 text-only step a judge check reads could not be judged: no recorded verdict and no key for openai (OPENAI_API_KEY)');
    // No judge read anything: the notes say it could not be judged, never that it came out as recorded, and that
    // the redaction rules masked what the report shows, not what a judge read.
    expect(report.notes).toContain('A judge check of the runs reads the words of 1 text-only step: 1 could not be judged (the warnings say why).');
    expect(report.notes.join('\n')).not.toMatch(/came out as recorded|what each judge check read/);
    expect(report.notes).toContain("The project's redaction rules masked the values this report shows, as they mask every export, pack and share link.");
    expect(judgeRequests(mock.requests).length).toBe(asked);
    const warned = await shadowlap(p.dir, ['decisions', 'goldens/*', '--model', 'mock-terse', '--inconclusive', 'warn']);
    expect(warned.code, warned.out).toBe(0);
    expect(warned.out).toContain('! inconclusive, and --inconclusive warn lets it pass: 1 run has a text-only change a judge check reads that could not be judged');
    expect(warned.stdout).toContain(`judge "fences" inconclusive · ${why}`);
    // migrate: the run writes, so it runs end to end, and is inconclusive there, since its judge can't be asked.
    const m = await shadowlap(p.dir, ['migrate', '--to', 'mock-terse', '-y', '--json']);
    expect(m.code, m.out).toBe(3);
    expect(json<MigrateReport>(m).passes.runs).toMatchObject([{ verdict: 'inconclusive', outcome: 'inconclusive', verified: true }]);
  }, 180_000);

  it('reads a run as inconclusive in migrate while a step of it waits on a judge, and as its recording when judged the same', () => {
    const side = (status: 'passed' | 'failed' | 'inconclusive') => ({ status, verdict: status === 'passed' ? ('yes' as const) : status === 'failed' ? ('no' as const) : null, reason: status === 'inconclusive' ? 'not judged: no recorded verdict and no key for openai (OPENAI_API_KEY)' : 'it says so', source: status === 'inconclusive' ? null : ('live' as const), cost: status === 'inconclusive' ? null : 0.001, request: null });
    const check = (now: 'passed' | 'failed' | 'inconclusive'): DecisionJudge => ({ name: 'fences', of: 'answer', model: 'gpt-5-mini', pass: 'yes', recorded: side('passed'), now: side(now), changed: now === 'inconclusive' ? null : now !== 'passed' });
    const run = (judge: DecisionJudge[], samples: { ranks: number[]; unjudged: number; majority: 2 | 5 }): DecisionRun => ({ runId: '01A', golden: 'goldens/research', steps: 1, asked: 1, rank: Math.min(...samples.ranks) as 2 | 5, majority: samples.majority, counts: { ...emptyCounts(), 5: 1 }, cost: { before: null, after: null, spent: 0 }, tokens: { before: NO_TOKENS, after: NO_TOKENS }, thinkingStripped: 0, refused: null, warnings: [], decisions: [{ callNo: 30, step: 11, scope: null, rank: Math.min(...samples.ranks) as 2 | 5, majority: samples.majority, changes: [], recorded: { stop: 'answer', stopReason: 'end_turn', tools: [], text: 'a' }, now: { stop: 'answer', stopReason: 'end_turn', tools: [], text: 'b' }, samples: { asked: samples.ranks.length, answered: samples.ranks.length, changed: samples.ranks.length, unjudged: samples.unjudged, ranks: samples.ranks }, model: { recorded: 'm', asked: 'n' }, tokens: { before: null, after: null }, cost: { before: null, after: null, spent: 0 }, thinkingStripped: 0, error: null, judge }] });
    expect(passesOf([run([check('inconclusive')], { ranks: [5], unjudged: 1, majority: 5 })], [], null, () => true)).toMatchObject([{ verdict: 'inconclusive', outcome: 'not-judged', verified: false, tally: null }]);
    expect(passesOf([run([check('passed')], { ranks: [5], unjudged: 0, majority: 5 })], [], null, () => true)).toMatchObject([{ verdict: 'passed', outcome: 'unchanged' }]);
    // Three samples: the one shown came out otherwise, in fewer than half of them, and the judge could not judge the other two, which might flag it.
    const hidden = run([check('failed')], { ranks: [2, 5, 5], unjudged: 2, majority: 5 });
    expect(judgeOpen(hidden.decisions[0])).toBe(true);
    expect(passesOf([hidden], [], null, () => true)).toMatchObject([{ verdict: 'inconclusive', outcome: 'not-judged' }]);
    expect(decisionsInconclusive({ stopReason: null, runs: [hidden], flagged: [], verify: null } as unknown as DecisionsReport)).toBe('1 run has a text-only change a judge check reads that could not be judged');
  });
});

describe('judging text-only changes, more ways', () => {
  it('stops judging once --budget is spent, and says what it could not judge, never that it came out as recorded', async () => {
    const p = await project('budget', [ANSWER, RUN]);
    const asked = judgeRequests(mock.requests).length;
    // Asking mock-wordy, which has no price, spends nothing; the first live judge call spends the budget, so the second is not made.
    const r = await shadowlap(p.dir, ['decisions', 'goldens/*', '--model', 'mock-wordy', '--budget', '0.0001', '--json']);
    expect(r.code, r.out).toBe(3);
    const report = json<DecisionsReport>(r);
    expect(judgeRequests(mock.requests).length - asked).toBe(1);
    const step = report.runs[0].decisions[0];
    expect(step.judge!.map((j) => [j.name, j.now.source, j.now.status, j.changed])).toEqual([
      ['fences', 'live', 'passed', false],
      ['run-fences', null, 'inconclusive', null],
    ]);
    expect(step.judge![1].now.reason).toBe('not judged: the budget of $0.00 is spent');
    expect(step).toMatchObject({ rank: 5, samples: { unjudged: 1 } });
    expect(report.stopReason).toBeNull();
    expect(report.flagged).toEqual([]);
    expect(report.judge).toMatchObject({ steps: 1, changed: 0, inconclusive: 1, upstreamRequests: 1 });
    expect(report.notes).toContain('A judge check of the runs reads the words of 1 text-only step: 1 could not be judged (the warnings say why).');
    expect(report.notes.join('\n')).not.toMatch(/came out as recorded/);
    expect(report.warnings).toContain('1 text-only step a judge check reads could not be judged: the budget of $0.00 is spent');
    expect(decisionsInconclusive(report)).toBe('1 run has a text-only change a judge check reads that could not be judged');
  }, 120_000);

  it('asks a request the samples of a step share once', async () => {
    const p = await project('samples', [ANSWER]);
    const asked = judgeRequests(mock.requests).length;
    const r = await shadowlap(p.dir, ['decisions', 'goldens/*', '--model', 'mock-terse', '--samples', '3', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    // Three samples, the same new words: their verdict is asked once and read three times.
    expect(judgeRequests(mock.requests).length - asked).toBe(1);
    expect(report.judge).toMatchObject({ steps: 1, changed: 1, inconclusive: 0, upstreamRequests: 1 });
    const step = report.runs[0].decisions[0];
    expect(step).toMatchObject({ rank: 2, majority: 2, samples: { asked: 3, answered: 3, changed: 3, unjudged: 0, ranks: [2, 2, 2] } });
    expect(step.judge!.map((j) => [j.recorded.source, j.now.source, j.changed])).toEqual([['recording', 'live', true]]);
    expect(report.flagged).toEqual([p.runId]);
  }, 120_000);

  it('waits on the judge when it could not judge some samples of a step, whichever sample shows the step', async () => {
    const p = await project('mixed', [ANSWER]);
    // mock-mixed words one sample tersely and the other as recorded in other words; the first judged spends the budget,
    // so the second is not judged. Whichever comes first, the step's flag waits on the words the judge never read.
    const r = await shadowlap(p.dir, ['decisions', 'goldens/*', '--model', 'mock-mixed', '--samples', '2', '--budget', '0.0001', '--json']);
    expect(r.code, r.out).toBe(3);
    const report = json<DecisionsReport>(r);
    const step = report.runs[0].decisions[0];
    expect(step.samples).toMatchObject({ asked: 2, answered: 2, changed: 2, unjudged: 1 });
    expect(step.samples.ranks.slice().sort()).toEqual(step.samples.ranks.includes(2) ? [2, 5] : [5, 5]);
    expect(judgeOpen(step)).toBe(true);
    expect(report.flagged).toEqual([]);
    expect(report.judge).toMatchObject({ steps: 1, changed: 0, inconclusive: 1, upstreamRequests: 1 });
    expect(report.notes).toContain('A judge check of the runs reads the words of 1 text-only step: 1 could not be judged (the warnings say why).');
    expect(report.warnings).toContain('1 text-only step a judge check reads could not be judged: the budget of $0.00 is spent');
    expect(decisionsInconclusive(report)).toBe('1 run has a text-only change a judge check reads that could not be judged');
  }, 120_000);

  it('says a judge with no price is no free call', async () => {
    const p = await project('unpriced', [{ ...ANSWER, model: 'claude-mock-judge-9' }]);
    const r = await shadowlap(p.dir, ['decisions', 'goldens/*', '--model', 'mock-terse']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('judge "fences" passed → failed · it no longer says that forks fence writes (judged live, no price for its model)');
    expect(r.stdout).toContain('judging: 1 upstream request · ≈$0 spent (no price for claude-mock-judge-9)');
    // Asked again, the verdict is the one the first session kept, and nothing goes upstream: that is free.
    const again = await shadowlap(p.dir, ['decisions', 'goldens/*', '--model', 'mock-terse', '--json']);
    const report = json<DecisionsReport>(again);
    expect(report.judge).toMatchObject({ upstreamRequests: 0, spent: 0, unknownModels: [] });
    expect(report.runs[0].decisions[0].judge!.map((j) => [j.now.source, j.now.cost])).toEqual([['kept', 0]]);
  }, 120_000);

  it('judges with the checks --expect gives --then-verify, which a golden with none has not', async () => {
    const p = await project('expect', []);
    const none = await shadowlap(p.dir, ['decisions', 'goldens/*', '--model', 'mock-terse', '--json']);
    expect(json<DecisionsReport>(none)).toMatchObject({ flagged: [], judge: null, counts: { 5: 1 } });
    const r = await shadowlap(p.dir, ['decisions', 'goldens/*', '--model', 'mock-terse', '--then-verify', '--expect', JSON.stringify({ judge: [ANSWER] }), '--attempts', '1', '--json']);
    expect(r.code, r.out).toBe(1);
    const report = json<DecisionsReport>(r);
    // The recording holds no verdict for a check it was never judged by: both sides are asked live.
    expect(report.runs[0].decisions[0].judge!.map((j) => [j.name, j.recorded.source, j.recorded.status, j.now.source, j.now.status])).toEqual([['fences', 'live', 'passed', 'live', 'failed']]);
    expect(report.flagged).toEqual([p.runId]);
    expect(report.verify).toMatchObject({ verdict: 'rejected', runs: [{ runId: p.runId, outcome: 'broken', passes: 0, attempts: 1 }] });
  }, 180_000);

  // Windows has no Ctrl-C to send a child process.
  it.skipIf(process.platform === 'win32')('starts no verify after a Ctrl-C while the judge is asked, and says why it did not', async () => {
    const p = await project('interrupted', [ANSWER]);
    // A way to the mock that holds the judge's request until the Ctrl-C has landed.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let judging = () => {};
    const asking = new Promise<void>((resolve) => (judging = resolve));
    const proxy = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void (async () => {
          const body = Buffer.concat(chunks);
          if (body.includes('<material>')) {
            judging();
            await held;
          }
          const up = await fetch(`${mock.url}${req.url ?? '/'}`, { method: req.method ?? 'POST', headers: { 'content-type': 'application/json' }, body });
          res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' });
          res.end(Buffer.from(await up.arrayBuffer()));
        })();
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const upstream = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      const child = spawn(process.execPath, [CLI, '--db', join(p.dir, 'store.db'), ...once(['decisions', 'goldens/*', '--model', 'mock-terse', '--then-verify', '--attempts', '1', '--json'])], {
        cwd: p.dir,
        env: { ...process.env, ...NO_OTHER_PROVIDER, SHADOWLAP_UPSTREAM_ANTHROPIC: upstream, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_HOME: join(p.dir, 'home') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let stdout = '';
      child.stdout.on('data', (d: Buffer) => ((out += d.toString()), (stdout += d.toString())));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
      await asking;
      child.kill('SIGINT');
      // The signal lands while the judge's answer is held; then the answer comes.
      await new Promise((resolve) => setTimeout(resolve, 500));
      release();
      const code = await exited;
      expect(code, out).toBe(130);
      const report = json<DecisionsReport>({ stdout, out });
      // The judge's answer still counts: the run is flagged. Verify, which would run the agent, did not start.
      expect(report.flagged).toEqual([p.runId]);
      expect(report.verify).toMatchObject({ verdict: 'not-run', runs: [], reasons: ['it was interrupted before verify started'] });
      expect(report.verify!.commands).toHaveLength(1);
      expect(decisionsInconclusive(report)).toBe('verify did not run: it was interrupted before verify started');
    } finally {
      release();
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  }, 180_000);

  it('judges no text-only change of a run that did not complete, which fails whatever a judge says', async () => {
    const dir = join(root, 'failed');
    mkdirSync(join(dir, 'goldens'), { recursive: true });
    writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/research': { expect: { judge: [ANSWER] } } } }));
    // The agent gives its final answer, then its command exits 1 (flaky-agent.mjs, on its third run): the recording
    // holds the final answer, and the run failed.
    const counter = join(dir, 'flaky.count');
    writeFileSync(counter, '2');
    const rec = await shadowlap(dir, ['run', '--', process.execPath, FLAKY, counter, process.execPath, AGENT]);
    expect(rec.code, rec.out).not.toBe(0);
    const runId = /recording run (\w{26})/.exec(rec.out)![1];
    const packed = await shadowlap(dir, ['pack', runId, 'goldens/research']);
    expect(packed.code, packed.out).toBe(0);
    const asked = judgeRequests(mock.requests).length;
    const r = await shadowlap(dir, ['decisions', 'goldens/*', '--model', 'mock-terse', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    expect(judgeRequests(mock.requests).length).toBe(asked);
    expect(report.runs[0].decisions[0]).toMatchObject({ rank: 5, judge: null, samples: { unjudged: 0 } });
    expect(report.judge).toBeNull();
    expect(report.notes).toContain(`${runId.slice(0, 10)} did not complete, so it fails its checks whatever a judge says: no judge check reads its text-only changes, which are counted.`);
    expect(decisionsInconclusive(report)).toBeNull();
  }, 180_000);
});
