import { describe, expect, it } from 'vitest';
import { callNeedsCalls, captureVerdict, captureVerdictLine, checkCallAt, familyGoldens, familyRoot, familySpecs, judgeByFamily, judgeCapture, judgeRecording, keptCaptureVerdict, parseTests, rulesOnCalls, Store, storeParents, type RunRecord } from '../src/index.js';
import { RunBuilder, text, toolUse, usage, user } from './run-fixtures.js';

/**
 * Runs judged by checks they were not given (family-checks.ts): a run that kept no verdict of its own
 * by its family's goldens' checks, from its recording, as `shadowlap check` judges one; a capture by
 * the project's rules on calls, kept with the rules it was judged by and judged again once they change.
 */

const ASK = [user('Order A-1042 arrived damaged. Refund it, please.')];
const DIR = '/work/project';

/** A refund run: the order looked up, then refunded for `amount`, and an email sent `emails` times. */
function refund(store: Store, o: { amount: number; emails?: number; parent?: string; meta?: RunRecord['meta'] } = { amount: 200 }): string {
  const b = RunBuilder.start(store, { ...(o.parent ? { parent: o.parent } : {}), ...(o.meta ? { meta: o.meta } : {}) });
  b.model({ messages: ASK }, [toolUse('lookup_order', { order_id: 'A-1042' }, 'toolu_1')], { usage: usage(120) });
  b.tool('lookup_order', { order_id: 'A-1042' }, { order_id: 'A-1042', total: 240 });
  b.model({ messages: ASK }, [toolUse('issue_refund', { order_id: 'A-1042', amount: o.amount }, 'toolu_2')], { usage: usage(160) });
  b.tool('issue_refund', { order_id: 'A-1042', amount: o.amount }, { refund_id: 'R-5401' }, { effect: 'write' });
  for (let i = 0; i < (o.emails ?? 1); i++) b.tool('send_email', { to: 'ada@example.com' }, { sent: true }, { effect: 'write' });
  b.model({ messages: ASK }, [text('Refund issued for order A-1042.')], { usage: usage(200) });
  return b.end();
}

const WITHIN_TOTAL = { tool: 'issue_refund', after: 'lookup_order', args: { amount: { '<=': '@lookup_order.result.total' } } };
const run = (store: Store, id: string) => store.getRun(id)!;

describe("a run's family", () => {
  it('is its recording and every replay and fork of it, and its goldens those packed from any of them or that it replays', () => {
    const store = Store.open(':memory:');
    const rec = refund(store);
    const fork = refund(store, { amount: 300, parent: rec });
    const forkOfFork = refund(store, { amount: 300, parent: fork });
    const other = refund(store);
    // A golden's pack holds a run of the family; another, a run the store doesn't have; a test replays a third by its folder.
    const unpacked = refund(store, { amount: 200, meta: { imported: { at: 1, from: 'goldens/unpacked' } } });
    const test = refund(store, { amount: 200, parent: unpacked, meta: { test: { golden: 'goldens/unpacked', session: 's1' } } });
    const goldens = [
      { path: 'goldens/from-fork', runId: fork },
      { path: 'goldens/refund', runId: rec },
      { path: 'goldens/elsewhere', runId: '01K8RG00000000000000000099' },
      { path: 'goldens/unpacked', runId: unpacked },
    ];
    const parents = storeParents(store);
    expect(familyRoot(forkOfFork, parents)).toBe(rec);
    expect(familyRoot('01K8RG00000000000000000099', parents)).toBeNull();
    const paths = (id: string) => familyGoldens(store, run(store, id), goldens, DIR).map((g) => g.path);
    expect(paths(forkOfFork)).toEqual(['goldens/from-fork', 'goldens/refund']);
    expect(paths(rec)).toEqual(['goldens/from-fork', 'goldens/refund']);
    expect(paths(other)).toEqual([]);
    // The golden a test replays comes first, as recordingsOfRun names it, nearest first.
    expect(paths(test)).toEqual(['goldens/unpacked']);
    store.close();
  });

  it("takes each golden's checks from its entry under tests, a pattern's too, and leaves out a golden with none", () => {
    const entries = parseTests({ 'goldens/refund': { expect: { calls: [WITHIN_TOTAL] } }, 'goldens/quiet': {}, 'goldens/email-*': { expect: { tools: { send_email: '<= 1' } } } });
    const specs = familySpecs(entries, [{ path: 'goldens/refund', runId: null }, { path: 'goldens/quiet', runId: null }, { path: 'goldens/email-twice', runId: null }], DIR);
    expect(specs.map((s) => s.golden)).toEqual(['goldens/refund', 'goldens/email-twice']);
  });
});

describe('a run judged by its family’s checks', () => {
  const entries = parseTests({
    'goldens/refund': { expect: { calls: [WITHIN_TOTAL], tools: { send_email: '<= 1' } } },
    // The same rule again, and a judge no recording answered.
    'goldens/again': { expect: { calls: [WITHIN_TOTAL], judge: [{ name: 'polite', question: 'Is the answer polite?', model: 'claude-haiku-4-5' }] } },
  });

  it('fails at the call the first failed check names, each check judged once, by the nearest golden that has it', () => {
    const store = Store.open(':memory:');
    const rec = refund(store);
    const fork = refund(store, { amount: 300, emails: 2, parent: rec });
    const specs = familySpecs(entries, [{ path: 'goldens/refund', runId: rec }, { path: 'goldens/again', runId: rec }], DIR);
    const judged = judgeByFamily(store, run(store, fork), store.getCalls(fork), specs)!;
    expect(judged.verdict).toBe('failed');
    expect(judged.goldens).toEqual(['goldens/refund', 'goldens/again']);
    expect(judged.checks.map((c) => [c.label, c.status, c.golden, c.callNo])).toEqual([
      ['send_email called at most 1 time', 'failed', 'goldens/refund', 6],
      ['every issue_refund call: after lookup_order, amount <= lookup_order.result.total', 'failed', 'goldens/refund', 4],
      ['judge "polite" answers yes', 'inconclusive', 'goldens/again', null],
    ]);
    expect(judged.checks[2]?.detail).toBe('not judged: no recorded verdict');
    // The first failed check's call: the second email, one past what the count allows.
    expect(judged.callNo).toBe(6);
    store.close();
  });

  it('passes a run that holds to them, inconclusive while a judge has no verdict, and says nothing with no checks', () => {
    const store = Store.open(':memory:');
    const rec = refund(store);
    const one = familySpecs(entries, [{ path: 'goldens/refund', runId: rec }], DIR);
    expect(judgeByFamily(store, run(store, rec), store.getCalls(rec), one)).toMatchObject({ verdict: 'passed', callNo: null });
    const both = familySpecs(entries, [{ path: 'goldens/refund', runId: rec }, { path: 'goldens/again', runId: rec }], DIR);
    expect(judgeByFamily(store, run(store, rec), store.getCalls(rec), both)?.verdict).toBe('inconclusive');
    expect(judgeByFamily(store, run(store, rec), store.getCalls(rec), [])).toBeNull();
    store.close();
  });

  it('holds a check on what the agent printed inconclusive, under a when too, and says what shadowlap check says', () => {
    const store = Store.open(':memory:');
    const rec = refund(store);
    const printed = parseTests({
      'goldens/refund': { expect: { tools: { send_email: '<= 1' }, output: { includes: 'Refund issued' } } },
      // Its condition held at the lookup (total 240): the output check under it can't be decided either.
      'goldens/large': { expect: { when: [{ if: { tool: 'lookup_order', result: { total: { '>': 200 } } }, then: { output: { excludes: 'error' } } }] } },
      // A golden whose only check reads the output.
      'goldens/said': { expect: { output: { includes: 'A-1042' } } },
    });
    const goldens = ['goldens/refund', 'goldens/large', 'goldens/said'].map((path) => ({ path, runId: rec }));
    const specs = familySpecs(printed, goldens, DIR);
    const judged = judgeByFamily(store, run(store, rec), store.getCalls(rec), specs)!;
    expect(judged.verdict).toBe('inconclusive');
    expect(judged.checks.map((c) => [c.label, c.status, c.detail])).toEqual([
      ['send_email called at most 1 time', 'passed', null],
      ['output includes "Refund issued"', 'inconclusive', 'a recording keeps no output'],
      ['when lookup_order has result.total > 200: output doesn\'t include "error"', 'inconclusive', 'a recording keeps no output'],
      ['output includes "A-1042"', 'inconclusive', 'a recording keeps no output'],
    ]);
    expect(judged.unsettled).toEqual([]);
    // shadowlap check calls each of these recordings inconclusive too.
    for (const { spec } of specs) expect(judgeRecording(store, run(store, rec), store.getCalls(rec), spec).passed).toBeNull();
    // A condition that never held: the check under it doesn't apply, but check still can't settle a spec that reads the output.
    const never = familySpecs(parseTests({ 'goldens/refund': { expect: { tools: { send_email: '<= 1' }, when: [{ if: { tool: 'escalate' }, then: { output: { includes: 'escalated' } } }] } } }), [{ path: 'goldens/refund', runId: rec }], DIR);
    expect(judgeByFamily(store, run(store, rec), store.getCalls(rec), never)).toMatchObject({
      verdict: 'inconclusive',
      unsettled: ["a check reads what the agent printed, which a recording doesn't keep"],
      checks: [{ status: 'passed' }, { status: 'not-applicable', detail: 'the condition never held: escalate was never called' }],
    });
    expect(judgeRecording(store, run(store, rec), store.getCalls(rec), never[0]!.spec).passed).toBeNull();
    // A failure still fails it.
    const over = refund(store, { amount: 200, emails: 2, parent: rec });
    expect(judgeByFamily(store, run(store, over), store.getCalls(over), specs)).toMatchObject({ verdict: 'failed', callNo: 6 });
    store.close();
  });
});

describe('the call a failed check turned on', () => {
  it('is the call its detail names, else the first call past what a count allows', () => {
    const store = Store.open(':memory:');
    const id = refund(store, { amount: 300, emails: 3 });
    const calls = store.getCalls(id);
    const argsOf = (c: (typeof calls)[number]) => store.getJson<{ args?: unknown }>(c.requestRef!)?.args;
    expect(checkCallAt({ label: 'every issue_refund call: after lookup_order', detail: 'issue_refund #4: amount 300 > lookup_order.result.total 240 (#2)' }, calls)).toBe(4);
    // A call the detail names that the run doesn't have is no call.
    expect(checkCallAt({ label: 'every issue_refund call: after lookup_order', detail: 'issue_refund #40: no lookup_order call before it' }, calls)).toBeNull();
    expect(checkCallAt({ label: 'send_email called at most 1 time', detail: 'called 3 times' }, calls)).toBe(6);
    expect(checkCallAt({ label: 'send_email called 0 times', detail: 'called 3 times' }, calls)).toBe(5);
    expect(checkCallAt({ label: 'send_email with {"to":"ada@example.com"} called 1 time', detail: 'called 3 times' }, calls, argsOf)).toBe(6);
    expect(checkCallAt({ label: 'send_email called at least 4 times', detail: 'called 3 times' }, calls)).toBeNull();
    expect(checkCallAt({ label: 'at most 2 model calls', detail: '3 model calls' }, calls)).toBe(8);
    expect(checkCallAt({ label: 'when lookup_order has result.total > 200: send_email called at most 2 times', detail: 'called 3 times; the condition held at lookup_order #2 (result.total 240 > 200)' }, calls)).toBe(7);
    // Without the run's calls, only the call its detail names.
    expect(checkCallAt({ label: 'every issue_refund call: after lookup_order', detail: 'issue_refund #4: amount 300 > 240' }, null)).toBe(4);
    expect(checkCallAt({ label: 'send_email called at most 1 time', detail: 'called 3 times' }, null)).toBeNull();
    // Only a count whose detail names no call needs the run's calls to tell it.
    expect(callNeedsCalls({ label: 'send_email called at most 1 time', detail: 'called 3 times' })).toBe(true);
    expect(callNeedsCalls({ label: 'when lookup_order has result.total > 200: at most 2 model calls', detail: '3 model calls; the condition held at lookup_order #2' })).toBe(true);
    expect(callNeedsCalls({ label: 'every issue_refund call: after lookup_order', detail: 'issue_refund #4: amount 300 > 240' })).toBe(false);
    expect(callNeedsCalls({ label: 'send_email called at least 4 times', detail: 'called 3 times' })).toBe(false);
    expect(callNeedsCalls({ label: 'cost at most $0.05', detail: 'cost ≈ $0.071' })).toBe(false);
    store.close();
  });
});

describe('a capture judged by the rules on calls', () => {
  const config = (calls: unknown[]) => parseTests({ 'goldens/refund': { expect: { calls, tools: { send_email: 0 } } }, 'goldens/other': { expect: { calls: [WITHIN_TOTAL] } } });

  it('reads every calls rule in any golden’s expect once, and nothing else of them', () => {
    const rules = rulesOnCalls(config([WITHIN_TOTAL, { tool: 'send_email', after: 'issue_refund' }]));
    expect(rules.rules.map((r) => r.tool)).toEqual(['issue_refund', 'send_email']);
    expect(rulesOnCalls(config([WITHIN_TOTAL])).key).not.toBe(rules.key);
    expect(rulesOnCalls(config([WITHIN_TOTAL, { tool: 'send_email', after: 'issue_refund' }])).key).toBe(rules.key);
    expect(rulesOnCalls(parseTests({ 'goldens/refund': { expect: { tools: { send_email: 0 } } } })).rules).toEqual([]);
  });

  it('passes, fails on the first rule broken, and does not apply where no rule had a call to read', () => {
    const store = Store.open(':memory:');
    const rules = rulesOnCalls(config([WITHIN_TOTAL, { tool: 'escalate', after: 'lookup_order' }]));
    const ok = refund(store);
    const over = refund(store, { amount: 300 });
    const passed = judgeCapture(store, store.getCalls(ok), rules, 5)!;
    expect(passed).toEqual({
      rules: rules.key,
      at: 5,
      verdict: 'passed',
      why: null,
      checks: [
        { status: 'passed', ok: true, label: 'every issue_refund call: after lookup_order, amount <= lookup_order.result.total', detail: null },
        { status: 'not-applicable', ok: true, label: 'every escalate call: after lookup_order', detail: 'escalate was never called' },
      ],
    });
    expect(captureVerdictLine(passed)).toBe('✓ judged by the rules on calls in shadowlap.config.json · 1 check passed, 1 not applicable');
    const failed = judgeCapture(store, store.getCalls(over), rules)!;
    expect(failed.verdict).toBe('failed');
    expect(captureVerdictLine(failed)).toBe('✗ judged by the rules on calls in shadowlap.config.json · check failed: every issue_refund call: after lookup_order, amount <= lookup_order.result.total, but issue_refund #4: amount 300 > lookup_order.result.total 240 (#2)');
    // A capture of the model calls alone holds no tool calls, which every rule reads.
    const b = RunBuilder.start(store, { meta: { covers: ['api'] } });
    b.model({ messages: ASK }, [text('Refund issued.')]);
    const models = b.end();
    const na = judgeCapture(store, store.getCalls(models), rules)!;
    expect(na).toMatchObject({ verdict: 'not-applicable', why: 'it holds no tool calls, and every rule reads them' });
    expect(captureVerdictLine(na)).toBe('– judged by the rules on calls in shadowlap.config.json · not applicable: it holds no tool calls, and every rule reads them');
    expect(judgeCapture(store, store.getCalls(ok), rulesOnCalls([]))).toBeNull();
    store.close();
  });

  it('keeps its verdict while the rules stay, and is judged again once they change', () => {
    const store = Store.open(':memory:');
    const id = refund(store, { amount: 300 });
    const only = (rule: unknown) => parseTests({ 'goldens/refund': { expect: { calls: [rule] } } });
    const before = rulesOnCalls(only({ tool: 'issue_refund', after: 'lookup_order' }));
    store.updateRunMeta(id, { judged: judgeCapture(store, store.getCalls(id), before, 7)! });
    const kept = keptCaptureVerdict(run(store, id))!;
    expect(kept).toMatchObject({ rules: before.key, at: 7, verdict: 'passed' });
    let read = 0;
    const calls = () => (read++, store.getCalls(id));
    expect(captureVerdict(store, run(store, id), before, calls)).toMatchObject({ verdict: 'passed', again: false });
    expect(read).toBe(0);
    const after = rulesOnCalls(only(WITHIN_TOTAL));
    expect(captureVerdict(store, run(store, id), after, calls)).toMatchObject({ verdict: 'failed', again: true, rules: after.key });
    expect(read).toBe(1);
    // With no rule left to judge it by, it has no verdict, and nothing of it is read.
    expect(captureVerdict(store, run(store, id), rulesOnCalls([]), calls)).toBeNull();
    expect(read).toBe(1);
    // What a pack can carry is read field by field.
    expect(keptCaptureVerdict({ meta: { judged: { rules: 1, verdict: 'passed', checks: [] } } } as unknown as RunRecord)).toBeNull();
    store.close();
  });
});
