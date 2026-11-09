import { describe, expect, it } from 'vitest';
import { ancestorsOf, callTree, foldLabel, heads, itemWords, unfolded, type GroupCall } from '../ui/run/groups.js';
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
