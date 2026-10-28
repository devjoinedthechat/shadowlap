import { canonicalize } from './canonical.js';
import { isFailedOutcome, outcomeLabel, type RunOutcome } from './classify.js';
import { clipText, compareDecisions, effectsOf, isHandover, type DecisionCall, type DecisionChangeKind, type DecisionRank, type ModelDecision } from './decisions.js';
import { isJudgeCall } from './judge-scope.js';
import { applyNormalizers, rewriteText } from './normalize.js';
import { finalAnswer } from './responses.js';
import type { StoreOf } from './store.js';
import type { CallRecord, Effect, Normalizer, RunRecord, RunStatus } from './types.js';

/**
 * What a fork did differently from the run it forked from, from the call it left that run at on, as
 * the dashboard's fork banner and the terminal UI's diff tab both show it: the tool calls it made
 * that its parent didn't and the other way round, the tools it called with other arguments, its
 * writes and what became of each, and how each run ended. Every change is ranked as `shadowlap
 * decisions` ranks a changed decision (decisions.ts): a write first, then how the run ended (a check
 * coming out otherwise is a change of rank 2, as a judge check reading the words otherwise is there),
 * then reads added or removed, reads asked differently, and the words of its last answer. Arguments
 * and words are compared after the project's normalizers, so an id or a time made anew is no change.
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
  /** The call it is about in the parent's run and in the fork's, when it is a call. */
  parentCallNo: number | null;
  forkCallNo: number | null;
}

/** How a run ended, as the fork banner says it. `tone` is null for an end neither good nor bad (still running, interrupted, an exit). */
export interface ForkEnd {
  status: RunStatus;
  failed: boolean;
  /** How it ended, in the lists' words: `2 checks passed`, `failed: send_email called 1 time`, `interrupted`. */
  words: string;
  tone: 'ok' | 'err' | 'warn' | null;
}

export interface ForkWrite {
  callNo: number;
  tool: string;
  /** Its arguments, in a line. */
  args: string;
  /** What became of it: fenced (`blocked`, `stubbed`), run for real (`live`), answered by a flag (`overridden`), replayed, or `failed`. */
  fate: 'blocked' | 'stubbed' | 'live' | 'overridden' | 'replayed' | 'failed';
}

export interface ForkComparison {
  /** The call the fork left its parent at: everything before it replayed as recorded. */
  from: number;
  /** Each change, most consequential first. */
  changes: ForkChange[];
  ended: { parent: ForkEnd; fork: ForkEnd };
  /** The fork's writes from where it left its parent on, in order. */
  writes: ForkWrite[];
  /** The tool calls each run made from there, as compared. */
  toolCalls: { parent: number; fork: number };
  /** The words of each run's last answer, as compared: masked, on one line. */
  words: { parent: string; fork: string };
  /** True when a run made more tool calls from there than are compared (`MAX_TOOL_CALLS`). */
  cut: boolean;
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
  const args = request && typeof request === 'object' && 'args' in request ? request.args : request;
  if (!normalizers.length) return args;
  return (applyNormalizers({ args }, [...normalizers], 'tool', c.name) as { args: unknown }).args;
}

/** The agent's own tool calls from `from` on: a person's answers (`user_input`) and a judge's calls are no decisions of the agent's. */
function toolCallsFrom(calls: readonly CallRecord[], from: number): CallRecord[] {
  return calls.filter((c) => c.callNo >= from && c.kind === 'tool' && c.meta.input !== true && !isJudgeCall(c));
}

/**
 * How a run ended, as the fork banner says it: by its outcome, and `failed` as the run's lists count
 * it (by default, its outcome's: diverged, lost, or a failed check).
 */
export function forkEnd(status: RunStatus, outcome: RunOutcome, failed: boolean = isFailedOutcome(outcome)): ForkEnd {
  const o = outcome;
  const base = { status, failed };
  if (status === 'running') return { ...base, words: 'still running', tone: null };
  if (failed) {
    if (o.kind === 'check-failed') return { ...base, words: o.check ? `failed: ${o.check}` : 'exited with an error', tone: 'err' };
    if (o.kind === 'lost') return { ...base, words: `failed, lost at #${o.callNo}`, tone: 'err' };
    if (o.kind === 'diverged') return { ...base, words: `diverged at #${o.callNo}`, tone: 'err' };
    return { ...base, words: 'failed', tone: 'err' };
  }
  if (status === 'crashed') return { ...base, words: 'interrupted', tone: null };
  if (o.kind === 'inconclusive') return { ...base, words: `check inconclusive${o.check ? `: ${o.check}` : ''}`, tone: 'warn' };
  if (o.kind === 'passed') return { ...base, words: outcomeLabel(o), tone: 'ok' };
  if (o.kind === 'clean') return { ...base, words: 'replayed clean', tone: 'ok' };
  return { ...base, words: status === 'failed' ? 'exited with an error' : 'exited 0', tone: null };
}

/** How the two runs ended, as a change of rank 2 when they ended otherwise. */
function endedChange(parent: ForkEnd, fork: ForkEnd): ForkChange | null {
  if (parent.words === fork.words && parent.failed === fork.failed) return null;
  const detail = fork.failed && !parent.failed ? 'it fails, where its parent did not' : parent.failed && !fork.failed ? 'it does not fail, where its parent did' : 'it ends otherwise';
  return { rank: 2, kind: 'ended', tool: null, effect: null, detail, before: parent.words, after: fork.words, parentCallNo: null, forkCallNo: null };
}

/** What a fenced or answered call became, from its origin and how it ended. */
function fateOf(c: CallRecord): ForkWrite['fate'] {
  if (c.origin === 'blocked' || c.origin === 'stubbed' || c.origin === 'overridden' || c.origin === 'replayed') return c.origin;
  return c.end?.outcome === 'error' ? 'failed' : 'live';
}

/** One side as a decision: its tool calls in order, its last words, whom it handed over to; and where each call was, by what it called with. */
function decisionOf(store: StoreOf<'recording'>, calls: readonly CallRecord[], all: CallRecord[], normalizers: readonly Normalizer[]): { decision: ModelDecision; at: Map<string, number[]> } {
  const tools: DecisionCall[] = calls.map((c) => ({ name: c.name, args: argsOf(store, c, normalizers) }));
  const handover = [...tools].reverse().find((t) => isHandover(t.name))?.name ?? null;
  const words = finalAnswer(store, all) ?? '';
  // Masked as decisions masks a model's words: what a normalizer masks is no change.
  const text = normalizers.length ? rewriteText(words, [...normalizers]) : words;
  const decision: ModelDecision = { stop: 'answer', stopReason: null, tools, text: text.replace(/\s+/g, ' ').trim(), handover };
  // Where each call was, by what it called with, to name a change's call.
  const at = new Map<string, number[]>();
  tools.forEach((t, i) => {
    const key = `${t.name}\u0000${canonicalize(t.args ?? null)}`;
    at.set(key, [...(at.get(key) ?? []), calls[i]!.callNo]);
  });
  return { decision, at };
}

/**
 * What `run`, a fork of `parent`, did differently from it; null for a run that is no fork (a
 * recording, a replay that never forked). `ended` says how each ended, as the caller counts a run's
 * outcome (the dashboard from its run index): forkEnd words it.
 */
export function compareFork(store: StoreOf<'recording'>, run: RunRecord, parent: RunRecord, ended: { parent: ForkEnd; fork: ForkEnd }, options: { normalizers?: readonly Normalizer[] } = {}): ForkComparison | null {
  if (run.mode !== 'replay' || !run.divergence) return null;
  const from = run.divergence.callNo;
  const normalizers = options.normalizers ?? [];
  const parentCalls = store.getCalls(parent.runId);
  const forkCalls = store.getCalls(run.runId);
  const parentTools = toolCallsFrom(parentCalls, from);
  const forkTools = toolCallsFrom(forkCalls, from);
  const shownParent = parentTools.slice(0, MAX_TOOL_CALLS);
  const shownFork = forkTools.slice(0, MAX_TOOL_CALLS);

  const effects = effectsOf([...parentCalls, ...forkCalls]);
  const effectOf = (tool: string): Effect | null => effects.get(tool) ?? null;
  const was = decisionOf(store, shownParent, parentCalls, normalizers);
  const now = decisionOf(store, shownFork, forkCalls, normalizers);
  const compared = compareDecisions(was.decision, now.decision, effectOf);
  const callOf = (where: Map<string, number[]>, tool: string | null, args: unknown): number | null => {
    if (!tool || args === null || args === undefined) return null;
    const list = where.get(`${tool}\u0000${canonicalize(args)}`);
    return list?.shift() ?? null;
  };
  const changes: ForkChange[] = compared.changes.map((c) => {
    const calls = c.kind !== 'text' && c.kind !== 'write-order';
    const line = (v: unknown) => (v === null || v === undefined ? null : c.kind === 'text' ? oneLine(clipText(String(v), VALUE_SHOWN)) : oneLine(v));
    return { rank: c.rank, kind: c.kind, tool: c.tool, effect: c.effect, detail: c.detail, before: line(c.before), after: line(c.after), parentCallNo: calls ? callOf(was.at, c.tool, c.before) : null, forkCallNo: calls ? callOf(now.at, c.tool, c.after) : null };
  });
  const end = endedChange(ended.parent, ended.fork);
  if (end) changes.push(end);
  changes.sort((a, b) => a.rank - b.rank);

  // A tool no run gives an effect counts as a write, as decisions counts it: nothing says it doesn't act on the world.
  const isWrite = (c: CallRecord) => {
    const e = c.effect ?? effectOf(c.name);
    return e === 'write' || e === null;
  };
  const writes: ForkWrite[] = shownFork.filter(isWrite).map((c) => ({ callNo: c.callNo, tool: c.name, args: oneLine(argsOf(store, c, normalizers)), fate: fateOf(c) }));
  return {
    from,
    changes,
    ended,
    writes,
    toolCalls: { parent: parentTools.length, fork: forkTools.length },
    words: { parent: was.decision.text, fork: now.decision.text },
    cut: parentTools.length > MAX_TOOL_CALLS || forkTools.length > MAX_TOOL_CALLS,
  };
}
