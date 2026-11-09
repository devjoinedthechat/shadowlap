import { describe, expect, it } from 'vitest';
import { CANDIDATES_PER_SHAPE, GOOD_RUNS_MAX, SUGGESTED_MAX, checkCandidates, goodRunsOf, judgeRecording, lowerRecorded, parseExpect, suggestChecks, Store, type RunRecord } from '../src/index.js';
import { RunBuilder, text, toolUse, user } from './run-fixtures.js';

/**
 * Suggested checks (suggest-checks.ts): rules that fail a failed recording and pass every good run
 * it is compared with, mined in four shapes and judged by the engine's evaluator from what the
 * recordings hold.
 */

const ASK = [user('Order A-1042 arrived damaged. Refund it, please.')];

interface Refund {
  /** What the order cost, and what was refunded. */
  amount: number;
  refunded?: number;
  /** The policy's limit; null for a run that never reads the policy. */
  limit?: number | null;
  /** Emails sent before the refund, and after it. */
  emailsBefore?: number;
  emails?: number;
  argv?: string[];
  meta?: RunRecord['meta'];
  startedAt?: number;
  end?: 'completed' | 'failed' | null;
  /** What the order's lookup returned, when not the order and its amount. */
  looked?: Record<string, unknown>;
}

/** A refund run in the mock's shape: the order looked up (a read), the policy read, the refund issued (a write), an email sent (a write). */
function refund(store: Store, o: Refund): { runId: string; calls: Record<string, number> } {
  const b = RunBuilder.start(store, { argv: o.argv ?? ['node', 'agent.mjs'], ...(o.meta ? { meta: o.meta } : {}), ...(o.startedAt ? { startedAt: o.startedAt } : {}) });
  const calls: Record<string, number> = {};
  b.model({ messages: ASK }, [toolUse('lookup_order', { order_id: 'A-1042' }, 'toolu_1')]);
  calls.lookup_order = b.tool('lookup_order', { order_id: 'A-1042' }, o.looked ?? { order_id: 'A-1042', amount: o.amount });
  if (o.limit !== null) calls.get_policy = b.tool('get_policy', {}, { limit: o.limit ?? 100 }, { effect: 'pure' });
  for (let i = 0; i < (o.emailsBefore ?? 0); i++) calls.send_email = b.tool('send_email', { to: 'ada@example.com' }, { sent: true }, { effect: 'write' });
  calls.issue_refund = b.tool('issue_refund', { order_id: 'A-1042', amount: o.refunded ?? o.amount }, { refund_id: 'R-5401' }, { effect: 'write' });
  for (let i = 0; i < (o.emails ?? 1); i++) calls.send_email = b.tool('send_email', { to: 'ada@example.com' }, { sent: true }, { effect: 'write' });
  b.model({ messages: ASK }, [text('Refund issued for order A-1042.')]);
  const runId = o.end === null ? b.runId : b.end(o.end ?? 'completed');
  return { runId, calls };
}

const GOOD = { meta: { labels: ['good'] } };
const run = (store: Store, id: string) => store.getRun(id)!;
const read = (store: Store, id: string) => ({ run: run(store, id), calls: store.getCalls(id) });
const labels = (s: { suggestions: Array<{ label: string }> }) => s.suggestions.map((x) => x.label);

const VALUE = 'every issue_refund call: amount <= get_policy.result.limit';
const WHEN = 'when lookup_order has result.amount > 100: issue_refund called 0 times';

describe('suggested checks', () => {
  it('gives a write’s number at most a number an earlier call returned, and a condition on a read then the write it rules out', () => {
    const store = Store.open(':memory:');
    const good = refund(store, { amount: 80, ...GOOD, startedAt: 1_000 });
    const bad = refund(store, { amount: 240, startedAt: 2_000 });
    const out = suggestChecks(store, run(store, bad.runId));
    expect(out.goods.map((r) => r.runId)).toEqual([good.runId]);
    expect(out.suggestions).toEqual([
      { shape: 'value', expect: { calls: [{ tool: 'issue_refund', args: { amount: { '<=': '@get_policy.result.limit' } } }] }, label: VALUE },
      // The condition never held on the good run: not applicable there, which doesn't fail it.
      { shape: 'when', expect: { when: [{ if: { tool: 'lookup_order', result: { amount: { '>': 100 } } }, then: { tools: { issue_refund: 0 } } }] }, label: WHEN },
    ]);
  });

  it('gives an order every good run keeps, and a count every good run has', () => {
    const store = Store.open(':memory:');
    refund(store, { amount: 80, ...GOOD, startedAt: 1_000 });
    refund(store, { amount: 90, ...GOOD, startedAt: 1_500 });
    const bad = refund(store, { amount: 80, emailsBefore: 1, emails: 1, startedAt: 2_000 });
    const out = suggestChecks(store, run(store, bad.runId), { max: 60 });
    expect(out.suggestions.filter((s) => s.shape === 'order')).toEqual([{ shape: 'order', expect: { calls: [{ tool: 'send_email', after: 'issue_refund' }] }, label: 'every send_email call: after issue_refund' }]);
    expect(out.suggestions.filter((s) => s.shape === 'count')).toEqual([{ shape: 'count', expect: { tools: { send_email: 1 } }, label: 'send_email called 1 time' }]);
  });

  it('gives a count of 0 for a tool the run calls and no good run does', () => {
    const store = Store.open(':memory:');
    refund(store, { amount: 80, emails: 0, ...GOOD });
    const bad = refund(store, { amount: 80, emails: 1, startedAt: 2_000 });
    expect(suggestChecks(store, run(store, bad.runId), { max: 60 }).suggestions.filter((s) => s.shape === 'count').map((s) => s.label)).toEqual(['send_email called 0 times']);
  });

  it('keeps a rule only when its own result fails the run: a run failed by its exit status alone gives none', () => {
    const store = Store.open(':memory:');
    refund(store, { amount: 80, ...GOOD });
    const exited = refund(store, { amount: 80, end: 'failed', startedAt: 2_000 });
    expect(suggestChecks(store, run(store, exited.runId))).toMatchObject({ suggestions: [] });
  });

  it('drops a rule that fails one good run, or that a good run can’t settle', () => {
    const store = Store.open(':memory:');
    refund(store, { amount: 80, ...GOOD, startedAt: 1_000 });
    const bad = refund(store, { amount: 240, startedAt: 3_000 });
    expect(labels(suggestChecks(store, run(store, bad.runId)))).toContain(VALUE);
    // A good run refunding over the limit fails the value rule, and a good run over 100 fails the condition.
    const over = refund(store, { amount: 150, ...GOOD, startedAt: 1_500 });
    expect(labels(suggestChecks(store, run(store, bad.runId)))).not.toContain(VALUE);
    expect(labels(suggestChecks(store, run(store, bad.runId)))).not.toContain(WHEN);
    store.deleteRun(over.runId);
    // A good run whose order has no amount can't settle the condition: inconclusive there, never passed.
    const unsure = refund(store, { amount: 80, looked: { order_id: 'A-1042' }, ...GOOD, startedAt: 1_600 }).runId;
    const rule = parseExpect({ when: [{ if: { tool: 'lookup_order', result: { amount: { '>': 100 } } }, then: { tools: { issue_refund: 0 } } }] }, 'expect');
    expect(judgeRecording(store, run(store, unsure), store.getCalls(unsure), rule).checks.map((c) => c.status)).toEqual(['inconclusive']);
    expect(labels(suggestChecks(store, run(store, bad.runId)))).toEqual([VALUE]);
  });

  it('leaves out a rule the builder holds, the next taking its place, and gives no repeats', () => {
    const store = Store.open(':memory:');
    refund(store, { amount: 80, ...GOOD });
    const bad = run(store, refund(store, { amount: 240, startedAt: 2_000 }).runId);
    expect(labels(suggestChecks(store, bad, { max: 1 }))).toEqual([VALUE]);
    expect(labels(suggestChecks(store, bad, { max: 1, have: [VALUE] }))).toEqual([WHEN]);
    const all = labels(suggestChecks(store, bad, { max: 60 }));
    expect(new Set(all).size).toBe(all.length);
  });

  it('gives at most three, the shapes in turn', () => {
    const store = Store.open(':memory:');
    refund(store, { amount: 80, ...GOOD });
    const bad = refund(store, { amount: 240, emailsBefore: 1, emails: 1, startedAt: 2_000 });
    const out = suggestChecks(store, run(store, bad.runId));
    expect(SUGGESTED_MAX).toBe(3);
    expect(out.suggestions.map((s) => s.shape)).toEqual(['value', 'when', 'order']);
    expect(suggestChecks(store, run(store, bad.runId), { max: 60 }).suggestions.map((s) => s.shape)).toContain('count');
  });

  it('tries the write the check is made from first, else the run’s first write', () => {
    const store = Store.open(':memory:');
    const good = refund(store, { amount: 80, ...GOOD });
    const bad = refund(store, { amount: 240, startedAt: 2_000 });
    const [mine, goods] = [read(store, bad.runId), [read(store, good.runId)]];
    const whenThen = (at: number | null) => checkCandidates(store, mine, goods, { at }).find((c) => c.shape === 'when')!.expect.when![0].then;
    expect(whenThen(null)).toEqual({ tools: { issue_refund: 0 } });
    expect(whenThen(bad.calls.send_email)).toEqual({ tools: { send_email: 0 } });
    // A read the check is made from is no write: the run's first write comes first.
    expect(whenThen(bad.calls.lookup_order)).toEqual({ tools: { issue_refund: 0 } });
    expect(checkCandidates(store, mine, goods, { at: bad.calls.send_email }).find((c) => c.shape === 'order')!.label).toBe('every send_email call: after lookup_order');
  });

  it('reads the write the check is made from, and the fields before it, else the write’s first call', () => {
    const store = Store.open(':memory:');
    const g = RunBuilder.start(store, { argv: ['node', 'agent.mjs'], startedAt: 1_000, ...GOOD });
    g.tool('get_policy', {}, { limit: 100 }, { effect: 'pure' });
    g.tool('issue_refund', { amount: 80 }, { refund_id: 'R-1' }, { effect: 'write' });
    g.end();
    // The first refund comes before the policy is read: no field is recorded before it.
    const b = RunBuilder.start(store, { argv: ['node', 'agent.mjs'], startedAt: 2_000 });
    b.tool('issue_refund', { amount: 50 }, { refund_id: 'R-2' }, { effect: 'write' });
    b.tool('get_policy', {}, { limit: 100 }, { effect: 'pure' });
    const at = b.tool('issue_refund', { amount: 240 }, { refund_id: 'R-3' }, { effect: 'write' });
    const bad = run(store, b.end());
    expect(labels(suggestChecks(store, bad, { max: 60 }))).not.toContain(VALUE);
    expect(labels(suggestChecks(store, bad, { at, max: 60 }))).toContain(VALUE);
  });

  it('judges the other shapes when a write has more number candidates than one shape takes', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store, { argv: ['node', 'agent.mjs'], ...GOOD });
    b.tool('lookup_order', {}, { amount: 80, fee: 1, tax: 2, shipping: 3, items: 4, weight: 5 });
    b.tool('issue_refund', { amount: 80, fee: 1, tax: 2, shipping: 3 }, { ok: true }, { effect: 'write' });
    const good = b.end();
    const c = RunBuilder.start(store, { argv: ['node', 'agent.mjs'], startedAt: 1_760_000_100_000 });
    c.tool('lookup_order', {}, { amount: 240, fee: 1, tax: 2, shipping: 3, items: 4, weight: 5 });
    c.tool('issue_refund', { amount: 240, fee: 1, tax: 2, shipping: 3 }, { ok: true }, { effect: 'write' });
    c.tool('issue_refund', { amount: 240, fee: 1, tax: 2, shipping: 3 }, { ok: true }, { effect: 'write' });
    const bad = c.end();
    const cands = checkCandidates(store, read(store, bad), [read(store, good)]);
    expect(cands.filter((x) => x.shape === 'value')).toHaveLength(CANDIDATES_PER_SHAPE);
    expect(cands.some((x) => x.shape === 'when')).toBe(true);
    expect(labels(suggestChecks(store, run(store, bad), { max: 60 }))).toContain('issue_refund called 1 time');
  });

  it('gives nothing for a run with no good runs, a replay, or a run with no command', () => {
    const store = Store.open(':memory:');
    const alone = refund(store, { amount: 240 });
    expect(suggestChecks(store, run(store, alone.runId))).toEqual({ goods: [], suggestions: [] });
    refund(store, { amount: 80, argv: [], ...GOOD });
    const commandless = refund(store, { amount: 240, argv: [], startedAt: 2_000 });
    expect(suggestChecks(store, run(store, commandless.runId))).toEqual({ goods: [], suggestions: [] });
  });
});

describe('the good runs a failed recording is compared with', () => {
  it('are its fix’s good runs first, then the agent’s recordings labelled good, newest first', () => {
    const store = Store.open(':memory:');
    const older = refund(store, { amount: 80, ...GOOD, startedAt: 1_000 }).runId;
    const newer = refund(store, { amount: 90, ...GOOD, startedAt: 1_500 }).runId;
    const kept = refund(store, { amount: 70, startedAt: 1_200 }).runId;
    refund(store, { amount: 60, argv: ['python', 'other.py'], ...GOOD });
    const bad = refund(store, { amount: 240, startedAt: 2_000 }).runId;
    const fixId = 'fx-01M3RZ0000000000000000V5D0';
    store.insertFix({ fixId, title: 'Refund over the limit', labels: [], check: { expect: null, key: 'check:exit', oracle: [], text: 'the agent exits 0' }, status: 'open', openedAt: 3_000, verifiedAt: null, appliedAt: null, data: {} });
    store.addFixLink(fixId, 'failing', bad, 3_000);
    store.addFixLink(fixId, 'good', kept, 3_001);
    store.addFixLink(fixId, 'good', newer, 3_002);
    store.addFixLink(fixId, 'good', 'gone-run', 3_003);
    expect(goodRunsOf(store, run(store, bad)).map((r) => r.runId)).toEqual([kept, newer, older]);
    // In a fix's builder the fix is given; without one, the labelled runs alone.
    expect(goodRunsOf(store, run(store, bad), { fix: null }).map((r) => r.runId)).toEqual([newer, older]);
  });

  it('leave out the run itself, one still recording and a partial recording that holds no tool calls', () => {
    const store = Store.open(':memory:');
    const done = refund(store, { amount: 80, ...GOOD, startedAt: 1_000 }).runId;
    refund(store, { amount: 80, ...GOOD, end: null, startedAt: 1_100 });
    refund(store, { amount: 80, meta: { labels: ['good'], covers: ['api'] }, startedAt: 1_200 });
    const self = refund(store, { amount: 240, ...GOOD, startedAt: 2_000 }).runId;
    expect(goodRunsOf(store, run(store, self)).map((r) => r.runId)).toEqual([done]);
  });

  it('are none by label for a run with no command, though commandless runs labelled good exist', () => {
    const store = Store.open(':memory:');
    refund(store, { amount: 80, argv: [], ...GOOD });
    const bad = refund(store, { amount: 240, argv: [], startedAt: 2_000 }).runId;
    expect(goodRunsOf(store, run(store, bad))).toEqual([]);
  });

  it('are at most two hundred', () => {
    const store = Store.open(':memory:');
    for (let i = 0; i <= GOOD_RUNS_MAX; i++) {
      const b = RunBuilder.start(store, { argv: ['node', 'agent.mjs'], startedAt: 1_000 + i, ...GOOD });
      b.tool('lookup_order', {}, { amount: 80 });
      b.end();
    }
    const bad = refund(store, { amount: 240, startedAt: 9_000 }).runId;
    const goods = goodRunsOf(store, run(store, bad));
    expect(GOOD_RUNS_MAX).toBe(200);
    expect(goods).toHaveLength(200);
    expect(goods[0].startedAt).toBe(1_000 + GOOD_RUNS_MAX);
  });
});

describe('a threshold the run recorded', () => {
  it('is the largest other value below it and above 0, else none', () => {
    const fields = [
      { tool: 'lookup_order', field: 'amount', value: 240 },
      { tool: 'get_policy', field: 'limit', value: 100 },
      { tool: 'get_policy', field: 'floor', value: '20' },
      { tool: 'get_policy', field: 'none', value: 0 },
    ];
    expect(lowerRecorded(fields, fields[0])).toBe(100);
    expect(lowerRecorded(fields, fields[1])).toBe(20);
    expect(lowerRecorded(fields, fields[2])).toBeNull();
    expect(lowerRecorded(fields, { tool: 'x', field: 'y', value: 'many' })).toBeNull();
  });
});
