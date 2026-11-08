import { describe, expect, it } from 'vitest';
import { ancestorsOf, callTree, caretWords, foldLabel, groupName, heads, itemWords, pathOf, traceOf, traceRows, unfolded, type GroupCall, type TraceCall, type TraceGroup, type TraceOptions } from '../ui/run/groups.js';
import { times, timesOf } from '../../engine/test/timing.js';

/**
 * Light grouping in Calls: each call under the call it belongs to, the list itself as it was. A tool
 * call under the model call that asked for it; a sub-agent's work under the model call whose tool
 * started it; in a batch, each conversation under its first call.
 */

const api = (callNo: number, o: Partial<GroupCall> = {}): GroupCall => ({ callNo, kind: 'api', scope: null, conversation: 1, ...o });
const tool = (callNo: number, requestedBy: number | null, o: Partial<GroupCall> = {}): GroupCall => ({ callNo, kind: 'tool', scope: null, conversation: 1, requestedBy, ...o });
const read = (callNo: number, kind: 'clock' | 'random', o: Partial<GroupCall> = {}): GroupCall => ({ callNo, kind, scope: null, conversation: 1, ...o });

const shape = (calls: GroupCall[]) => {
  const t = callTree(calls);
  return calls.map((c, i) => `${c.callNo}:${t.depth[i]}${t.kids[i] ? `+${t.kids[i]}` : ''}`);
};

describe('the calls of an agent loop', () => {
  it('put each tool call under the model call that asked for it', () => {
    const calls = [api(1), tool(2, 1), tool(3, 1), api(4), tool(5, 4), api(6)];
    expect(shape(calls)).toEqual(['1:0+2', '2:1', '3:1', '4:0+1', '5:1', '6:0']);
    const t = callTree(calls);
    expect([...t.parent]).toEqual([
      [2, 1],
      [3, 1],
      [5, 4],
    ]);
    expect(t.grouped).toBe(true);
    expect(heads(calls, t)).toEqual([1, 4]);
  });

  it('put a read before the first model call at the top, and one after a model call under it', () => {
    expect(shape([read(1, 'clock'), api(2), tool(3, 2), read(4, 'random'), api(5)])).toEqual(['1:0', '2:0+2', '3:1', '4:1', '5:0']);
    // A run of reads alone groups nothing.
    expect(callTree([read(1, 'clock'), read(2, 'random')]).grouped).toBe(false);
  });

  it('keep a tool call whose model call is left out of the list, or not read yet, at the top', () => {
    expect(shape([tool(5, 4), api(6)])).toEqual(['5:0', '6:0']);
    expect(shape([api(1), { callNo: 2, pending: true }, tool(3, 1)])).toEqual(['1:0', '2:0', '3:0']);
  });
});

describe('a sub-agent', () => {
  it('goes under the model call whose tool started it, its own tool calls under its model calls', () => {
    const calls = [
      api(1, { scope: 'customer', conversation: 1 }),
      api(2, { scope: 'agent', conversation: 2 }),
      api(3, { scope: 'agent/policy-checker', conversation: 3 }),
      tool(4, 3, { scope: 'agent/policy-checker', conversation: 3 }),
      api(5, { scope: 'agent/policy-checker', conversation: 3 }),
      api(6, { scope: 'agent', conversation: 2 }),
      api(7, { scope: 'customer', conversation: 1 }),
    ];
    expect(shape(calls)).toEqual(['1:0', '2:0+3', '3:1+1', '4:2', '5:1', '6:0', '7:0']);
    expect(ancestorsOf(callTree(calls), 4)).toEqual([3, 2]);
    // Two agents with one conversation each: no batch.
    expect(callTree(calls).items.size).toBe(0);
  });

  it('that runs beside another goes under the nearest call of its own still open', () => {
    const calls = [api(1, { scope: 'agent' }), api(2, { scope: 'agent/a', conversation: 2 }), api(3, { scope: 'agent/b', conversation: 3 }), tool(4, 2, { scope: 'agent/a', conversation: 2 }), api(5, { scope: 'agent' })];
    // #4 belongs to #2, which #3 closed: it goes under #1, beside them.
    expect(shape(calls)).toEqual(['1:0+3', '2:1', '3:1', '4:1', '5:0']);
  });
});

describe('the agents of a run without scopes', () => {
  // Claude Code's main session (#1) starts its Explore subagent with the Task tool; the server names both.
  const main = { agent: 'claude-code', conversation: 1 };
  const sub = { agent: 'claude-code/Explore', conversation: 2, spawnedBy: 1 };

  it('put a subagent under the model call whose tool started it, though no scope says so', () => {
    const calls = [api(1, main), api(2, sub), tool(3, 2, sub), api(4, sub), tool(5, 1, main), api(6, main)];
    expect(shape(calls)).toEqual(['1:0+4', '2:1+1', '3:2', '4:1', '5:1', '6:0']);
    // Its conversation is no batch item, though the run holds two.
    expect(callTree(calls).items.size).toBe(0);
  });

  it('count a batch among one agent’s conversations, never across agents', () => {
    const planner = (callNo: number, conversation: number) => api(callNo, { agent: 'planner', conversation });
    const calls = [planner(1, 1), api(2, { agent: 'executor', conversation: 2 }), planner(3, 3)];
    expect([...callTree(calls).items]).toEqual([
      [1, { n: 1, of: 2 }],
      [3, { n: 2, of: 2 }],
    ]);
    // Two agents with one conversation each: no batch, where a run grouped by scope alone made one.
    expect(callTree([api(1, { agent: 'triage-agent', conversation: 1 }), api(2, { agent: 'summarizer', conversation: 2 })]).items.size).toBe(0);
  });

  it('put a call no agent is named for under its scope’s latest model call, as before', () => {
    expect(shape([api(1, main), read(2, 'clock', { conversation: null })])).toEqual(['1:0+1', '2:1']);
  });
});

describe('a batch', () => {
  it('puts each conversation under its first call, its model calls and their tools under that', () => {
    const one = [read(1, 'clock', { conversation: 1 }), read(2, 'random', { conversation: 1 }), api(3, { conversation: 1 }), tool(4, 3, { conversation: 1 }), api(5, { conversation: 1 })];
    const two = [read(6, 'clock', { conversation: 2 }), read(7, 'random', { conversation: 2 }), api(8, { conversation: 2 }), tool(9, 8, { conversation: 2 }), api(10, { conversation: 2 })];
    const calls = [...one, ...two];
    expect(shape(calls)).toEqual(['1:0+4', '2:1', '3:1+1', '4:2', '5:1', '6:0+4', '7:1', '8:1+1', '9:2', '10:1']);
    const t = callTree(calls);
    expect([...t.items]).toEqual([
      [1, { n: 1, of: 2 }],
      [6, { n: 2, of: 2 }],
    ]);
    expect(itemWords(t.items.get(6)!)).toBe('conversation 2 of 2');
    // Folded, each item is a row.
    expect(unfolded(calls, t, new Set([1, 6])).map((c) => c.callNo)).toEqual([1, 6]);
  });
});

describe('folding', () => {
  const calls = [api(1), tool(2, 1), tool(3, 1), api(4), tool(5, 4), api(6)];
  const t = callTree(calls);

  it('hides what is under a folded head, and keeps the head', () => {
    expect(unfolded(calls, t, new Set([1])).map((c) => c.callNo)).toEqual([1, 4, 5, 6]);
    expect(unfolded(calls, t, new Set([4])).map((c) => c.callNo)).toEqual([1, 2, 3, 4, 6]);
    // A call that heads nothing folds nothing.
    expect(unfolded(calls, t, new Set([6])).map((c) => c.callNo)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(unfolded(calls, t, new Set())).toBe(calls);
  });

  it('says what a fold mark does, for a screen reader', () => {
    expect(foldLabel(1, 2, false)).toBe('Hide the 2 calls under #1');
    expect(foldLabel(4, 1, true)).toBe('Show the call under #4');
  });

  it('works through a run of fifty thousand calls in one pass', () => {
    const big: GroupCall[] = [];
    for (let i = 1; i <= 50_000; i += 2) big.push(api(i), tool(i + 1, i));
    const tree = callTree(big);
    expect(tree.depth[1]).toBe(1);
    expect(unfolded(big, tree, new Set(heads(big, tree)))).toHaveLength(25_000);
    // Held against this machine, not a number of milliseconds: the pass takes about three times as
    // long as indexing the calls by number, where one that looks back over every earlier call for each
    // takes over a hundred times as long. Under 30 times leaves room for both and fails it.
    const t = timesOf({ tree: () => callTree(big), index: () => new Map(big.map((c, i) => [c.callNo, i])) });
    expect(t.tree, `the pass took ${times(t.tree, t.index)} indexing the calls`).toBeLessThan(30 * t.index);
  });
});

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
    const calls = [...ticket(1, 1, { end: { outcome: 'error', status: 529, resultShort: null } }), ...ticket(2, 5, { end: { outcome: 'error', status: null, error: 'Error: socket hang up', resultShort: null } }), ...ticket(3, 9).slice(0, 3)];
    const tr = traceOf(calls, { live: true });
    expect([1, 5, 9].map((n) => pathOf(tr, n)[0].end)).toEqual([
      { text: 'HTTP 529 at #4', err: true },
      { text: 'Error: socket hang up at #8', err: true },
      { text: 'in progress', progress: true },
    ]);
  });

  it('leaves a call of Shadowlap’s own and one not read yet at the top, and a sub-agent’s conversations no item', () => {
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
