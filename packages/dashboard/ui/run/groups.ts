import { num } from '../format.js';

/**
 * Light grouping in Calls: the list stays the run's calls in their order, each call given a depth
 * under the call it belongs to, so a group folds away under its head and opens again, and nothing
 * else about the list changes (its rows, their order, what a row shows, the window it is drawn in).
 *
 * - A tool call goes under the model call that asked for it (`requestedBy`, the server's), and any
 *   other call (a clock read, a person's answer, a tool no model asked for) under the latest model
 *   call of its own scope and conversation.
 * - A sub-agent, a scope inside another (`agent/policy-checker` in `agent`), goes under the latest
 *   model call of the scope that called it: the call whose tool started it.
 * - In a batch, a run that works through several conversations one after another in one scope (an
 *   overnight batch of tickets), each conversation is an item: its first call heads it, and every
 *   other call of it goes under that.
 *
 * A call can only go under a call still open above it: one that comes after a later group has
 * started (agents running at once) goes under the nearest of its own that is, or at the top. No DOM
 * here: the tests import it, and `CallsView.tsx` draws it.
 */

/** What the grouping reads of a call: a call not read yet has its number alone. */
export interface GroupCall {
  callNo: number;
  kind?: string;
  scope?: string | null;
  requestedBy?: number | null;
  conversation?: number | null;
  pending?: true;
}

export interface CallTree {
  /** Each row's depth, by its place in the list: 0 at the top. */
  depth: Int32Array;
  /** How many rows follow each one under it: what folding it hides. */
  kids: Int32Array;
  /** The call each call sits under, by call number; absent at the top. */
  parent: ReadonlyMap<number, number>;
  /** A row's place in the list, by call number. */
  index: ReadonlyMap<number, number>;
  /** The calls that head a batch's item: which conversation of how many in their scope. */
  items: ReadonlyMap<number, { n: number; of: number }>;
  /** Whether any call has a call under it: a list with none draws no fold marks. */
  grouped: boolean;
}

const scopeOf = (c: GroupCall) => c.scope ?? '';
const parentScope = (s: string) => {
  const at = s.lastIndexOf('/');
  return at < 0 ? null : s.slice(0, at);
};
const convKey = (scope: string, conversation: number | null | undefined) => `${scope}\n${conversation ?? ''}`;

/** The batches' items: in each top scope with several conversations, the first call of each, with its place among them. */
function batchItems(calls: readonly GroupCall[]): Map<number, { n: number; of: number; scope: string; conversation: number }> {
  // The conversations each top scope's model calls take part in, in the order they start.
  const convs = new Map<string, number[]>();
  for (const c of calls) {
    if (c.pending || c.kind !== 'api' || typeof c.conversation !== 'number') continue;
    const s = scopeOf(c);
    if (s.includes('/')) continue;
    const list = convs.get(s) ?? [];
    if (!list.includes(c.conversation)) list.push(c.conversation);
    convs.set(s, list);
  }
  const out = new Map<number, { n: number; of: number; scope: string; conversation: number }>();
  const headed = new Set<string>();
  for (const c of calls) {
    if (c.pending || typeof c.conversation !== 'number') continue;
    const s = scopeOf(c);
    const list = convs.get(s);
    if (!list || list.length < 2 || !list.includes(c.conversation)) continue;
    const key = convKey(s, c.conversation);
    if (headed.has(key)) continue;
    headed.add(key);
    out.set(c.callNo, { n: list.indexOf(c.conversation) + 1, of: list.length, scope: s, conversation: c.conversation });
  }
  return out;
}

/** The calls of a run grouped as Calls draws them (see the module's comment), in one pass. */
export function callTree(calls: readonly GroupCall[]): CallTree {
  const n = calls.length;
  const depth = new Int32Array(n);
  const kids = new Int32Array(n);
  const parent = new Map<number, number>();
  const index = new Map<number, number>();
  const heads = batchItems(calls);
  // The item each batch conversation is, by its scope and conversation: its head's call number.
  const itemOf = new Map<string, number>();
  for (const [callNo, it] of heads) itemOf.set(convKey(it.scope, it.conversation), callNo);
  // The latest model call of each scope, and of each scope and conversation.
  const lastInScope = new Map<string, number>();
  const lastInConv = new Map<string, number>();
  // The calls still open above the one placed: each the one under the one before it.
  const stack: number[] = [];
  const open = new Set<number>();
  const depthOf = new Map<number, number>();

  const close = (to: number) => {
    while (stack.length > to) open.delete(stack.pop()!);
  };
  /** The latest model call of a scope above `s`, nearest first: the call a sub-agent's work goes under. */
  const callerOf = (s: string): number | null => {
    for (let p = parentScope(s); p !== null; p = parentScope(p)) {
      const m = lastInScope.get(p);
      if (m !== undefined) return m;
    }
    return null;
  };

  for (let i = 0; i < n; i++) {
    const c = calls[i]!;
    index.set(c.callNo, i);
    if (c.pending) {
      // Not read yet: nothing says where it goes, and what was open above it can't be told to go on.
      close(0);
      depthOf.set(c.callNo, 0);
      continue;
    }
    const s = scopeOf(c);
    const item = itemOf.get(convKey(s, c.conversation)) ?? null;
    let want: number | null;
    if (heads.has(c.callNo)) want = null;
    else if (c.kind === 'tool' && typeof c.requestedBy === 'number') want = c.requestedBy;
    else if (c.kind === 'api') want = s.includes('/') ? callerOf(s) : item;
    else {
      // Its conversation's latest model call; in a batch never another conversation's, so before its
      // own first model call it goes under its item; else its scope's latest, or its caller's.
      const own = typeof c.conversation === 'number' ? lastInConv.get(convKey(s, c.conversation)) : undefined;
      want = own ?? (item !== null ? item : (lastInScope.get(s) ?? (s.includes('/') ? callerOf(s) : null)));
    }
    // Under the call it belongs to, or the nearest call of that call's own still open, else at the top.
    let at: number | null = want;
    while (at !== null && !open.has(at)) at = parent.get(at) ?? null;
    if (at === null) close(0);
    else {
      close(stack.indexOf(at) + 1);
      parent.set(c.callNo, at);
    }
    const d = at === null ? 0 : depthOf.get(at)! + 1;
    depth[i] = d;
    depthOf.set(c.callNo, d);
    stack.push(c.callNo);
    open.add(c.callNo);
    if (c.kind === 'api') {
      lastInScope.set(s, c.callNo);
      lastInConv.set(convKey(s, c.conversation), c.callNo);
    }
  }
  // How many rows follow each one under it, by the depths: a row's group ends at the next row no deeper.
  const below: number[] = [];
  for (let i = 0; i < n; i++) {
    while (below.length && depth[below.at(-1)!]! >= depth[i]!) {
      const k = below.pop()!;
      kids[k] = i - k - 1;
    }
    below.push(i);
  }
  for (const k of below) kids[k] = n - k - 1;
  let grouped = false;
  for (let i = 0; i < n && !grouped; i++) if (kids[i]! > 0) grouped = true;
  return { depth, kids, parent, index, items: new Map([...heads].map(([k, v]) => [k, { n: v.n, of: v.of }])), grouped };
}

/** The rows a list shows with some groups folded: a folded head stays, what is under it goes. */
export function unfolded<C extends { callNo: number }>(calls: readonly C[], tree: CallTree, folded: ReadonlySet<number>): C[] {
  if (!folded.size) return calls as C[];
  const out: C[] = [];
  let hideBelow = Infinity;
  for (let i = 0; i < calls.length; i++) {
    const d = tree.depth[i]!;
    if (d > hideBelow) continue;
    hideBelow = Infinity;
    const c = calls[i]!;
    out.push(c);
    if (folded.has(c.callNo) && tree.kids[i]! > 0) hideBelow = d;
  }
  return out;
}

/** The calls a call sits under, the nearest first. */
export function ancestorsOf(tree: CallTree, callNo: number): number[] {
  const out: number[] = [];
  for (let p = tree.parent.get(callNo); p !== undefined && out.length < 10_000; p = tree.parent.get(p)) out.push(p);
  return out;
}

/** Every call that heads a group: what Fold all folds. */
export function heads(calls: readonly { callNo: number }[], tree: CallTree): number[] {
  const out: number[] = [];
  for (let i = 0; i < calls.length; i++) if (tree.kids[i]! > 0) out.push(calls[i]!.callNo);
  return out;
}

/** A head's fold mark, as a screen reader hears it: `Hide the 3 calls under #5`, or `Show` them. */
export function foldLabel(callNo: number, kids: number, folded: boolean): string {
  return `${folded ? 'Show' : 'Hide'} the ${kids === 1 ? 'call' : `${num(kids)} calls`} under #${callNo}`;
}

/** What a batch's item says beside its first call: `conversation 3 of 40`. */
export const itemWords = (it: { n: number; of: number }): string => `conversation ${num(it.n)} of ${num(it.of)}`;
