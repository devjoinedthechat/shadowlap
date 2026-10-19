import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type DecisionsReport } from '@shadowlap/engine';
import { startMockAnthropic, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from '@shadowlap-testing/reference-agent';
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
/** The Wilson bound of 5 passes in 7 attempts, at the gate's 95%. */
const BOUND_5_OF_7 = 'rate 0.36 to 0.92 (95%)';

let mock: MockServer;
let cwd: string;
let db: string;

beforeAll(async () => {
  mock = await startMockAnthropic({ script: referenceScript, eventDelayMs: () => 0 });
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
  return /recording run (\w{26})/.exec(r.out)![1]!;
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
    const r = await shadowlap(['decisions', runId, '--model', 'claude-sonnet-4-6', '--set', 'temperature=0', '--json']);
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
      expect(kept!.runRows[0]!.data).toEqual(JSON.parse(JSON.stringify(report.runs[0])));
      expect(store.decisionsOfRun(runId)[0]).toMatchObject({ sessionId: report.decisionsId, kind: 'decisions', rank: null });
      expect(store.listEvents({ kinds: ['decisions.done'] })[0]).toMatchObject({ ref: report.decisionsId, data: { runs: 1, flagged: 0 } });
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
    const r = await shadowlap(['decisions', runId, '--from-code', '--json'], { AGENT_SYSTEM_SUFFIX: 'Do not email the summary.', REFERENCE_AGENT_OUTBOX: outbox });
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    expect(report.flagged).toEqual([runId]);
    expect(report.counts).toMatchObject({ 1: 1, 2: 0, same: 10 });
    const step = report.runs[0]!.decisions[0]!;
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

  it('refuses --from-code, saying why, when the first request differs in more than its prompt and tools', async () => {
    const runId = await record();
    const before = mock.requests.length;
    const r = await shadowlap(['decisions', runId, '--from-code', '--json'], { AGENT_MODEL: 'claude-haiku-4-5' });
    expect(r.code, r.out).toBe(1);
    const report = json<DecisionsReport>(r);
    expect(report.runs[0]!.asked).toBe(0);
    expect(report.runs[0]!.refused).toMatch(/^the first model request \(#\d+\) differs in more than its system prompt and tools \(\$\.model changed\): --from-code previews a prompt change/);
    expect(mock.requests.length).toBe(before);
  }, 120_000);

  it('asks the steps after a change that is more than a prompt with the prompt the code sends, and says so', async () => {
    const runId = await record();
    // The code adds a user message before the sixth model call, besides the prompt change.
    const r = await shadowlap(['decisions', runId, '--from-code', '--json'], { AGENT_SYSTEM_SUFFIX: 'Do not email the summary.', AGENT_LATE_CHANGE: '1' });
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    const run = report.runs[0]!;
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
    const prompt = await shadowlap(['decisions', runId, '--from-code', '--json'], { ...thinks, AGENT_SYSTEM_SUFFIX: 'Do not email the summary.' });
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
    expect(changed.runs[0]!.thinkingStripped).toBe(45);
    expect(changed.notes.join('\n')).toMatch(/Reasoning from earlier turns was left out of 9 requests: providers tie it to the prompt it was made under/);

    // A new model is sent the reasoning as the agent would send it after a switch.
    before = mock.requests.length;
    const model = await shadowlap(['decisions', runId, '--model', 'claude-haiku-4-5', '--json']);
    expect(model.code, model.out).toBe(0);
    const switched = json<DecisionsReport>(model);
    sent = mock.requests.slice(before).map((q) => q.body as unknown as Sent);
    expect(sent.every((q) => q.model === 'claude-haiku-4-5' && assistantTurns(q).every(opensWithThinking))).toBe(true);
    expect(switched.runs[0]!.thinkingStripped).toBe(0);
    expect(switched.notes.join('\n')).not.toMatch(/Reasoning from earlier turns/);

    // Claude 4.7 and later refuse the budget: decisions sends the change as given, and says what the model takes.
    const refused = await shadowlap(['decisions', runId, '--model', 'claude-sonnet-5-5', '--json']);
    expect(refused.code, refused.out).toBe(1);
    const unanswered = json<DecisionsReport>(refused);
    expect(unanswered.counts).toMatchObject({ same: 0, notAsked: 11 });
    expect(unanswered.warnings).toContain('claude-sonnet-5-5 takes thinking={"type":"adaptive"} in place of what the recorded requests send: shadowlap migrate --to claude-sonnet-5-5 asks with that, says why, and verifies the runs that change');
    const text = await shadowlap(['decisions', runId, '--model', 'claude-sonnet-5-5']);
    expect(text.code).toBe(1);
    expect(text.stdout).toContain('! No step was answered (the warnings say why), under the model claude-sonnet-5-5');
    expect(text.stdout).toContain('11 steps got no answer: HTTP 400: "thinking.type.enabled" is not supported for this model');
  }, 120_000);

  it('ranks what another model decides differently, with how often across samples, in rank order', async () => {
    const runId = await record();
    const r = await shadowlap(['decisions', runId, '--model', 'claude-haiku-4-5', '--samples', '2', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    const changed = report.runs[0]!.decisions.filter((s) => s.rank !== null);
    expect(changed.map((s) => [s.rank, s.changes[0]!.kind, s.changes[0]!.tool])).toEqual([
      [1, 'write-arguments', 'send_email'],
      [3, 'read-removed', 'fetch_page'],
      [4, 'read-arguments', 'search_web'],
    ]);
    expect(changed.every((s) => s.samples.asked === 2 && s.samples.changed === 2)).toBe(true);
    expect(changed[0]!.changes[0]).toMatchObject({ before: { body: 'Replay works.' }, after: { body: 'Replay works; forks fence writes.' } });
    // Cheaper per run: the same tokens at a lower price.
    expect(report.cost.after!).toBeLessThan(report.cost.before!);
    expect(report.cost.upstreamRequests).toBe(22);
  }, 120_000);

  it('verifies only the runs it flags with --then-verify', async () => {
    const full = await record();
    // A run that crashes after its third model call never reaches the email: the prompt change doesn't touch its decisions.
    const short = await shadowlap(['run', '--', process.execPath, AGENT], { AGENT_FAIL_AFTER_CALL: '3' });
    const shortId = /recording run (\w{26})/.exec(short.out)![1]!;
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
    // Its verdict as the gate states one: the tally, the Wilson bound, and the rule, once.
    expect(report.verify).toMatchObject({ verdict: 'accepted', rule: 'gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts', runs: [{ runId, role: 'good', outcome: 'kept', passes: 12, attempts: 12, bound: 'rate >= 0.76 (95%)' }] });
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
    expect(both.code).toBe(1);
    expect(both.out).toContain('give a gate (--gate) or a fixed count (--attempts, --passes), not both');
    const alone = await shadowlap(['decisions', runId, '--from-code', '--attempts', '3'], noEmail);
    expect(alone.code).toBe(1);
    expect(alone.out).toContain('--expect, --gate, --attempts and --passes are for --then-verify');
  }, 180_000);

  it('leaves a run its gate could not settle inconclusive, for --inconclusive to decide, in the report and in the session it keeps', async () => {
    const [one, two] = [await record(), await record()];
    const asked = await shadowlap(['decisions', one, two, '--model', 'claude-haiku-4-5', '--json']);
    expect(asked.code, asked.out).toBe(0);
    const session = json<DecisionsReport>(asked);
    expect(session.flagged).toEqual([one, two]);
    // The command verify runs fails every third time: a run passing about two times in three, which seven
    // attempts can't tell from one passing half the time or one passing 90%. The gate runs out between its bounds.
    const flaky = ['--', process.execPath, FLAKY, join(cwd, `flaky-${one}.count`), process.execPath, AGENT];
    const gate = '{"bad":0.5,"max":7}';
    const rule = 'gate: tells 90%+ from 50%- at <= 5% risk, up to 7 attempts';
    const r = await shadowlap(['decisions', '--verify', session.decisionsId!, one, '--gate', gate, '--json', ...flaky]);
    expect(r.code, r.out).toBe(1);
    const first = json<{ verify: NonNullable<DecisionsReport['verify']> }>(r).verify;
    expect(first).toMatchObject({ verdict: 'incomplete', rule, runs: [{ runId: one, role: 'good', outcome: 'inconclusive', passes: 5, attempts: 7, bound: BOUND_5_OF_7 }] });
    expect(first.reasons).toEqual([`good run ${one.slice(0, 10)} inconclusive: 5 of 7 passed · ${BOUND_5_OF_7}, between the gate's bounds when its attempts ran out`]);

    // The other run settles under other figures; the session stays incomplete while the first is inconclusive, and names both rules.
    const other = await shadowlap(['decisions', '--verify', session.decisionsId!, two, '--gate', '{"bad":0.1,"max":4}']);
    expect(other.code, other.out).toBe(0);
    expect(other.stdout).toContain('gate: tells 90%+ from 10%- at <= 5% risk, up to 4 attempts');
    expect(other.stdout).toMatch(new RegExp(`${two.slice(0, 10)}  kept  2 of 2 passed · rate >= 0\\.34 \\(95%\\)`));
    const store = Store.open(db);
    try {
      const kept = store.getDecisionSession(session.decisionsId!)!.data.verify as NonNullable<DecisionsReport['verify']>;
      expect(kept).toMatchObject({ verdict: 'incomplete', rule: `${rule}; gate: tells 90%+ from 10%- at <= 5% risk, up to 4 attempts` });
      expect(kept.runs.map((x) => [x.runId, x.outcome])).toEqual([
        [one, 'inconclusive'],
        [two, 'kept'],
      ]);
    } finally {
      store.close();
    }

    // --then-verify the same way: inconclusive, which --inconclusive warn lets through with a warning.
    const warned = await shadowlap(['decisions', one, '--model', 'claude-haiku-4-5', '--then-verify', '--gate', gate, '--inconclusive', 'warn', ...flaky]);
    expect(warned.code, warned.out).toBe(0);
    expect(warned.out).toContain('! inconclusive, and --inconclusive warn lets it pass: verify did not settle every run it took');
    expect(warned.stdout).toContain(`  ${rule}\n  ${one.slice(0, 10)}  inconclusive  5 of 7 passed · ${BOUND_5_OF_7}\n`);
  }, 180_000);

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
    expect(r.code).toBe(1);
    const refusal = json<{ outcome: string; error: { message: string } }>(r);
    expect(refusal).toEqual({ kind: 'decisions', outcome: 'error', error: { message: 'nothing was sent: no Anthropic key: set ANTHROPIC_API_KEY' } });
    const shape = departures('decisionsError', refusal);
    expect([...shape.missing, ...shape.extra]).toEqual([]);
  }, 120_000);

  it('flags a change by what most samples show: a write changed in 1 of 3 is listed, not flagged', async () => {
    const runId = await record();
    const emailStep = callOf(runId, 'send_email');
    // mock-coin words the email its own way the first time it is asked at that turn, and as recorded after.
    const r = await shadowlap(['decisions', runId, '--model', 'mock-coin', '--samples', '3', '--strict', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    const step = report.runs[0]!.decisions.find((s) => s.callNo === emailStep)!;
    expect(step).toMatchObject({ rank: 1, majority: null, samples: { asked: 3, answered: 3, changed: 1 } });
    expect(step.samples.ranks.slice().sort()).toEqual([0, 0, 1]);
    expect(report.runs[0]).toMatchObject({ rank: 1, majority: null });
    expect(report.flagged).toEqual([]);
    expect(report.notes).toContain("1 step had a write, stop or judged change in fewer than half its samples: listed, not flagged, as a model's own variation.");
    const text = await shadowlap(['decisions', runId, '--model', 'mock-coin', '--samples', '3']);
    expect(text.stdout).toMatch(/rank 1 +send_email is called with other arguments · in 1 of 3 samples, fewer than half: not flagged/);
  }, 120_000);

  it("masks what the project's redaction rules mask in the report, as every copy that leaves the machine is", async () => {
    const project = join(cwd, 'redacted');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ redact: [{ pattern: '/Replay works/', replace: '<masked>' }] }));
    const runId = await record({}, project);
    const r = await shadowlap(['decisions', runId, '--model', 'claude-haiku-4-5', '--json'], {}, project);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).not.toContain('Replay works');
    const report = json<DecisionsReport>(r);
    const email = report.runs[0]!.decisions[0]!;
    expect(email.changes[0]).toMatchObject({ kind: 'write-arguments', before: { body: '<masked>.' }, after: { body: '<masked>; forks fence writes.' } });
    expect(email.recorded.tools[0]!.args).toMatchObject({ body: '<masked>.' });
    expect(report.notes).toContain("The project's redaction rules masked the values this report shows, as they mask every copy of a run that leaves the machine.");
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
    const fetch = report.runs[0]!.decisions.find((s) => s.changes.some((c) => c.tool === 'fetch_page'))!;
    expect(fetch).toMatchObject({ rank: 1, changes: [{ kind: 'write-removed', tool: 'fetch_page', effect: 'write', detail: 'fetch_page is no longer called' }] });
    expect(fetch.recorded.tools.find((t) => t.name === 'fetch_page')!.effect).toBe('write');
    // Where the config says nothing, the run's own effects stand: the search is still a read asked differently.
    expect(report.runs[0]!.decisions.find((s) => s.changes.some((c) => c.tool === 'search_web'))).toMatchObject({ rank: 4 });
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
    expect(unknown.code).toBe(1);
    expect(json<{ error: { message: string } }>(unknown).error.message).toMatch(/^no session dc-01Z/);
  }, 240_000);

  it('stops at its budget and says so', async () => {
    const runId = await record();
    const r = await shadowlap(['decisions', runId, '--model', 'claude-opus-5', '--budget', '0.01', '--concurrency', '1', '--json']);
    expect(r.code).toBe(1);
    const report = json<DecisionsReport>(r);
    expect(report.stopReason).toBe('the budget of $0.01 is spent');
    expect(report.runs[0]!.asked).toBeLessThan(11);
    expect(report.counts.notAsked).toBeGreaterThan(0);
  }, 120_000);

  it('prints the JSON its docs describe', async () => {
    const runId = await record();
    const report = json<DecisionsReport>(await shadowlap(['decisions', runId, '--model', 'claude-haiku-4-5', '--json']));
    const problems = [
      departures('decisions', report),
      departures('decisionsChange', report.change),
      departures('decisionsRun', report.runs[0]),
      departures('decisionsStep', report.runs[0]!.decisions[0]),
      departures('decisionsDifference', report.runs[0]!.decisions[0]!.changes[0]),
      departures('decisionsView', report.runs[0]!.decisions[0]!.recorded),
    ];
    expect(problems.flatMap((x) => [...x.missing, ...x.extra])).toEqual([]);
  }, 120_000);

  it('refuses a change it is not given, and a step it cannot place', async () => {
    const none = await shadowlap(['decisions', 'nosuchrun', '--json']);
    expect(none.code).toBe(1);
    expect(none.out).toMatch(/give the change: --model <model>, --set <key=value>, or --from-code/);
    expect(existsSync(join(cwd, 'goldens'))).toBe(true);
  }, 60_000);
});
