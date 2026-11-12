import { describe, expect, it } from 'vitest';
import { DEFAULT_CHAOS, NOT_PACKED, chaosJudge, chaosToolChoices, nearestThen, parseExpect, presetProof, replayChaosSpec, Store, type CallRecord, type ChaosSpec } from '../src/index.js';
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
