import { afterEach, describe, expect, it, vi } from 'vitest';
import { JUDGE_SCOPE, checkOutcome, checkStatus, statusTally, type CallRecord } from '@shadowlap/engine';
import { aliasOf, checkLine, evaluateChecks, hasChecks, judgeChecksOf, judgeProvider, notJudgedWhy, parseExpect, parseJudge, parseTests, pathsNamed, readsOutput, toolsNamed, unreadPaths, withoutOutput, type CheckInput, type CheckResult, type JudgeVerdict } from '../src/checks.js';
import { oracleLabels } from '../src/attempts.js';
import { checkText, failureTitle } from '../src/fixes.js';
import { scoredChecks } from '../src/tasks.js';

/**
 * The checks that say what an agent did, not only how much: `calls` (every call of a tool meets a
 * rule: what it comes after, its arguments, values from earlier calls), `when` (an expect that
 * applies once a call matched a condition, and is not applicable until then), and the grammar of
 * `judge`, whose verdicts come from elsewhere. Every result has a status.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

type Tool = CallRecord & { args?: unknown; result?: unknown };

/** A tool call as a recording holds it, its arguments and result beside it. */
function tool(callNo: number, name: string, args: unknown, result?: unknown, o: { origin?: CallRecord['origin']; outcome?: 'ok' | 'error'; ended?: boolean; scope?: string } = {}): Tool {
  return {
    runId: 'r',
    callNo,
    kind: 'tool',
    name,
    fingerprint: `f${callNo}`,
    occurrence: 1,
    origin: o.origin ?? 'replayed',
    effect: null,
    requestRef: null,
    meta: o.scope ? { scope: o.scope } : {},
    at: callNo,
    end: o.ended === false ? null : { runId: 'r', callNo, attempt: 0, responseRef: null, outcome: o.outcome ?? 'ok', meta: {}, at: callNo },
    attempts: [],
    args,
    ...(result !== undefined ? { result } : {}),
  };
}

function model(callNo: number, scope?: string): CallRecord {
  return { runId: 'r', callNo, kind: 'api', name: 'POST /v1/messages', fingerprint: `m${callNo}`, occurrence: 1, origin: 'replayed', effect: null, requestRef: null, meta: scope ? { scope } : {}, at: callNo, end: { runId: 'r', callNo, attempt: 0, responseRef: null, outcome: 'ok', meta: { usage: { inputTokens: 100, outputTokens: 10 } }, at: callNo }, attempts: [] };
}

const input = (calls: CallRecord[], extra: Partial<CheckInput> = {}): CheckInput => ({
  calls,
  output: '',
  answer: null,
  argsOf: (c) => (c as Tool).args,
  resultOf: (c) => (c.end?.outcome === 'ok' ? (c as Tool).result : undefined),
  costOf: () => null,
  ...extra,
});

const judge = (expect_: unknown, calls: CallRecord[], options = {}): CheckResult[] => evaluateChecks(parseExpect(expect_, '--expect'), input(calls), options);
const one = (expect_: unknown, calls: CallRecord[]): CheckResult => judge(expect_, calls)[0];

/** The rule the spec opens with: a refund never more than the order it refunds came to. */
const REFUND_RULE = { calls: [{ tool: 'issue_refund', after: 'lookup_order', args: { amount: { '<=': '@lookup_order.result.total' } } }] };
const refundRun = (amount: number) => [model(1), tool(5, 'lookup_order', { order_id: 'A-1042' }, { order_id: 'A-1042', total: 180 }), model(6), tool(7, 'issue_refund', { order_id: 'A-1042', amount }, { refunded: true }), model(8)];

describe('calls: a rule every call of a tool meets', () => {
  it('fails a refund above the looked-up total, naming both values, and passes the same run below it', () => {
    expect(one(REFUND_RULE, refundRun(240))).toEqual({
      status: 'failed',
      ok: false,
      label: 'every issue_refund call: after lookup_order, amount <= lookup_order.result.total',
      detail: 'issue_refund #7: amount 240 > lookup_order.result.total 180 (#5)',
    });
    expect(one(REFUND_RULE, refundRun(120))).toEqual({ status: 'passed', ok: true, label: 'every issue_refund call: after lookup_order, amount <= lookup_order.result.total', detail: null });
    // At the total exactly is within it.
    expect(one(REFUND_RULE, refundRun(180)).status).toBe('passed');
  });

  it('reads the most recent call of the tool before the call checked, never one after it', () => {
    const calls = [tool(2, 'lookup_order', { order_id: 'A' }, { total: 500 }), tool(4, 'lookup_order', { order_id: 'B' }, { total: 40 }), tool(6, 'issue_refund', { amount: 100 }), tool(8, 'lookup_order', { order_id: 'C' }, { total: 900 })];
    expect(one(REFUND_RULE, calls).detail).toBe('issue_refund #6: amount 100 > lookup_order.result.total 40 (#4)');
    // By call number, in whatever order the calls are handed over.
    expect(one(REFUND_RULE, [...calls].reverse()).detail).toBe('issue_refund #6: amount 100 > lookup_order.result.total 40 (#4)');
  });

  it('fails and names the missing call when there is nothing to read, and never passes on a missing value', () => {
    const rule = { calls: [{ tool: 'issue_refund', args: { amount: { '<=': '@lookup_order.result.total' } } }] };
    expect(one(rule, [tool(3, 'issue_refund', { amount: 10 })]).detail).toBe('issue_refund #3: no lookup_order call before it');
    // The lookup failed, was blocked or never finished: it has no result to read.
    expect(one(rule, [tool(2, 'lookup_order', {}, undefined, { outcome: 'error' }), tool(3, 'issue_refund', { amount: 10 })]).detail).toBe('issue_refund #3: lookup_order #2 has no result (it failed)');
    expect(one(rule, [tool(2, 'lookup_order', {}, undefined, { origin: 'blocked', outcome: 'error' }), tool(3, 'issue_refund', { amount: 10 })]).detail).toBe('issue_refund #3: lookup_order #2 has no result (it was blocked)');
    expect(one(rule, [tool(2, 'lookup_order', {}, undefined, { ended: false }), tool(3, 'issue_refund', { amount: 10 })]).detail).toBe('issue_refund #3: lookup_order #2 has no result (it never finished)');
    // The result has no such value.
    expect(one(rule, [tool(2, 'lookup_order', {}, { amount: 10 }), tool(3, 'issue_refund', { amount: 10 })]).detail).toBe('issue_refund #3: lookup_order #2 has no result.total');
    // The call has no such argument.
    expect(one(rule, [tool(2, 'lookup_order', {}, { total: 10 }), tool(3, 'issue_refund', { order_id: 'A' })]).detail).toBe('issue_refund #3: has no amount');
    // Negating a comparison that can't be made doesn't make it pass either.
    const negated = { calls: [{ tool: 'issue_refund', args: { amount: { not: { '>': '@lookup_order.result.total' } } } }] };
    expect(one(negated, [tool(3, 'issue_refund', { amount: 10 })]).status).toBe('failed');
    // A reader without results reads none, and so passes nothing that needs one.
    const { resultOf: _results, ...withoutResults } = input([tool(2, 'lookup_order', {}, { total: 10 }), tool(3, 'issue_refund', { amount: 1 })]);
    expect(evaluateChecks(parseExpect(rule, 'e'), withoutResults)[0].detail).toBe('issue_refund #3: lookup_order #2 has no result');
    // Nor does it switch a condition on a result off quietly: whether it held can't be told.
    const big = parseExpect({ when: [{ if: { tool: 'lookup_order', result: { total: { '>': 5 } } }, then: { tools: { escalate: 1 } } }] }, 'e');
    expect(evaluateChecks(big, withoutResults)[0]).toMatchObject({ status: 'inconclusive', detail: 'could not tell whether the condition held: lookup_order #2: has no result' });
  });

  it('passes a rule on a tool that was never called, which "tools" is for', () => {
    expect(one(REFUND_RULE, [model(1), tool(2, 'escalate', { reason: 'above the limit' })])).toMatchObject({ status: 'passed', detail: null });
  });

  it('checks "after" against one tool or each of a list, before every call', () => {
    const after = (a: unknown) => ({ calls: [{ tool: 'issue_refund', after: a }] });
    const calls = [tool(2, 'lookup_order', {}, {}), tool(3, 'issue_refund', {}), tool(4, 'check_policy', {}, {}), tool(5, 'issue_refund', {})];
    expect(one(after('lookup_order'), calls).status).toBe('passed');
    expect(one(after(['lookup_order', 'check_policy']), calls)).toMatchObject({ status: 'failed', label: 'every issue_refund call: after lookup_order and check_policy', detail: 'issue_refund #3: no check_policy call before it' });
    expect(one(after(['lookup_order', 'check_policy', 'verify_identity']), calls).detail).toBe('issue_refund #3: no check_policy or verify_identity call before it; issue_refund #5: no verify_identity call before it');
    // A reference to a call "after" already found missing says nothing more.
    const both = { calls: [{ tool: 'issue_refund', after: 'lookup_order', args: { amount: { '<=': '@lookup_order.result.total' } } }] };
    expect(one(both, [tool(3, 'issue_refund', { amount: 10 })]).detail).toBe('issue_refund #3: no lookup_order call before it');
  });

  it('names the first three calls that break a rule, and how many more', () => {
    const calls = [1, 2, 3, 4, 5].map((n) => tool(n, 'send_email', { to: `user${n}@evil.test` }));
    expect(one({ calls: [{ tool: 'send_email', args: { to: { endsWith: '@example.com' } } }] }, calls).detail).toBe(
      'send_email #1: to "user1@evil.test" doesn\'t end with "@example.com"; send_email #2: to "user2@evil.test" doesn\'t end with "@example.com"; send_email #3: to "user3@evil.test" doesn\'t end with "@example.com"; 2 more send_email calls too',
    );
  });

  it('compares with every operator, and says what the values were', () => {
    const at = (args: unknown, value: unknown) => one({ calls: [{ tool: 't', args }] }, [tool(1, 't', value)]);
    expect(at({ n: { '=': 3 } }, { n: 3 }).status).toBe('passed');
    expect(at({ n: { '!=': 3 } }, { n: 3 }).detail).toBe('t #1: n 3 = 3');
    expect(at({ n: { '<': 3 } }, { n: 3 }).detail).toBe('t #1: n 3 >= 3');
    expect(at({ n: { '>': 3 } }, { n: 3 }).detail).toBe('t #1: n 3 <= 3');
    expect(at({ n: { '>=': 4 } }, { n: 3 }).detail).toBe('t #1: n 3 < 4');
    expect(at({ n: { '>': 0, '<': 500 } }, { n: 250 }).status).toBe('passed');
    expect(at({ n: { '>': 0, '<': 500 } }, { n: 900 }).detail).toBe('t #1: n 900 >= 500');
    expect(at({ c: { in: ['USD', 'GBP'] } }, { c: 'EUR' }).detail).toBe('t #1: c "EUR" not in ["USD", "GBP"]');
    expect(at({ s: { includes: 'refund' } }, { s: 'Your refund is on its way' }).status).toBe('passed');
    expect(at({ s: { includes: 'refund' } }, { s: 'Hello' }).detail).toBe('t #1: s "Hello" doesn\'t include "refund"');
    expect(at({ tags: { includes: 'vip' } }, { tags: ['new', 'vip'] }).status).toBe('passed');
    expect(at({ to: { startsWith: 'ops@' } }, { to: 'ceo@example.com' }).detail).toBe('t #1: to "ceo@example.com" doesn\'t start with "ops@"');
    expect(at({ to: { endsWith: '@example.com' } }, { to: 'ops@example.com' }).status).toBe('passed');
    expect(at({ to: { not: { in: ['ceo@example.com'] } } }, { to: 'ceo@example.com' }).detail).toBe('t #1: to "ceo@example.com" in ["ceo@example.com"]');
    // A number written as text compares as the number; anything else can't be compared, and fails.
    expect(at({ amount: { '<=': 100 } }, { amount: '99.50' }).status).toBe('passed');
    expect(at({ amount: { '<=': 100 } }, { amount: 'lots' })).toMatchObject({ status: 'failed', detail: 't #1: amount "lots" is not a number' });
    expect(at({ to: { endsWith: '.com' } }, { to: 5 }).detail).toBe('t #1: to 5 is not text');
    // Case matters: a value is compared as it is.
    expect(at({ to: { endsWith: '@example.com' } }, { to: 'ops@EXAMPLE.com' }).status).toBe('failed');
  });

  it('keeps a literal\'s meaning from "tools": equal, objects partially, lists item by item, with predicates inside', () => {
    const at = (args: unknown, value: unknown) => one({ calls: [{ tool: 't', args }] }, [tool(1, 't', value)]);
    expect(at({ order_id: 'A-1042' }, { order_id: 'A-1042', amount: 3 }).status).toBe('passed');
    expect(at({ order_id: 'A-1042' }, { order_id: 'B-7' }).detail).toBe('t #1: order_id "B-7" != "A-1042"');
    expect(at({ customer: { tier: 'gold' } }, { customer: { tier: 'gold', id: 7 } }).status).toBe('passed');
    expect(at({ customer: { email: { endsWith: '@example.com' } } }, { customer: { email: 'x@evil.test' } }).detail).toBe('t #1: customer.email "x@evil.test" doesn\'t end with "@example.com"');
    expect(at({ ids: [1, 2] }, { ids: [1] }).detail).toBe('t #1: ids has 1 item, not 2');
    expect(at({ ids: [{ '>': 0 }, 2] }, { ids: [5, 2] }).status).toBe('passed');
    // An operator's name as a value, compared with "=".
    expect(at({ filter: { '=': { in: 'inbox' } } }, { filter: { in: 'inbox', other: 1 } }).status).toBe('passed');
    // A reference on its own stands for its value: the refund is for the order that was looked up.
    const same = { calls: [{ tool: 'issue_refund', args: { order_id: '@lookup_order.args.order_id' } }] };
    expect(one(same, [tool(1, 'lookup_order', { order_id: 'A-1' }, {}), tool(2, 'issue_refund', { order_id: 'A-1' })]).status).toBe('passed');
    expect(one(same, [tool(1, 'lookup_order', { order_id: 'A-1' }, {}), tool(2, 'issue_refund', { order_id: 'B-2' })]).detail).toBe('issue_refund #2: order_id "B-2" != lookup_order.args.order_id "A-1" (#1)');
    // "@example.com" is no reference: only "@<tool>.result" and "@<tool>.args" are.
    expect(at({ to: { endsWith: '@example.com' } }, { to: 'a@example.com' }).status).toBe('passed');
  });

  it('reads paths into results, a JSON result held in text, and lists of values with *', () => {
    const lookup = (result: unknown) => tool(1, 'lookup_customer', {}, result);
    const leak = { calls: [{ tool: 'send_email', args: { to: { not: { in: '@lookup_customer.result.*' } } } }] };
    expect(one(leak, [lookup({ email: 'jo@example.com', phone: '555' }), tool(2, 'send_email', { to: 'jo@example.com' })])).toMatchObject({
      status: 'failed',
      label: 'every send_email call: to not in lookup_customer.result.*',
      detail: 'send_email #2: to "jo@example.com" in lookup_customer.result.* ["jo@example.com","555"] (#1)',
    });
    expect(one(leak, [lookup({ email: 'jo@example.com' }), tool(2, 'send_email', { to: 'ops@example.com' })]).status).toBe('passed');
    // A tool that answers with JSON in a string is read as that JSON.
    expect(one(REFUND_RULE, [tool(1, 'lookup_order', {}, '{"total": 50}'), tool(2, 'issue_refund', { amount: 60 })]).detail).toBe('issue_refund #2: amount 60 > lookup_order.result.total 50 (#1)');
    // Positions in a list, counted from the end too.
    const first = { calls: [{ tool: 'add_item', args: { sku: '@search.result.items[0].sku' } }] };
    expect(one(first, [tool(1, 'search', {}, { items: [{ sku: 'A' }, { sku: 'B' }] }), tool(2, 'add_item', { sku: 'A' })]).status).toBe('passed');
    const last = { calls: [{ tool: 'add_item', args: { sku: '@search.result.items[-1].sku' } }] };
    expect(one(last, [tool(1, 'search', {}, { items: [{ sku: 'A' }, { sku: 'B' }] }), tool(2, 'add_item', { sku: 'A' })]).detail).toBe('add_item #2: sku "A" != search.result.items[-1].sku "B" (#1)');
    // "in" a list another call returned.
    const allowed = { calls: [{ tool: 'send_email', args: { to: { in: '@list_contacts.result.emails' } } }] };
    expect(one(allowed, [tool(1, 'list_contacts', {}, { emails: ['a@x.test'] }), tool(2, 'send_email', { to: 'b@x.test' })]).detail).toBe('send_email #2: to "b@x.test" not in list_contacts.result.emails ["a@x.test"] (#1)');
    expect(one(allowed, [tool(1, 'list_contacts', {}, { emails: 'a@x.test' }), tool(2, 'send_email', { to: 'a@x.test' })]).detail).toBe('send_email #2: list_contacts.result.emails is "a@x.test" (#1), not a list');
  });
});

describe('when: an expect that applies once a call matched its condition', () => {
  const ESCALATE = { when: [{ if: { tool: 'lookup_order', result: { total: { '>': 200 } } }, then: { tools: { escalate: '>= 1', issue_refund: 0 } } }] };
  const run = (total: number, then: Tool[]) => [model(1), tool(2, 'lookup_order', { order_id: 'A' }, { total }), ...then];

  it('reports not applicable when its condition never held, never passed', () => {
    const results = judge(ESCALATE, run(180, [tool(3, 'issue_refund', { amount: 180 })]));
    expect(results).toEqual([
      { status: 'not-applicable', ok: true, label: 'when lookup_order has result.total > 200: escalate called at least 1 time', detail: 'the condition never held: lookup_order #2: result.total 180 <= 200' },
      { status: 'not-applicable', ok: true, label: 'when lookup_order has result.total > 200: issue_refund called 0 times', detail: 'the condition never held: lookup_order #2: result.total 180 <= 200' },
    ]);
    expect(judge(ESCALATE, [model(1)]).map((r) => r.detail)).toEqual(['the condition never held: lookup_order was never called', 'the condition never held: lookup_order was never called']);
    // A not-applicable check never fails a run, and never counts as passed.
    expect(checkOutcome(results)).toBe('passed');
    expect(statusTally(results)).toBe('2 checks not applicable');
  });

  it('applies its checks to the whole run once any call met the condition, saying where it held', () => {
    expect(judge(ESCALATE, run(240, [tool(3, 'escalate', { reason: 'above the limit' })])).map((r) => [r.status, r.detail])).toEqual([
      ['passed', null],
      ['passed', null],
    ]);
    expect(judge(ESCALATE, run(240, [tool(3, 'issue_refund', { amount: 240 })]))).toEqual([
      { status: 'failed', ok: false, label: 'when lookup_order has result.total > 200: escalate called at least 1 time', detail: 'called 0 times; tools called: lookup_order, issue_refund; the condition held at lookup_order #2 (result.total 240 > 200)' },
      { status: 'failed', ok: false, label: 'when lookup_order has result.total > 200: issue_refund called 0 times', detail: 'called 1 time; the condition held at lookup_order #2 (result.total 240 > 200)' },
    ]);
  });

  it('matches arguments and results, any call of the tool, and treats a missing value as no match', () => {
    const cond = (c: unknown) => ({ when: [{ if: c, then: { tools: { escalate: 1 } } }] });
    const calls = [tool(1, 'lookup_order', { region: 'EU' }, { total: 50 }), tool(2, 'lookup_order', { region: 'US' }, { total: 900 }), tool(3, 'escalate', {})];
    expect(one(cond({ tool: 'lookup_order', args: { region: 'US' }, result: { total: { '>': 200 } } }), calls)).toMatchObject({ status: 'passed', label: 'when lookup_order has args.region = "US" and result.total > 200: escalate called 1 time' });
    expect(one(cond({ tool: 'lookup_order', args: { region: 'EU' }, result: { total: { '>': 200 } } }), calls)).toMatchObject({ status: 'not-applicable', detail: 'the condition never held: lookup_order #1: result.total 50 <= 200; lookup_order #2: args.region "US" != "EU"' });
    expect(one(cond({ tool: 'escalate' }), calls)).toMatchObject({ status: 'passed', label: 'when escalate is called: escalate called 1 time' });
    expect(one(cond({ tool: 'lookup_order', result: { total: { '>': 0 } } }), [tool(1, 'lookup_order', {}, undefined, { outcome: 'error' })])).toMatchObject({ status: 'not-applicable', detail: 'the condition never held: lookup_order #1: has no result (it failed)' });
    // A result that is a plain value takes a predicate itself.
    expect(one(cond({ tool: 'count_open', result: { '>': 3 } }), [tool(1, 'count_open', {}, 7)])).toMatchObject({ status: 'failed', label: 'when count_open has result > 3: escalate called 1 time' });
  });

  it('parses its then by the same grammar, a when inside a when included', () => {
    const nested = { when: [{ if: { tool: 'lookup_order' }, then: { when: [{ if: { tool: 'issue_refund', args: { amount: { '>': 100 } } }, then: { calls: [{ tool: 'issue_refund', after: 'approve' }] } }] } }] };
    const calls = [tool(1, 'lookup_order', {}, {}), tool(2, 'issue_refund', { amount: 150 })];
    expect(one(nested, calls)).toMatchObject({ status: 'failed', label: 'when lookup_order is called: when issue_refund has args.amount > 100: every issue_refund call: after approve', detail: 'issue_refund #2: no approve call before it; the condition held at issue_refund #2 (args.amount 150 > 100); the condition held at lookup_order #1' });
    expect(() => parseExpect({ when: [{ if: { tool: 'x' }, then: { tool: {} } }] }, '--expect')).toThrow('--expect.when[0].then has an unknown key "tool"');
  });

  it('keeps the same labels whatever the run did, so a golden\'s checks are known before it runs', () => {
    const spec = parseExpect({ ...REFUND_RULE, ...ESCALATE, judge: [{ name: 'polite', question: 'Is the reply polite?', model: 'claude-haiku-4-5' }] }, 'e');
    const labels = (calls: CallRecord[]) => evaluateChecks(spec, input(calls)).map((r) => r.label);
    expect(labels(run(240, [tool(3, 'issue_refund', { amount: 240 })]))).toEqual(labels([]));
    expect(oracleLabels(spec).slice(1)).toEqual(labels(run(50, [])));
  });
});

describe('judge: the grammar, and a verdict given or missing', () => {
  const JUDGE = { name: 'explains-escalation', question: 'Does the final reply tell the customer why the refund was escalated instead of issued?', of: 'answer', model: 'claude-haiku-4-5', pass: 'yes' };

  it('parses a judge check exactly as the contract says, with "answer" and "yes" by default', () => {
    expect(parseJudge(JUDGE, 'j')).toEqual(JUDGE);
    expect(parseJudge({ name: 'tone', question: 'Is it rude?', model: 'openai:gpt-5.5', pass: 'no' }, 'j')).toEqual({ name: 'tone', question: 'Is it rude?', of: 'answer', model: 'openai:gpt-5.5', pass: 'no' });
    expect(parseExpect({ judge: [JUDGE] }, '--expect').judge).toEqual([JUDGE]);
    expect(judgeProvider('claude-haiku-4-5')).toBe('anthropic');
    expect(judgeProvider('openai:gpt-5.5')).toBe('openai');
    expect(judgeProvider('gpt-5.5')).toBe('openai');
    expect(judgeProvider('gemini-3-flash')).toBe('gemini');
  });

  it('refuses a judge check it cannot ask, naming the key', () => {
    const bad = (j: Record<string, unknown>) => () => parseExpect({ judge: [{ ...JUDGE, ...j }] }, '--expect');
    expect(bad({ name: 'has spaces' })).toThrow('--expect.judge[0].name must be a short name');
    expect(bad({ question: ' ' })).toThrow('--expect.judge[0].question must be the question the judge answers yes or no');
    expect(bad({ of: 'everything' })).toThrow('--expect.judge[0].of must be "answer" (the last model response), "output" (what the agent printed) or "run"');
    expect(bad({ model: '' })).toThrow('--expect.judge[0].model must name a model a judge can be asked through: a Claude, OpenAI or Gemini model');
    expect(bad({ model: 'llama3' })).toThrow('--expect.judge[0].model must name a model a judge can be asked through');
    expect(bad({ pass: true })).toThrow('--expect.judge[0].pass must be "yes" or "no"');
    expect(bad({ temperature: 0 })).toThrow('--expect.judge[0] has an unknown key "temperature" (expected "name", "question", "of", "model", "pass")');
    expect(() => parseExpect({ judge: JUDGE }, '--expect')).toThrow('--expect.judge must be a list of questions');
    // A verdict is kept under its judge's name, so a name is used once, a when's then included.
    expect(() => parseExpect({ judge: [JUDGE], when: [{ if: { tool: 'x' }, then: { judge: [JUDGE] } }] }, '--expect')).toThrow('--expect.judge[0].name "explains-escalation" is already the name of --expect.when[0].then.judge[0]: each judge needs a name of its own');
  });

  it('is inconclusive without a verdict, saying why, and never passes unjudged', () => {
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) vi.stubEnv(k, '');
    // How it came out is kept beside it, for the reports: no verdict, from nowhere, at no cost.
    const outcome = { name: 'explains-escalation', model: 'claude-haiku-4-5', of: 'answer', verdict: null, source: null, cost: null, redactions: 0, normalized: false, cut: 0 };
    expect(judge({ judge: [JUDGE] }, [])).toEqual([{ status: 'inconclusive', ok: false, label: 'judge "explains-escalation" answers yes', detail: 'not judged: no recorded verdict and no key for anthropic', judge: outcome }]);
    // A key that is there is not named as missing.
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    expect(judge({ judge: [JUDGE] }, [])[0].detail).toBe('not judged: no recorded verdict');
    expect(judge({ judge: [JUDGE] }, [], { judgeMissing: () => 'not judged: the recording holds no verdict' })[0].detail).toBe('not judged: the recording holds no verdict');
  });

  it('passes or fails on its verdict, with the reason beside it and where the verdict came from', () => {
    const verdicts = (v: JudgeVerdict) => ({ judgeVerdicts: new Map([['explains-escalation', v]]) });
    const outcome = (verdict: 'yes' | 'no', source: 'recording' | 'live', cost: number | null) => ({ name: 'explains-escalation', model: 'claude-haiku-4-5', of: 'answer', verdict, source, cost, redactions: 0, normalized: false, cut: 0 });
    expect(judge({ judge: [JUDGE] }, [], verdicts({ verdict: 'yes', reason: 'It says the refund is above the limit.', source: 'recording' }))).toEqual([
      { status: 'passed', ok: true, label: 'judge "explains-escalation" answers yes', detail: null, reason: 'It says the refund is above the limit.', source: 'recording', judge: outcome('yes', 'recording', 0) },
    ]);
    // A verdict asked live costs what its call cost, which a caller that doesn't know leaves unpriced.
    expect(judge({ judge: [JUDGE] }, [], verdicts({ verdict: 'no', reason: 'It never says why.', source: 'live' }))).toEqual([
      { status: 'failed', ok: false, label: 'judge "explains-escalation" answers yes', detail: 'the judge answered no', reason: 'It never says why.', source: 'live', judge: outcome('no', 'live', null) },
    ]);
  });

  it('collects every judge check of a spec, those under a when included', () => {
    const spec = parseExpect({ judge: [JUDGE], when: [{ if: { tool: 'x' }, then: { judge: [{ ...JUDGE, name: 'second' }] } }] }, 'e');
    expect(judgeChecksOf(spec).map((j) => j.name)).toEqual(['explains-escalation', 'second']);
    expect(hasChecks(parseExpect({ judge: [JUDGE] }, 'e'))).toBe(true);
  });
});

describe('the result model', () => {
  it('gives every result a status, ok true only for passed and not applicable', () => {
    const results = judge(
      { tools: { escalate: 1 }, calls: [{ tool: 'issue_refund', after: 'lookup_order' }], when: [{ if: { tool: 'nothing' }, then: { modelCalls: 1 } }], judge: [{ name: 'j', question: 'q?', model: 'claude-haiku-4-5' }] },
      [tool(1, 'issue_refund', {})],
    );
    expect(results.map((r) => [r.status, r.ok])).toEqual([
      ['failed', false],
      ['failed', false],
      ['not-applicable', true],
      ['inconclusive', false],
    ]);
    expect(checkOutcome(results)).toBe('failed');
    expect(checkOutcome(results.slice(2))).toBe('inconclusive');
    expect(checkOutcome(results.slice(2, 3))).toBe('passed');
    expect(statusTally(results)).toBe('2 of 4 checks failed, 1 inconclusive, 1 not applicable');
    expect(statusTally(results.slice(3))).toBe('1 check inconclusive');
  });

  it('reads a result kept before results had a status as its ok says', () => {
    expect(checkStatus({ ok: true })).toBe('passed');
    expect(checkStatus({ ok: false })).toBe('failed');
    expect(checkStatus({ ok: true, status: 'not-applicable' })).toBe('not-applicable');
    expect(checkStatus({ ok: false, status: 'nonsense' })).toBe('failed');
    expect(statusTally([{ ok: true }, { ok: true }])).toBe('2 checks passed');
  });

  it('writes each verdict in the same words in a report line', () => {
    expect(checkLine({ status: 'passed', ok: true, label: 'a', detail: null })).toBe('✓ a');
    expect(checkLine({ status: 'failed', ok: false, label: 'a', detail: 'b' })).toBe('✗ a: b');
    expect(checkLine({ ok: false, label: 'a', detail: 'b' }, ', but ')).toBe('✗ a, but b');
    expect(checkLine({ status: 'inconclusive', ok: false, label: 'a', detail: 'not judged' })).toBe('? a: inconclusive · not judged');
    expect(checkLine({ status: 'not-applicable', ok: true, label: 'a', detail: 'the condition never held' })).toBe('– a: not applicable · the condition never held');
    expect(checkLine({ status: 'passed', ok: true, label: 'judge "j" answers yes', detail: null, reason: 'It does.' })).toBe('✓ judge "j" answers yes · It does.');
  });

  it('scores a task on the checks that applied: one that did not is left out, one that could not be decided is no pass', () => {
    const results = judge({ tools: { escalate: 1 }, when: [{ if: { tool: 'nothing' }, then: { modelCalls: 1 } }], judge: [{ name: 'j', question: 'q?', model: 'claude-haiku-4-5' }] }, [tool(1, 'escalate', {})]);
    expect(scoredChecks(results)).toEqual([
      { check: 'escalate called 1 time', pass: true, detail: null },
      { check: 'judge "j" answers yes', pass: false, detail: expect.stringMatching(/^not judged: no recorded verdict/) },
    ]);
  });

  it('leaves the judge\'s own model calls out of every count', () => {
    const calls = [model(1), model(2, JUDGE_SCOPE), tool(3, 'lookup_order', {}, {}), model(4)];
    expect(judge({ modelCalls: 2, inputTokens: '<= 200' }, calls).map((r) => r.status)).toEqual(['passed', 'passed']);
  });
});

describe('the grammar\'s errors, in the existing style', () => {
  const errs: Array<[unknown, string]> = [
    [{ calls: { tool: 'x' } }, 'tests["g"].expect.calls must be a list of rules'],
    [{ calls: [{ tool: 'x', args: {}, when: 1 }] }, 'tests["g"].expect.calls[0] has an unknown key "when" (expected "tool", "after", "args")'],
    [{ calls: [{ args: { a: 1 } }] }, 'tests["g"].expect.calls[0].tool must name a tool'],
    [{ calls: [{ tool: 'x' }] }, 'tests["g"].expect.calls[0] checks nothing: give it "after", "args" or both (to require a call of x, use "tools")'],
    [{ calls: [{ tool: 'x', args: {} }] }, 'tests["g"].expect.calls[0] checks nothing'],
    [{ calls: [{ tool: 'x', after: [] }] }, 'tests["g"].expect.calls[0].after must be a tool name or a list of them'],
    [{ calls: [{ tool: 'x', after: ['a', 3] }] }, 'tests["g"].expect.calls[0].after[1] must name a tool'],
    [{ calls: [{ tool: 'x', args: 'amount' }] }, 'tests["g"].expect.calls[0].args must be an object of argument names'],
    [{ calls: [{ tool: 'x', args: { amount: { '<=': 'a lot' } } }] }, 'tests["g"].expect.calls[0].args["amount"]["<="] must be a number or a reference such as "@lookup_order.result.total"'],
    [{ calls: [{ tool: 'x', args: { amount: { '<=': 5, currency: 'EUR' } } }] }, 'tests["g"].expect.calls[0].args["amount"] mixes predicates ("<=") with values to match ("currency")'],
    [{ calls: [{ tool: 'x', args: { to: { in: 'ops@example.com' } } }] }, 'tests["g"].expect.calls[0].args["to"]["in"] must be a list of values, or a reference to one'],
    [{ calls: [{ tool: 'x', args: { to: { endsWith: 5 } } }] }, 'tests["g"].expect.calls[0].args["to"]["endsWith"] must be text or a reference'],
    [{ calls: [{ tool: 'x', args: { to: { not: 'a' } } }] }, 'tests["g"].expect.calls[0].args["to"]["not"] must be a predicate to negate'],
    [{ calls: [{ tool: 'x', args: { to: '@lookup.result.*' } }] }, 'tests["g"].expect.calls[0].args["to"]: @lookup.result.* names several values (it has *); compare with one, or use it with "in"'],
    [{ calls: [{ tool: 'x', args: { n: { '<': '@lookup.result.items[*].price' } } }] }, 'names several values (it has *), which only "in" can compare with'],
    [{ calls: [{ tool: 'x', args: { n: { '<': '@lookup.result.items[' } } }] }, 'tests["g"].expect.calls[0].args["n"]["<"]: the reference @lookup.result.items[ has a path that can\'t be read'],
    [{ when: { if: {}, then: {} } }, 'tests["g"].expect.when must be a list of rules'],
    [{ when: [{ if: { tool: 'x' } }] }, 'tests["g"].expect.when[0] needs both "if" and "then"'],
    [{ when: [{ if: { tool: 'x', after: 'y' }, then: { tools: { a: 1 } } }] }, 'tests["g"].expect.when[0].if has an unknown key "after" (expected "tool", "args", "result")'],
    [{ when: [{ if: { tool: 'x' }, then: {} }] }, 'tests["g"].expect.when[0].then has no checks'],
    [{ when: [{ if: 'x', then: { tools: { a: 1 } } }] }, 'tests["g"].expect.when[0].if must be an object with "tool"'],
  ];
  it.each(errs)('%j', (expect_, message) => {
    expect(() => parseTests({ g: { expect: expect_ } })).toThrow(message);
  });

  it('still names every key an expect may have', () => {
    expect(() => parseTests({ g: { expect: { tool: {} } } })).toThrow('shadowlap.config.json: tests["g"].expect has an unknown key "tool" (expected "tools", "modelCalls", "toolCalls", "inputTokens", "outputTokens", "cost", "output", "answer", "calls", "when", "judge")');
  });
});

describe('what a spec names and reads', () => {
  it('lists every tool a rule names, with where, for doctor', () => {
    const spec = parseTests({
      g: {
        expect: {
          tools: { send_email: 0, escalate: '>= 1' },
          calls: [{ tool: 'issue_refund', after: ['lookup_order', 'check_policy'], args: { amount: { '<=': '@lookup_order.result.total' }, to: { not: { in: '@lookup_customer.result.*' } } } }],
          when: [{ if: { tool: 'lookup_order', result: { total: { '>': '@read_policy.result.limit' } } }, then: { tools: { approve: 1 } } }],
        },
      },
    })[0].spec;
    const w = 'shadowlap.config.json: tests["g"].expect';
    expect(toolsNamed(spec, w)).toEqual([
      { tool: 'send_email', use: 'count', at: `${w}.tools["send_email"]`, zero: true },
      { tool: 'escalate', use: 'count', at: `${w}.tools["escalate"]` },
      { tool: 'issue_refund', use: 'rule', at: `${w}.calls[0].tool` },
      { tool: 'lookup_order', use: 'after', at: `${w}.calls[0].after[0]` },
      { tool: 'check_policy', use: 'after', at: `${w}.calls[0].after[1]` },
      { tool: 'lookup_order', use: 'reference', at: `${w}.calls[0].args["amount"]["<="]` },
      { tool: 'lookup_customer', use: 'reference', at: `${w}.calls[0].args["to"]["not"]["in"]` },
      { tool: 'lookup_order', use: 'condition', at: `${w}.when[0].if.tool` },
      { tool: 'read_policy', use: 'reference', at: `${w}.when[0].if.result["total"][">"]` },
      { tool: 'approve', use: 'count', at: `${w}.when[0].then.tools["approve"]` },
    ]);
  });

  it('knows which checks read the output, which a recording does not keep, wherever they are', () => {
    const spec = parseExpect({ tools: { a: 1 }, when: [{ if: { tool: 'x' }, then: { output: { includes: 'done' } } }, { if: { tool: 'y' }, then: { output: { includes: 'ok' }, tools: { b: 1 } } }] }, 'e');
    expect(readsOutput(spec)).toBe(true);
    const recordable = withoutOutput(spec);
    expect(readsOutput(recordable)).toBe(false);
    expect(recordable.when).toHaveLength(1);
    expect(recordable.when![0].then.tools).toEqual([{ name: 'b', count: { min: 1, max: 1 } }]);
    expect(readsOutput(parseExpect({ judge: [{ name: 'j', question: 'q?', of: 'output', model: 'claude-haiku-4-5' }] }, 'e'))).toBe(true);
  });
});

describe('a fix opened from one of these checks', () => {
  it('says the check and the failure in plain words', () => {
    const spec = parseExpect({ ...REFUND_RULE, when: [{ if: { tool: 'lookup_order', result: { total: { '>': 200 } } }, then: { tools: { escalate: '>= 1', issue_refund: 0 } } }], judge: [{ name: 'polite', question: 'Polite?', model: 'claude-haiku-4-5' }] }, 'e');
    expect(checkText(spec)).toBe('every issue_refund call: after lookup_order, amount <= lookup_order.result.total; when lookup_order has result.total > 200: escalate called at least once and issue_refund never called; judge "polite" answers yes');
    const failing = (calls: CallRecord[]) => failureTitle(spec, { checks: evaluateChecks(spec, input(calls)), failures: [] });
    expect(failing(refundRun(240))).toBe('issue_refund: amount 240 > lookup_order.result.total 180');
    expect(failing([tool(2, 'lookup_order', {}, { total: 300 }), tool(3, 'issue_refund', { amount: 100 })])).toBe('escalate never called, when lookup_order has result.total > 200');
    expect(failing([])).toBe('Judge "polite" not judged');
  });
});

describe('a typo never passes: values of another kind, keys named like operators', () => {
  const at = (args: unknown, value: unknown, calls: Tool[] = []) => one({ calls: [{ tool: 't', args }] }, [...calls, tool(9, 't', value)]);

  it('can\'t decide a value of another kind than the literal, and negating that never makes it pass', () => {
    // A list where the call has text: the rule can't tell, so it fails and says so.
    expect(at({ to: { not: ['x@evil.test'] } }, { to: 'x@evil.test' })).toMatchObject({ status: 'failed', detail: 't #9: to is "x@evil.test", not a list' });
    expect(at({ customer: { not: { tier: 'gold' } } }, { customer: 'C-7' })).toMatchObject({ status: 'failed', detail: 't #9: customer is "C-7", not an object' });
    expect(at({ customer: { tier: 'gold' } }, { customer: 'C-7' })).toMatchObject({ status: 'failed', detail: 't #9: customer is "C-7", not an object' });
  });

  it('decides as three-valued logic: a part that is broken settles "all of these", a missing value never passes', () => {
    const range = { n: { not: { '>': 0, '<': '@lookup.result.max' } } };
    // -1 is not above 0, so "above 0 and below max" is false whatever max is: its negation holds.
    expect(at(range, { n: -1 }).status).toBe('passed');
    // 5 is above 0, and whether it is below max can't be told without a lookup: never a pass.
    expect(at(range, { n: 5 })).toMatchObject({ status: 'failed', detail: 't #9: no lookup call before it' });
  });

  it('refuses a key named like an operator it is not, saying which was meant', () => {
    const refused = (args: unknown) => () => parseExpect({ calls: [{ tool: 't', args }] }, '--expect');
    expect(refused({ to: { not: { endswith: '@evil.com' } } })).toThrow('--expect.calls[0].args["to"]["not"] has the key "endswith", which would be matched as a key the value has, not compared: did you mean { "endsWith": "@evil.com" }? (to match a key named "endswith", write { "=": {"endswith":"@evil.com"} })');
    expect(refused({ body: { not: { contains: 'password' } } })).toThrow('did you mean { "includes": "password" }?');
    expect(refused({ to: { $in: ['a@example.com'] } })).toThrow('did you mean { "in": ["a@example.com"] }?');
    expect(refused({ to: { nin: ['a@example.com'] } })).toThrow('did you mean { "not": { "in": ["a@example.com"] } }?');
    expect(refused({ n: { GTE: 3 } })).toThrow('did you mean { ">=": 3 }?');
    expect(refused({ to: { regex: '^ops@' } })).toThrow('has the key "regex", which is no operator: there are no regular expressions, so compare with "=", "in", "includes", "startsWith" or "endsWith"');
    // In a condition too, where it would never hold.
    expect(() => parseExpect({ when: [{ if: { tool: 'lookup_order', result: { total: { gt: 100 } } }, then: { tools: { escalate: 1 } } }] }, '--expect')).toThrow('--expect.when[0].if.result["total"] has the key "gt", which would be matched as a key the value has, not compared: did you mean { ">": 100 }?');
    expect(() => parseExpect({ when: [{ if: { tool: 'count_open', result: { gt: 3 } }, then: { tools: { escalate: 1 } } }] }, '--expect')).toThrow('--expect.when[0].if.result has the key "gt"');
    expect([aliasOf('lte'), aliasOf('$not'), aliasOf('Includes'), aliasOf('total'), aliasOf('in'), aliasOf('like')]).toEqual(['<=', 'not', 'includes', undefined, undefined, null]);
  });

  it('matches a real key named like an operator with "=", and takes any argument name at the top of "args"', () => {
    expect(at({ filter: { '=': { gt: 1 } } }, { filter: { gt: 1, other: 2 } }).status).toBe('passed');
    expect(at({ gt: 5 }, { gt: 5 }).status).toBe('passed');
    expect(at({ gt: 5 }, { gt: 6 }).detail).toBe('t #9: gt 6 != 5');
  });

  it('reads "@@" as text that starts with "@", never a reference', () => {
    expect(at({ to: '@@corp.args.io' }, { to: '@corp.args.io' })).toMatchObject({ status: 'passed', label: 'every t call: to = "@corp.args.io"' });
    expect(at({ to: '@@corp.args.io' }, { to: 'ops@corp.io' }).detail).toBe('t #9: to "ops@corp.io" != "@corp.args.io"');
    expect(at({ to: { endsWith: '@@corp.result' } }, { to: 'x@corp.result' }).status).toBe('passed');
    expect(at({ to: { in: ['@@corp.args.io'] } }, { to: '@corp.args.io' }).status).toBe('passed');
    // Without the escape it reads the call before it, which isn't there.
    expect(at({ to: '@corp.args.io' }, { to: '@corp.args.io' }).detail).toBe('t #9: no corp call before it');
  });
});

describe('when: a condition that can\'t be read is inconclusive, never "never held"', () => {
  const cond = (c: unknown) => ({ when: [{ if: c, then: { tools: { escalate: '>= 1' } } }] });

  it('says it could not tell when a value the condition compares is missing from the result', () => {
    const misspelt = cond({ tool: 'lookup_order', result: { totl: { '>': 100 } } });
    expect(one(misspelt, [tool(2, 'lookup_order', {}, { order_id: 'A', amount: 240 })])).toEqual({
      status: 'inconclusive',
      ok: false,
      label: 'when lookup_order has result.totl > 100: escalate called at least 1 time',
      detail: 'could not tell whether the condition held: lookup_order #2: has no result.totl',
    });
    expect(checkOutcome(judge(misspelt, [tool(2, 'lookup_order', {}, { amount: 240 })]))).toBe('inconclusive');
    // Of another kind than it compares.
    expect(one(cond({ tool: 'lookup_order', result: { total: { '>': 100 } } }), [tool(2, 'lookup_order', {}, { total: 'lots' })]).detail).toBe('could not tell whether the condition held: lookup_order #2: result.total "lots" is not a number');
    // A call that never finished has no result to read yet.
    expect(one(cond({ tool: 'lookup_order', result: { total: { '>': 100 } } }), [tool(2, 'lookup_order', {}, undefined, { ended: false })])).toMatchObject({ status: 'inconclusive', detail: 'could not tell whether the condition held: lookup_order #2: has no result (it never finished)' });
  });

  it('says it could not tell when a reference in the condition has nothing to read', () => {
    const big = cond({ tool: 'issue_refund', args: { amount: { '>': '@lookup_order.result.total' } } });
    expect(one(big, [tool(3, 'issue_refund', { amount: 50 })])).toMatchObject({ status: 'inconclusive', detail: 'could not tell whether the condition held: issue_refund #3: no lookup_order call before it' });
  });

  it('is not applicable when every call definitely missed it, whatever else it couldn\'t read', () => {
    // The region rules this call out, so its result doesn't matter.
    const eu = cond({ tool: 'lookup_order', args: { region: 'EU' }, result: { totl: { '>': 1 } } });
    expect(one(eu, [tool(2, 'lookup_order', { region: 'US' }, { total: 5 })])).toMatchObject({ status: 'not-applicable', detail: 'the condition never held: lookup_order #2: args.region "US" != "EU"; has no result.totl' });
    // A call that failed returned nothing, so a condition on its result did not hold there.
    expect(one(cond({ tool: 'lookup_order', result: { total: { '>': 1 } } }), [tool(2, 'lookup_order', {}, undefined, { outcome: 'error' })]).status).toBe('not-applicable');
    // One call that met it applies the checks, however the others read.
    const big = cond({ tool: 'lookup_order', result: { total: { '>': 100 } } });
    expect(one(big, [tool(2, 'lookup_order', {}, { amount: 1 }), tool(3, 'lookup_order', {}, { total: 240 }), tool(4, 'escalate', {})]).status).toBe('passed');
  });
});

describe('judge models: one a judge can be asked through', () => {
  const j = (model: string) => parseJudge({ name: 'j', question: 'q?', model }, 'j');

  it('takes a Claude, OpenAI or Gemini model, or any with its provider, and names the provider', () => {
    for (const [model, provider] of [['claude-haiku-4-5', 'anthropic'], ['anthropic:my-proxy-model', 'anthropic'], ['gpt-5.5', 'openai'], ['chatgpt-4o-latest', 'openai'], ['o3', 'openai'], ['openai:local-model', 'openai'], ['gemini-3-flash', 'gemini'], ['gemini:my-tuned', 'gemini']] as const) {
      expect(j(model).model).toBe(model);
      expect(judgeProvider(model)).toBe(provider);
    }
    for (const model of ['llama3', 'm', 'bedrock:claude-haiku', 'Claude-haiku', 'claude haiku']) expect(() => j(model), model).toThrow('must name a model a judge can be asked through');
    expect(judgeProvider('llama3')).toBeNull();
  });

  it('says no key only when the environment has none for the provider', () => {
    expect(notJudgedWhy(j('claude-haiku-4-5'), {})).toBe('not judged: no recorded verdict and no key for anthropic');
    expect(notJudgedWhy(j('claude-haiku-4-5'), { ANTHROPIC_AUTH_TOKEN: 't' })).toBe('not judged: no recorded verdict');
    expect(notJudgedWhy(j('openai:local-model'), { ANTHROPIC_API_KEY: 'k' })).toBe('not judged: no recorded verdict and no key for openai');
    expect(notJudgedWhy(j('gemini-3-flash'), { GOOGLE_API_KEY: 'k' })).toBe('not judged: no recorded verdict');
    expect(notJudgedWhy(j('gpt-5.5'), { OPENAI_API_KEY: ' ' })).toBe('not judged: no recorded verdict and no key for openai');
  });
});

describe('the values a spec reads, held against recorded calls', () => {
  it('lists every argument, result and reference a rule reads, where it is', () => {
    const spec = parseExpect(
      {
        calls: [{ tool: 'issue_refund', args: { amount: { '<=': '@lookup_order.result.total' }, customer: { email: { endsWith: '@example.com' } } } }],
        when: [{ if: { tool: 'lookup_order', result: { totl: { '>': 100 } } }, then: { calls: [{ tool: 'send_email', args: { to: { not: { in: '@lookup_customer.result.*' } } } }] } }],
      },
      'e',
    );
    expect(pathsNamed(spec).map((p) => [p.tool, p.text, p.use, p.at])).toEqual([
      ['issue_refund', 'args.amount', 'rule', 'e.calls[0].args["amount"]'],
      ['lookup_order', 'result.total', 'reference', 'e.calls[0].args["amount"]["<="]'],
      ['issue_refund', 'args.customer.email', 'rule', 'e.calls[0].args["customer"]["email"]'],
      ['lookup_order', 'result.totl', 'condition', 'e.when[0].if.result["totl"]'],
      ['send_email', 'args.to', 'rule', 'e.when[0].then.calls[0].args["to"]'],
      ['lookup_customer', 'result.*', 'reference', 'e.when[0].then.calls[0].args["to"]["not"]["in"]'],
    ]);
  });

  it('names those no recorded call of the tool has, with the keys the calls do have', () => {
    const spec = parseExpect({ calls: [{ tool: 'issue_refund', args: { amount: { '<=': '@lookup_order.result.total' } } }], when: [{ if: { tool: 'lookup_order', result: { amount: { '>': 100 } } }, then: { tools: { escalate: 1 } } }] }, 'e');
    const calls = [tool(1, 'lookup_order', {}, { order_id: 'A', amount: 240, status: 'delivered' }), tool(2, 'issue_refund', { order_id: 'A', amount: 240 })];
    const recordings = [{ calls, input: input(calls) }];
    expect(unreadPaths(pathsNamed(spec), recordings).map((u) => [u.tool, u.text, u.calls, u.keys])).toEqual([['lookup_order', 'result.total', 1, ['amount', 'order_id', 'status']]]);
    // A tool no recording called is left to the check on tool names.
    expect(unreadPaths(pathsNamed(parseExpect({ calls: [{ tool: 'refund', args: { amt: 1 } }] }, 'e')), recordings)).toEqual([]);
  });
});
