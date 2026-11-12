import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { checkLabels, checkLine, evaluateChecks, LABEL_INPUT, notJudgedWhy, parseExpect, parseTests, Store, storedCheckInput, type JudgeCheck, readsMoreThanAStep } from '../src/index.js';
import type * as labels from '../src/checks/labels.js';
import { NEVER_HELD, notApplicableParts } from '../src/checks/labels.js';
import { RunBuilder, text, toolUse, usage, user } from './run-fixtures.js';

// Outcome checks live in the engine (src/checks/), so the CLI, the dashboard's server and its pages
// read, label and judge a check one way. The CLI's own tests hold their words, through the CLI's
// checks.ts, which re-exports these; here they are held where the dashboard takes them from.

/** A refund run as the sidecar records it: the order looked up, then refunded for more than its total. */
function refundRun(store: Store): string {
  const b = RunBuilder.start(store);
  const ask = [user('Order A-1042 arrived damaged. Refund it, please.')];
  b.model({ messages: ask }, [toolUse('lookup_order', { order_id: 'A-1042' }, 'toolu_1')], { usage: usage(120) });
  b.tool('lookup_order', { order_id: 'A-1042' }, { order_id: 'A-1042', total: 240 });
  b.model({ messages: ask }, [toolUse('issue_refund', { order_id: 'A-1042', amount: 300 }, 'toolu_2')], { usage: usage(160) });
  b.tool('issue_refund', { order_id: 'A-1042', amount: 300 }, { refund_id: 'R-5401', status: 'issued' }, { effect: 'write' });
  b.model({ messages: ask }, [text('Refund issued for order A-1042.')], { usage: usage(200) });
  return b.end();
}

/** An expect with every kind of check, a `when` rule's checks of each kind under its condition included. */
const EVERY_KIND = {
  tools: { send_email: 0, issue_refund: { count: '>= 1', args: { order_id: 'A-1042' } } },
  modelCalls: '<= 12',
  toolCalls: '2-4',
  inputTokens: '<= 60000',
  outputTokens: '>= 100',
  cost: '<= 0.50',
  output: { includes: ['refund issued'] },
  answer: { includes: ['A-1042'], excludes: ['cannot help'] },
  calls: [{ tool: 'issue_refund', after: 'lookup_order', args: { amount: { '<=': '@lookup_order.result.total' } } }],
  when: [
    {
      if: { tool: 'lookup_order', result: { total: { '>': 200 } } },
      then: { tools: { escalate: '>= 1' }, outputTokens: '<= 800', cost: '<= 0.20', answer: { excludes: ['refunded'] }, calls: [{ tool: 'escalate', after: 'lookup_order' }], judge: [{ name: 'says-escalated', question: 'Does the answer say it was escalated?', model: 'claude-haiku-4-5' }] },
    },
    { if: { tool: 'escalate' }, then: { tools: { send_email: '<= 1' } } },
  ],
  judge: [{ name: 'explains-refund', question: 'Does the answer say what was refunded?', model: 'claude-haiku-4-5', pass: 'no' }],
};

/** What the CLI calls each of them, in the order it reports them. */
const EVERY_LABEL = [
  'send_email called 0 times',
  'issue_refund with {"order_id":"A-1042"} called at least 1 time',
  'at most 12 model calls',
  '2 to 4 tool calls',
  'at most 60000 input tokens',
  'at least 100 output tokens',
  'cost at most $0.50',
  'output includes "refund issued"',
  'final answer includes "A-1042"',
  'final answer doesn\'t include "cannot help"',
  'every issue_refund call: after lookup_order, amount <= lookup_order.result.total',
  'when lookup_order has result.total > 200: escalate called at least 1 time',
  'when lookup_order has result.total > 200: at most 800 output tokens',
  'when lookup_order has result.total > 200: cost at most $0.20',
  'when lookup_order has result.total > 200: final answer doesn\'t include "refunded"',
  'when lookup_order has result.total > 200: every escalate call: after lookup_order',
  'when lookup_order has result.total > 200: judge "says-escalated" answers yes',
  'when escalate is called: send_email called at most 1 time',
  'judge "explains-refund" answers no',
];

describe('a check’s label', () => {
  it('is what evaluateChecks reports it as, in its order, whatever the run did', () => {
    const spec = parseExpect(EVERY_KIND, '--expect');
    expect(checkLabels(spec)).toEqual(EVERY_LABEL);
    expect(evaluateChecks(spec, LABEL_INPUT).map((r) => r.label)).toEqual(EVERY_LABEL);
    // Judged on a run, where one condition held and the other never did, every status comes up and the labels stay the same.
    const store = Store.open(':memory:');
    const runId = refundRun(store);
    const results = evaluateChecks(spec, storedCheckInput(store, store.getCalls(runId), 'Refund issued.'));
    expect(results.map((r) => r.label)).toEqual(EVERY_LABEL);
    expect(new Set(results.map((r) => r.status))).toEqual(new Set(['passed', 'failed', 'inconclusive', 'not-applicable']));
    store.close();
  });
});

describe('a run judged by its checks in the engine', () => {
  it('reads what the run recorded, values from earlier calls included, in the words the CLI prints', () => {
    const store = Store.open(':memory:');
    const runId = refundRun(store);
    const spec = parseExpect(
      {
        tools: { issue_refund: 1, send_email: 0 },
        modelCalls: '<= 3',
        answer: { includes: ['refund issued'] },
        calls: [{ tool: 'issue_refund', after: 'lookup_order', args: { amount: { '<=': '@lookup_order.result.total' } } }],
        when: [{ if: { tool: 'lookup_order', result: { total: { '>': 200 } } }, then: { tools: { escalate: '>= 1' } } }],
      },
      '--expect',
    );
    const results = evaluateChecks(spec, storedCheckInput(store, store.getCalls(runId), ''));
    expect(results.map((r) => checkLine(r))).toEqual([
      '✓ issue_refund called 1 time',
      '✓ send_email called 0 times',
      '✓ at most 3 model calls',
      '✓ final answer includes "refund issued"',
      '✗ every issue_refund call: after lookup_order, amount <= lookup_order.result.total: issue_refund #4: amount 300 > lookup_order.result.total 240 (#2)',
      '✗ when lookup_order has result.total > 200: escalate called at least 1 time: called 0 times; tools called: lookup_order, issue_refund; the condition held at lookup_order #2 (result.total 240 > 200)',
    ]);
    store.close();
  });

  it('says why a check under a condition that never held didn’t apply, then what the calls had instead, which a page splits by the engine’s rule', () => {
    const store = Store.open(':memory:');
    const runId = refundRun(store);
    const spec = parseExpect({ when: [{ if: { tool: 'lookup_order', result: { total: { '>': 500 } } }, then: { tools: { escalate: '>= 1' } } }] }, '--expect');
    const [skipped] = evaluateChecks(spec, storedCheckInput(store, store.getCalls(runId), ''));
    expect(skipped).toMatchObject({ status: 'not-applicable', ok: true });
    const parts = notApplicableParts(skipped.detail!);
    expect(parts.why).toBe(NEVER_HELD);
    expect(parts.values).toMatch(/^lookup_order #2: result\.total 240/);
    expect(`${parts.why}: ${parts.values!}`).toBe(skipped.detail);
    // A detail that says only why is all why.
    expect(notApplicableParts(NEVER_HELD)).toEqual({ why: NEVER_HELD, values: null });
    store.close();
  });

  it('asks no judge: a judge check with no verdict is inconclusive, never passed', () => {
    const store = Store.open(':memory:');
    const runId = refundRun(store);
    const spec = parseExpect({ judge: [{ name: 'explains-refund', question: 'Does the answer say what was refunded?', model: 'claude-haiku-4-5' }] }, '--expect');
    const judge = spec.judge![0];
    const missing = (j: JudgeCheck) => notJudgedWhy(j, {});
    const [unjudged] = evaluateChecks(spec, storedCheckInput(store, store.getCalls(runId), ''), { judgeMissing: missing });
    expect(unjudged).toMatchObject({ status: 'inconclusive', ok: false, judge: { name: 'explains-refund', verdict: null, source: null } });
    expect(checkLine(unjudged)).toBe('? judge "explains-refund" answers yes: inconclusive · not judged: no recorded verdict and no key for anthropic');
    expect(notJudgedWhy(judge, { ANTHROPIC_API_KEY: 'test-key' })).toBe('not judged: no recorded verdict');
    // A verdict the recording holds decides it, and says where it came from.
    const verdicts = new Map([['explains-refund', { verdict: 'yes' as const, reason: 'It names order A-1042.', source: 'recording' as const }]]);
    const [judged] = evaluateChecks(spec, storedCheckInput(store, store.getCalls(runId), ''), { judgeVerdicts: verdicts });
    expect(checkLine(judged)).toBe('✓ judge "explains-refund" answers yes · It names order A-1042. (judged from the recording, free)');
    store.close();
  });

  it('reads a tests entry in the config with its checks, its runs and its error-path presets', () => {
    const [entry] = parseTests({ 'goldens/refund-*': { fork: true, repeat: 3, passes: 2, expect: { tools: { issue_refund: '<= 1' } }, chaos: { presets: ['timeout'] } } });
    expect(entry).toMatchObject({ recording: 'goldens/refund-*', spec: { fork: true, repeat: 3, passes: 2, tools: [{ name: 'issue_refund', count: { min: 0, max: 1 } }] } });
    expect(() => parseTests({ 'goldens/refund-*': { expect: { tools: { issue_refund: 'once' } } } })).toThrow('shadowlap.config.json: tests["goldens/refund-*"].expect.tools["issue_refund"] must be a count such as 0, ">= 1", "<= 12" or "2-4"');
    expect(() => parseTests({ 'goldens/refund-*': { chaos: { presets: ['flood'] } } })).toThrow(/tests\["goldens\/refund-\*"\]\.chaos\.presets/);
  });
});

describe('the browser bundle', () => {
  // What the check builder imports on the dashboard's pages: the grammar, the parser and the labels.
  const builder = `
    export { EXPECT_KEYS, hasChecks } from './grammar.js';
    export { parseExpect } from './parse.js';
    export { callRuleLabel, checkLabels, checkLine, conditionLabel, costLabel, countLabel, formatAmount, formatCount, judgeLabel, textLabels, toolCheckLabel, whenLabel } from './labels.js';
  `;
  const bundle = (format: 'esm' | 'iife') =>
    build({
      stdin: { contents: builder, resolveDir: fileURLToPath(new URL('../src/checks/', import.meta.url)), loader: 'ts', sourcefile: 'builder.ts' },
      bundle: true,
      write: false,
      platform: 'browser',
      format,
      ...(format === 'iife' ? { globalName: 'checks' } : {}),
      logLevel: 'silent',
    });

  it('can take the check parser and its labels: nothing they import needs Node', async () => {
    const out = await bundle('esm');
    expect(out.errors).toEqual([]);
    expect(out.outputFiles[0].text).toContain('parseExpect');
  });

  /** The bundle run where nothing of Node is in scope, as a page runs it. */
  async function inPage(): Promise<{ parseExpect: typeof parseExpect } & typeof labels> {
    const out = await bundle('iife');
    const scope = createContext({});
    runInContext(out.outputFiles[0].text, scope);
    return (scope as { checks: { parseExpect: typeof parseExpect } & typeof labels }).checks;
  }

  it('parses and labels a check with nothing of Node in scope, in the CLI’s words', async () => {
    const checks = await inPage();
    const spec = checks.parseExpect({ calls: [{ tool: 'issue_refund', after: 'lookup_order', args: { amount: { '<=': '@lookup_order.result.total' } } }] }, 'expect');
    expect(checks.callRuleLabel(spec.calls![0])).toBe('every issue_refund call: after lookup_order, amount <= lookup_order.result.total');
    expect(() => checks.parseExpect({ calls: [{ tool: 'issue_refund' }] }, 'expect')).toThrow('expect.calls[0] checks nothing: give it "after", "args" or both (to require a call of issue_refund, use "tools")');
    expect(() => checks.parseExpect({ calls: [{ tool: 'issue_refund', args: { amount: { lte: 100 } } }] }, 'expect')).toThrow('did you mean { "<=": 100 }?');
  });

  it('labels every kind of check with nothing of Node in scope, as evaluateChecks reports them', async () => {
    const checks = await inPage();
    const reported = evaluateChecks(parseExpect(EVERY_KIND, 'expect'), LABEL_INPUT).map((r) => r.label);
    const spec = checks.parseExpect(EVERY_KIND, 'expect');
    expect([...checks.checkLabels(spec)]).toEqual(reported);
    // Each kind by its own label too, as a page labels the one check it is building.
    const [when] = spec.when!;
    expect([checks.toolCheckLabel(spec.tools[0]), checks.toolCheckLabel(spec.tools[1])]).toEqual(reported.slice(0, 2));
    expect([checks.countLabel('modelCalls', spec.modelCalls!), checks.countLabel('toolCalls', spec.toolCalls!), checks.countLabel('inputTokens', spec.inputTokens!), checks.countLabel('outputTokens', spec.outputTokens!)]).toEqual(reported.slice(2, 6));
    expect(checks.costLabel(spec.cost!)).toBe(reported[6]);
    expect([...checks.textLabels('output', spec.output!), ...checks.textLabels('answer', spec.answer!)]).toEqual(reported.slice(7, 10));
    expect(checks.callRuleLabel(spec.calls![0])).toBe(reported[10]);
    expect(checks.whenLabel(when.if, checks.toolCheckLabel(when.then.tools[0]))).toBe(reported[11]);
    expect(checks.whenLabel(when.if, checks.judgeLabel(when.then.judge![0]))).toBe(reported[16]);
    expect(checks.judgeLabel(spec.judge![0])).toBe(reported[18]);
  });
});

describe('readsMoreThanAStep', () => {
  const empty = { tools: [] };
  const judge = (of: 'answer' | 'output' | 'run') => ({ name: 'j', question: 'q', of, model: 'm', pass: 'yes' as const });

  it('holds of a check on what the run did or printed, and not of a judge of a model call\'s words', () => {
    expect(readsMoreThanAStep(empty)).toBe(false);
    expect(readsMoreThanAStep({ ...empty, judge: [judge('answer')] })).toBe(false);
    expect(readsMoreThanAStep({ ...empty, judge: [judge('run')] })).toBe(false);
    expect(readsMoreThanAStep({ ...empty, judge: [judge('output')] })).toBe(true);
    expect(readsMoreThanAStep({ ...empty, answer: { includes: ['x'], excludes: [] } })).toBe(true);
    expect(readsMoreThanAStep({ tools: [{ name: 't' }] as never })).toBe(true);
  });
});
