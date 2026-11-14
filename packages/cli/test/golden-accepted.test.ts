import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext, type ScriptResult } from '@shadowlap-testing/mock-anthropic';
import { ACCEPTED_FILE, acceptanceLine, addedSentences, readAcceptances, sentences, takenOut, type Acceptance } from '../src/golden-accepted.js';

/**
 * A golden's accepted changes. `shadowlap test --update --reason` keeps why a golden was replaced
 * beside it, with what the new recording does differently, and a later change that takes out what
 * the accepted one put in is told so, with the reason, where its golden diverges.
 *
 * The project is the support agent with its prompt in prompt.txt. The mock plays the model: it
 * refunds the $240 order unless the prompt says to escalate refunds above $100.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const SUPPORT = fileURLToPath(new URL('./support-agent.mjs', import.meta.url));
const ORIGINAL = 'You are a support agent.';
const RULE = 'Escalate refunds above $100.';
const REASON = 'a $240 refund went out against policy';

let mock: MockServer;
let work: string;
let db: string;

function answer(ctx: ScriptContext): ScriptResult {
  const system = JSON.stringify(ctx.request.system ?? '');
  switch (ctx.assistantTurns) {
    case 0:
      return { message: message([toolUse('lookup_order', { order_id: 'A-1042' }, `toolu_lookup_${ctx.requestNo}`)]) };
    case 1:
      if (system.includes(RULE)) return { message: message([toolUse('escalate', { reason: 'refund of $240 is above $100' }, `toolu_decide_${ctx.requestNo}`)]) };
      return { message: message([toolUse('issue_refund', { order_id: 'A-1042', amount: 240 }, `toolu_decide_${ctx.requestNo}`)]) };
    default:
      return { message: message([text('Done.')], { stop_reason: 'end_turn' }) };
  }
}

function shadowlap(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], { cwd: work, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_AUTHOR: 'dev@example.com' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

const prompt = (...lines: string[]) => writeFileSync(join(work, 'prompt.txt'), `${lines.join(' ')}\n`);
const accepted = () => readAcceptances(join(work, 'goldens', 'refund'));

beforeAll(async () => {
  mock = await startMockAnthropic({ script: answer, eventDelayMs: () => 0 });
});
afterAll(async () => {
  await mock.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
/** A golden of the agent refunding the $240 order under the original prompt. */
beforeEach(async () => {
  if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  work = mkdtempSync(join(tmpdir(), 'sl-accepted-'));
  db = join(work, 'store.db');
  writeFileSync(join(work, 'agent.mjs'), `import { readFileSync } from 'node:fs';\nprocess.env.AGENT_SYSTEM = readFileSync(new URL('./prompt.txt', import.meta.url), 'utf8').trim();\nawait import(${JSON.stringify(SUPPORT)});\n`);
  prompt(ORIGINAL);
  const recorded = await shadowlap(['run', '--', process.execPath, join(work, 'agent.mjs')]);
  const runId = /recording run (\w{26})/.exec(recorded.out)![1];
  expect((await shadowlap(['pack', runId, 'goldens/refund'])).code).toBe(0);
});

describe('shadowlap test --update --reason', () => {
  it('keeps who accepted the change, why, and what the new recording does differently, beside the golden', async () => {
    prompt(ORIGINAL, RULE);
    const r = await shadowlap(['test', 'goldens/refund', '--update', '--reason', REASON, '--json', 'report.json']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('what it does differently: ');
    expect(r.out).toContain('issue_refund is no longer called');
    expect(r.out).toContain('escalate is called');
    expect(r.out).toContain(`accepted by dev@example.com: ${REASON} (kept in goldens/refund/${ACCEPTED_FILE})`);
    const [a, ...rest] = accepted();
    expect(rest).toEqual([]);
    expect(a).toMatchObject({ by: 'dev@example.com', reason: REASON, changed: expect.arrayContaining(['system prompt changed']), decides: expect.arrayContaining(['issue_refund is no longer called', 'escalate is called']) });
    expect(a.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The sentence the change added is kept as a hash: the file holds no prompt text.
    expect(a.added).toEqual(addedSentences(ORIGINAL, `${ORIGINAL} ${RULE}`));
    expect(readFileSync(join(work, 'goldens', 'refund', ACCEPTED_FILE), 'utf8')).not.toContain('Escalate');
    const report = JSON.parse(readFileSync(join(work, 'report.json'), 'utf8')) as { results: Array<{ updated: { reason?: string; decides?: string[] } | null }> };
    expect(report.results[0].updated).toMatchObject({ reason: REASON, decides: expect.arrayContaining(['escalate is called']) });
  });

  it('tells a later change that takes the sentence out who accepted it and why, where the golden diverges', async () => {
    prompt(ORIGINAL, RULE);
    expect((await shadowlap(['test', 'goldens/refund', '--update', '--reason', REASON])).code).toBe(0);
    // Someone tidies the prompt, and the rule goes with it.
    prompt(ORIGINAL);
    const r = await shadowlap(['test', 'goldens/refund', '--json', 'report.json']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('! this change takes out what an accepted change put in:');
    expect(r.out).toContain(`"${RULE}"`);
    expect(r.out).toContain(`accepted ${new Date().toISOString().slice(0, 4)}`);
    expect(r.out).toContain(`by dev@example.com: ${REASON}`);
    const report = JSON.parse(readFileSync(join(work, 'report.json'), 'utf8')) as { results: Array<{ takesOut?: Array<{ sentence: string; by: string | null; reason: string }> }> };
    expect(report.results[0].takesOut).toMatchObject([{ sentence: RULE, by: 'dev@example.com', reason: REASON }]);
  });

  it('says nothing of a change that leaves the accepted sentence in', async () => {
    prompt(ORIGINAL, RULE);
    expect((await shadowlap(['test', 'goldens/refund', '--update', '--reason', REASON])).code).toBe(0);
    prompt(ORIGINAL, RULE, 'Be brief.');
    const r = await shadowlap(['test', 'goldens/refund', '--json', 'report.json']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('diverged at call 1');
    expect(r.out).not.toContain('takes out');
    expect((JSON.parse(readFileSync(join(work, 'report.json'), 'utf8')) as { results: Array<{ takesOut?: unknown }> }).results[0].takesOut).toBeUndefined();
  });

  it('updates without a reason as before, keeps none, and says what a reason would do', async () => {
    prompt(ORIGINAL, RULE);
    const r = await shadowlap(['test', 'goldens/refund', '--update']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('no reason was kept: with --reason "<why>", a later change that takes this one out is told why it is there');
    expect(existsSync(join(work, 'goldens', 'refund', ACCEPTED_FILE))).toBe(false);
  });

  it('keeps every accepted change, the oldest first, and leaves the file alone when the golden is replaced again', async () => {
    prompt(ORIGINAL, RULE);
    expect((await shadowlap(['test', 'goldens/refund', '--update', '--reason', REASON])).code).toBe(0);
    prompt(ORIGINAL, RULE, 'Be brief.');
    expect((await shadowlap(['test', 'goldens/refund', '--update', '--reason', 'answers ran long'])).code).toBe(0);
    expect(accepted().map((a) => a.reason)).toEqual([REASON, 'answers ran long']);
    // The second change took nothing out and the agent does the same: it has no decisions to name.
    expect(accepted()[1].decides).toEqual([]);
  });

  it('refuses a reason with nothing to update, and an empty one', async () => {
    const alone = await shadowlap(['test', 'goldens/refund', '--reason', REASON]);
    expect(alone.code).toBe(2);
    expect(alone.out).toContain('--reason says why a golden is updated: give it with --update');
    const empty = await shadowlap(['test', 'goldens/refund', '--update', '--reason', '  ']);
    expect(empty.code).toBe(2);
    expect(empty.out).toContain('--reason needs the reason, in a few words');
  });
});

describe('a golden\'s accepted changes', () => {
  const acceptance = (over: Partial<Acceptance>): Acceptance => ({ at: '2026-11-14T10:00:00.000Z', by: 'dev@example.com', reason: REASON, from: 'A', to: 'B', code: null, changed: [], decides: [], added: [], ...over });

  it('reads a prompt by its sentences, whatever its line breaks and spaces', () => {
    expect(sentences('You are a support agent.  Escalate refunds\nabove $100. Is that clear? Yes!\n\n- never guess')).toEqual(['You are a support agent.', 'Escalate refunds', 'above $100.', 'Is that clear?', 'Yes!', '- never guess']);
    expect(sentences('  \n ')).toEqual([]);
  });

  it('finds the sentences a request takes out, each under the last accepted change that added it', () => {
    const first = acceptance({ reason: 'first', added: addedSentences('', `${RULE} Be brief.`) });
    const second = acceptance({ reason: 'second', added: addedSentences('', 'Be brief.') });
    const divergence = { type: 'request_changed' as const, callNo: 1, kind: 'api' as const, name: 'POST /v1/messages', replayedBefore: 0, diff: [{ path: '$.system', op: 'changed' as const, before: `${ORIGINAL} ${RULE} Be brief.`, after: `${ORIGINAL} Be kind.` }] };
    expect(takenOut(divergence, [first, second]).map((t) => [t.sentence, t.acceptance.reason])).toEqual([[RULE, 'first'], ['Be brief.', 'second']]);
    // A sentence only reworded elsewhere, a value that was added, or no accepted change: nothing to say.
    expect(takenOut({ ...divergence, diff: [{ path: '$.system', op: 'added' as const, after: RULE }] }, [first])).toEqual([]);
    expect(takenOut(divergence, [])).toEqual([]);
    expect(takenOut(null, [first])).toEqual([]);
  });

  it('skips a line that is no accepted change, as a merge can leave one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-accepted-file-'));
    try {
      writeFileSync(join(dir, ACCEPTED_FILE), `${JSON.stringify(acceptance({ reason: 'kept' }))}\n<<<<<<< HEAD\n{"at":1}\n\n${JSON.stringify({ at: '2026-11-15T10:00:00.000Z', reason: 'no author', to: 'C', added: [] })}\n`);
      expect(readAcceptances(dir).map((a) => [a.reason, a.by])).toEqual([['kept', 'dev@example.com'], ['no author', null]]);
      expect(readAcceptances(join(dir, 'missing'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says an accepted change in a line, with its fix when it came with one', () => {
    expect(acceptanceLine(acceptance({}))).toBe(`accepted 2026-11-14 by dev@example.com: ${REASON}`);
    expect(acceptanceLine(acceptance({ by: null, fix: 'fx-01M3RXQ4VB' }))).toBe(`accepted 2026-11-14: ${REASON} (fix fx-01M3RXQ4VB)`);
  });
});
