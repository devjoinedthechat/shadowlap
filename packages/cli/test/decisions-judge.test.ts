import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyCounts, NO_TOKENS, Store, type DecisionJudge, type DecisionRun, type DecisionsReport } from '@shadowlap/engine';
import { judgeRequests, startMockAnthropic, withJudge, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from '@shadowlap-testing/reference-agent';
import { passesOf, type MigrateReport } from '../src/migrate.js';
import { departures } from './json-shapes.js';

/**
 * Text-only changes judged by the decision diff: the reference agent's golden carries judge checks
 * on its final answer and on its run, which say whether it tells the user that forks fence writes.
 * The mock plays the agent's model and its judge: `mock-terse` words the final answer without it,
 * `mock-wordy` with it in other words (decision-rules.ts in the reference agent), and the judge says
 * yes only when what it reads says it.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('../../../testing/reference-agent/dist/main.js', import.meta.url));
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

function shadowlap(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', join(dir, 'store.db'), ...args], {
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

/** A project whose golden, goldens/research, is judged by these checks; packed, so it holds the verdicts the judge could give. */
async function project(name: string, judge: unknown[]): Promise<{ dir: string; runId: string; final: number }> {
  const dir = join(root, name);
  mkdirSync(join(dir, 'goldens'), { recursive: true });
  writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/research': { expect: { judge } } } }));
  const rec = await shadowlap(dir, ['run', '--', process.execPath, AGENT]);
  expect(rec.code, rec.out).toBe(0);
  const runId = /recording run (\w{26})/.exec(rec.out)![1]!;
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
    const step = report.runs[0]!.decisions[0]!;
    expect(step).toMatchObject({ callNo: p.final, rank: 2, majority: 2, recorded: { stop: 'answer', text: FINAL_RECORDED }, now: { stop: 'answer', text: FINAL_TERSE } });
    expect(step.changes.map((c) => [c.rank, c.kind, c.before, c.after])).toEqual([
      [2, 'judge', 'passed', 'failed'],
      [2, 'judge', 'passed', 'failed'],
      [5, 'text', FINAL_RECORDED, FINAL_TERSE],
    ]);
    expect(step.changes[0]!.detail).toBe('judge "fences" fails what it says now, which passed as recorded');
    // Each check's verdict on both sides: the recorded words' from the golden's own judge call, free; the new words' live.
    const judged = step.judge!;
    expect(judged.map((j) => j.name)).toEqual(['fences', 'run-fences']);
    for (const j of judged) {
      expect(j).toMatchObject({ model: 'claude-haiku-4-5', pass: 'yes', changed: true, recorded: { status: 'passed', verdict: 'yes', source: 'recording', cost: 0 }, now: { status: 'failed', verdict: 'no', reason: 'it no longer says that forks fence writes', source: 'live' } });
      expect(j.now.cost).toBeGreaterThan(0);
      expect(j.now.request).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(judged[0]!.of).toBe('answer');
    expect(judged[1]!.of).toBe('run');
    // Only the new words were asked, each as the judge runtime asks: at temperature 0, for the verdict's schema.
    const sent = judgeRequests(mock.requests).slice(asked);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.material).toBe(FINAL_TERSE);
    expect(sent[1]!.material).toContain(`assistant: ${FINAL_TERSE}`);
    expect(sent[1]!.material).not.toContain(FINAL_RECORDED);
    for (const q of sent) expect(q.request).toMatchObject({ model: 'claude-haiku-4-5', temperature: 0, output_config: { format: { type: 'json_schema' } } });
    // What judging cost, apart from asking.
    expect(report.judge).toMatchObject({ steps: 1, changed: 1, inconclusive: 0, upstreamRequests: 2, unknownModels: [] });
    expect(report.judge!.spent).toBeGreaterThan(0);
    expect(report.cost.upstreamRequests).toBe(11);
    expect(report.notes).toContain('A judge check of the runs read the words of 1 text-only step, as recorded and as answered now: 1 came out otherwise, rank 2, as a changed stop is.');
    expect(report.notes).toContain('The judge check "printed" reads what the agent printed, which asking a model call again doesn\'t make: verify judges it.');
    expect(report.notes.join('\n')).not.toMatch(/counted, not judged/);
    const shapes = [departures('decisions', report), departures('decisionsStep', step), departures('decisionsDifference', step.changes[0]), departures('decisionsJudge', judged[0]), departures('decisionsJudgeSide', judged[0]!.now), departures('decisionsJudged', report.judge)];
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
    const asked = judgeRequests(mock.requests).length;
    const r = await shadowlap(p.dir, ['decisions', 'goldens/*', '--model', 'mock-terse', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    expect(judgeRequests(mock.requests).length).toBe(asked);
    const judged = report.runs[0]!.decisions[0]!.judge!;
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
    const step = report.runs[0]!.decisions[0]!;
    expect(step).toMatchObject({ rank: 5, changes: [{ kind: 'text' }] });
    expect(step.judge!.map((j) => [j.name, j.recorded.status, j.now.status, j.now.source, j.changed])).toEqual([
      ['fences', 'passed', 'passed', 'live', false],
      ['run-fences', 'passed', 'passed', 'live', false],
    ]);
    expect(report.notes).toContain('A judge check of the runs read the words of 1 text-only step, as recorded and as answered now: every check came out as recorded.');
  }, 120_000);

  it('judges a run from the store by the tests entry of the recording it comes from', async () => {
    // A test's replay of the golden, named by its id: its checks are the golden's, as a replay of it finds them.
    const results = join(p.dir, 'test.json');
    const tested = await shadowlap(p.dir, ['test', 'goldens/research', '--inconclusive', 'warn', '--json', results]);
    expect(tested.code, tested.out).toBe(0);
    const replay = (JSON.parse(readFileSync(results, 'utf8')) as { results: Array<{ runId: string }> }).results[0]!.runId;
    const r = await shadowlap(p.dir, ['decisions', replay, '--model', 'mock-terse', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    expect(report.flagged).toEqual([replay]);
    // The replay holds the judge's calls it was served from the recording: the recorded words' verdicts, free.
    expect(report.runs[0]!.decisions[0]!.judge!.map((j) => [j.name, j.recorded.source, j.recorded.status, j.now.status])).toEqual([
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
    expect(report.pullRequest.body).toContain('and the 1 with a write, stop or judged change verified end to end');
    const text = await shadowlap(p.dir, ['migrate', '--to', 'mock-terse', '-y', '--attempts', '1']);
    expect(text.stdout).toMatch(/rank 2 +goldens\/research #\d+ +judge "fences" fails what it says now, which passed as recorded/);
    expect(text.stdout).toMatch(/checking it {2}\S+ asking, \S+ judging, \S+ verifying/);
  }, 180_000);
});

describe('a judge check that cannot be asked', () => {
  it('leaves the step text only and inconclusive, saying why, which fails the preview unless --inconclusive warn', async () => {
    // The judge is OpenAI's, and this machine has no key for it: neither the pack nor the preview can ask it.
    const p = await project('no-key', [{ ...ANSWER, model: 'gpt-5-mini' }]);
    const asked = judgeRequests(mock.requests).length;
    const r = await shadowlap(p.dir, ['decisions', 'goldens/*', '--model', 'mock-terse', '--json']);
    expect(r.code, r.out).toBe(1);
    const report = json<DecisionsReport>(r);
    const why = 'not judged: no recorded verdict and no key for openai (OPENAI_API_KEY)';
    const step = report.runs[0]!.decisions[0]!;
    expect(step).toMatchObject({ rank: 5, judge: [{ name: 'fences', changed: null, recorded: { status: 'inconclusive', verdict: null, reason: why, source: null }, now: { status: 'inconclusive', reason: why, source: null } }] });
    expect(report.flagged).toEqual([]);
    expect(report.judge).toMatchObject({ steps: 1, changed: 0, inconclusive: 1, upstreamRequests: 0 });
    expect(report.warnings).toContain('1 text-only step a judge check reads could not be judged: no recorded verdict and no key for openai (OPENAI_API_KEY)');
    expect(judgeRequests(mock.requests).length).toBe(asked);
    const warned = await shadowlap(p.dir, ['decisions', 'goldens/*', '--model', 'mock-terse', '--inconclusive', 'warn']);
    expect(warned.code, warned.out).toBe(0);
    expect(warned.out).toContain('! inconclusive, and --inconclusive warn lets it pass: 1 run has a text-only change a judge check reads that could not be judged');
    expect(warned.stdout).toContain(`judge "fences" inconclusive · ${why}`);
    // migrate: the run is inconclusive, not unchanged, since the words it can't judge might read otherwise.
    const m = await shadowlap(p.dir, ['migrate', '--to', 'mock-terse', '-y', '--json']);
    expect(m.code, m.out).toBe(1);
    expect(json<MigrateReport>(m).passes.runs).toMatchObject([{ verdict: 'inconclusive', outcome: 'not-judged', verified: false }]);
  }, 180_000);

  it('reads a run as inconclusive in migrate while a text-only step a judge reads is not judged, and as its recording when judged the same', () => {
    const side = (status: 'passed' | 'inconclusive') => ({ status, verdict: status === 'passed' ? ('yes' as const) : null, reason: status === 'passed' ? 'it says so' : 'not judged: no recorded verdict and no key for openai (OPENAI_API_KEY)', source: status === 'passed' ? ('live' as const) : null, cost: status === 'passed' ? 0.001 : null, request: null });
    const check = (now: 'passed' | 'inconclusive'): DecisionJudge => ({ name: 'fences', of: 'answer', model: 'gpt-5-mini', pass: 'yes', recorded: side('passed'), now: side(now), changed: now === 'passed' ? false : null });
    const run = (judge: DecisionJudge[]): DecisionRun => ({ runId: '01A', golden: 'goldens/research', steps: 1, asked: 1, rank: 5, majority: 5, counts: { ...emptyCounts(), 5: 1 }, cost: { before: null, after: null, spent: 0 }, tokens: { before: NO_TOKENS, after: NO_TOKENS }, thinkingStripped: 0, refused: null, warnings: [], decisions: [{ callNo: 30, step: 11, scope: null, rank: 5, majority: 5, changes: [], recorded: { stop: 'answer', stopReason: 'end_turn', tools: [], text: 'a' }, now: { stop: 'answer', stopReason: 'end_turn', tools: [], text: 'b' }, samples: { asked: 1, answered: 1, changed: 1, ranks: [5] }, model: { recorded: 'm', asked: 'n' }, tokens: { before: null, after: null }, cost: { before: null, after: null, spent: 0 }, thinkingStripped: 0, error: null, judge }] });
    expect(passesOf([run([check('inconclusive')])], [], null, () => true)).toMatchObject([{ verdict: 'inconclusive', outcome: 'not-judged', verified: false, tally: null }]);
    expect(passesOf([run([check('passed')])], [], null, () => true)).toMatchObject([{ verdict: 'passed', outcome: 'unchanged' }]);
  });
});
