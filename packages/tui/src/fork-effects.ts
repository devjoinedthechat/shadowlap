import {
  applyNormalizers,
  clipText,
  compareDecisions,
  effectsOf,
  finalAnswer,
  isFailedOutcome,
  isHandover,
  isJudgeCall,
  outcomeLabel,
  RANK_LABELS,
  rewriteText,
  type CallRecord,
  type DecisionRank,
  type Effect,
  type ModelDecision,
  type Normalizer,
  type RunOutcome,
  type RunRecord,
  type StoreOf,
} from '@shadowlap/engine';
import { outcomeFor, type Tone } from './verdict.js';

/**
 * What a fork did differently from its parent, from the call it forked at on, as the dashboard's
 * fork banner works it out (packages/dashboard/src/fork-differences.ts): each side's tool calls as
 * one decision, compared by the engine's `compareDecisions` and ranked as `shadowlap decisions`
 * ranks a change, a write first; how each run ended; the fork's writes and what became of them.
 */
export interface ForkChange {
  rank: DecisionRank;
  detail: string;
  before: string | null;
  after: string | null;
  tone: Tone;
}

export interface ForkEnd {
  words: string;
  failed: boolean;
  tone: Tone;
}

export interface ForkWrite {
  callNo: number;
  tool: string;
  args: string;
  fate: 'blocked' | 'stubbed' | 'overridden' | 'replayed' | 'failed' | 'live';
}

export interface ForkEffects {
  /** The highest-ranked change, in `shadowlap decisions`' words: `a write changed`. */
  most: string | null;
  changes: ForkChange[];
  ended: { parent: ForkEnd; fork: ForkEnd };
  writes: ForkWrite[];
  words: { parent: string | null; fork: string | null };
  /** True when a run made more tool calls from the fork on than are compared. */
  cut: boolean;
}

/** The tool calls compared on each side: the differences a pane can show, not a transcript. */
export const MAX_TOOL_CALLS = 2000;
const VALUE_SHOWN = 120;

const oneLine = (v: unknown, max = VALUE_SHOWN): string => {
  const s = typeof v === 'string' ? JSON.stringify(v) : (JSON.stringify(v) ?? 'null');
  const flat = s.replace(/\s+/g, ' ');
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** A tool call's arguments as stored, masked by the project's normalizers for that tool. */
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

/** The agent's own tool calls from `from` on: a person's answers and a judge's calls are no decisions of the agent's. */
function toolCallsFrom(calls: readonly CallRecord[], from: number): CallRecord[] {
  return calls.filter((c) => c.callNo >= from && c.kind === 'tool' && c.meta.input !== true && !isJudgeCall(c));
}

/** How a run ended, as the fork banner says it. */
export function endOf(run: RunRecord, o: RunOutcome): ForkEnd {
  const failed = isFailedOutcome(o);
  if (run.status === 'running') return { words: 'still running', failed, tone: 'info' };
  if (failed) {
    if (o.kind === 'check-failed') return { words: o.check ? `failed: ${o.check}` : 'exited with an error', failed, tone: 'err' };
    if (o.kind === 'lost') return { words: `failed, lost at #${o.callNo}`, failed, tone: 'err' };
    if (o.kind === 'diverged') return { words: `diverged at #${o.callNo}`, failed, tone: 'err' };
    return { words: 'failed', failed, tone: 'err' };
  }
  if (run.status === 'crashed') return { words: 'interrupted', failed, tone: 'info' };
  if (o.kind === 'inconclusive') return { words: `check inconclusive${o.check ? `: ${o.check}` : ''}`, failed, tone: 'warn' };
  if (o.kind === 'passed') return { words: outcomeLabel(o), failed, tone: 'ok' };
  if (o.kind === 'clean') return { words: 'replayed clean', failed, tone: 'ok' };
  return { words: run.status === 'failed' ? 'exited with an error' : 'exited 0', failed, tone: 'info' };
}

/** How the two runs ended, as a change of rank 2 when they ended otherwise. */
function endedChange(parent: ForkEnd, fork: ForkEnd): ForkChange | null {
  if (parent.words === fork.words && parent.failed === fork.failed) return null;
  const detail = fork.failed && !parent.failed ? 'it fails, where its parent did not' : parent.failed && !fork.failed ? 'it does not fail, where its parent did' : 'it ends otherwise';
  const tone: Tone = fork.failed && !parent.failed ? 'err' : parent.failed && !fork.failed ? 'ok' : 'info';
  return { rank: 2, detail, before: parent.words, after: fork.words, tone };
}

/** One side as a decision: its tool calls in order, its last words, whom it handed over to. */
function decisionOf(store: StoreOf<'recording'>, tools: readonly CallRecord[], all: CallRecord[], normalizers: readonly Normalizer[]): ModelDecision {
  const calls = tools.map((c) => ({ name: c.name, args: argsOf(store, c, normalizers) }));
  const handover = [...calls].reverse().find((t) => isHandover(t.name))?.name ?? null;
  const words = finalAnswer(store, all) ?? '';
  // Masked as decisions masks a model's words: what a normalizer masks is no change.
  const text = normalizers.length ? rewriteText(words, [...normalizers]) : words;
  return { stop: 'answer', stopReason: null, tools: calls, text: text.replace(/\s+/g, ' ').trim(), handover };
}

/** What a fenced or answered call became, from its origin and how it ended. */
function fateOf(c: CallRecord): ForkWrite['fate'] {
  if (c.origin === 'blocked' || c.origin === 'stubbed' || c.origin === 'overridden' || c.origin === 'replayed') return c.origin;
  return c.end?.outcome === 'error' ? 'failed' : 'live';
}

function changesOf(was: ModelDecision, now: ModelDecision, effectOf: (tool: string) => Effect | null): ForkChange[] {
  return compareDecisions(was, now, effectOf).changes.map((c) => {
    const line = (v: unknown) => (v === null || v === undefined ? null : c.kind === 'text' ? oneLine(clipText(String(v), VALUE_SHOWN)) : oneLine(v));
    return { rank: c.rank, detail: c.detail, before: line(c.before), after: line(c.after), tone: c.rank === 1 ? 'warn' : 'info' };
  });
}

/** What the fork did differently; null for a run that isn't a fork of a run in the store. */
export function forkEffects(store: StoreOf<'recording'>, run: RunRecord, calls: CallRecord[], normalizers: readonly Normalizer[] = []): ForkEffects | null {
  if (run.mode !== 'replay' || !run.parentRunId || !run.divergence) return null;
  const parent = store.getRun(run.parentRunId);
  if (!parent) return null;
  const from = run.divergence.callNo;
  const parentCalls = store.getCalls(parent.runId);
  const parentTools = toolCallsFrom(parentCalls, from);
  const forkTools = toolCallsFrom(calls, from);
  const effects = effectsOf([...parentCalls, ...calls]);
  const effectOf = (tool: string): Effect | null => effects.get(tool) ?? null;
  const was = decisionOf(store, parentTools.slice(0, MAX_TOOL_CALLS), parentCalls, normalizers);
  const now = decisionOf(store, forkTools.slice(0, MAX_TOOL_CALLS), calls, normalizers);
  const ended = { parent: endOf(parent, outcomeFor(store, parent, parentCalls)), fork: endOf(run, outcomeFor(store, run, calls)) };
  const changes = [...changesOf(was, now, effectOf), endedChange(ended.parent, ended.fork)].filter((c): c is ForkChange => c !== null).sort((a, b) => a.rank - b.rank);
  // A tool no run gives an effect counts as a write, as decisions counts it: nothing says it doesn't act on the world.
  const isWrite = (c: CallRecord) => (c.effect ?? effectOf(c.name) ?? 'write') === 'write';
  const writes = forkTools
    .slice(0, MAX_TOOL_CALLS)
    .filter(isWrite)
    .map((c) => ({ callNo: c.callNo, tool: c.name, args: oneLine(argsOf(store, c, normalizers)), fate: fateOf(c) }));
  return {
    most: changes.length ? RANK_LABELS[changes[0]!.rank] : null,
    changes,
    ended,
    writes,
    words: { parent: was.text ? clipText(was.text, 160) : null, fork: now.text ? clipText(now.text, 160) : null },
    cut: parentTools.length > MAX_TOOL_CALLS || forkTools.length > MAX_TOOL_CALLS,
  };
}
