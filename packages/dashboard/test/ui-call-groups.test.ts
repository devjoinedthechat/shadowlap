import { describe, expect, it } from 'vitest';
import { caretWords, groupName, pathOf, traceOf, traceRows, type TraceCall, type TraceGroup, type TraceOptions } from '../ui/run/groups.js';
import { times, timesOf } from '../../engine/test/timing.js';
import { forgetFolds, isOpen, setFolds } from '../ui/run/folds.js';

/**
 * Calls' trace: a model call's tool calls under it while nothing came between them, a sub-agent's
 * stretch and a batch's item under a row of its own, each group's facts and end line, the rows with
 * the folds taken out, and the folds kept for the session.
 */

type T = TraceCall & { effect?: string | null };
const m = (callNo: number, o: Partial<T> = {}): T => ({ callNo, kind: 'api', scope: null, conversation: 1, outcome: 'ok', origin: 'live', ...o });
const t = (callNo: number, requestedBy: number | null, o: Partial<T> = {}): T => ({ callNo, kind: 'tool', scope: null, conversation: 1, requestedBy, outcome: 'ok', origin: 'live', ...o });
const r = (callNo: number, kind: 'clock' | 'random', o: Partial<T> = {}): T => ({ callNo, kind, scope: null, conversation: 1, outcome: 'ok', origin: 'live', ...o });
const loud = (c: T) => (c.outcome === 'error' ? 'k-err' : c.effect === 'write' ? 'k-write' : null);
const allOpen = () => true;

/** Rows as `<call>:<depth>`, a group's as `g:<key>:<depth>`, the held one marked `^`. */
const rows = (calls: T[], o: TraceOptions<T> = {}, open: (g: TraceGroup) => boolean = allOpen, selected: number | null = null) =>
  traceRows(traceOf(calls, { loud, ...o }), open, selected).rows.map((x) => `${x.group && !x.call ? `g:${x.group.key}` : x.call.callNo}:${x.depth}${x.held ? '^' : ''}`);

describe('the trace: a model call’s tool calls', () => {
  it('puts each tool call under the model call that asked for it, while nothing else came between them', () => {
    const calls = [m(1), t(2, 1), t(3, 1), m(4), t(5, 4), m(6)];
    expect(rows(calls)).toEqual(['1:0', '2:1', '3:1', '4:0', '5:1', '6:0']);
    const tr = traceOf(calls);
    expect(caretWords(tr.heads.get(1)!, true)).toBe('Hide tool calls of #1');
    expect(caretWords(tr.heads.get(4)!, false)).toBe('Show tool call of #4');
    expect(tr.heads.has(6)).toBe(false);
    // A clock read, a random value and a tool after them stand at their level and close the group.
    expect(rows([r(1, 'clock'), m(2), t(3, 2), r(4, 'random'), m(5), t(6, 2)])).toEqual(['1:0', '2:0', '3:1', '4:0', '5:0', '6:0']);
  });

  it('leaves a list with no group as it was', () => {
    const tr = traceOf([m(1), m(2)]);
    expect(tr.grouped).toBe(false);
  });
});

describe('the trace: a sub-agent’s row', () => {
  const calls = [
    m(1, { scope: 'customer' }),
    m(2, { scope: 'agent', asks: ['ask_policy', 'lookup_order'] }),
    m(3, { scope: 'agent/policy-checker', asks: ['lookup_policy'], cost: 0.002 }),
    t(4, 3, { scope: 'agent/policy-checker' }),
    m(5, { scope: 'agent/policy-checker', cost: 0.002, resultShort: 'Above the $100 EU limit.' }),
    t(6, 2, { scope: 'agent' }),
    m(7, { scope: 'agent' }),
  ];

  it('makes a row of its calls under the model call that started it, grouped again within it', () => {
    expect(rows(calls)).toEqual(['1:0', '2:0', 'g:s3:1', '3:2', '4:3', '5:2', '6:1', '7:0']);
    const tr = traceOf(calls, { loud });
    const sub = pathOf(tr, 4)[1];
    expect([sub.kind, sub.agent, groupName(sub), sub.calls, sub.end]).toEqual(['sub', 'agent/policy-checker', 'policy-checker', 3, { text: 'Above the $100 EU limit.' }]);
    expect(sub.spent).toBeCloseTo(0.004);
    expect(caretWords(tr.heads.get(2)!, true)).toBe('Hide calls of #2');
    // Its calls leave their agent to its row.
    expect(traceRows(tr, allOpen, null).rows.filter((x) => x.sub).map((x) => x.call?.callNo)).toEqual([3, 4, 5]);
  });

  it('stands at its level where its parent asked for no tool, and alone where it is the agent picked', () => {
    const quiet = calls.map((c) => (c.callNo === 2 ? { ...c, asks: null } : c));
    expect(rows(quiet)).toEqual(['1:0', '2:0', 'g:s3:0', '3:1', '4:2', '5:1', '6:0', '7:0']);
    expect(rows(calls.filter((c) => c.scope === 'agent/policy-checker'), { base: 'agent/policy-checker' })).toEqual(['3:0', '4:1', '5:0']);
    expect(rows(calls.filter((c) => c.scope?.startsWith('agent')), { base: 'agent' })).toEqual(['2:0', 'g:s3:1', '3:2', '4:3', '5:2', '6:1', '7:0']);
  });

  it('makes a row for each stretch beside its parent, and goes under the call that spawned it', () => {
    const mixed = [calls[1], calls[2], calls[5], calls[4]];
    expect(rows(mixed)).toEqual(['2:0', 'g:s3:1', '3:2', '6:1', 'g:s5:1', '5:2']);
    const spawned = [m(1, { agent: 'claude-code', asks: ['Task'] }), m(2, { agent: 'claude-code/Explore', spawnedBy: 1 }), m(3, { agent: 'claude-code/Explore', spawnedBy: 9 })];
    expect(rows(spawned)).toEqual(['1:0', 'g:s2:1', '2:2', 'g:s3:0', '3:1']);
    expect(rows([spawned[0], m(5), spawned[2]])).toEqual(['1:0', '5:0', 'g:s3:0', '3:1']);
  });

  it('says what it spent only where every live model call is priced, and not on an imported run', () => {
    expect(traceOf(calls, { spend: false }).heads.get(2) && pathOf(traceOf(calls, { spend: false }), 4)[1].spent).toBeNull();
    const unpriced = calls.map((c) => (c.callNo === 5 ? { ...c, cost: null } : c));
    expect(pathOf(traceOf(unpriced), 4)[1].spent).toBeNull();
    const replayed = calls.map((c) => ({ ...c, origin: 'replayed' }));
    expect(pathOf(traceOf(replayed), 4)[1].spent).toBe(0);
  });
});

describe('the trace: a batch’s items', () => {
  const ticket = (k: number, at: number, o: { input?: string; end?: Partial<T> } = {}): T[] => [
    r(at, 'clock', { conversation: k }),
    m(at + 1, { conversation: k, asks: ['issue_refund'], conversationInput: o.input ?? null }),
    t(at + 2, at + 1, { conversation: k, effect: 'write' }),
    m(at + 3, { conversation: k, resultShort: `Refunded ticket ${k}.`, ...o.end }),
  ];

  it('makes a row of each conversation, its calls under it, the first three open', () => {
    const calls = [...ticket(1, 1, { input: 'Ticket T-9101: order A-2001 arrived damaged' }), ...ticket(2, 5)];
    expect(rows(calls)).toEqual(['g:i1:0', '1:1', '2:1', '3:2', '4:1', 'g:i2:0', '5:1', '6:1', '7:2', '8:1']);
    const tr = traceOf(calls, { loud });
    const [one, two] = [pathOf(tr, 1)[0], pathOf(tr, 5)[0]];
    expect([groupName(one), groupName(two)]).toEqual(['Ticket T-9101: order A-2001 arrived damaged', 'conversation 2 of 2']);
    expect([one.calls, [...one.loud], one.end]).toEqual([4, [['k-write', 1]], { text: 'Refunded ticket 1.' }]);
    const forty = Array.from({ length: 40 }, (_, i) => ticket(i + 1, 4 * i + 1)).flat();
    const shown = traceRows(traceOf(forty), (g) => !g.shut, null).rows;
    expect(shown.filter((x) => !x.call).length).toBe(40);
    expect(shown.length).toBe(40 + 3 * 4);
  });

  it('says how each ended: its answer, the model call that failed, or in progress while the run records it', () => {
    const failed = (k: number, at: number, end: Partial<T>) => ticket(k, at, { end: { outcome: 'error', resultShort: null, ...end } });
    const calls = [...failed(1, 1, { status: 529 }), ...failed(2, 5, { status: null, error: 'Error: socket hang up' }), ...failed(3, 9, { status: null, error: null }), ...ticket(4, 13).slice(0, 3)];
    const tr = traceOf(calls, { live: true });
    // A failed model call in its row's words: its HTTP status, else its error, else `error`.
    expect([1, 5, 9, 13].map((n) => pathOf(tr, n)[0].end)).toEqual([
      { text: 'HTTP 529 at #4', err: true },
      { text: 'Error: socket hang up at #8', err: true },
      { text: 'error at #12', err: true },
      { text: 'in progress', progress: true },
    ]);
  });

  it('leaves calls with no conversation number at the top until they are known, unless a later call of the item follows them', () => {
    const two = [...ticket(1, 1), ...ticket(2, 5)];
    const both = ['g:i1:0', '1:1', '2:1', '3:2', '4:1', 'g:i2:0', '5:1', '6:1', '7:2', '8:1'];
    // A page read before the run's conversations were numbered, right after the last item read.
    const deep = [m(9, { conversation: null, asks: ['lookup'] }), t(10, 9, { conversation: null }), m(11, { conversation: null })];
    expect(rows([...two, ...deep])).toEqual([...both, '9:0', '10:1', '11:0']);
    expect(pathOf(traceOf([...two, ...deep]), 11)).toEqual([]);
    // A recording's clock read that waits for the model call it feeds, the next ticket's.
    const waiting = [...two, r(9, 'clock', { conversation: null }), ...ticket(3, 9).slice(1)];
    expect(rows(waiting)).toEqual([...both, '9:0', 'g:i3:0', '10:1', '11:2', '12:1']);
    // Among an item's calls, as a request that is no conversation's turn (an embedding), it stays in the item.
    const embedded = [...ticket(1, 1).slice(0, 3), m(4, { conversation: null }), m(5, { conversation: 1 }), ...ticket(2, 6)];
    expect(rows(embedded)).toEqual(['g:i1:0', '1:1', '2:1', '3:2', '4:1', '5:1', 'g:i2:0', '6:1', '7:1', '8:2', '9:1']);
  });

  it('leaves a call of shadowlap’s own and one not read yet at the top, and a sub-agent’s conversations no item', () => {
    const judge = m(9, { scope: 'shadowlap:judge', conversation: 3, reserved: true });
    expect(rows([...ticket(1, 1), ...ticket(2, 5).slice(0, 2), { callNo: 7, pending: true }, ...ticket(2, 5).slice(3), judge])).toEqual(['g:i1:0', '1:1', '2:1', '3:2', '4:1', 'g:i2:0', '5:1', '6:1', '7:0', 'g:i2@8:0', '8:1', '9:0']);
    const spawned = [m(1, { agent: 'a', conversation: 1, asks: ['Task'] }), m(2, { agent: 'a/b', conversation: 2, spawnedBy: 1 }), m(3, { agent: 'a/b', conversation: 3, spawnedBy: 1 })];
    expect(rows(spawned)).toEqual(['1:0', 'g:s2:1', '2:2', '3:2']);
  });

  it('holds the selection in the outermost folded group around it', () => {
    const calls = [...ticket(1, 1), ...ticket(2, 5)];
    const shut = new Set(['i2', 'm2']);
    expect(rows(calls, {}, (g) => !shut.has(g.key), 3)).toEqual(['g:i1:0', '1:1', '2:1^', '4:1', 'g:i2:0']);
    expect(rows(calls, {}, (g) => !shut.has(g.key), 7)).toEqual(['g:i1:0', '1:1', '2:1', '4:1', 'g:i2:0^']);
  });
});

describe('the trace at scale', () => {
  it('works through fifty thousand calls in one pass', () => {
    const big: T[] = [];
    for (let i = 1; i <= 50_000; i += 2) big.push(m(i), t(i + 1, i));
    const tr = traceOf(big, { loud });
    expect(traceRows(tr, () => false, null).rows).toHaveLength(25_000);
    const took = timesOf({ tree: () => traceRows(traceOf(big, { loud }), allOpen, 49_999), index: () => new Map(big.map((c, i) => [c.callNo, i])) });
    expect(took.tree, `the pass took ${times(took.tree, took.index)} indexing the calls`).toBeLessThan(30 * took.index);
  });
});

describe('the folds, kept for the session', () => {
  it('opens every group but a batch’s items past the third, until folded or opened, per run', () => {
    const forty = Array.from({ length: 5 }, (_, i) => [m(2 * i + 1, { conversation: i + 1, asks: ['x'] }), t(2 * i + 2, 2 * i + 1, { conversation: i + 1 })]).flat();
    const items = traceRows(traceOf(forty), allOpen, null).rows.filter((x) => !x.call).map((x) => x.group);
    expect(items.map((g) => isOpen('a', g))).toEqual([true, true, true, false, false]);
    setFolds('a', ['i1', 'i5'], false);
    setFolds('a', ['i5'], true);
    expect(items.map((g) => isOpen('a', g))).toEqual([false, true, true, false, true]);
    expect(items.map((g) => isOpen('b', g))).toEqual([true, true, true, false, false]);
    forgetFolds();
    expect(isOpen('a', items[0])).toBe(true);
  });
});
