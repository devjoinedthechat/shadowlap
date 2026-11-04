import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { checkLine, evaluateChecks, notJudgedWhy, parseExpect, parseTests, Store, storedCheckInput, type JudgeCheck } from '../src/index.js';
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
    export { callRuleLabel, checkLine, conditionLabel, formatAmount, formatCount, judgeLabel } from './labels.js';
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

  it('parses and labels a check with nothing of Node in scope, in the CLI’s words', async () => {
    const out = await bundle('iife');
    const scope = createContext({});
    runInContext(out.outputFiles[0].text, scope);
    const checks = (scope as { checks: { parseExpect: typeof parseExpect; callRuleLabel: (rule: unknown) => string } }).checks;
    const spec = checks.parseExpect({ calls: [{ tool: 'issue_refund', after: 'lookup_order', args: { amount: { '<=': '@lookup_order.result.total' } } }] }, 'expect');
    expect(checks.callRuleLabel(spec.calls![0])).toBe('every issue_refund call: after lookup_order, amount <= lookup_order.result.total');
    expect(() => checks.parseExpect({ calls: [{ tool: 'issue_refund' }] }, 'expect')).toThrow('expect.calls[0] checks nothing: give it "after", "args" or both (to require a call of issue_refund, use "tools")');
    expect(() => checks.parseExpect({ calls: [{ tool: 'issue_refund', args: { amount: { lte: 100 } } }] }, 'expect')).toThrow('did you mean { "<=": 100 }?');
  });
});
