import { canonicalize, clipText, effectsOf, finalAnswer, outcomeLabel, RANK_LABELS, type CallRecord, type DecisionRank, type Effect, type RunOutcome, type RunRecord, type Store } from '@shadowlap/engine';
import { failing, outcomeFor, type Fact, type Tone } from './verdict.js';

/**
 * What a fork did differently from its parent, from the call it forked at on: the tool calls it made
 * that its parent didn't and the other way round, those it asked differently, how each run ended
 * and its last words. Ranked as `shadowlap decisions` ranks a change, a write first (a tool with no
 * known effect counts as one), as the dashboard's fork banner does.
 */
export interface ForkChange extends Fact {
  rank: DecisionRank;
}

interface ToolCall {
  name: string;
  args: string;
  fenced: boolean;
}

function argsOf(store: Store, c: CallRecord): string {
  try {
    const req = c.requestRef ? store.getJson<{ args?: unknown }>(c.requestRef) : null;
    return canonicalize(req?.args ?? null);
  } catch {
    return 'null';
  }
}

function toolCalls(store: Store, calls: readonly CallRecord[], from: number): ToolCall[] {
  return calls.filter((c) => c.kind === 'tool' && c.callNo >= from).map((c) => ({ name: c.name, args: argsOf(store, c), fenced: c.origin === 'blocked' || c.origin === 'stubbed' }));
}

const isWrite = (e: Effect | undefined) => e !== 'read' && e !== 'pure';
const clip = (s: string) => clipText(s, 60);

/** One tool's change between the parent's calls and the fork's, or null when it was called alike. */
function changeOf(name: string, before: ToolCall[], after: ToolCall[], write: boolean): ForkChange | null {
  const tone: Tone = write ? 'err' : 'info';
  if (!before.length) return { rank: write ? 1 : 3, text: `+ ${name} is called${after.some((t) => t.fenced) ? ' (fenced)' : ''}`, tone };
  if (!after.length) return { rank: write ? 1 : 3, text: `- ${name} is no longer called`, tone };
  const b = before.map((t) => t.args).join('\n');
  const a = after.map((t) => t.args).join('\n');
  if (b === a) return fencedChange(name, before, after, write);
  if (before.length !== after.length) return { rank: write ? 1 : 3, text: `~ ${name} is called ${after.length} time${after.length === 1 ? '' : 's'}, ${before.length} in its parent`, tone };
  return { rank: write ? 1 : 4, text: `~ ${name} asked differently: ${clip(before[0]!.args)} → ${clip(after[0]!.args)}`, tone };
}

/** The same calls, but the fork fenced them (blocked or stubbed) where its parent's ran, or the other way round. */
function fencedChange(name: string, before: ToolCall[], after: ToolCall[], write: boolean): ForkChange | null {
  const was = before.some((t) => t.fenced);
  const now = after.some((t) => t.fenced);
  if (was === now) return null;
  return { rank: write ? 1 : 4, text: now ? `~ ${name} is fenced, where its parent's ran` : `~ ${name} runs, where its parent's was fenced`, tone: now ? 'ok' : 'err' };
}

export function toolChanges(before: ToolCall[], after: ToolCall[], effects: Map<string, Effect>): ForkChange[] {
  const names = [...new Set([...before, ...after].map((t) => t.name))];
  const changes = names.map((n) => changeOf(n, before.filter((t) => t.name === n), after.filter((t) => t.name === n), isWrite(effects.get(n))));
  return changes.filter((c): c is ForkChange => c !== null).sort((x, y) => x.rank - y.rank);
}

/** How a run ended, as the fork banner says it. */
export function endWords(run: RunRecord, o: RunOutcome): string {
  switch (o.kind) {
    case 'check-failed':
      return o.check ? `failed: ${o.check}` : 'exited with an error';
    case 'lost':
      return `failed, lost at #${o.callNo}`;
    case 'diverged':
      return `diverged at #${o.callNo}`;
    case 'running':
      return 'interrupted';
    case 'inconclusive':
      return `check inconclusive${o.check ? `: ${o.check}` : ''}`;
    case 'clean':
      return 'replayed clean';
    case 'passed':
      return outcomeLabel(o);
    default:
      return run.status === 'completed' ? 'exited 0' : run.status;
  }
}

/** A change in how the run ended, ranked with the stops: it fails where its parent did not, or the other way round. */
function endedChange(parent: RunOutcome, fork: RunOutcome): ForkChange | null {
  if (failing(fork) && !failing(parent)) return { rank: 2, text: 'it fails, where its parent did not', tone: 'err' };
  if (!failing(fork) && failing(parent)) return { rank: 2, text: 'it does not fail, where its parent did', tone: 'ok' };
  return null;
}

export interface ForkEffects {
  changes: ForkChange[];
  /** The highest-ranked change, in `shadowlap decisions`' words: `a write changed`. */
  most: string | null;
  ends: { parent: string; fork: string };
  words: { parent: string | null; fork: string | null };
}

export function forkEffects(store: Store, run: RunRecord, calls: CallRecord[]): ForkEffects | null {
  const parent = run.parentRunId ? store.getRun(run.parentRunId) : null;
  if (!parent || !run.divergence) return null;
  const parentCalls = store.getCalls(parent.runId);
  const from = run.divergence.callNo;
  const effects = effectsOf([...parentCalls, ...calls]);
  const p = outcomeFor(store, parent, parentCalls);
  const f = outcomeFor(store, run, calls);
  const changes = [endedChange(p, f), ...toolChanges(toolCalls(store, parentCalls, from), toolCalls(store, calls, from), effects)].filter((c): c is ForkChange => c !== null);
  changes.sort((x, y) => x.rank - y.rank);
  const last = (cs: CallRecord[]) => {
    const w = finalAnswer(store, cs);
    return w ? clipText(w.replace(/\s+/g, ' ').trim(), 160) : null;
  };
  return {
    changes,
    most: changes.length ? RANK_LABELS[changes[0]!.rank] : null,
    ends: { parent: endWords(parent, p), fork: endWords(run, f) },
    words: { parent: last(parentCalls), fork: last(calls) },
  };
}
