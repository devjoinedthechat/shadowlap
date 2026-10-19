import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CallRecord } from '@shadowlap/engine';
import { argsMatch, evaluateChecks, formatCount, parseAmount, parseCount, parseExpect, parseTests, specFor } from '../src/checks.js';
import { loadTests, saveConfig } from '../src/config.js';

function call(callNo: number, kind: CallRecord['kind'], name: string, origin: CallRecord['origin'] = 'replayed', args?: unknown): CallRecord & { args?: unknown } {
  return { runId: 'r', callNo, kind, name, fingerprint: 'f', occurrence: 1, origin, effect: null, requestRef: null, meta: {}, at: 0, end: null, attempts: [], args };
}

describe('outcome checks', () => {
  it('reads counts as numbers, comparisons and ranges', () => {
    expect(parseCount(0, 'x')).toEqual({ min: 0, max: 0 });
    expect(parseCount('>= 1', 'x')).toEqual({ min: 1, max: Infinity });
    expect(parseCount('>0', 'x')).toEqual({ min: 1, max: Infinity });
    expect(parseCount('<= 12', 'x')).toEqual({ min: 0, max: 12 });
    expect(parseCount('< 3', 'x')).toEqual({ min: 0, max: 2 });
    expect(parseCount('2-4', 'x')).toEqual({ min: 2, max: 4 });
    for (const bad of [-1, 1.5, 'some', '4-2', '< 0', null]) expect(() => parseCount(bad, 'tests["a"].expect.modelCalls')).toThrow(/tests\["a"\]\.expect\.modelCalls must be a count/);
    expect(formatCount({ min: 1, max: 1 })).toBe('1 time');
    expect(formatCount({ min: 1, max: Infinity })).toBe('at least 1 time');
    expect(formatCount({ min: 0, max: 12 }, 'model call')).toBe('at most 12 model calls');
    expect(formatCount({ min: 2, max: 4 })).toBe('2 to 4 times');
  });

  it('rejects a config it cannot read, naming the key', () => {
    expect(() => parseTests({ 'goldens/a': { expect: { tool: {} } } })).toThrow('shadowlap.config.json: tests["goldens/a"].expect has an unknown key "tool"');
    expect(() => parseTests({ 'goldens/a': { expect: { modelCalls: 'lots' } } })).toThrow('shadowlap.config.json: tests["goldens/a"].expect.modelCalls must be a count');
    expect(() => parseTests({ 'goldens/a': { repeat: 3, passes: 4 } })).toThrow('passes must be a whole number from 1 to repeat (3)');
    expect(() => parseTests({ 'goldens/a': { fork: 'yes' } })).toThrow('fork must be true or false');
    expect(() => parseTests({ 'goldens/a': { expect: { output: 'done' } } })).toThrow('"includes" and/or "excludes"');
    expect(parseTests({ 'goldens/a': { expect: { tools: { send_email: 0, refund: { args: { id: 1 } } } } } })[0]!.spec).toEqual({
      fork: false,
      repeat: 1,
      passes: 1,
      tools: [
        { name: 'send_email', count: { min: 0, max: 0 } },
        { name: 'refund', count: { min: 1, max: Infinity }, args: { id: 1 } },
      ],
    });
  });

  it('reads a gate beside fork, in place of repeat and passes', () => {
    const where = 'shadowlap.config.json: tests["goldens/a"]';
    expect(parseTests({ 'goldens/a': { fork: true, gate: {}, expect: { tools: { send_email: 0 } } } })[0]!.spec).toEqual({
      fork: true,
      repeat: 1,
      passes: 1,
      gate: { kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 80 },
      tools: [{ name: 'send_email', count: { min: 0, max: 0 } }],
    });
    expect(parseTests({ 'goldens/a': { fork: true, gate: { baseline: 'history', drop: 0.2 } } })[0]!.spec.gate).toEqual({ kind: 'baseline', drop: 0.2, risk: 0.05, window: 10, min: 5, max: 40 });
    expect(() => parseTests({ 'goldens/a': { fork: true, repeat: 5, gate: {} } })).toThrow(`${where}: a gate decides how many attempts run and what passes; give the gate, or repeat and passes, not both`);
    expect(() => parseTests({ 'goldens/a': { fork: true, passes: 1, gate: {} } })).toThrow('give the gate, or repeat and passes, not both');
    expect(() => parseTests({ 'goldens/a': { gate: {} } })).toThrow(`${where}.gate needs "fork": true`);
    expect(() => parseTests({ 'goldens/a': { fork: true, gate: { good: 0.9, repeat: 3 } } })).toThrow(`${where}.gate has an unknown key "repeat" (expected "good", "bad", "risk", "max")`);
    expect(() => parseTests({ 'goldens/a': { fork: true, gate: { max: 4 } } })).toThrow(`${where}.gate: max (4) is fewer than the 12 attempts an agent that always passes needs`);
  });

  it('finds the entry for a recording: an exact path first, then a pattern in the last part', () => {
    const entries = parseTests({ 'goldens/*': { repeat: 2 }, 'goldens/refund': { repeat: 3 }, 'other/*-flow': { repeat: 4 } });
    const root = join(tmpdir(), 'project');
    expect(specFor(entries, join(root, 'goldens', 'refund'), root)?.repeat).toBe(3);
    expect(specFor(entries, join(root, 'goldens', 'triage') + '/', root)?.repeat).toBe(2);
    expect(specFor(entries, join(root, 'other', 'refund-flow'), root)?.repeat).toBe(4);
    expect(specFor(entries, join(root, 'other', 'refund'), root)).toBeNull();
    expect(specFor(entries, join(root, 'goldens', 'nested', 'x'), root)).toBeNull();
  });

  it('matches arguments partially in objects and exactly elsewhere', () => {
    expect(argsMatch({ to: 'a@b.c', subject: 'Hi', meta: { cc: ['x'], urgent: true } }, { to: 'a@b.c', meta: { urgent: true } })).toBe(true);
    expect(argsMatch({ to: 'a@b.c' }, { to: 'A@b.c' })).toBe(false);
    expect(argsMatch({ ids: [1, 2] }, { ids: [1] })).toBe(false);
    expect(argsMatch(null, { to: 'a' })).toBe(false);
  });

  it('evaluates tools, counts and text, and says what happened when a check fails', () => {
    const calls = [
      call(1, 'api', 'POST /v1/messages'),
      call(2, 'tool', 'search_web', 'replayed', { query: 'a' }),
      call(3, 'api', 'POST /v1/messages', 'live'),
      call(4, 'tool', 'send_email', 'blocked', { to: 'team@example.com' }),
      call(5, 'api', 'POST /v1/messages', 'live'),
    ];
    const [spec] = parseTests({
      x: {
        expect: {
          tools: { search_web: '>= 1', send_email: 0, refund: '>= 1' },
          modelCalls: '<= 2',
          toolCalls: 2,
          output: { includes: 'DONE', excludes: ['Traceback'] },
          answer: { includes: 'refund issued' },
        },
      },
    }).map((e) => e.spec);
    const results = evaluateChecks(spec!, { calls, output: 'done.\n', answer: 'I could not issue it.', argsOf: (c) => (c as { args?: unknown }).args, costOf: () => null });
    expect(results).toEqual([
      { ok: true, label: 'search_web called at least 1 time', detail: null },
      { ok: false, label: 'send_email called 0 times', detail: 'called 1 time (1 blocked or stubbed)' },
      { ok: false, label: 'refund called at least 1 time', detail: 'called 0 times; tools called: search_web, send_email' },
      { ok: false, label: 'at most 2 model calls', detail: '3 model calls' },
      { ok: true, label: '2 tool calls', detail: null },
      { ok: true, label: 'output includes "DONE"', detail: null },
      { ok: true, label: `output doesn't include "Traceback"`, detail: null },
      { ok: false, label: 'final answer includes "refund issued"', detail: 'not found in the final answer' },
    ]);
    const [withArgs] = parseTests({ x: { expect: { tools: { send_email: { count: 1, args: { to: 'ceo@example.com' } } } } } }).map((e) => e.spec);
    expect(evaluateChecks(withArgs!, { calls, output: '', answer: null, argsOf: (c) => (c as { args?: unknown }).args, costOf: () => null })[0]).toEqual({
      ok: false,
      label: 'send_email with {"to":"ceo@example.com"} called 1 time',
      detail: 'called 0 times; 1 call with other arguments',
    });
  });

  it('are kept when a command saves normalizers to the config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-config-'));
    writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify({ normalize: [], redact: [], tests: { 'goldens/a': { expect: { tools: { send_email: 0 } } } }, future: 1 }));
    saveConfig(dir, { normalize: [{ path: '$.system', replace: '<M>' }], redact: [] });
    const saved = JSON.parse(readFileSync(join(dir, 'shadowlap.config.json'), 'utf8'));
    expect(saved).toMatchObject({ normalize: [{ path: '$.system' }], future: 1, tests: { 'goldens/a': { expect: { tools: { send_email: 0 } } } } });
    expect(loadTests(dir)).toHaveLength(1);
  });
});

function apiCall(callNo: number, usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number }, model = 'claude-haiku-4-5'): CallRecord {
  return {
    runId: 'r', callNo, kind: 'api', name: 'POST /v1/messages', fingerprint: `f${callNo}`, occurrence: 1,
    origin: 'replayed', effect: null, requestRef: null, meta: {}, at: 0, attempts: [],
    end: { runId: 'r', callNo, attempt: 0, responseRef: null, outcome: 'ok', meta: { model, usage }, at: 1 },
  };
}
const budget = (expect_: Record<string, unknown>) => parseTests({ 'g': { expect: expect_ } })[0]!.spec;
const run = (spec: ReturnType<typeof budget>, calls: CallRecord[], costOf: (c: CallRecord) => number | null = () => null) =>
  evaluateChecks(spec, { calls, output: '', answer: null, argsOf: () => undefined, costOf });

describe('token and cost budgets', () => {
  it('reads amounts as numbers, comparisons and ranges, and tolerates a dollar sign', () => {
    expect(parseAmount(0.5, 'x')).toEqual({ min: 0.5, max: 0.5 });
    expect(parseAmount('<= 0.50', 'x')).toEqual({ min: 0, max: 0.5 });
    expect(parseAmount('$0.25', 'x')).toEqual({ min: 0.25, max: 0.25 });
    expect(parseAmount('>= 1', 'x')).toEqual({ min: 1, max: Infinity });
    expect(parseAmount('0.1-0.4', 'x')).toEqual({ min: 0.1, max: 0.4 });
    for (const bad of [-1, 'free', '0.4-0.1', null]) expect(() => parseAmount(bad, 'tests["a"].expect.cost')).toThrow(/must be an amount/);
  });

  it('counts input tokens across every model call, cache reads included', () => {
    // A cache read is input the request still carried: a budget is about what the run sends.
    const calls = [apiCall(1, { inputTokens: 100, outputTokens: 10 }), apiCall(2, { inputTokens: 50, outputTokens: 5, cacheReadInputTokens: 900 })];
    expect(run(budget({ inputTokens: '<= 2000' }), calls)[0]).toEqual({ ok: true, label: 'at most 2000 input tokens', detail: null });
    expect(run(budget({ inputTokens: '<= 1000' }), calls)[0]).toMatchObject({ ok: false, detail: '1050 input tokens' });
  });

  it('counts output tokens separately', () => {
    const calls = [apiCall(1, { inputTokens: 1, outputTokens: 40 })];
    expect(run(budget({ outputTokens: '<= 50' }), calls)[0]!.ok).toBe(true);
    expect(run(budget({ outputTokens: '<= 20' }), calls)[0]).toMatchObject({ ok: false, detail: '40 output tokens' });
  });

  it('measures cost from the price table and reports the overrun', () => {
    const calls = [apiCall(1, { inputTokens: 1000, outputTokens: 100 }), apiCall(2, { inputTokens: 1000, outputTokens: 100 })];
    const each = () => 0.3;
    expect(run(budget({ cost: '<= 1.00' }), calls, each)[0]).toEqual({ ok: true, label: 'cost at most $1.00', detail: null });
    expect(run(budget({ cost: '<= 0.50' }), calls, each)[0]).toMatchObject({ ok: false, label: 'cost at most $0.50' });
  });

  it('fails rather than passes when a model has no price', () => {
    // Treating an unknown price as zero would let any budget pass on an uncosted model.
    const calls = [apiCall(1, { inputTokens: 10, outputTokens: 1 }, 'some-local-model')];
    const result = run(budget({ cost: '<= 0.01' }), calls, () => null)[0]!;
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('no price for some-local-model');
  });

  it('ignores tool calls, and says a run has no checks when no budget is set', () => {
    const calls = [apiCall(1, { inputTokens: 10, outputTokens: 1 }), call(2, 'tool', 'search')];
    expect(run(budget({ inputTokens: '<= 10' }), calls)[0]!.ok).toBe(true);
    expect(run(budget({}), calls)).toEqual([]);
  });
});

describe('parseExpect', () => {
  it('reads an expect object on its own, and names its source in errors', () => {
    expect(parseExpect({ tools: { send_email: 0 }, answer: { includes: 'done' } }, '--expect')).toEqual({
      fork: true,
      repeat: 1,
      passes: 1,
      tools: [{ name: 'send_email', count: { min: 0, max: 0 } }],
      answer: { includes: ['done'], excludes: [] },
    });
    expect(() => parseExpect({ tools: { send_email: 'never' } }, '--expect')).toThrow('--expect.tools["send_email"] must be a count');
    expect(() => parseExpect([], '--expect')).toThrow('--expect must be an object');
    expect(() => parseExpect({ fork: true }, '--expect')).toThrow('--expect has an unknown key "fork"');
  });
});
