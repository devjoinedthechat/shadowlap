import { describe, expect, it } from 'vitest';
import { DEFAULT_CHAOS, NOT_PACKED, chaosIn, chaosJudge, chaosToolChoices, expectPrefill, gateWords, keptGate, keptPresetBound, nearestThen, parseExpect, presetBound, presetProof, presetRule, presetsGate, recordingRule, replayChaosSpec, Store, type CallRecord, type ChaosSpec } from '../src/index.js';
import { RunBuilder, text, toolUse, user } from './run-fixtures.js';

/** The presets' judge, their proof and the tools they can hit, and coverage's words: the engine's, which the CLI and the dashboard both read. */

function calls(build: (b: RunBuilder) => void): CallRecord[] {
  const store = Store.open(':memory:');
  const b = RunBuilder.start(store);
  build(b);
  const out = store.getCalls(b.end());
  store.close();
  return out;
}

const spec = (expect: Record<string, unknown>) => parseExpect(expect, 'expect');
const effects: Record<string, 'read' | 'write' | 'pure'> = { lookup_order: 'read', issue_refund: 'write' };
const effectOf = (name: string) => effects[name] ?? null;

describe("the presets' judge", () => {
  it('chaos.expect, else the write limits of the golden’s own expect, else the exit alone', () => {
    const golden = spec({ tools: { lookup_order: 1, issue_refund: '<= 1' } });
    const own = spec({ tools: { escalate: 0 } });
    expect(chaosJudge({ expect: own }, golden, effectOf).judge).toEqual({ source: 'chaos.expect', checks: ['escalate called 0 times'] });
    expect(chaosJudge({ expect: own, expectFrom: '--expect' }, golden, effectOf).judge.source).toBe('--expect');
    const limits = chaosJudge({ expect: null }, golden, effectOf);
    expect(limits.judge).toEqual({ source: 'write-limits', checks: ['issue_refund called at most 1 time'] });
    expect(limits.checks?.tools.map((t) => t.name)).toEqual(['issue_refund']);
    expect(chaosJudge({ expect: null }, spec({ tools: { lookup_order: 1 } }), effectOf)).toEqual({ checks: null, judge: { source: 'exit', checks: [] } });
  });

  it("replay --chaos: --expect judges the defaults, a golden's entry its own presets, and \"chaos\": false the defaults by its write limits", () => {
    const golden = spec({ tools: { issue_refund: 1 } });
    const own: ChaosSpec = { ...DEFAULT_CHAOS, presets: ['timeout'], tool: 'lookup_order' };
    expect(replayChaosSpec({ spec: golden, source: '--expect' }, () => own)).toEqual({ chaos: { ...DEFAULT_CHAOS, expect: golden, expectFrom: '--expect' }, golden: null });
    expect(replayChaosSpec({ spec: golden, source: 'goldens/refund' }, (folder) => (folder === 'goldens/refund' ? own : false))).toEqual({ chaos: own, golden });
    expect(replayChaosSpec({ spec: golden, source: 'goldens/refund' }, () => false)).toEqual({ chaos: DEFAULT_CHAOS, golden });
    expect(replayChaosSpec(null, () => own)).toEqual({ chaos: DEFAULT_CHAOS, golden: null });
  });
});

describe("the presets' gate, rule and bound", () => {
  const sprt = { good: 0.9, bad: 0.7, risk: 0.05, max: 20 };

  it('reads a kept gate back, and words it', () => {
    expect(keptGate({ ...sprt, kind: 'x' })).toEqual(sprt);
    expect(keptGate({ repeat: 3, passes: 2 })).toEqual({ repeat: 3, passes: 2 });
    expect(keptGate({ repeat: '3' })).toBeNull();
    expect(keptGate(null)).toBeNull();
    expect(gateWords(sprt)).toBe('tells 90%+ from 70%- at <= 5% risk, up to 20 attempts');
    expect(gateWords({ repeat: 3, passes: 2 })).toBe('2 of 3 attempts must pass');
  });

  it('states a sequential gate once, never for a fixed count, no attempt or a reason of its own', () => {
    const o = { attempts: 6, gate: sprt, verdict: 'passed', reason: null };
    expect(presetRule(o)).toBe('gate: tells 90%+ from 70%- at <= 5% risk, up to 20 attempts');
    expect(presetRule({ ...o, gate: { repeat: 1, passes: 1 } })).toBeNull();
    expect(presetRule({ ...o, attempts: 0 })).toBeNull();
    expect(presetRule({ ...o, verdict: 'inconclusive', reason: 'the replay never reached #4, so the preset was never played in' })).toBeNull();
    expect(recordingRule([{ ...o, attempts: 0 }, o])).toBe(presetRule(o));
  });

  it("bounds a tally as the CLI printed it, a kept result's read back the same way", () => {
    const bound = presetBound(sprt, { passes: 6, attempts: 6 }, 'pass');
    expect(bound).toMatch(/^rate >= 0\.\d+ \(95%\)$/);
    expect(keptPresetBound({ attempts: 6, passes: 6, gate: sprt, verdict: 'passed', reason: null })).toBe(bound);
    expect(keptPresetBound({ attempts: 6, passes: 1, gate: sprt, verdict: 'failed', reason: 'issue_refund called 2 times' })).toBe(presetBound(sprt, { passes: 1, attempts: 6 }, 'fail'));
    // Cut short by the provider: counted against either verdict, so the bound widens.
    expect(keptPresetBound({ attempts: 6, passes: 4, gate: sprt, verdict: 'inconclusive', reason: null, cutShort: 2 })).toBe(presetBound(sprt, { passes: 4, attempts: 6 }, 'inconclusive', 2));
    expect(presetBound(sprt, { passes: 4, attempts: 6 }, 'inconclusive', 2)).not.toBe(presetBound(sprt, { passes: 4, attempts: 6 }, 'inconclusive'));
    expect(presetBound(sprt, { passes: 1, attempts: 1 }, 'pass')).toBeNull();
    expect(presetBound({ repeat: 3, passes: 3 }, { passes: 3, attempts: 3 }, 'pass')).toBeNull();
    expect(keptPresetBound({ attempts: 2, passes: 0, gate: sprt, verdict: 'inconclusive', reason: 'the replay never reached #4, so the preset was never played in' })).toBeNull();
  });
});

describe("what the dialog reads of a golden's entry and a run's checks", () => {
  it('decides by chaos.gate, else the golden repeating, else one attempt; and reads chaos from the tests as written', () => {
    const gate = { kind: 'sprt' as const, good: 0.9, bad: 0.7, risk: 0.05, max: 20 };
    expect(presetsGate({ gate }, null)).toEqual({ good: 0.9, bad: 0.7, risk: 0.05, max: 20 });
    expect(presetsGate({ gate: null }, spec({ tools: {} }))).toEqual({ repeat: 1, passes: 1 });
    expect(presetsGate({ gate: null }, { ...spec({ tools: {} }), repeat: 3, passes: 2 })).toEqual({ repeat: 3, passes: 2 });
    expect(presetsGate({ gate: null }, null)).toEqual({ repeat: 1, passes: 1 });
    const tests = { 'goldens/a': { chaos: { presets: ['429'] } }, 'goldens/b': { chaos: false } };
    expect(chaosIn(tests, 'goldens/a')).toMatchObject({ presets: ['429'] });
    expect(chaosIn(tests, 'goldens/b')).toBe(false);
    expect(chaosIn(tests, 'goldens/c')).toEqual(DEFAULT_CHAOS);
    expect(chaosIn(tests, null)).toEqual(DEFAULT_CHAOS);
  });

  it("prefills the write limit a run's own failed check set, never one that held or a read's", () => {
    const refunded = [{ kind: 'tool' as const, name: 'lookup_order' }, { kind: 'tool' as const, name: 'issue_refund' }, { kind: 'tool' as const, name: 'issue_refund' }];
    expect(expectPrefill(spec({ tools: { issue_refund: '<= 1' } }), refunded, effectOf)).toBe('{"tools":{"issue_refund":"<= 1"}}');
    expect(expectPrefill(spec({ tools: { issue_refund: '<= 2' } }), refunded, effectOf)).toBeNull();
    expect(expectPrefill(spec({ tools: { lookup_order: 0 } }), refunded, effectOf)).toBeNull();
    expect(expectPrefill(null, refunded, effectOf)).toBeNull();
  });
});

describe("a recording's newest presets", () => {
  it('reads one run alone through its index, the same rows as the whole table holds for it', () => {
    const store = Store.open(':memory:');
    const s = store.startChaosSession({ command: ['shadowlap', 'replay', 'r1', '--chaos'], presets: ['timeout'], owner: null });
    const add = (runId: string, at: number, verdict: 'passed' | 'failed') => store.addChaosResult({ sessionId: s.sessionId, runId, preset: 'timeout', verdict, at });
    add('r1', 1, 'failed');
    add('r1', 2, 'passed');
    add('r2', 3, 'failed');
    expect(store.latestChaosResults('r1').map((r) => [r.runId, r.verdict])).toEqual([['r1', 'passed']]);
    expect(store.latestChaosResults().filter((r) => r.runId === 'r1')).toEqual(store.latestChaosResults('r1'));
    expect(store.latestChaosResults('r3')).toEqual([]);
    store.close();
  });
});

describe("the presets' proof", () => {
  const cell = (verdict: string, runs: Array<[string, string]>) => ({ verdict, callNo: 4, runs: runs.map(([runId, v]) => ({ runId, verdict: v })) });

  it('the first kept attempt that failed, in the first preset that failed with one kept', () => {
    const cells = [cell('passed', [['a', 'passed']]), cell('failed', [['gone', 'failed']]), cell('failed', [['b', 'passed'], ['c', 'inconclusive'], ['d', 'failed']])];
    const kept = (id: string) => id !== 'gone';
    expect(presetProof(cells, kept)).toEqual({ cell: cells[2], attempt: { runId: 'd', verdict: 'failed' } });
    expect(presetProof([cell('failed', [['b', 'passed'], ['c', 'inconclusive']])], kept)?.attempt.runId).toBe('c');
    expect(presetProof([cell('inconclusive', [['c', 'failed']])], kept)).toBeNull();
  });
});

describe('the tools the tool presets can hit', () => {
  it('each tool at its first answered call the agent reads, pure tools, typed input and failures left out', () => {
    const c = calls((b) => {
      b.model({ messages: [user('go')] }, [toolUse('get_units', {}, 'a')]);
      b.tool('get_units', {}, { units: 'c' }, { effect: 'pure' });
      b.tool('ask_user', {}, { text: 'yes' }, { meta: { input: true } });
      b.tool('lookup_order', {}, null, { error: 'not found' });
      b.tool('lookup_order', { id: 2 }, { amount: 40 });
      b.tool('issue_refund', {}, { ok: true }, { effect: 'write' });
      b.tool('lookup_order', { id: 3 }, { amount: 41 });
      b.model({ messages: [user('go')] }, [text('done')]);
    });
    expect(chaosToolChoices(c).map(({ name, callNo }) => `${name} #${callNo}`)).toEqual(['lookup_order #5', 'issue_refund #6']);
  });
});

describe("coverage's words", () => {
  it('where a behaviour parts from its nearest golden, each name as its reader shows it', () => {
    expect(nearestThen({ step: 3, seen: 'get_policy', golden: 'lookup_customer' })).toBe('then it calls get_policy where the golden calls lookup_customer');
    expect(nearestThen({ step: 3, seen: 'get_policy', golden: null }, (s) => `<${s}>`)).toBe('then it calls <get_policy> where the golden has stopped');
    expect(nearestThen({ step: 3, seen: null, golden: 'lookup_customer' })).toBe('then it stops where the golden calls lookup_customer');
    expect(nearestThen(null)).toBeNull();
    expect(NOT_PACKED['not-reproduced']).toBe('the agent no longer does this (--fork with --expect keeps it as a golden that forks)');
  });
});
