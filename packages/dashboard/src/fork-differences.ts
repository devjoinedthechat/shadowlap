import { applyNormalizers, canonicalize, clipText, compareDecisions, effectsOf, finalAnswer, isHandover, isJudgeCall, outcomeLabel, RANK_LABELS, rewriteText, type CallRecord, type DecisionCall, type DecisionChangeKind, type DecisionRank, type Effect, type ModelDecision, type Normalizer, type RunStatus, type StoreOf } from '@shadowlap/engine';
import { lookupRun } from './api.js';
import { links } from './links.js';
import { loadRunIndex, type IndexedRun } from './run-index.js';

/**
 * What a fork did differently from the run it forked from, from the call it left that run at on:
 * the tool calls it made that its parent didn't and the other way round, the tools it called with
 * other arguments, its writes and what became of each, and how each run ended. Every change is
 * ranked as `shadowlap decisions` ranks a changed decision (engine decisions.ts): a write first,
 * then how the run ended (a check coming out otherwise is a change of rank 2, as a judge check reading
 * the words otherwise is there), then reads added or removed, reads asked differently, and the
 * words of its last answer. Arguments and words are compared after the project's normalizers, so an
 * id or a time made anew is no change. A plain function of the store, for `GET /api/runs/:id/differences`.
 */

export type ForkChangeKind = DecisionChangeKind | 'ended';

export interface ForkChange {
  rank: DecisionRank;
  kind: ForkChangeKind;
  /** The tool it is about, for a tool call's change. */
  tool: string | null;
  /** What the tool does, by the runs' effects: a tool no run gives one counts as a write. */
  effect: Effect | 'unknown' | null;
  /** The change in a few words: `issue_refund is no longer called`. */
  detail: string;
  /** The parent's side and the fork's, in a line: arguments, how the run ended, its last words. */
  before: string | null;
  after: string | null;
  /** Where each side is: the call in the parent's run and in the fork's, when it is a call. */
  parent: { callNo: number; href: string } | null;
  fork: { callNo: number; href: string } | null;
}

export interface ForkEnd {
  status: RunStatus;
  failed: boolean;
  /** How it ended, in the lists' words: `2 checks passed`, `failed: send_email called 1 time`, `interrupted`. */
  words: string;
  tone: 'ok' | 'err' | 'warn' | 'n';
}

export interface ForkWrite {
  callNo: number;
  tool: string;
  /** Its arguments, in a line. */
  args: string;
  /** What became of it: fenced (`blocked`, `stubbed`), run for real (`live`), answered by a flag (`overridden`), or `failed`. */
  fate: 'blocked' | 'stubbed' | 'live' | 'overridden' | 'replayed' | 'failed';
  href: string;
}

export interface ForkDifferences {
  runId: string;
  parentRunId: string;
  /** The call the fork left its parent at: everything before it replayed as recorded. */
  from: number;
  /** The most consequential change, or null when the fork did as its parent did. */
  rank: DecisionRank | null;
  /** Each change, most consequential first. */
  changes: ForkChange[];
  ended: { parent: ForkEnd; fork: ForkEnd };
  /** The fork's writes from where it left its parent on, in order. */
  writes: ForkWrite[];
  /** The tool calls each run made from there, as compared. */
  toolCalls: { parent: number; fork: number };
  /** True when a run made more tool calls from there than are compared (`MAX_TOOL_CALLS`). */
  cut: boolean;
  /** What each rank means, as `decisions` words it. */
  ranks: Record<DecisionRank, string>;
}

/** The tool calls compared on each side: the differences a page can show, not a transcript. */
export const MAX_TOOL_CALLS = 2000;
const VALUE_SHOWN = 120;

const oneLine = (v: unknown, max = VALUE_SHOWN): string => {
  const s = typeof v === 'string' ? JSON.stringify(v) : (JSON.stringify(v) ?? 'null');
  const flat = s.replace(/\s+/g, ' ');
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** A tool call's arguments as stored (`{ args }`), masked by the project's normalizers for that tool. */
function argsOf(store: StoreOf<'recording'>, c: CallRecord, normalizers: readonly Normalizer[]): unknown {
  let request: unknown;
  try {
    request = c.requestRef ? store.getJson(c.requestRef) : null;
  } catch {
    request = null;
  }
  const args = request && typeof request === 'object' && 'args' in request ? (request).args : request;
  if (!normalizers.length) return args;
  return (applyNormalizers({ args }, [...normalizers], 'tool', c.name) as { args: unknown }).args;
}

/** The agent's own tool calls from `from` on: a person's answers (`user_input`) and a judge's calls are no decisions of the agent's. */
function toolCallsFrom(calls: readonly CallRecord[], from: number): CallRecord[] {
  return calls.filter((c) => c.callNo >= from && c.kind === 'tool' && c.meta.input !== true && !isJudgeCall(c));
}

function endOf(r: IndexedRun): ForkEnd {
  const o = r.outcome;
  const base = { status: r.status, failed: r.failed };
  if (r.status === 'running') return { ...base, words: 'still running', tone: 'n' };
  if (r.failed) {
    if (o.kind === 'check-failed') return { ...base, words: o.check ? `failed: ${o.check}` : 'exited with an error', tone: 'err' };
    if (o.kind === 'lost') return { ...base, words: `failed, lost at #${o.callNo}`, tone: 'err' };
    if (o.kind === 'diverged') return { ...base, words: `diverged at #${o.callNo}`, tone: 'err' };
    return { ...base, words: 'failed', tone: 'err' };
  }
  if (r.status === 'crashed') return { ...base, words: 'interrupted', tone: 'n' };
  if (o.kind === 'inconclusive') return { ...base, words: `check inconclusive${o.check ? `: ${o.check}` : ''}`, tone: 'warn' };
  if (o.kind === 'passed') return { ...base, words: outcomeLabel(o), tone: 'ok' };
  if (o.kind === 'clean') return { ...base, words: 'replayed clean', tone: 'ok' };
  return { ...base, words: r.status === 'failed' ? 'exited with an error' : 'exited 0', tone: 'n' };
}

/** How the two runs ended, as a change of rank 2 when they ended otherwise. */
function endedChange(parent: ForkEnd, fork: ForkEnd): ForkChange | null {
  if (parent.words === fork.words && parent.failed === fork.failed) return null;
  const detail = fork.failed && !parent.failed ? 'it fails, where its parent did not' : parent.failed && !fork.failed ? 'it does not fail, where its parent did' : 'it ends otherwise';
  return { rank: 2, kind: 'ended', tool: null, effect: null, detail, before: parent.words, after: fork.words, parent: null, fork: null };
}

/** What a fenced or answered call became, from its origin and how it ended. */
function fateOf(c: CallRecord): ForkWrite['fate'] {
  if (c.origin === 'blocked' || c.origin === 'stubbed' || c.origin === 'overridden' || c.origin === 'replayed') return c.origin;
  return c.end?.outcome === 'error' ? 'failed' : 'live';
}

/**
 * What the fork `idOrPrefix` did differently from its parent; null for a run that isn't a fork of a
 * run in the store (a recording, a clean replay, a fork whose parent was deleted).
 */
export function forkDifferences(store: StoreOf<'recording' | 'readModels'>, idOrPrefix: string, options: { normalizers?: readonly Normalizer[] } = {}): ForkDifferences | null {
  const run = lookupRun(store, idOrPrefix);
  if (!run || run.mode !== 'replay' || !run.parentRunId || !run.divergence) return null;
  const parent = store.getRun(run.parentRunId);
  if (!parent) return null;
  const index = loadRunIndex(store);
  const ownRow = index.byId.get(run.runId);
  const parentRow = index.byId.get(parent.runId);
  if (!ownRow || !parentRow) return null;
  const from = run.divergence.callNo;
  const normalizers = options.normalizers ?? [];
  const parentCalls = store.getCalls(parent.runId);
  const forkCalls = store.getCalls(run.runId);
  const parentTools = toolCallsFrom(parentCalls, from);
  const forkTools = toolCallsFrom(forkCalls, from);
  const cut = parentTools.length > MAX_TOOL_CALLS || forkTools.length > MAX_TOOL_CALLS;
  const shownParent = parentTools.slice(0, MAX_TOOL_CALLS);
  const shownFork = forkTools.slice(0, MAX_TOOL_CALLS);

  // Each side as a decision: its tool calls in order, its last words, whom it handed over to.
  const effects = effectsOf([...parentCalls, ...forkCalls]);
  const effectOf = (tool: string): Effect | null => effects.get(tool) ?? null;
  const side = (calls: CallRecord[], all: CallRecord[]) => {
    const tools: DecisionCall[] = calls.map((c) => ({ name: c.name, args: argsOf(store, c, normalizers) }));
    const handover = [...tools].reverse().find((t) => isHandover(t.name))?.name ?? null;
    const words = finalAnswer(store, all) ?? '';
    // Masked as decisions masks a model's words: what a normalizer masks is no change.
    const text = normalizers.length ? rewriteText(words, [...normalizers]) : words;
    const decision: ModelDecision = { stop: 'answer', stopReason: null, tools, text: text.replace(/\s+/g, ' ').trim(), handover };
    // Where each call was, by what it called with, to link a change to its call.
    const at = new Map<string, number[]>();
    tools.forEach((t, i) => {
      const key = `${t.name}\u0000${canonicalize(t.args ?? null)}`;
      at.set(key, [...(at.get(key) ?? []), calls[i]!.callNo]);
    });
    return { decision, at };
  };
  const was = side(shownParent, parentCalls);
  const now = side(shownFork, forkCalls);
  const compared = compareDecisions(was.decision, now.decision, effectOf);
  const callOf = (where: Map<string, number[]>, tool: string | null, args: unknown): number | null => {
    if (!tool || args === null || args === undefined) return null;
    const list = where.get(`${tool}\u0000${canonicalize(args)}`);
    return list?.shift() ?? null;
  };

  const changes: ForkChange[] = compared.changes.map((c) => {
    const parentCall = c.kind === 'text' || c.kind === 'write-order' ? null : callOf(was.at, c.tool, c.before);
    const forkCall = c.kind === 'text' || c.kind === 'write-order' ? null : callOf(now.at, c.tool, c.after);
    const line = (v: unknown) => (v === null || v === undefined ? null : c.kind === 'text' ? oneLine(clipText(String(v), VALUE_SHOWN)) : oneLine(v));
    return {
      rank: c.rank,
      kind: c.kind,
      tool: c.tool,
      effect: c.effect,
      detail: c.detail,
      before: line(c.before),
      after: line(c.after),
      parent: parentCall !== null ? { callNo: parentCall, href: links.run(parent.runId, parentCall) } : null,
      fork: forkCall !== null ? { callNo: forkCall, href: links.run(run.runId, forkCall) } : null,
    };
  });
  const ended = { parent: endOf(parentRow), fork: endOf(ownRow) };
  const end = endedChange(ended.parent, ended.fork);
  if (end) changes.push(end);
  changes.sort((a, b) => a.rank - b.rank);

  // A tool no run gives an effect counts as a write, as decisions counts it: nothing says it doesn't act on the world.
  const isWrite = (c: CallRecord) => {
    const e = c.effect ?? effectOf(c.name);
    return e === 'write' || e === null;
  };
  const writes: ForkWrite[] = shownFork.filter(isWrite).map((c) => ({ callNo: c.callNo, tool: c.name, args: oneLine(argsOf(store, c, normalizers)), fate: fateOf(c), href: links.run(run.runId, c.callNo) }));

  return {
    runId: run.runId,
    parentRunId: parent.runId,
    from,
    rank: changes[0]?.rank ?? null,
    changes,
    ended,
    writes,
    toolCalls: { parent: parentTools.length, fork: forkTools.length },
    cut,
    ranks: RANK_LABELS,
  };
}
