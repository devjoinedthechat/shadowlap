import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type DecisionsReport } from '@shadowlap/engine';
import { startMockAnthropic, withJudge, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from '@shadowlap-testing/reference-agent';
import { mergeVerify } from '../src/decisions-verify.js';
import { departures } from './json-shapes.js';

/**
 * `shadowlap decisions` through the CLI, on the reference agent and its mock model: every recorded
 * model call asked again with only the change swapped in, and what it decides compared with the
 * recording. The mock decides differently under a prompt that says not to email, and under
 * claude-haiku-4-5 (decision-rules.ts in the reference agent).
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('../../../testing/reference-agent/dist/main.js', import.meta.url));
/** Runs the agent, failing every third time (flaky-agent.mjs). */
const FLAKY = fileURLToPath(new URL('./flaky-agent.mjs', import.meta.url));
/** Five of seven passed on each side of seven pairs: the drop's interval, each end at 97.5% so the two hold together at 95%. */
const DROP_5_OF_7 = 'drop -0.72 to 0.76 (95%)';

let mock: MockServer;
let cwd: string;
let db: string;

beforeAll(async () => {
  // A judge whose provider turns every request away, for a check verify can't decide.
  const turnedAway = { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'the judge model is not available' } } };
  mock = await startMockAnthropic({ script: withJudge(() => turnedAway, referenceScript), eventDelayMs: () => 0 });
  cwd = mkdtempSync(join(tmpdir(), 'sl-decisions-'));
  db = join(cwd, 'store.db');
});
afterAll(async () => {
  await mock.close();
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}, dir: string = cwd): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], {
      cwd: dir,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_HOME: join(cwd, 'home'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => ((out += d.toString()), (stdout += d.toString())));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out, stdout }));
  });
}

async function record(env: NodeJS.ProcessEnv = {}, dir: string = cwd): Promise<string> {
  const r = await shadowlap(['run', '--', process.execPath, AGENT], env, dir);
  expect(r.code, r.out).toBe(0);
  return /recording run (\w{26})/.exec(r.out)![1];
}

const json = <T,>(r: { stdout: string; out: string }): T => {
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new Error(`not JSON:\n${r.out}`);
  }
};

/** The recorded model call whose answer called a tool, by the tool's name. */
function callOf(runId: string, tool: string): number {
  const store = Store.open(db);
  try {
    const calls = store.getCalls(runId);
    const toolCall = calls.find((c) => c.kind === 'tool' && c.name === tool)!;
    return calls.filter((c) => c.kind === 'api' && c.callNo < toolCall.callNo).at(-1)!.callNo;
  } finally {
    store.close();
  }
}

const runsInStore = () => {
  const store = Store.open(db);
  try {
    return store.allRuns().map((r) => r.runId);
  } finally {
    store.close();
  }
};

describe('shadowlap decisions', () => {
  it('reports no rank 1 or 2 change for the same model at temperature 0, and sends each recorded request with only that set', async () => {
    const runId = await record({ AGENT_MODEL: 'claude-sonnet-4-6' });
    const before = mock.requests.length;
    // One sample, so each recorded request is sent once, changed: the control arm is tested apart.
    const r = await shadowlap(['decisions', runId, '--model', 'claude-sonnet-4-6', '--set', 'temperature=0', '--samples', '1', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    expect(report.counts).toMatchObject({ 1: 0, 2: 0, same: 11, notAsked: 0 });
    expect(report.flagged).toEqual([]);
    expect(report.runs[0]).toMatchObject({ runId, steps: 11, asked: 11, rank: null });
    expect(report.change).toMatchObject({ model: 'claude-sonnet-4-6', fields: { temperature: 0 }, fromCode: null, text: 'the model claude-sonnet-4-6 and temperature=0' });
    // Each step asked once, as recorded but for the field, and no tool ran: no run was made.
    const sent = mock.requests.slice(before);
    expect(sent).toHaveLength(11);
    expect(sent.every((q) => q.body.model === 'claude-sonnet-4-6' && (q.body as { temperature?: unknown }).temperature === 0)).toBe(true);
    expect(runsInStore()).toEqual([runId]);
    expect(report.notes[0]).toMatch(/^Later steps are judged in the recorded run's state/);
    expect(report.cost).toMatchObject({ upstreamRequests: 11 });
    expect(report.decisionsId).toMatch(/^dc-[0-9A-Z]{26}$/);

    // Kept in the store, as the dashboard reads it.
    const store = Store.open(db);
    try {
      const kept = store.getDecisionSession(report.decisionsId!);
      expect(kept).toMatchObject({ kind: 'decisions', change: 'the model claude-sonnet-4-6 and temperature=0', runs: 1, flagged: 0 });
      expect(kept!.runRows[0].data).toEqual(JSON.parse(JSON.stringify(report.runs[0])));
      expect(store.decisionsOfRun(runId)[0]).toMatchObject({ sessionId: report.decisionsId, kind: 'decisions', rank: null });
      // By its name, and settled: no why, and the status it ended with.
      expect(store.listEvents({ kinds: ['decisions.done'] })[0]).toMatchObject({ ref: report.decisionsId, data: { runs: 1, flagged: 0, name: 'Model switch to claude-sonnet-4-6 with temperature=0', why: null, exit: 0 } });
    } finally {
      store.close();
    }
  }, 120_000);

  it('shows a prompt that stops the agent emailing as a rank 1 change at the email step, with no tool run', async () => {
    const outbox = join(cwd, 'outbox.jsonl');
    const runId = await record({ REFERENCE_AGENT_OUTBOX: outbox });
    expect(readFileSync(outbox, 'utf8').trim().split('\n')).toHaveLength(1);
    const emailStep = callOf(runId, 'send_email');
    const runs = runsInStore();
    const before = mock.requests.length;
    const r = await shadowlap(['decisions', runId, '--from-code', '--samples', '1', '--json'], { AGENT_SYSTEM_SUFFIX: 'Do not email the summary.', REFERENCE_AGENT_OUTBOX: outbox });
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    expect(report.flagged).toEqual([runId]);
    expect(report.counts).toMatchObject({ 1: 1, 2: 0, same: 10 });
    const step = report.runs[0].decisions[0];
    expect(step).toMatchObject({ callNo: emailStep, rank: 1, recorded: { stop: 'tools', tools: [{ name: 'send_email', effect: 'write' }] }, now: { stop: 'answer', tools: [] } });
    expect(step.changes.map((c) => c.kind)).toEqual(['write-removed', 'stops', 'text']);
    // The change is the prompt the working tree sends, read offline: nothing ran, nothing was kept but the recording.
    expect(report.change.fromCode).toMatchObject({ calls: 11, tools: { added: [], removed: [], changed: [] } });
    expect(report.change.fromCode!.instructions!.after).toContain('Do not email the summary.');
    expect(readFileSync(outbox, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(runsInStore().sort()).toEqual(runs.sort());
    const sent = mock.requests.slice(before);
    expect(sent).toHaveLength(11);
    expect(sent.every((q) => JSON.stringify(q.body.system).includes('Do not email the summary.'))).toBe(true);

    const text = await shadowlap(['decisions', runId.slice(0, 10), '--from-code'], { AGENT_SYSTEM_SUFFIX: 'Do not email the summary.' });
    expect(text.code, text.out).toBe(0);
    expect(text.stdout).toContain('1 of 1 run decides a write or when to stop differently, under the prompt and tools in the working tree');
    expect(text.stdout).toMatch(new RegExp(`#${emailStep} +step 10 +rank 1 +send_email is no longer called`));
    expect(text.stdout).toContain("Later steps are judged in the recorded run's state");
  }, 120_000);

  it("keeps a --from-code preview with the test session it names, beside the session's cost per run, and refuses a session the store has no record of before asking anything", async () => {
    const runId = await record();
    const store = Store.open(db);
    const { sessionId } = store.startTestSession({ command: ['test', 'goldens/*'], owner: null });
    store.setTestSessionComment(sessionId, { costPerRun: { before: 0.041, after: 0.043 } });
    store.close();
    const change = { AGENT_SYSTEM_SUFFIX: 'Do not email the summary.' };
    const before = mock.requests.length;
    const unknown = await shadowlap(['decisions', runId, '--from-code', '--samples', '1', '--test-session', 'NO-SUCH-SESSION', '--json'], change);
    expect(unknown.code, unknown.out).toBe(2);
    expect(json<{ error: { message: string } }>(unknown).error.message).toBe('unknown test session NO-SUCH-SESSION');
    expect(mock.requests.length).toBe(before);

    const r = await shadowlap(['decisions', runId, '--from-code', '--samples', '1', '--test-session', sessionId, '--json'], change);
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    expect(report.decisionsId).toMatch(/^dc-/);
    const kept = Store.open(db);
    try {
      expect(kept.getTestSession(sessionId)?.comment).toEqual({ decisions: report.decisionsId, costPerRun: { before: 0.041, after: 0.043 } });
    } finally {
      kept.close();
    }
    // A preview of anything but the working tree's prompt and tools is no pull request's: refused.
    for (const args of [['--model', 'claude-haiku-4-5'], ['--verify', report.decisionsId!]]) {
      const refused = await shadowlap(['decisions', runId, ...args, '--test-session', sessionId]);
      expect(refused.code, refused.out).toBe(2);
      expect(refused.out).toContain('--test-session keeps a preview of the prompt and tools your working tree sends with a test session: give it with --from-code, and not with --verify');
    }
  }, 120_000);

  it('refuses --from-code, saying why, when the first request differs in more than its prompt and tools', async () => {
    const runId = await record();
    const before = mock.requests.length;
    const r = await shadowlap(['decisions', runId, '--from-code', '--json'], { AGENT_MODEL: 'claude-haiku-4-5' });
    expect(r.code, r.out).toBe(3);
    const report = json<DecisionsReport>(r);
    expect(report.runs[0].asked).toBe(0);
    expect(report.runs[0].refused).toMatch(/^the first model request \(#\d+\) differs in more than its system prompt and tools \(\$\.model changed\): --from-code previews a prompt change/);
    expect(mock.requests.length).toBe(before);
  }, 120_000);

  it('asks the steps after a change that is more than a prompt with the prompt the code sends, and says so', async () => {
    const runId = await record();
    // The code adds a user message before the sixth model call, besides the prompt change.
    const r = await shadowlap(['decisions', runId, '--from-code', '--json'], { AGENT_SYSTEM_SUFFIX: 'Do not email the summary.', AGENT_LATE_CHANGE: '1' });
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    const run = report.runs[0];
    expect(run.refused).toBeNull();
    expect(run.warnings.join('\n')).toMatch(/From model call #\d+ on, the working tree sends more than a new prompt \(\$\.messages\[\d+\] added\)/);
    expect(run.warnings.join('\n')).toMatch(/The offline replay reached 6 of the run's 11 model calls/);
    // Every step is still asked with the new prompt, and the email step still changes.
    expect(run.asked).toBe(11);
    expect(report.flagged).toEqual([runId]);
  }, 120_000);

  it('leaves earlier reasoning out under a new prompt, keeping what manual thinking needs, and sends it as recorded to a new model', async () => {
    // Claude Sonnet 4.6 still takes a manual thinking budget; the mock thinks before each answer.
    const thinks = { AGENT_MODEL: 'claude-sonnet-4-6', AGENT_THINKING_BUDGET: '1024' };
    const runId = await record(thinks);
    type Sent = { model: string; thinking?: unknown; messages: Array<{ role: string; content: unknown }> };
    const assistantTurns = (q: Sent) => q.messages.filter((m) => m.role === 'assistant');
    const opensWithThinking = (m: { content: unknown }) => Array.isArray(m.content) && (m.content[0] as { type?: string } | undefined)?.type === 'thinking';
    const hasThinking = (m: { content: unknown }) => Array.isArray(m.content) && m.content.some((b) => (b as { type?: string }).type === 'thinking');

    let before = mock.requests.length;
    const prompt = await shadowlap(['decisions', runId, '--from-code', '--samples', '1', '--json'], { ...thinks, AGENT_SYSTEM_SUFFIX: 'Do not email the summary.' });
    expect(prompt.code, prompt.out).toBe(0);
    const changed = json<DecisionsReport>(prompt);
    expect(changed.flagged).toEqual([runId]);
    let sent = mock.requests.slice(before).map((q) => q.body as unknown as Sent);
    expect(sent).toHaveLength(11);
    // In manual mode the last assistant turn keeps its thinking, as the API requires; every earlier one loses it.
    for (const q of sent) {
      const turns = assistantTurns(q);
      expect(turns.slice(0, -1).some(hasThinking)).toBe(false);
      if (turns.length) expect(opensWithThinking(turns.at(-1)!)).toBe(true);
    }
    expect(changed.runs[0].thinkingStripped).toBe(45);
    expect(changed.notes.join('\n')).toMatch(/Reasoning from earlier turns was left out of 9 requests: providers tie it to the prompt it was made under/);

    // A new model is sent the reasoning as the agent would send it after a switch.
    before = mock.requests.length;
    const model = await shadowlap(['decisions', runId, '--model', 'claude-haiku-4-5', '--samples', '1', '--json']);
    expect(model.code, model.out).toBe(0);
    const switched = json<DecisionsReport>(model);
    sent = mock.requests.slice(before).map((q) => q.body as unknown as Sent);
    expect(sent.every((q) => q.model === 'claude-haiku-4-5' && assistantTurns(q).every(opensWithThinking))).toBe(true);
    expect(switched.runs[0].thinkingStripped).toBe(0);
    expect(switched.notes.join('\n')).not.toMatch(/Reasoning from earlier turns/);

    // Claude 4.7 and later refuse the budget: decisions sends the change as given, and says what the model takes.
    const refused = await shadowlap(['decisions', runId, '--model', 'claude-sonnet-5-5', '--json']);
    expect(refused.code, refused.out).toBe(3);
    const unanswered = json<DecisionsReport>(refused);
    expect(unanswered.counts).toMatchObject({ same: 0, notAsked: 11 });
    expect(unanswered.warnings).toContain('claude-sonnet-5-5 takes thinking={"type":"adaptive"} in place of what the recorded requests send: shadowlap migrate --to claude-sonnet-5-5 asks with that, says why, and verifies the runs that change');
    const text = await shadowlap(['decisions', runId, '--model', 'claude-sonnet-5-5']);
    expect(text.code).toBe(3);
    expect(text.stdout).toContain('! No step was answered (the warnings say why), under the model claude-sonnet-5-5');
    expect(text.stdout).toContain('11 steps got no answer: HTTP 400: "thinking.type.enabled" is not supported for this model');
  }, 120_000);

  it('ranks what another model decides differently, with how often across samples, in rank order', async () => {
    const runId = await record();
    const r = await shadowlap(['decisions', runId, '--model', 'claude-haiku-4-5', '--samples', '2', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    const changed = report.runs[0].decisions.filter((s) => s.rank !== null);
    expect(changed.map((s) => [s.rank, s.changes[0].kind, s.changes[0].tool])).toEqual([
      [1, 'write-arguments', 'send_email'],
      [3, 'read-removed', 'fetch_page'],
      [4, 'read-arguments', 'search_web'],
    ]);
    expect(changed.every((s) => s.samples.asked === 2 && s.samples.changed === 2)).toBe(true);
    expect(changed[0].changes[0]).toMatchObject({ before: { body: 'Replay works.' }, after: { body: 'Replay works; forks fence writes.' } });
    // Cheaper per run: the same tokens at a lower price.
    expect(report.cost.after!).toBeLessThan(report.cost.before!);
    expect(report.cost.upstreamRequests).toBe(22);
  }, 120_000);

  it('verifies only the runs it flags with --then-verify', async () => {
    const full = await record();
    // A run that crashes after its third model call never reaches the email: the prompt change doesn't touch its decisions.
    const short = await shadowlap(['run', '--', process.execPath, AGENT], { AGENT_FAIL_AFTER_CALL: '3' });
    const shortId = /recording run (\w{26})/.exec(short.out)![1];
    const r = await shadowlap(['decisions', full, shortId, '--from-code', '--then-verify', '--attempts', '2', '--json'], { AGENT_SYSTEM_SUFFIX: 'Do not email the summary.' });
    const report = json<DecisionsReport>(r);
    expect(report.flagged).toEqual([full]);
    expect(report.runs.find((x) => x.runId === shortId)).toMatchObject({ rank: null, asked: 3 });
    expect(report.verify).toMatchObject({ verdict: 'accepted', runs: [{ runId: full, role: 'good', outcome: 'kept' }] });
    expect(report.verify!.verifyIds).toHaveLength(1);
    expect(report.verify!.commands[0]).toBe(`shadowlap verify --keeps ${full.slice(0, 10)} --attempts 2`);
    // The command that asks the same way again carries every option given.
    expect(report.command).toBe(`shadowlap decisions ${full} ${shortId} --from-code --then-verify --attempts 2`);
    expect(r.code, r.out).toBe(0);
    // Verify's attempts replayed the flagged run and nothing else.
    const store = Store.open(db);
    try {
      const attempts = store.allRuns().filter((x) => x.meta?.verify);
      expect(attempts.length).toBeGreaterThan(0);
      expect(new Set(attempts.map((x) => x.parentRunId))).toEqual(new Set([full]));
    } finally {
      store.close();
    }
  }, 180_000);

  it("verifies through verify's own gate unless a fixed count is given, and --gate changes its figures", async () => {
    const runId = await record();
    const noEmail = { AGENT_SYSTEM_SUFFIX: 'Do not email the summary.' };
    // No count given: the gate decides, as verify's does, so a run that always passes is kept after 12 attempts, not 4 of 5.
    const r = await shadowlap(['decisions', runId, '--from-code', '--then-verify', '--json'], noEmail);
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    // Its verdict as the gate states one: the tally, the bound, and the rule, once.
    expect(report.verify).toMatchObject({ verdict: 'accepted', rule: 'gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts', runs: [{ runId, role: 'good', outcome: 'kept', passes: 12, attempts: 12, bound: 'rate >= 0.73 (95%)' }] });
    expect(report.verify!.commands).toEqual([`shadowlap verify --keeps ${runId.slice(0, 10)}`]);
    expect(report.command).toBe(`shadowlap decisions ${runId} --from-code --then-verify`);
    // Other figures, for the session kept: two straight passes settle it, and the command says how.
    const again = await shadowlap(['decisions', '--verify', report.decisionsId!, '--gate', '{"bad":0.1,"max":4}', '--json'], noEmail);
    expect(again.code, again.out).toBe(0);
    const out = json<{ verify: NonNullable<DecisionsReport['verify']> }>(again);
    expect(out.verify.runs).toMatchObject([{ runId, outcome: 'kept', passes: 2, attempts: 2 }]);
    expect(out.verify.commands).toEqual([`shadowlap verify --keeps ${runId.slice(0, 10)} --gate '{"bad":0.1,"max":4}'`]);
    // A gate and a count at once is refused, as verify refuses it; so is either without a verify to decide.
    const both = await shadowlap(['decisions', '--verify', report.decisionsId!, '--gate', '{"bad":0.1}', '--attempts', '3'], noEmail);
    expect(both.code).toBe(2);
    expect(both.out).toContain('give a gate (--gate) or a fixed count (--attempts, --passes), not both');
    const alone = await shadowlap(['decisions', runId, '--from-code', '--attempts', '3'], noEmail);
    expect(alone.code).toBe(2);
    expect(alone.out).toContain('--expect, --gate, --attempts and --passes are for --then-verify');
  }, 180_000);

  it('counts a verify attempt a judge could not answer apart, never as one that failed', async () => {
    const runId = await record();
    const noEmail = { AGENT_SYSTEM_SUFFIX: 'Do not email the summary.' };
    const unanswered = JSON.stringify({ judge: [{ name: 'summary', question: 'Did the agent summarise the refunds?', of: 'output', model: 'claude-haiku-4-5' }] });
    const r = await shadowlap(['decisions', runId, '--from-code', '--then-verify', '--attempts', '3', '--passes', '3', '--expect', unanswered, '--json'], noEmail);
    const report = json<DecisionsReport>(r);
    // Its first attempt could not be judged, which stops the run: inconclusive, with why, and no bound.
    expect(report.verify).toMatchObject({ verdict: 'incomplete', runs: [{ runId, outcome: 'inconclusive', passes: 0, attempts: 1, bound: null, undecided: expect.stringMatching(/^judge "summary" answers yes, but it is inconclusive: not judged: the judge's call failed: HTTP 400/) }] });
    expect(r.code, r.out).toBe(3);
    const text = await shadowlap(['decisions', '--verify', report.decisionsId!, '--attempts', '3', '--passes', '3', '--expect', unanswered], noEmail);
    expect(text.out).toContain(`${runId.slice(0, 10)}  inconclusive  attempt 1 not judged`);
    expect(text.out).not.toMatch(/0 of 1 passed|broken/);
  }, 180_000);

  it('leaves a run its gate could not settle inconclusive, for --inconclusive to decide, in the report and in the session it keeps', async () => {
    const [one, two] = [await record(), await record()];
    const asked = await shadowlap(['decisions', one, two, '--model', 'claude-haiku-4-5', '--samples', '1', '--json']);
    expect(asked.code, asked.out).toBe(0);
    const session = json<DecisionsReport>(asked);
    expect(session.flagged).toEqual([one, two]);
    // Both runs pass as recorded, so verify keeps each against its baseline: the same run on the model it
    // was recorded with, attempt for attempt. The command verify runs fails every third time it starts,
    // the baseline's attempts counted in turn with the change's: five of seven pass on each side, which
    // seven pairs can't tell from a drop of 10 points. A gate's max other than its default caps the pairs.
    const flaky = ['--', process.execPath, FLAKY, join(cwd, `flaky-${one}.count`), process.execPath, AGENT];
    const gate = '{"bad":0.5,"max":7}';
    const keptRule = (pairs: number) => `kept unless it drops 10+ points below its baseline, attempt for attempt, <= 5% risk, up to ${pairs} pairs`;
    const rule = keptRule(7);
    const r = await shadowlap(['decisions', '--verify', session.decisionsId!, one, '--gate', gate, '--json', ...flaky]);
    expect(r.code, r.out).toBe(3);
    const first = json<{ verify: NonNullable<DecisionsReport['verify']> }>(r).verify;
    expect(first).toMatchObject({ verdict: 'incomplete', runs: [{ runId: one, role: 'good', outcome: 'inconclusive', passes: 5, attempts: 7, baseline: { passes: 5, attempts: 7 }, bound: DROP_5_OF_7, rule }] });
    expect(first.reasons).toEqual([`good run ${one.slice(0, 10)} inconclusive: 5 of 7 passed, baseline 5 of 7 · ${DROP_5_OF_7}, neither kept nor broken against its baseline when its pairs ran out`]);

    // The other run under other figures, four pairs: too few to keep a run at 10 points (38 when every
    // attempt passes), inconclusive too. Each run keeps the rule that decided it, so its tally and bound
    // read under their own rule: none is stated for both.
    const other = await shadowlap(['decisions', '--verify', session.decisionsId!, two, '--gate', '{"bad":0.1,"max":4}']);
    expect(other.code, other.out).toBe(3);
    const otherRule = keptRule(4);
    expect(other.stdout).toContain(`  ${otherRule}\n  ${two.slice(0, 10)}  inconclusive  4 of 4 passed, baseline 4 of 4 · drop `);
    const store = Store.open(db);
    try {
      const kept = store.getDecisionSession(session.decisionsId!)!.data.verify as NonNullable<DecisionsReport['verify']>;
      expect(kept).toMatchObject({ verdict: 'incomplete', rule: null });
      expect(kept.runs.map((x) => [x.runId, x.outcome, x.bound, x.rule])).toEqual([
        [one, 'inconclusive', DROP_5_OF_7, rule],
        [two, 'inconclusive', expect.stringMatching(/^drop -?\d\.\d\d to \d\.\d\d \(95%\)$/), otherRule],
      ]);
    } finally {
      store.close();
    }

    // --then-verify the same way: inconclusive, which --inconclusive warn lets through with a warning.
    const warned = await shadowlap(['decisions', one, '--model', 'claude-haiku-4-5', '--samples', '1', '--then-verify', '--gate', gate, '--inconclusive', 'warn', ...flaky]);
    expect(warned.code, warned.out).toBe(0);
    expect(warned.out).toContain('! inconclusive, and --inconclusive warn lets it pass: verify did not settle every run it took');
    // The counter goes on from where the first verify left it, so this time the change's attempts fail where the baseline's did.
    expect(warned.stdout).toMatch(new RegExp(`  ${rule.replace(/[+.]/g, '\\$&')}\\n  ${one.slice(0, 10)}  inconclusive  \\d of 7 passed, baseline \\d of 7 · drop `));
    // And --verify: the same run, counted afresh, inconclusive again, and let through.
    const again = ['--', process.execPath, FLAKY, join(cwd, `flaky-${one}-again.count`), process.execPath, AGENT];
    const warnedAgain = await shadowlap(['decisions', '--verify', session.decisionsId!, one, '--gate', gate, '--inconclusive', 'warn', ...again]);
    expect(warnedAgain.code, warnedAgain.out).toBe(0);
    expect(warnedAgain.out).toContain('! inconclusive, and --inconclusive warn lets it pass: verify did not settle every run it took');
    expect(warnedAgain.stdout).toContain(`  ${rule}\n  ${one.slice(0, 10)}  inconclusive  5 of 7 passed, baseline 5 of 7 · ${DROP_5_OF_7}\n`);

    // Verified again as the dashboard's Verify the changed runs verifies it, every run the session flagged with
    // no count and no gate of its own, by the command each was recorded with: kept against its baseline, as
    // every attempt of each side passes; the session reads accepted. The project's verify.margin, 50 points,
    // keeps such a run after 6 pairs where the default 10 takes 38.
    const config = join(cwd, 'shadowlap.config.json');
    writeFileSync(config, JSON.stringify({ verify: { margin: 0.5 } }));
    try {
      const settled = await shadowlap(['decisions', '--verify', session.decisionsId!, '--json']);
      expect(settled.code, settled.out).toBe(0);
      const wide = 'kept unless it drops 50+ points below its baseline, attempt for attempt, <= 5% risk, up to 200 pairs';
      const byBaseline = { role: 'good', outcome: 'kept', passes: 6, attempts: 6, baseline: { passes: 6, attempts: 6 }, bound: expect.stringMatching(/^drop <= 0\.\d\d \(95%\)$/), rule: wide };
      expect(json<{ verify: NonNullable<DecisionsReport['verify']> }>(settled).verify).toMatchObject({ verdict: 'accepted', runs: [{ runId: one, ...byBaseline }, { runId: two, ...byBaseline }] });
      const after = Store.open(db);
      try {
        const kept = after.getDecisionSession(session.decisionsId!)!.data.verify as NonNullable<DecisionsReport['verify']>;
        expect(kept).toMatchObject({ verdict: 'accepted' });
        expect(kept.runs.map((x) => [x.runId, x.outcome, x.passes, x.attempts, x.rule])).toEqual([
          [one, 'kept', 6, 6, wide],
          [two, 'kept', 6, 6, wide],
        ]);
      } finally {
        after.close();
      }
    } finally {
      rmSync(config, { force: true });
    }
  }, 300_000);

  it('asks the goldens a pack holds, named as test names them, and warns about a model that retires', async () => {
    const runId = await record({ AGENT_MODEL: 'claude-sonnet-4-5-20250929' });
    mkdirSync(join(cwd, 'goldens'), { recursive: true });
    const packed = await shadowlap(['pack', runId, 'goldens/research']);
    expect(packed.code, packed.out).toBe(0);
    const r = await shadowlap(['decisions', 'goldens/*', '--model', 'claude-sonnet-4-5-20250929', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]).toMatchObject({ runId, golden: 'goldens/research', rank: null });
    expect(report.retirements[0]).toMatchObject({ model: 'claude-sonnet-4-5-20250929', platform: 'anthropic', retires: '2026-11-30', replacement: 'claude-sonnet-5-5', source: 'https://platform.claude.com/docs/en/about-claude/model-deprecations' });
  }, 120_000);

  it('sends nothing without credentials for the provider, and says which', async () => {
    const runId = await record();
    const r = await shadowlap(['decisions', runId, '--model', 'claude-opus-5', '--json'], { SHADOWLAP_UPSTREAM_ANTHROPIC: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '' });
    expect(r.code).toBe(2);
    const refusal = json<{ outcome: string; error: { message: string } }>(r);
    expect(refusal).toEqual({ kind: 'decisions', outcome: 'error', error: { message: 'nothing was sent: no Anthropic key: set ANTHROPIC_API_KEY' } });
    const shape = departures('decisionsError', refusal);
    expect([...shape.missing, ...shape.extra]).toEqual([]);
  }, 120_000);

  it("ranks a change only beyond the model's own variation: a write changed in 1 of 3 samples, and in none as recorded, is listed, not ranked", async () => {
    const runId = await record();
    const emailStep = callOf(runId, 'send_email');
    // mock-coin words the email its own way the first time it is asked at that turn, and as recorded
    // after; the control asks the recorded model, which plays the recording.
    const r = await shadowlap(['decisions', runId, '--model', 'mock-coin', '--samples', '3', '--strict', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    const step = report.runs[0].decisions.find((s) => s.callNo === emailStep)!;
    // One changed sample of three against none of three is a split one time in two: not beyond chance.
    expect(step).toMatchObject({ rank: null, majority: null, sampled: 1, samples: { asked: 3, answered: 3, changed: 1 }, control: { asked: 3, answered: 3, changed: 0, ranks: [0, 0, 0] } });
    expect(step.noise!.p).toBeCloseTo(0.5, 12);
    expect(step.samples.ranks.slice().sort()).toEqual([0, 0, 1]);
    expect(report.runs[0]).toMatchObject({ rank: null, majority: null });
    expect(report.flagged).toEqual([]);
    expect(report.counts.noise).toBe(1);
    expect(report.notes).toContain("1 step decided otherwise no more often than it did as recorded: listed with both counts, not ranked, as the model's own variation.");
    // Each sample of the change went with one of the request as recorded: six requests a step.
    expect(report.cost.upstreamRequests).toBe(6 * report.runs[0].asked);
    const text = await shadowlap(['decisions', runId, '--model', 'mock-coin', '--samples', '3']);
    expect(text.stdout).toMatch(/step 10 {2}within the model's own variation {2}send_email is called with other arguments · in 1 of 3 samples, 0 of 3 as recorded/);
    expect(text.stdout).toMatch(/11 steps asked, 3 samples each and as many as recorded: 1 within the model's own variation, 10 the same/);
    // Below 3 samples no split can reach 5%, so there is no control: the change's own samples decide, by what most show.
    const two = json<DecisionsReport>(await shadowlap(['decisions', runId, '--model', 'mock-coin', '--samples', '2', '--strict', '--json']));
    const twoStep = two.runs[0].decisions.find((s) => s.callNo === emailStep)!;
    expect(twoStep.control).toBeUndefined();
    expect(two.notes).toContain("Each step was asked 2 times, too few to tell a change from the model's own variation: from --samples 3, each step is asked as recorded as often too, and a change ranked only beyond it.");
  }, 120_000);

  it('ranks no step whose request as recorded got no answer for now, and ranks by its own samples one the provider will never answer again', async () => {
    const runId = await record();
    const emailStep = callOf(runId, 'send_email');
    const turnedAway = { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'the judge model is not available' } } };
    // The recorded model's requests, the control's, fail: overloaded for now, or gone for good.
    for (const [status, type] of [
      [529, 'overloaded_error'],
      [404, 'not_found_error'],
    ] as const) {
      const down = await startMockAnthropic({ script: withJudge(() => turnedAway, (ctx) => (ctx.request.model === 'claude-opus-5' ? { status, body: { type: 'error', error: { type, message: `${type} for the test` } }, headers: { 'retry-after': '0' } } : referenceScript(ctx))), eventDelayMs: () => 0 });
      try {
        const r = await shadowlap(['decisions', runId, '--model', 'mock-coin', '--samples', '3', '--json'], { SHADOWLAP_UPSTREAM_ANTHROPIC: down.url });
        const report = json<DecisionsReport>(r);
        const step = report.runs[0].decisions.find((s) => s.callNo === emailStep)!;
        expect(step).toMatchObject({ sampled: 1, samples: { asked: 3, answered: 3, changed: 1 }, control: { asked: 3, answered: 0 } });
        if (status === 529) {
          // One changed sample of three, and nothing as recorded to tell it from the model's own variation: not ranked, not settled.
          expect(step).toMatchObject({ rank: null, majority: null });
          expect(report.runs[0].counts.notAsked).toBeGreaterThanOrEqual(1);
          expect(report.warnings.some((w) => /got fewer than 3 answers under the change or as recorded \(.*overloaded_error.*\): not ranked, since nothing told/.test(w)), report.warnings.join('\n')).toBe(true);
          // It settles nothing: decisions exits 3 for it.
          expect(r.code, r.out).toBe(3);
          const text = await shadowlap(['decisions', runId, '--model', 'mock-coin', '--samples', '3'], { SHADOWLAP_UPSTREAM_ANTHROPIC: down.url });
          expect(text.stdout).toMatch(new RegExp(`#${emailStep} +step \\d+ {2}not settled {2}send_email is called with other arguments · in 1 of 3 samples; as recorded, no answer`));
        } else {
          // A request the provider will never answer again: the change's samples rank it, and the warnings say so.
          expect(step).toMatchObject({ rank: 1, majority: null });
          expect(report.warnings.some((w) => /could not be asked as recorded any more \(.*not_found_error.*\): ranked by the change's samples alone/.test(w)), report.warnings.join('\n')).toBe(true);
          expect(r.code, r.out).toBe(0);
        }
      } finally {
        await down.close();
      }
    }
  }, 120_000);

  it('ranks no step whose request as recorded got fewer than 3 answers, which no split can rank, and leaves its run unsettled', async () => {
    const runId = await record();
    const emailStep = callOf(runId, 'send_email');
    const turnedAway = { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'the judge model is not available' } } };
    // At each step, the request as recorded is answered twice; every later ask of it is overloaded, its retries too.
    const asked = new Map<number, number>();
    const down = await startMockAnthropic({
      script: withJudge(
        () => turnedAway,
        (ctx) => {
          if (ctx.request.model !== 'claude-opus-5') return referenceScript(ctx);
          const n = (asked.get(ctx.assistantTurns) ?? 0) + 1;
          asked.set(ctx.assistantTurns, n);
          return n <= 2 ? referenceScript(ctx) : { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'overloaded for the test' } }, headers: { 'retry-after': '0' } };
        },
      ),
      eventDelayMs: () => 0,
    });
    try {
      const r = await shadowlap(['decisions', runId, '--model', 'mock-coin', '--samples', '3', '--json'], { SHADOWLAP_UPSTREAM_ANTHROPIC: down.url });
      const report = json<DecisionsReport>(r);
      const step = report.runs[0].decisions.find((s) => s.callNo === emailStep)!;
      // 1 changed sample of 3 against 2 answers as recorded: the least any split comes out is 1 in 10, so it could never rank.
      expect(step).toMatchObject({ rank: null, majority: null, sampled: 1, samples: { asked: 3, answered: 3, changed: 1 }, control: { asked: 3, answered: 2 } });
      expect(step.control!.error).toMatch(/overloaded/);
      expect(report.runs[0].counts.noise ?? 0).toBe(0);
      expect(report.warnings.some((w) => /got fewer than 3 answers under the change or as recorded \(.*overloaded.*\): not ranked/.test(w)), report.warnings.join('\n')).toBe(true);
      // It settles nothing: decisions exits 3 for it.
      expect(r.code, r.out).toBe(3);
    } finally {
      await down.close();
    }
  }, 120_000);

  it("ranks a change every sample shows and no sample as recorded does, with both arms' counts", async () => {
    const runId = await record();
    const emailStep = callOf(runId, 'send_email');
    const before = mock.requests.length;
    const r = await shadowlap(['decisions', runId, '--from-code', '--json'], { AGENT_SYSTEM_SUFFIX: 'Do not email the summary.' });
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    const step = report.runs[0].decisions.find((s) => s.callNo === emailStep)!;
    // Three of three against none of three: the one split of twenty that comes out so, 5%.
    expect(step).toMatchObject({ rank: 1, majority: 1, sampled: 1, samples: { asked: 3, changed: 3 }, control: { asked: 3, answered: 3, changed: 0 } });
    expect(step.noise!.p).toBeCloseTo(1 / 20, 12);
    expect(report.flagged).toEqual([runId]);
    // The control asks each changed step's request as recorded: the recorded system prompt, three times.
    const sent = mock.requests.slice(before).map((q) => JSON.stringify(q.body.system ?? ''));
    const changed = sent.filter((x) => x.includes('Do not email the summary.')).length;
    expect(changed).toBe(3 * report.runs[0].asked);
    expect(sent.length - changed).toBe(changed);
  }, 120_000);

  it("masks what the project's redaction rules mask in the report, as every export, pack and share link is", async () => {
    const project = join(cwd, 'redacted');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ redact: [{ pattern: '/Replay works/', replace: '<masked>' }] }));
    const runId = await record({}, project);
    const r = await shadowlap(['decisions', runId, '--model', 'claude-haiku-4-5', '--json'], {}, project);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).not.toContain('Replay works');
    const report = json<DecisionsReport>(r);
    const email = report.runs[0].decisions[0];
    expect(email.changes[0]).toMatchObject({ kind: 'write-arguments', before: { body: '<masked>.' }, after: { body: '<masked>; forks fence writes.' } });
    expect(email.recorded.tools[0].args).toMatchObject({ body: '<masked>.' });
    expect(report.notes).toContain("The project's redaction rules masked the values this report shows, as they mask every export, pack and share link.");
    // The comparison read the values themselves: the email still changed, rank 1.
    expect(report.flagged).toEqual([runId]);
    const text = await shadowlap(['decisions', runId, '--model', 'claude-haiku-4-5'], {}, project);
    expect(text.stdout).not.toContain('Replay works');
    expect(text.stdout).toContain('send_email.body: "<masked>." → "<masked>; forks fence writes."');
  }, 120_000);

  it("takes a tool's effect from the config first: what you declare today outranks what an old recording said", async () => {
    const project = join(cwd, 'declared');
    mkdirSync(project, { recursive: true });
    // fetch_page was recorded as a read; the config now says it writes.
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ mcp: { effects: { fetch_page: 'write' } } }));
    const runId = await record({}, project);
    const r = await shadowlap(['decisions', runId, '--model', 'claude-haiku-4-5', '--json'], {}, project);
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    const fetch = report.runs[0].decisions.find((s) => s.changes.some((c) => c.tool === 'fetch_page'))!;
    expect(fetch).toMatchObject({ rank: 1, changes: [{ kind: 'write-removed', tool: 'fetch_page', effect: 'write', detail: 'fetch_page is no longer called' }] });
    expect(fetch.recorded.tools.find((t) => t.name === 'fetch_page')!.effect).toBe('write');
    // Where the config says nothing, the run's own effects stand: the search is still a read asked differently.
    expect(report.runs[0].decisions.find((s) => s.changes.some((c) => c.tool === 'search_web'))).toMatchObject({ rank: 4 });
  }, 120_000);

  it("verifies a kept session's flagged runs with --verify, each golden under its own checks", async () => {
    const project = join(cwd, 'verify-session');
    mkdirSync(join(project, 'goldens'), { recursive: true });
    // Two goldens of the same agent, judged by different checks: one must email exactly once, one at most once.
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/exactly': { expect: { tools: { send_email: 1 } } }, 'goldens/at-most': { expect: { tools: { send_email: '<= 1' } } } } }));
    for (const name of ['exactly', 'at-most']) {
      const runId = await record({}, project);
      const packed = await shadowlap(['pack', runId, `goldens/${name}`], {}, project);
      expect(packed.code, packed.out).toBe(0);
    }
    const noEmail = { AGENT_SYSTEM_SUFFIX: 'Do not email the summary.' };
    const asked = await shadowlap(['decisions', 'goldens/*', '--from-code', '--json'], noEmail, project);
    expect(asked.code, asked.out).toBe(0);
    const session = json<DecisionsReport>(asked);
    expect(session.flagged).toHaveLength(2);
    const before = mock.requests.length;

    const r = await shadowlap(['decisions', '--verify', session.decisionsId!, '--attempts', '1', '--json'], noEmail, project);
    // The agent no longer emails: the golden that must email once breaks, the other keeps passing.
    expect(r.code, r.out).toBe(1);
    const out = json<{ sessionId: string; kind: string; verify: NonNullable<DecisionsReport['verify']>; passes: null }>(r);
    expect(out).toMatchObject({ sessionId: session.decisionsId, kind: 'decisions', passes: null, verify: { verdict: 'rejected' } });
    const outcome = Object.fromEntries(out.verify.runs.map((x) => [session.runs.find((y) => y.runId === x.runId)!.golden, [x.role, x.outcome]]));
    expect(outcome).toEqual({ 'goldens/exactly': ['good', 'broken'], 'goldens/at-most': ['good', 'kept'] });
    // One verify per set of checks, each with its golden's.
    expect(out.verify.commands).toHaveLength(2);
    expect(out.verify.commands.some((c) => c.includes(`--expect '{"tools":{"send_email":1}}'`))).toBe(true);
    expect(out.verify.commands.some((c) => c.includes(`--expect '{"tools":{"send_email":"<= 1"}}'`))).toBe(true);
    // Nothing was asked again: the model calls verify made are its attempts' own.
    expect(mock.requests.length - before).toBeGreaterThan(0);
    const shape = departures('decisionsSessionVerify', out);
    expect([...shape.missing, ...shape.extra]).toEqual([]);
    // Kept in the session, for its page.
    const store = Store.open(db);
    try {
      expect(store.getDecisionSession(session.decisionsId!)!.data).toMatchObject({ verify: { verdict: 'rejected', commands: out.verify.commands } });
    } finally {
      store.close();
    }
    const unknown = await shadowlap(['decisions', '--verify', 'dc-01ZZZZZZZZZZZZZZZZZZZZZZZZ', '--json'], {}, project);
    expect(unknown.code).toBe(2);
    expect(json<{ error: { message: string } }>(unknown).error.message).toMatch(/^no session dc-01Z/);
  }, 240_000);

  it('stops at its budget and says so', async () => {
    const runId = await record();
    const r = await shadowlap(['decisions', runId, '--model', 'claude-opus-5', '--budget', '0.01', '--concurrency', '1', '--json']);
    expect(r.code).toBe(3);
    const report = json<DecisionsReport>(r);
    expect(report.stopReason).toBe('the budget of $0.01 is spent');
    expect(report.runs[0].asked).toBeLessThan(11);
    expect(report.counts.notAsked).toBeGreaterThan(0);
  }, 120_000);

  it('prints the JSON its docs describe', async () => {
    const runId = await record();
    const report = json<DecisionsReport>(await shadowlap(['decisions', runId, '--model', 'claude-haiku-4-5', '--json']));
    const problems = [
      departures('decisions', report),
      departures('decisionsChange', report.change),
      departures('decisionsRun', report.runs[0]),
      departures('decisionsStep', report.runs[0].decisions[0]),
      departures('decisionsDifference', report.runs[0].decisions[0].changes[0]),
      departures('decisionsView', report.runs[0].decisions[0].recorded),
    ];
    expect(problems.flatMap((x) => [...x.missing, ...x.extra])).toEqual([]);
  }, 120_000);

  it('refuses a change it is not given, and a step it cannot place', async () => {
    const none = await shadowlap(['decisions', 'nosuchrun', '--json']);
    expect(none.code).toBe(2);
    expect(none.out).toMatch(/give the change: --model <model>, --set <key=value>, or --from-code/);
    expect(existsSync(join(cwd, 'goldens'))).toBe(true);
  }, 60_000);
});

describe('a session verified again', () => {
  const run = (runId: string, outcome: string) => ({ runId, role: outcome === 'kept' || outcome === 'broken' ? 'good' : 'target', outcome, passes: 0, attempts: 1, bound: null });
  const verify = (verdict: NonNullable<DecisionsReport['verify']>['verdict'], runs: ReturnType<typeof run>[]): NonNullable<DecisionsReport['verify']> => ({ verdict, verifyIds: [], runs, rule: null, commands: [], spent: 0, upstreamRequests: 0, reasons: [] });

  it('stays incomplete while a run an earlier verify left inconclusive is not settled, never accepted', () => {
    // A's gate ran out of attempts between its bounds; verifying B alone now settles B, not A.
    const earlier = verify('incomplete', [run('A', 'inconclusive'), run('B', 'unsettled')]);
    expect(mergeVerify(earlier, verify('accepted', [run('B', 'fixed')]))).toMatchObject({ verdict: 'incomplete', runs: [{ runId: 'A', outcome: 'inconclusive' }, { runId: 'B', outcome: 'fixed' }] });
    // Once A is verified again and kept, every run is settled.
    expect(mergeVerify(earlier, verify('accepted', [run('A', 'kept'), run('B', 'fixed')])).verdict).toBe('accepted');
    // A run that failed still rejects, whatever else is open.
    expect(mergeVerify(earlier, verify('rejected', [run('B', 'not-fixed')])).verdict).toBe('rejected');
  });
});
