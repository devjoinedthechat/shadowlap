import { canonicalize } from './canonical.js';
import { isFailedOutcome, outcomeLabel, type RunOutcome } from './classify.js';
import { lostWords } from './run-verdicts.js';
import { clipText, compareDecisions, decisionOfResponse, decisionView, effectsOf, isHandover, STOP_WORDS, type DecisionCall, type DecisionChangeKind, type DecisionRank, type DecisionView, type EffectOf, type ModelDecision } from './decisions.js';
import { agentCallsOf, isJudgeCall } from './judge-scope.js';
import { applyNormalizers, rewriteText } from './normalize.js';
import { pairVerdict, type PairVerdict } from './pair-verdict.js';
import { finalAnswer } from './responses.js';
import type { StoreOf } from './store.js';
import type { CallKind, CallRecord, Effect, Normalizer, Origin, RunRecord, RunStatus } from './types.js';

/**
 * What a fork did differently from the run it forked from, from the call it left that run at on, as
 * the dashboard's fork banner and the terminal UI's diff tab both show it: the tool calls it made
 * that its parent didn't and the other way round, the tools it called with other arguments, its
 * writes and what became of each, and how each run ended. Every change is ranked as `shadowlap
 * decisions` ranks a changed decision (decisions.ts): a write first, then how the run ended (a check
 * coming out otherwise is a change of rank 2, as a judge check reading the words otherwise is there),
 * then reads added or removed, reads asked differently, and the words of its last answer. Arguments
 * and words are compared after the project's normalizers, so an id or a time made anew is no change.
 *
 * The same comparison serves any two runs (comparePair), from the first call after the calls they
 * share: Compare's verdict, a line a run saying how each ended, and both paths call by call
 * (pairDecisions), worked out on the server, as a browser can't read a model's answers.
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

/** A change between any two runs, `b` read against `a`: `write-added` is a write `b` made and `a` didn't. */
export interface PairChange extends Omit<ForkChange, 'parentCallNo' | 'forkCallNo'> {
  /** The call it is about in each run, when it is a call. */
  aCallNo: number | null;
  bCallNo: number | null;
}

/** What `b` did differently from `a` from a call on each side on (comparePair): a fork's comparison, for any pair. */
export interface PairComparison {
  /** The first call compared in each run. */
  from: { a: number; b: number };
  /** Each change, most consequential first. */
  changes: PairChange[];
  ended: { a: ForkEnd; b: ForkEnd };
  /** Each run's writes from there on, in order. */
  writes: { a: ForkWrite[]; b: ForkWrite[] };
  /** The tool calls each run made from there, as compared. */
  toolCalls: { a: number; b: number };
  /** The words of each run's last answer, as compared: masked, on one line. */
  words: { a: string; b: string };
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
    if (o.kind === 'lost') return { ...base, words: `failed, ${lostWords(o.callNo, o.range)}`, tone: 'err' };
    if (o.kind === 'diverged') return { ...base, words: `diverged at #${o.callNo}`, tone: 'err' };
    return { ...base, words: 'failed', tone: 'err' };
  }
  if (status === 'crashed') return { ...base, words: 'interrupted', tone: null };
  if (o.kind === 'inconclusive') return { ...base, words: `check inconclusive${o.check ? `: ${o.check}` : ''}`, tone: 'warn' };
  if (o.kind === 'passed') return { ...base, words: outcomeLabel(o), tone: 'ok' };
  if (o.kind === 'clean') return { ...base, words: 'replayed clean', tone: 'ok' };
  return { ...base, words: status === 'failed' ? 'exited with an error' : 'exited 0', tone: null };
}

/** How the two runs ended, as a change of rank 2 when they ended otherwise; `other` names the first run in its words (`its parent`). */
function endedChange(was: ForkEnd, now: ForkEnd, other: string): PairChange | null {
  if (was.words === now.words && was.failed === now.failed) return null;
  const detail = now.failed && !was.failed ? `it fails, where ${other} did not` : was.failed && !now.failed ? `it does not fail, where ${other} did` : 'it ends otherwise';
  return { rank: 2, kind: 'ended', tool: null, effect: null, detail, before: was.words, after: now.words, aCallNo: null, bCallNo: null };
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

/** A tool no run gives an effect counts as a write, as decisions counts it: nothing says it doesn't act on the world. */
const writes = (effectOf: EffectOf) => (c: CallRecord) => {
  const e = c.effect ?? effectOf(c.name);
  return e === 'write' || e === null;
};

/** Each run's calls: those the caller read already, or the store's. */
const callsOf = (store: StoreOf<'recording'>, a: RunRecord, b: RunRecord, calls?: { a: CallRecord[]; b: CallRecord[] }) => calls ?? { a: store.getCalls(a.runId), b: store.getCalls(b.runId) };

/** The comparison, `b` read against `a` from `from` on in each; `other` names `a` in a change's words. */
function compareSides(store: StoreOf<'recording'>, a: RunRecord, b: RunRecord, from: { a: number; b: number }, ended: { a: ForkEnd; b: ForkEnd }, options: PairOptions, other: string): PairComparison {
  const normalizers = options.normalizers ?? [];
  const calls = callsOf(store, a, b, options.calls);
  const aTools = toolCallsFrom(calls.a, from.a);
  const bTools = toolCallsFrom(calls.b, from.b);
  const shownA = aTools.slice(0, MAX_TOOL_CALLS);
  const shownB = bTools.slice(0, MAX_TOOL_CALLS);

  const effects = effectsOf([...calls.a, ...calls.b]);
  const effectOf = (tool: string): Effect | null => effects.get(tool) ?? null;
  const was = decisionOf(store, shownA, calls.a, normalizers);
  const now = decisionOf(store, shownB, calls.b, normalizers);
  const compared = compareDecisions(was.decision, now.decision, effectOf);
  const callOf = (where: Map<string, number[]>, tool: string | null, args: unknown): number | null => {
    if (!tool || args === null || args === undefined) return null;
    const list = where.get(`${tool}\u0000${canonicalize(args)}`);
    return list?.shift() ?? null;
  };
  const changes: PairChange[] = compared.changes.map((c) => {
    const isCall = c.kind !== 'text' && c.kind !== 'write-order';
    const line = (v: unknown) => (v === null || v === undefined ? null : c.kind === 'text' ? oneLine(clipText(String(v), VALUE_SHOWN)) : oneLine(v));
    return { rank: c.rank, kind: c.kind, tool: c.tool, effect: c.effect, detail: c.detail, before: line(c.before), after: line(c.after), aCallNo: isCall ? callOf(was.at, c.tool, c.before) : null, bCallNo: isCall ? callOf(now.at, c.tool, c.after) : null };
  });
  const end = endedChange(ended.a, ended.b, other);
  if (end) changes.push(end);
  changes.sort((x, y) => x.rank - y.rank);

  // Each write's arguments as its side's decision read them.
  const writesOf = (shown: CallRecord[], d: ModelDecision): ForkWrite[] =>
    shown.flatMap((c, i) => (writes(effectOf)(c) ? [{ callNo: c.callNo, tool: c.name, args: oneLine(d.tools[i]!.args), fate: fateOf(c) }] : []));
  return {
    from,
    changes,
    ended,
    writes: { a: writesOf(shownA, was.decision), b: writesOf(shownB, now.decision) },
    toolCalls: { a: aTools.length, b: bTools.length },
    words: { a: was.decision.text, b: now.decision.text },
    cut: aTools.length > MAX_TOOL_CALLS || bTools.length > MAX_TOOL_CALLS,
  };
}

export interface PairOptions {
  normalizers?: readonly Normalizer[];
  /** Each run's calls, when the caller has read them: a long run is read once. */
  calls?: { a: CallRecord[]; b: CallRecord[] };
}

/**
 * What run `b` did differently from run `a` from a call on: `from.a` in `a`, `from.b` in `b`, which
 * differ where a judge's call sits between. `ended` says how each ended, as the caller counts a run's
 * outcome (forkEnd words it). Any two runs, ranked as a fork against its parent is.
 */
export function comparePair(store: StoreOf<'recording'>, a: RunRecord, b: RunRecord, from: { a: number; b: number }, ended: { a: ForkEnd; b: ForkEnd }, options: PairOptions = {}): PairComparison {
  return compareSides(store, a, b, from, ended, options, 'the other run');
}

/**
 * What `run`, a fork of `parent`, did differently from it; null for a run that is no fork (a
 * recording, a replay that never forked). `ended` says how each ended, as the caller counts a run's
 * outcome (the dashboard from its run index): forkEnd words it.
 */
export function compareFork(store: StoreOf<'recording'>, run: RunRecord, parent: RunRecord, ended: { parent: ForkEnd; fork: ForkEnd }, options: { normalizers?: readonly Normalizer[] } = {}): ForkComparison | null {
  if (run.mode !== 'replay' || !run.divergence) return null;
  const from = run.divergence.callNo;
  const c = compareSides(store, parent, run, { a: from, b: from }, { a: ended.parent, b: ended.fork }, options, 'its parent');
  return {
    from,
    changes: c.changes.map(({ aCallNo, bCallNo, ...change }) => ({ ...change, parentCallNo: aCallNo, forkCallNo: bCallNo })),
    ended,
    writes: c.writes.b,
    toolCalls: { parent: c.toolCalls.a, fork: c.toolCalls.b },
    words: { parent: c.words.a, fork: c.words.b },
    cut: c.cut,
  };
}

// ---- Compare's line a run and its rows: how each side ended, and both paths call by call ----

/** How a run's turn ended, from its last call (the agent's, not a judge's). */
export interface PairEnd {
  /** `exited`: the agent exited with an error; `stopped`: its last call got an HTTP failure; `answered`: its last call is a model's answer that ends its turn. */
  kind: 'exited' | 'stopped' | 'answered' | 'ended' | 'none' | 'running';
  /** Its last call; null with none. */
  callNo: number | null;
  /** For `stopped`: the HTTP status its last call got. */
  status?: number;
  /** For `exited`: the agent's exit code where a test result kept it, else null. */
  code?: number | null;
}

/** What a run did after the calls it shares with the other, as Compare's line a run says it. */
export interface PairEnding {
  /** The model calls that got an HTTP failure from there: the first one's status, the first and the last call. Null with none, or where the run stopped on that failure (its end says it). */
  failures: { status: number; from: number; to: number } | null;
  /** Its writes in the order made, those a replay fenced under what became of them: each tool once in its group, with how many times. */
  writes: Array<{ fate: 'blocked' | 'stubbed' | null; tools: Array<{ tool: string; count: number }> }>;
  end: PairEnd;
  /** It exited, or stopped on an HTTP failure, with no model call answered from there. */
  quit: boolean;
}

/** The HTTP status a model call failed with; null for one that got an answer, or failed with none. */
function httpFailure(c: CallRecord): number | null {
  return c.kind === 'api' && c.end?.outcome === 'error' && typeof c.end.meta.status === 'number' ? c.end.meta.status : null;
}

/** A model call's decision as its recorded answer says it, masked by the normalizers; null for a failure or an answer that can't be read. */
function modelDecision(store: StoreOf<'recording'>, c: CallRecord, normalizers: readonly Normalizer[]): ModelDecision | null {
  const end = c.end;
  if (c.kind !== 'api' || end?.outcome !== 'ok' || !end.responseRef) return null;
  try {
    const provider = end.meta.provider ?? c.meta.provider;
    return decisionOfResponse(store.getBlob(end.responseRef), end.meta.headers?.['content-type'], typeof provider === 'string' ? provider : undefined, { normalizers }, end.meta.chunks ?? []);
  } catch {
    return null;
  }
}

/** Writes grouped as the line says them: the fenced ones under their origin's word, each tool once with its count. */
function groupedWrites(calls: readonly CallRecord[], effectOf: EffectOf): PairEnding['writes'] {
  const groups: PairEnding['writes'] = [];
  for (const c of calls.filter(writes(effectOf))) {
    const fate = c.origin === 'blocked' || c.origin === 'stubbed' ? c.origin : null;
    let group = groups.find((g) => g.fate === fate);
    if (!group) groups.push((group = { fate, tools: [] }));
    const tool = group.tools.find((t) => t.tool === c.name);
    if (tool) tool.count++;
    else group.tools.push({ tool: c.name, count: 1 });
  }
  return groups;
}

/**
 * How `run` ended after the calls it shares with the other, from its agent's calls at `from` on: the
 * HTTP failures it got, its writes (those of no known effect included, as the ranking counts them)
 * and how its turn ended. `exitCode` is its agent's code where a test result kept it.
 */
export function pairEnding(store: StoreOf<'recording'>, run: Pick<RunRecord, 'status'>, calls: readonly CallRecord[], from: number, o: { effectOf: EffectOf; normalizers?: readonly Normalizer[]; exitCode?: number | null }): PairEnding {
  const agent = agentCallsOf(calls);
  const after = agent.filter((c) => c.callNo >= from);
  const last = agent.at(-1) ?? null;
  const exited = run.status === 'failed';
  const lastFailure = last ? httpFailure(last) : null;
  const stopped = !exited && lastFailure !== null;
  const failed = after.filter((c) => httpFailure(c) !== null);
  const failures = failed.length && !stopped ? { status: httpFailure(failed[0]!)!, from: failed[0]!.callNo, to: failed.at(-1)!.callNo } : null;
  const at = last?.callNo ?? null;
  let end: PairEnd;
  if (run.status === 'running') end = { kind: 'running', callNo: at };
  else if (exited) end = { kind: 'exited', callNo: at, code: o.exitCode ?? null };
  else if (!last) end = { kind: 'none', callNo: null };
  else if (stopped) end = { kind: 'stopped', callNo: last.callNo, status: lastFailure };
  else end = { kind: modelDecision(store, last, o.normalizers ?? [])?.stop === 'answer' ? 'answered' : 'ended', callNo: last.callNo };
  const answered = after.some((c) => c.kind === 'api' && c.end?.outcome === 'ok');
  return { failures, writes: groupedWrites(toolCallsFrom(after, from), o.effectOf), end, quit: (exited || lastFailure !== null) && !answered };
}

/** An end as two are compared: how the turn ended, an exit with its code; not where, nor a failure's status. */
const endKey = (e: PairEnd): string => (e.kind === 'exited' ? `exited ${e.code ?? ''}` : e.kind);

/** What a row shows of a call's words or arguments: a row is a line, and the opened row reads the call whole. */
export const ROW_TEXT = 300;

/**
 * A model call's decision as a row and its opened view draw it: the engine's decisionView (its
 * words, each tool it calls with what it does, `unknown` where no run says, and how its turn ends),
 * as a preview's cell takes it, with every string in it cut past ROW_TEXT, and `stops`, how its turn
 * ends in `decisions`' words (`calls tools`), since a page can't load the decisions module.
 */
export interface PathDecision extends DecisionView {
  stops: string;
}

/** One side's call in a row. */
export interface PathCall {
  callNo: number;
  kind: CallKind;
  name: string;
  /** What a tool does, as recorded; null where the call says none. */
  effect: Effect | null;
  /** Where its answer came from; `injected` for a failure Shadowlap answered (`--fail-at`), which the store keeps as live. */
  origin: Origin | 'injected';
  /** A person's answer (`user_input`), not the agent's call. */
  input: boolean;
  /** A model call that failed: its HTTP status (null with none), and who refused it. */
  failure: { status: number | null; by: 'injected' | 'offline' | 'provider' } | null;
  /** A model call's decision; null for a tool, a failure, or an answer that can't be read. */
  decision: PathDecision | null;
  /** A tool's arguments, masked by the normalizers, in a line cut past ROW_TEXT. */
  args: string | null;
}

/** Both runs' calls at one place after the identical prefix: by position, judge calls left out. */
export interface PathRow {
  /** The row's number: the call in `a`, or in `b` past `a`'s end. */
  callNo: number;
  a: PathCall | null;
  b: PathCall | null;
  /** Both made the same call: a model call deciding alike with the same status, a tool or a read asked alike. */
  alike: boolean;
  /** Not alike, but alike enough to mark the words that differ: model calls that call the same tools, or both failed; calls of the same name. */
  similar: boolean;
}

/** The rows Compare draws at most; past them, it counts the rest. */
export const PATH_ROWS = 200;

/** Who refused a model call that failed: Shadowlap's flag, an offline replay, or the provider. */
function refusedBy(c: CallRecord): NonNullable<PathCall['failure']>['by'] {
  const meta = c.end?.meta;
  if (meta?.injected) return 'injected';
  return meta?.offline || (meta?.status === 503 && /\boffline\b/i.test(meta.error?.message ?? '')) ? 'offline' : 'provider';
}

/** A side's call as its row reads it, with what the comparison needs whole: the decision and the arguments. */
function rowCall(store: StoreOf<'recording'>, c: CallRecord, normalizers: readonly Normalizer[]): { call: PathCall; decision: ModelDecision | null; args: unknown } {
  const failed = c.kind === 'api' && c.end?.outcome === 'error';
  const decision = c.kind === 'api' ? modelDecision(store, c, normalizers) : null;
  const args = c.kind === 'api' ? null : argsOf(store, c, normalizers);
  return {
    call: {
      callNo: c.callNo,
      kind: c.kind,
      name: c.name,
      effect: c.effect,
      origin: c.end?.meta.injected ? 'injected' : c.origin,
      input: c.meta.input === true,
      failure: failed ? { status: typeof c.end?.meta.status === 'number' ? c.end.meta.status : null, by: refusedBy(c) } : null,
      decision: null,
      args: c.kind === 'api' ? null : oneLine(args ?? null, ROW_TEXT),
    },
    decision,
    args,
  };
}

/** A value with each string in it cut past `max`: a row's arguments stay a line's worth, their shape kept. */
function clipStrings(v: unknown, max: number): unknown {
  if (typeof v === 'string') return clipText(v, max);
  if (Array.isArray(v)) return v.map((x) => clipStrings(x, max));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipStrings(x, max)]));
  return v;
}

/** A decision as a row draws it: the engine's view of it, its strings cut. */
function rowDecision(d: ModelDecision, effectOf: EffectOf): PathDecision {
  const view = decisionView(d, effectOf);
  return { ...view, tools: view.tools.map((t) => ({ ...t, args: clipStrings(t.args ?? null, ROW_TEXT) })), text: clipText(d.text, ROW_TEXT), stops: STOP_WORDS[d.stop] };
}

/** Whether two calls at one place are alike, or similar enough to mark the words that differ. */
function sameness(x: ReturnType<typeof rowCall>, y: ReturnType<typeof rowCall>, effectOf: EffectOf): { alike: boolean; similar: boolean } {
  const a = x.call;
  const b = y.call;
  if (a.kind !== b.kind) return { alike: false, similar: false };
  if (a.kind !== 'api') return { alike: a.name === b.name && canonicalize(x.args ?? null) === canonicalize(y.args ?? null), similar: a.name === b.name };
  if (a.failure || b.failure) return { alike: !!a.failure && !!b.failure && a.failure.status === b.failure.status, similar: !!a.failure && !!b.failure };
  if (!x.decision || !y.decision) return { alike: false, similar: false };
  const names = (d: ModelDecision) => d.tools.map((t) => t.name).join('\u0000');
  return { alike: compareDecisions(x.decision, y.decision, effectOf).rank === null, similar: !!x.decision.tools.length && names(x.decision) === names(y.decision) };
}

/**
 * Both runs' agent calls after the identical prefix (`prefix` calls), paired by position as
 * `compareRuns` pairs them, at most `max` rows: each call as its row reads it, a model call by its
 * decision, a tool by its arguments, both masked by the normalizers, and whether the two are alike.
 */
export function pathRows(store: StoreOf<'recording'>, aCalls: readonly CallRecord[], bCalls: readonly CallRecord[], prefix: number, o: { effectOf: EffectOf; normalizers?: readonly Normalizer[]; max?: number }): { rows: PathRow[]; more: number } {
  const xs = agentCallsOf(aCalls);
  const ys = agentCallsOf(bCalls);
  const normalizers = o.normalizers ?? [];
  const total = Math.max(0, Math.max(xs.length, ys.length) - prefix);
  const shown = Math.min(total, o.max ?? PATH_ROWS);
  const rows: PathRow[] = [];
  for (let k = prefix; k < prefix + shown; k++) {
    const x = xs[k] ? rowCall(store, xs[k]!, normalizers) : null;
    const y = ys[k] ? rowCall(store, ys[k]!, normalizers) : null;
    if (x?.decision) x.call.decision = rowDecision(x.decision, o.effectOf);
    if (y?.decision) y.call.decision = rowDecision(y.decision, o.effectOf);
    const same = x && y ? sameness(x, y, o.effectOf) : { alike: false, similar: false };
    rows.push({ callNo: (x ?? y)!.call.callNo, a: x?.call ?? null, b: y?.call ?? null, ...same });
  }
  return { rows, more: total - shown };
}

/** Two runs compared for Compare: the comparison from the first call after their identical prefix, each side's end, the verdict and the rows. */
export interface PairDecisions {
  /** The first call after the identical prefix in each run (one past its last call where it has none). */
  from: { a: number; b: number };
  comparison: PairComparison;
  endings: { a: PairEnding; b: PairEnding };
  /** Null where no call follows the identical prefix, or while a run records: its writes and its end aren't final. */
  verdict: PairVerdict | null;
  rows: PathRow[];
  /** The rows past `PATH_ROWS`, left out. */
  more: number;
}

/**
 * What `b` decided differently from `a` after the `identicalPrefix` calls they share (compareRuns
 * counts them): any two runs, a fork and its parent or two replays of one recording. `ended` says
 * how each ended by its checks (forkEnd); `exitCodes` each agent's code where a test result kept it.
 */
export function pairDecisions(store: StoreOf<'recording'>, a: RunRecord, b: RunRecord, identicalPrefix: number, ended: { a: ForkEnd; b: ForkEnd }, options: PairOptions & { exitCodes?: { a?: number | null; b?: number | null }; rows?: number } = {}): PairDecisions {
  const calls = callsOf(store, a, b, options.calls);
  const normalizers = options.normalizers ?? [];
  const xs = agentCallsOf(calls.a);
  const ys = agentCallsOf(calls.b);
  const fromOf = (agent: CallRecord[]) => agent[identicalPrefix]?.callNo ?? (agent.at(-1)?.callNo ?? 0) + 1;
  const from = { a: fromOf(xs), b: fromOf(ys) };
  const comparison = comparePair(store, a, b, from, ended, { normalizers, calls });
  const effects = effectsOf([...calls.a, ...calls.b]);
  const effectOf = (tool: string): Effect | null => effects.get(tool) ?? null;
  const endings = {
    a: pairEnding(store, a, calls.a, from.a, { effectOf, normalizers, exitCode: options.exitCodes?.a ?? null }),
    b: pairEnding(store, b, calls.b, from.b, { effectOf, normalizers, exitCode: options.exitCodes?.b ?? null }),
  };
  const decided = identicalPrefix < Math.max(xs.length, ys.length) && a.status !== 'running' && b.status !== 'running';
  const verdict = decided ? pairVerdict({ rank: comparison.changes[0]?.rank ?? null, quit: endings.a.quit || endings.b.quit, endsDiffer: endKey(endings.a.end) !== endKey(endings.b.end), identicalPrefix }) : null;
  const { rows, more } = pathRows(store, xs, ys, identicalPrefix, { effectOf, normalizers, max: options.rows ?? PATH_ROWS });
  return { from, comparison, endings, verdict, rows, more };
}
