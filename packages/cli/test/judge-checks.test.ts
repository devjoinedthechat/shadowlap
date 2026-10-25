import { describe, expect, it } from 'vitest';
import { JUDGE_SCOPE, judgeAskId, Store, storeApiRequest, type CallRecord } from '@shadowlap/engine';
import { attemptJudgeMissing, judgeRecording, oracleLabels, undecidableChecks } from '../src/attempts.js';
import { checkLine, evaluateChecks, hasChecks, judgeResults, judgeSource, parseExpect, parseTests } from '../src/checks.js';
import { judgedOptions, judgesOf, liveJudge, recordedVerdicts } from '../src/judge.js';

/** Judge checks as the config writes them, and as results: passed, failed, or inconclusive with why. */

const judge = { name: 'explains', question: 'Does the reply say why the refund was escalated?', of: 'answer', model: 'claude-haiku-4-5', pass: 'yes' } as const;
const at = 'shadowlap.config.json: tests["goldens/x"].expect';

describe('the judge key of expect', () => {
  it('reads each judge check, with what it reads and the answer that passes by default', () => {
    expect(parseExpect({ judge: [{ name: 'explains', question: 'Q?', model: 'claude-haiku-4-5' }] }, 'expect').judge).toEqual([{ name: 'explains', question: 'Q?', of: 'answer', model: 'claude-haiku-4-5', pass: 'yes' }]);
    expect(parseExpect({ judge: [{ name: 'quiet', question: 'Q?', model: 'gpt-5-mini', of: 'output', pass: 'no' }] }, 'expect').judge![0]).toMatchObject({ of: 'output', pass: 'no' });
    expect(hasChecks(parseExpect({ judge: [judge] }, 'expect'))).toBe(true);
  });

  it('says what is wrong with one, where', () => {
    const bad = (j: unknown) => () => parseTests({ 'goldens/x': { expect: { judge: j } } });
    expect(bad({ name: 'x' })).toThrow(`${at}.judge must be a list of questions`);
    expect(bad([{ name: 'x', question: 'Q?' }])).toThrow(`${at}.judge[0].model must name a model a judge can be asked through`);
    expect(bad([{ name: 'x', question: 'Q?', model: 'claude-haiku-4-5', of: 'everything' }])).toThrow(`${at}.judge[0].of must be "answer" (the last model response), "output" (what the agent printed) or "run"`);
    expect(bad([{ name: 'x', question: 'Q?', model: 'claude-haiku-4-5', pass: true }])).toThrow(`${at}.judge[0].pass must be "yes" or "no"`);
    expect(bad([{ name: 'x', question: 'Q?', model: 'claude-haiku-4-5', temperature: 1 }])).toThrow(`${at}.judge[0] has an unknown key "temperature"`);
    expect(bad([judge, judge])).toThrow(`${at}.judge[1].name "explains" is already the name of ${at}.judge[0]`);
    expect(bad([{ ...judge, model: 'mystery-model' }])).toThrow(/must name a model a judge can be asked through/);
  });
});

describe('a judge check\'s result', () => {
  it('passes on the verdict it passes on, fails on the other, and keeps the reason and where the verdict came from', () => {
    const verdicts = new Map([['explains', { verdict: 'yes' as const, reason: 'It says a manager reviews refunds over $100.', source: 'recording' as const }]]);
    const [passed] = judgeResults([judge], { judgeVerdicts: verdicts });
    expect(passed).toEqual({
      status: 'passed',
      ok: true,
      label: 'judge "explains" answers yes',
      detail: null,
      reason: 'It says a manager reviews refunds over $100.',
      source: 'recording',
      judge: { name: 'explains', model: 'claude-haiku-4-5', of: 'answer', verdict: 'yes', source: 'recording', cost: 0, redactions: 0, normalized: false, cut: 0 },
    });
    expect(checkLine(passed)).toBe('✓ judge "explains" answers yes · It says a manager reviews refunds over $100. (judged from the recording, free)');
    const [failed] = judgeResults([{ ...judge, pass: 'no' }], { judgeVerdicts: new Map([['explains', { verdict: 'yes', reason: 'r', source: 'live', cost: 0.0025, redactions: 2, cut: 1200 }]]) });
    expect(failed).toMatchObject({ ok: false, status: 'failed', detail: 'the judge answered yes', reason: 'r' });
    expect(checkLine(failed)).toBe('✗ judge "explains" answers no: the judge answered yes · r (judged live, ≈$0.0025 · read with 2 redaction rules applied · 1,200 characters left out)');
    expect(judgeSource(failed.judge!)).toBe('judged live, ≈$0.0025 · read with 2 redaction rules applied · 1,200 characters left out');
    expect(judgeSource({ ...failed.judge!, cost: 0.0004, redactions: 0, cut: 0 })).toBe('judged live, <$0.001');
    expect(judgeSource({ ...failed.judge!, cost: 0, source: 'recording', redactions: 0, normalized: true, cut: 0 })).toBe('judged from the recording, free · values that change every run masked');
    expect(judgeSource({ ...failed.judge!, cost: null, redactions: 0, cut: 0 })).toBe('judged live, no price for claude-haiku-4-5');
  });

  it('is inconclusive with why when it has no verdict, and never passes', () => {
    const judged = { verdicts: new Map(), notJudged: new Map([['explains', 'no recorded verdict and no key for anthropic (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN)']]) };
    const [none] = judgeResults([judge], judgedOptions(judged));
    expect(none).toMatchObject({ ok: false, status: 'inconclusive', detail: 'not judged: no recorded verdict and no key for anthropic (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN)', judge: { verdict: null, source: null } });
    expect(none).not.toHaveProperty('reason');
    expect(checkLine(none)).toBe('? judge "explains" answers yes: inconclusive · not judged: no recorded verdict and no key for anthropic (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN)');
    // Given nothing at all, as the oracle's labels are worked out: no verdict, and a key only if the environment has one.
    expect(judgeResults([judge])[0]).toMatchObject({ status: 'inconclusive', detail: expect.stringMatching(/^not judged: no recorded verdict/) });
    expect(oracleLabels(parseExpect({ judge: [judge] }, 'expect'))).toEqual(['the agent exits 0', 'judge "explains" answers yes']);
  });
});

/** A run whose agent answered once, and whose judge answered `judges`. */
function judgedRun(store: Store, judges: Array<{ ask: string; check: string; text: string; outcome?: 'ok' | 'error' }>, status: 'completed' | 'failed' = 'completed'): { runId: string; calls: CallRecord[] } {
  const run = store.createRun({ mode: 'record', parentRunId: null, command: { argv: ['agent'], cwd: '/' }, codeVersion: null, startedAt: 1 });
  const call = (callNo: number, reply: string, meta: CallRecord['meta'], outcome: 'ok' | 'error' = 'ok') => {
    const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: `f${callNo}`, occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo, ...identity, origin: 'live', effect: null, requestRef: storeApiRequest(store, { messages: [{ role: 'user', content: 'q' }] }), meta: { provider: 'anthropic', ...meta }, at: callNo });
    store.appendCallEnd(identity, { runId: run.runId, callNo, attempt: 0, responseRef: store.putBlob(Buffer.from(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn' }))), outcome, meta: { status: outcome === 'ok' ? 200 : 503, headers: { 'content-type': 'application/json' }, provider: 'anthropic', usage: { inputTokens: 100, outputTokens: 10 }, model: 'claude-sonnet-5' }, at: callNo });
  };
  call(1, 'A manager will review your refund.', {});
  judges.forEach((j, i) => call(i + 2, j.text, { scope: JUDGE_SCOPE, judge: { check: j.check, ask: j.ask } }, j.outcome));
  store.endRun(run.runId, status, 10);
  return { runId: run.runId, calls: store.getCalls(run.runId) };
}

describe('a recording\'s own verdicts', () => {
  it('are found by what the check asks, the newest that answered, whatever the check is named now', () => {
    const store = Store.open(':memory:');
    const ask = judgeAskId(judge);
    const { calls } = judgedRun(store, [
      { ask, check: 'old-name', text: '{"verdict":"no","reason":"first"}' },
      { ask, check: 'explains', text: '{"verdict":"yes","reason":"second"}' },
      { ask, check: 'explains', text: 'overloaded', outcome: 'error' },
      { ask: judgeAskId({ ...judge, model: 'claude-sonnet-5' }), check: 'explains', text: '{"verdict":"no","reason":"another model"}' },
    ]);
    const held = recordedVerdicts(store, calls, [judge, { ...judge, name: 'other', question: 'Another?' }]);
    expect(held.verdicts.get('explains')).toMatchObject({ verdict: 'yes', reason: 'second', source: 'recording', cost: 0, callNo: 3 });
    expect(held.notJudged.get('other')).toBe('no recorded verdict');
  });

  it('settle a recording against its oracle, and one with no verdict is no evidence either way', () => {
    const store = Store.open(':memory:');
    const spec = parseExpect({ judge: [judge] }, 'expect');
    const yes = judgedRun(store, [{ ask: judgeAskId(judge), check: 'explains', text: '{"verdict":"yes","reason":"r"}' }]);
    expect(judgeRecording(store, store.getRun(yes.runId)!, yes.calls, spec)).toMatchObject({ passed: true, failures: [], unsettled: [] });
    const no = judgedRun(store, [{ ask: judgeAskId(judge), check: 'explains', text: '{"verdict":"no","reason":"it never says why"}' }]);
    expect(judgeRecording(store, store.getRun(no.runId)!, no.calls, spec)).toMatchObject({ passed: false, failures: ['judge "explains" answers yes, but the judge answered no'], checks: [{ status: 'failed', reason: 'it never says why', source: 'recording' }] });
    const none = judgedRun(store, []);
    expect(judgeRecording(store, store.getRun(none.runId)!, none.calls, spec)).toMatchObject({ passed: null, failures: [], unsettled: ['judge "explains" answers yes, but it is inconclusive: not judged: no recorded verdict'] });
  });

  it('are none of the agent\'s calls: no other check counts them', () => {
    const store = Store.open(':memory:');
    const { calls } = judgedRun(store, [{ ask: judgeAskId(judge), check: 'explains', text: '{"verdict":"yes","reason":"r"}' }]);
    const checks = evaluateChecks(parseExpect({ modelCalls: 1, cost: '<= 0.01' }, 'expect'), { calls, output: '', answer: null, argsOf: () => undefined, costOf: () => 0.001 });
    expect(checks.map((c) => c.ok)).toEqual([true, true]);
  });
});

describe('whether a judge can be asked live', () => {
  it('needs its provider\'s key, or an upstream configured for it, and never a test that runs offline', () => {
    expect(liveJudge('anthropic', {}, { ANTHROPIC_API_KEY: 'k' })).toEqual({ headers: { 'x-api-key': 'k' } });
    expect(liveJudge('anthropic', {}, { ANTHROPIC_AUTH_TOKEN: 't' })).toEqual({ headers: { authorization: 'Bearer t' } });
    expect(liveJudge('openai', {}, { OPENAI_API_KEY: 'k' })).toEqual({ headers: { authorization: 'Bearer k' } });
    expect(liveJudge('gemini', {}, { GOOGLE_API_KEY: 'g' })).toEqual({ headers: { 'x-goog-api-key': 'g' } });
    expect(liveJudge('anthropic', {}, { ANTHROPIC_API_KEY: ' ' })).toEqual({ why: 'no key for anthropic (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN)' });
    // A mock or a local server needs no key.
    expect(liveJudge('openai', { openai: 'http://127.0.0.1:8080' }, {})).toEqual({ headers: {} });
    expect(liveJudge('anthropic', { anthropic: 'offline' }, { ANTHROPIC_API_KEY: 'k' })).toEqual({ why: 'the test runs offline' });
  });

  it('decides whether blame, verify and repair can have a verdict: each attempt is a fork, which asks the judge live', () => {
    expect(attemptJudgeMissing(judge, {}, { ANTHROPIC_API_KEY: 'k' })).toBeNull();
    expect(attemptJudgeMissing(judge, { anthropic: 'http://127.0.0.1:9' }, {})).toBeNull();
    const gemini = { ...judge, model: 'gemini-2.5-flash' };
    expect(attemptJudgeMissing(gemini, {}, {})).toBe('an attempt is a fork, whose judge must be asked live: no key for gemini (GEMINI_API_KEY or GOOGLE_API_KEY)');
    expect(undecidableChecks(parseExpect({ judge: [judge, { ...gemini, name: 'brief' }] }, 'expect'), (j) => attemptJudgeMissing(j, {}, { ANTHROPIC_API_KEY: 'k' }))).toEqual([
      { label: 'judge "brief" answers yes', why: 'an attempt is a fork, whose judge must be asked live: no key for gemini (GEMINI_API_KEY or GOOGLE_API_KEY)' },
    ]);
  });

  it('are asked wherever a spec holds them, under a when too', () => {
    const spec = parseExpect({ judge: [judge], when: [{ if: { tool: 'lookup_order', result: { total: { '>': 200 } } }, then: { judge: [{ ...judge, name: 'escalates' }] } }] }, 'expect');
    expect(judgesOf(spec).map((j) => j.name)).toEqual(['explains', 'escalates']);
  });
});

describe('the config schema', () => {
  it('describes a judge check as the parser reads it', async () => {
    const { readFileSync } = await import('node:fs');
    type Item = { properties: Record<string, { pattern?: string; enum?: string[] }>; required: string[] };
    const schema = JSON.parse(readFileSync(new URL('../../../shadowlap.config.schema.json', import.meta.url), 'utf8')) as { $defs: { judge: Item }; properties: { tests: { additionalProperties: { properties: { expect: { properties: { judge: { items: { $ref: string } } } } } } } } };
    // Each judge check of an expect, under when's then too, is the one definition.
    expect(schema.properties.tests.additionalProperties.properties.expect.properties.judge.items.$ref).toBe('#/$defs/judge');
    const item = schema.$defs.judge;
    expect(Object.keys(item.properties).sort()).toEqual(['model', 'name', 'of', 'pass', 'question']);
    expect(item.required).toEqual(['name', 'question', 'model']);
    expect(item.properties.of.enum).toEqual(['answer', 'output', 'run']);
    const model = new RegExp(item.properties.model.pattern!);
    for (const m of ['claude-haiku-4-5', 'gpt-5-mini', 'o4-mini', 'gemini-2.5-flash', 'openai:qwen2.5-7b']) {
      expect(model.test(m), m).toBe(true);
      expect(() => parseExpect({ judge: [{ ...judge, model: m }] }, 'expect'), m).not.toThrow();
    }
    for (const m of ['llama-3', 'mistral-large']) {
      expect(model.test(m), m).toBe(false);
      expect(() => parseExpect({ judge: [{ ...judge, model: m }] }, 'expect'), m).toThrow(/must name a model a judge can be asked through/);
    }
  });
});

describe('a judge whose material cannot be made', () => {
  it('is not judged, saying why, and nothing is sent', async () => {
    const { askJudges } = await import('../src/judge.js');
    const store = Store.open(':memory:');
    const sidecar = { url: 'http://127.0.0.1:9', judgeToken: 't' } as unknown as import('@shadowlap/sidecar').Sidecar;
    const r = await askJudges([{ ...judge, of: 'output' }], { calls: [], output: 'x' }, { sidecar, store, runId: 'R', upstreams: {}, redact: [{ pattern: '/(/', replace: 'x' }], env: {} });
    expect(r.verdicts.size).toBe(0);
    expect(r.notJudged.get('explains')).toMatch(/^what it reads could not be made: /);
  });
});
