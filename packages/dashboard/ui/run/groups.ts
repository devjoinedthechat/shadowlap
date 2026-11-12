import { num } from '../format.js';

/**
 * Calls groups the trace lightly: the list keeps call order, and no call moves.
 *
 * - A tool call sits one step in under the model call that asked for it (`requestedBy`), while
 *   nothing else came between them. Any other call (a clock read, a person's answer, a tool no open
 *   model call asked for) stands at its level and closes the model call's group.
 * - The calls a sub-agent made one after another are a group with a row that names it: its path
 *   (`agent`, else `scope`) cut to one part below the agent picked above the views (`agent/policy-
 *   checker` under All or under `agent`). The row sits under the model call that started it: the one
 *   its first call was spawned by (`spawnedBy`), else its parent's open model call when that one
 *   asked for tools; else it stands at its level. A sub-agent beside its parent makes a row for each
 *   stretch, and so does each of its conversations a tool started. Its calls are grouped again with
 *   it as the base.
 * - A batch, a top agent with two or more conversations of its own (none a sub-agent's, none in
 *   one of Shadowlap's own scopes), has a row for each stretch of each conversation, its calls under
 *   it; the calls before its first item, a call not read yet and a call of Shadowlap's own stand at
 *   the top. So do calls with no conversation number that no later call of the item follows: a page
 *   read before the run's conversations were numbered, a recording's call that waits for the model
 *   call it feeds. Items past their agent's third are folded until opened.
 *
 * A group's row says its calls, its loud ones and, for a sub-agent, what it spent, and how it ended.
 *
 * No DOM here: the tests import it, and `CallsView.tsx` draws it.
 */

/** What the grouping reads of a call: a call not read yet has its number alone. */
export interface GroupCall {
  callNo: number;
  kind?: string;
  scope?: string | null;
  agent?: string | null;
  spawnedBy?: number | null;
  requestedBy?: number | null;
  conversation?: number | null;
  pending?: true;
}

/** What a batch's item says beside its first call: `conversation 3 of 40`. */
const itemWords = (it: { n: number; of: number }): string => `conversation ${num(it.n)} of ${num(it.of)}`;

/** What the trace reads of a call beyond GroupCall, for the rows its groups draw. */
export interface TraceCall extends GroupCall {
  asks?: string[] | null;
  reserved?: true;
  conversationInput?: string | null;
  origin?: string | null;
  outcome?: 'ok' | 'error' | null;
  status?: number | null;
  error?: string | null;
  cost?: number | null;
  resultShort?: string | null;
}

export type TraceGroupKind = 'model' | 'sub' | 'item';

/** How a group ended: its last answer, the model call that failed (red), or `in progress` while the run records it. */
export interface TraceEnd {
  text: string;
  err?: true;
  progress?: true;
}

export interface TraceGroup {
  kind: TraceGroupKind;
  /**
   * Its fold key, kept for the session: `m<call>` for a model call's tool calls, `s<first call>` for a
   * sub-agent's stretch, `i<conversation>` for a batch's item (`i<conversation>@<first call>` for a
   * later stretch of the same conversation).
   */
  key: string;
  /** The group it sits in; null at the top. */
  parent: TraceGroup | null;
  /** Its row's depth, or its model call's. */
  depth: number;
  /** A model call's group: that call's number. */
  head: number | null;
  /** A sub-agent's path, its row naming its last part. */
  agent: string | null;
  /** A batch's item: its conversation, its place among its agent's conversations, and what it was asked (null when not known). */
  item: { conversation: number; n: number; of: number; input: string | null } | null;
  /** Folded until opened: a batch's item past its agent's third. */
  shut: boolean;
  /** The rows right under it, and whether all of them are calls (no sub-agent's row): its caret's words. */
  rows: number;
  toolsOnly: boolean;
  /** Its calls at every depth: how many, and the first and last call numbers. */
  calls: number;
  first: number;
  last: number;
  /** Its loud calls (TraceOptions.loud), by code, in the order first met. */
  loud: Map<string, number>;
  /** What its live model calls cost; null where one has no price, or the run's spend isn't told (TraceOptions.spend). */
  spent: number | null;
  end: TraceEnd | null;
}

export interface TraceOptions<C> {
  /** The agent picked above the views, or null under All. */
  base?: string | null;
  /** The key's code a call counts under on its group's row when it is loud (a write, an error; what a fork changed), else null. */
  loud?: (c: C) => string | null;
  /** Whether a sub-agent's row says what it spent: not on a run imported from a pack or a capture. */
  spend?: boolean;
  /** Whether the run still records: a group holding its newest call is `in progress`, unless that call ended its turn. */
  live?: boolean;
}

interface TraceNode<C> {
  /** A call's row; null for a sub-agent's or an item's. */
  call: C | null;
  /** The group it heads: a model call's when calls sit under it, or the sub-agent's or item's. */
  group: TraceGroup | null;
  kids: TraceNode<C>[];
}

export interface Trace<C> {
  nodes: readonly TraceNode<C>[];
  /** Whether any group formed: a list with none draws as it did. */
  grouped: boolean;
  /** The innermost group each call sits in (its own model call's group aside); its path goes up by `parent`. */
  within: ReadonlyMap<number, TraceGroup>;
  /** A model call's own group, by its number. */
  heads: ReadonlyMap<number, TraceGroup>;
}

export type TraceRow<C> = { call: C; group: null; depth: number; head: TraceGroup | null; held: boolean; sub: boolean } | { call: null; group: TraceGroup; depth: number; head: null; held: boolean; sub: boolean };

/** How many of a batch's items are open until folded. */
export const ITEMS_OPEN = 3;

const agentPath = (c: GroupCall): string => c.agent ?? c.scope ?? '';

/** A call read with no conversation number: not known yet, or a request that is no conversation's turn (an embedding, a token count). */
const unnumbered = (c: TraceCall): boolean => !c.pending && !c.reserved && typeof c.conversation !== 'number';

/** The sub-agent a call was made in, one part below `base`: `agent/policy-checker` under All or under `agent`; none in `base` itself. */
function subIn(c: GroupCall, base: string): string {
  if (c.pending) return '';
  const s = agentPath(c);
  if (!s || s === base || (base && !s.startsWith(`${base}/`))) return '';
  const parts = s.split('/');
  const k = base ? base.split('/').length : 1;
  return parts.length > k ? parts.slice(0, k + 1).join('/') : '';
}

function newGroup(kind: TraceGroupKind, key: string, parent: TraceGroup | null, depth: number): TraceGroup {
  return { kind, key, parent, depth, head: null, agent: null, item: null, shut: false, rows: 0, toolsOnly: true, calls: 0, first: 0, last: 0, loud: new Map(), spent: 0, end: null };
}

/** Whether a sub-agent's stretch, starting at `first`, goes under the open model call `open`. */
function hosts(open: TraceCall, first: TraceCall, sub: string): boolean {
  if (typeof first.spawnedBy === 'number') return first.spawnedBy === open.callNo;
  return agentPath(open) === sub.slice(0, sub.lastIndexOf('/')) && !!open.asks?.length;
}

/** The batches' conversations: each top agent's own, where it has two or more, with its place among them and what it was asked. */
function batchesOf(calls: readonly TraceCall[]): Map<number, { n: number; of: number; input: string | null }> {
  const byAgent = new Map<string, number[]>();
  const inputs = new Map<number, string>();
  for (const c of calls) {
    if (c.pending || c.reserved || typeof c.conversation !== 'number') continue;
    if (c.conversationInput && !inputs.has(c.conversation)) inputs.set(c.conversation, c.conversationInput);
    if (c.kind !== 'api' || typeof c.spawnedBy === 'number') continue;
    const a = agentPath(c);
    if (a.includes('/')) continue;
    const list = byAgent.get(a) ?? [];
    if (!list.includes(c.conversation)) list.push(c.conversation);
    byAgent.set(a, list);
  }
  const out = new Map<number, { n: number; of: number; input: string | null }>();
  for (const list of byAgent.values()) if (list.length > 1) list.forEach((conv, i) => out.set(conv, { n: i + 1, of: list.length, input: inputs.get(conv) ?? null }));
  return out;
}

class TraceBuilder<C extends TraceCall> {
  readonly within = new Map<number, TraceGroup>();
  readonly heads = new Map<number, TraceGroup>();
  constructor(private readonly calls: readonly C[]) {}

  /** The calls `from` to `to` at one level under `parent`, `base` the agent the level is of. */
  level(from: number, to: number, base: string, parent: TraceGroup | null, depth: number): TraceNode<C>[] {
    const out: TraceNode<C>[] = [];
    let open: TraceNode<C> | null = null;
    for (let i = from; i < to; ) {
      const c = this.calls[i]!;
      const sub = subIn(c, base);
      if (sub) {
        const j = this.stretch(i, to, base, sub);
        const host = open && hosts(open.call!, c, sub) ? open : null;
        const up = host ? this.headOf(host, parent, depth) : parent;
        const g = newGroup('sub', `s${c.callNo}`, up, host ? depth + 1 : depth);
        g.agent = sub;
        const node: TraceNode<C> = { call: null, group: g, kids: this.level(i, j, sub, g, g.depth + 1) };
        if (host) host.kids.push(node);
        else {
          out.push(node);
          open = null;
        }
        i = j;
        continue;
      }
      const node: TraceNode<C> = { call: c, group: null, kids: [] };
      if (!c.pending && c.kind === 'tool' && open && c.requestedBy === open.call!.callNo) {
        this.within.set(c.callNo, this.headOf(open, parent, depth));
        open.kids.push(node);
      } else {
        if (parent) this.within.set(c.callNo, parent);
        out.push(node);
        open = !c.pending && c.kind === 'api' ? node : null;
      }
      i++;
    }
    return out;
  }

  /** Where a sub-agent's stretch from `i` ends: at a call made elsewhere, or one of another conversation of it that a tool started. */
  stretch(i: number, to: number, base: string, sub: string): number {
    const own = (x: C) => (agentPath(x) === sub && typeof x.spawnedBy === 'number' ? x.spawnedBy : null);
    let by = own(this.calls[i]!);
    let j = i + 1;
    for (; j < to && subIn(this.calls[j]!, base) === sub; j++) {
      const s = own(this.calls[j]!);
      if (s === null) continue;
      if (by !== null && s !== by) break;
      by = s;
    }
    return j;
  }

  /** A model call's group, made as the first call goes under it. */
  headOf(node: TraceNode<C>, parent: TraceGroup | null, depth: number): TraceGroup {
    if (!node.group) {
      node.group = newGroup('model', `m${node.call!.callNo}`, parent, depth);
      node.group.head = node.call!.callNo;
      this.heads.set(node.call!.callNo, node.group);
    }
    return node.group;
  }

  /** The run's calls at the top, a batch's items cut out of them. */
  top(base: string): TraceNode<C>[] {
    const place = batchesOf(this.calls);
    if (!place.size) return this.level(0, this.calls.length, base, null, 0);
    const out: TraceNode<C>[] = [];
    const seen = new Set<number>();
    let cur: number | null = null;
    let from = 0;
    const flush = (to: number) => {
      if (from >= to) return;
      if (cur === null) out.push(...this.level(from, to, base, null, 0));
      else {
        const first = this.calls[from]!.callNo;
        const g = newGroup('item', seen.has(cur) ? `i${cur}@${first}` : `i${cur}`, null, 0);
        seen.add(cur);
        g.item = { conversation: cur, ...place.get(cur)! };
        g.shut = g.item.n > ITEMS_OPEN;
        out.push({ call: null, group: g, kids: this.level(from, to, base, g, 1) });
      }
      from = to;
    };
    for (let i = 0; i < this.calls.length; i++) {
      const c = this.calls[i]!;
      if (cur !== null && unnumbered(c)) {
        // Calls with no conversation number stay in the item while a later call of it follows them;
        // else they stand at the top until they are known, as a call not read yet does.
        const j = this.numberedFrom(i + 1);
        if (!this.continues(j, cur, place)) {
          flush(i);
          cur = null;
        }
        i = j - 1;
        continue;
      }
      const conv = !c.pending && !c.reserved && typeof c.conversation === 'number' && place.has(c.conversation) ? c.conversation : null;
      if (conv !== null && conv !== cur) {
        flush(i);
        cur = conv;
      } else if ((c.pending || c.reserved) && cur !== null) {
        flush(i);
        cur = null;
      }
    }
    flush(this.calls.length);
    return out;
  }

  /** The first call from `i` that has a conversation number, or is not read yet, or is one of Shadowlap's own; the calls' length when none is. */
  numberedFrom(i: number): number {
    let j = i;
    while (j < this.calls.length && unnumbered(this.calls[j]!)) j++;
    return j;
  }

  /** Whether the call at `j` goes on with item `cur`: one of its conversation, or of one inside it (a sub-agent's, a nested scope's). */
  continues(j: number, cur: number, place: ReadonlyMap<number, unknown>): boolean {
    const c = this.calls[j];
    if (!c || c.pending || c.reserved || typeof c.conversation !== 'number') return false;
    return c.conversation === cur || !place.has(c.conversation);
  }
}

/** What a group's calls add up to, worked out from its rows: the latest call, model call, and model call that said something. */
interface Tally<C> {
  last: C | null;
  model: C | null;
  said: C | null;
}

const later = <C extends TraceCall>(a: C | null, b: C | null): C | null => (!a ? b : !b ? a : b.callNo > a.callNo ? b : a);

function count<C extends TraceCall>(g: TraceGroup, c: C, o: TraceOptions<C>): void {
  g.calls++;
  if (!g.first || c.callNo < g.first) g.first = c.callNo;
  if (c.callNo > g.last) g.last = c.callNo;
  const k = c.pending ? null : (o.loud?.(c) ?? null);
  if (k) g.loud.set(k, (g.loud.get(k) ?? 0) + 1);
  if (g.spent !== null && c.kind === 'api' && c.origin === 'live') g.spent = typeof c.cost === 'number' ? g.spent + c.cost : null;
}

/** A group's facts, from every call under it, in one walk of its rows. */
function finish<C extends TraceCall>(node: TraceNode<C>, o: TraceOptions<C>, newest: number, into: TraceGroup[]): Tally<C> {
  const g = node.group;
  let t: Tally<C> = { last: null, model: null, said: null };
  const add = (c: C) => {
    if (c.pending) return void (t.last = later(t.last, c));
    t = { last: later(t.last, c), model: c.kind === 'api' ? later(t.model, c) : t.model, said: c.kind === 'api' && c.resultShort ? later(t.said, c) : t.said };
  };
  if (node.call) add(node.call);
  for (const kid of node.kids) {
    const k = finish(kid, o, newest, into);
    t = { last: later(t.last, k.last), model: later(t.model, k.model), said: later(t.said, k.said) };
  }
  if (!g) return t;
  into.push(g);
  g.rows = node.kids.length;
  g.toolsOnly = node.kids.every((k) => k.call !== null);
  if (o.spend === false) g.spent = null;
  g.end = endOf(t, !!o.live, newest);
  return t;
}

function endOf<C extends TraceCall>(t: Tally<C>, live: boolean, newest: number): TraceEnd | null {
  const { last, model } = t;
  const ended = !!model && model === last && model.outcome === 'ok' && !model.asks?.length;
  if (live && last?.callNo === newest && !ended) return { text: 'in progress', progress: true };
  // A model call that failed, in its row's words (calls.ts callDetail): its HTTP status, else its error.
  if (model?.outcome === 'error') return { text: `${model.status ? `HTTP ${model.status}` : (model.error ?? 'error')} at #${model.callNo}`, err: true };
  return t.said?.resultShort ? { text: t.said.resultShort } : null;
}

/** Each group's calls counted: every call is counted in each group that holds it, at every depth. */
function countAll<C extends TraceCall>(nodes: readonly TraceNode<C>[], holders: TraceGroup[], o: TraceOptions<C>): void {
  for (const node of nodes) {
    if (node.call) for (const g of holders) count(g, node.call, o);
    if (node.group) {
      holders.push(node.group);
      if (node.call) count(node.group, node.call, o);
      countAll(node.kids, holders, o);
      holders.pop();
    } else countAll(node.kids, holders, o);
  }
}

/** The calls of a run grouped as Calls draws them (see above), in one pass and a walk of what it built. */
export function traceOf<C extends TraceCall>(calls: readonly C[], o: TraceOptions<C> = {}): Trace<C> {
  const b = new TraceBuilder(calls);
  const nodes = b.top(o.base ?? '');
  countAll(nodes, [], o);
  const groups: TraceGroup[] = [];
  const newest = calls.at(-1)?.callNo ?? 0;
  for (const node of nodes) finish(node, o, newest, groups);
  return { nodes, grouped: groups.length > 0, within: b.within, heads: b.heads };
}

/** The groups that hold a call, outermost first: a model call's own group is not one of them. */
export function pathOf<C>(t: Trace<C>, callNo: number): TraceGroup[] {
  const out: TraceGroup[] = [];
  for (let g = t.within.get(callNo) ?? null; g && out.length < 10_000; g = g.parent) out.unshift(g);
  return out;
}

/**
 * The rows Calls draws, the folds taken out: each call with its depth, a group's row where a
 * sub-agent's or an item's group starts, and the held row, the outermost folded group that holds the
 * selection, which carries the selection's ground. `open` says whether a group is open.
 */
export function traceRows<C>(t: Trace<C>, open: (g: TraceGroup) => boolean, selected: number | null): { rows: TraceRow<C>[]; held: TraceGroup | null } {
  const held = selected === null ? null : (pathOf(t, selected).find((g) => !open(g)) ?? null);
  const rows: TraceRow<C>[] = [];
  const walk = (nodes: readonly TraceNode<C>[], depth: number, sub: boolean) => {
    for (const node of nodes) {
      const g = node.group;
      if (node.call) rows.push({ call: node.call, group: null, depth, head: g, held: !!g && g === held, sub });
      else rows.push({ call: null, group: g!, depth, head: null, held: g === held, sub });
      if (g && node.kids.length && open(g)) walk(node.kids, depth + 1, sub || g.kind === 'sub');
    }
  };
  walk(t.nodes, 0, false);
  return { rows, held };
}

/** A model call's caret, as it says on hover and to a screen reader: `Hide tool call of #17`, `Hide tool calls of #27`, `Show calls of #2` (a sub-agent among them). */
export function caretWords(g: TraceGroup, open: boolean): string {
  return `${open ? 'Hide' : 'Show'} ${g.toolsOnly ? 'tool call' : 'call'}${g.toolsOnly && g.rows === 1 ? '' : 's'} of #${String(g.head)}`;
}

/** A group row's name: a sub-agent's last part, an item's input, else its place among its agent's conversations (`conversation 3 of 40`). */
export function groupName(g: TraceGroup): string {
  if (g.agent) return g.agent.slice(g.agent.lastIndexOf('/') + 1);
  return g.item ? (g.item.input ?? itemWords(g.item)) : '';
}
