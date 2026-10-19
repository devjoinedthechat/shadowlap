import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], {
      cwd,
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

async function record(env: NodeJS.ProcessEnv = {}): Promise<string> {
  const r = await shadowlap(['run', '--', process.execPath, AGENT], env);
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
    expect(json<{ outcome: string; error: { message: string } }>(r)).toEqual({ kind: 'decisions', outcome: 'error', error: { message: 'nothing was sent: no Anthropic key: set ANTHROPIC_API_KEY' } });
  }, 120_000);

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
