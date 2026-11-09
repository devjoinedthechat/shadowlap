import type { CheckStatus } from './check-status.js';
import { intoText, storedCalls } from './checks/evaluate.js';
import { lowerRecorded, type RecordedField } from './checks/fields.js';
import { asNumber, type TestSpec } from './checks/grammar.js';
import { checkLabels } from './checks/labels.js';
import { parseExpect, referenceTo } from './checks/parse.js';
import { judgeRecording } from './checks/recorded.js';
import { agentOfRun } from './fix-jobs.js';
import { GOOD_LABEL, fixOfRun } from './fixes.js';
import { isObject } from './is-object.js';
import { isJudgeCall } from './judge-scope.js';
import { hasRecordedCommand } from './pack.js';
import { isUserInput } from './run-actions.js';
import type { Store } from './store.js';
import type { StoredFix } from './store/fixes.js';
import type { CallRecord, RunRecord } from './types.js';

/**
 * Suggested checks: rules mined from a failed recording that fail it and pass every good run it is
 * compared with, as the dashboard's check builder offers them, each one click into the builder and
 * never saved by itself. Four shapes are tried, in turn:
 *
 * - a write's number argument at most a number an earlier call returned (`amount <= get_policy.result.limit`);
 * - a condition on a read at another value the run recorded below it, then the write it rules out;
 * - an order: a write after each other tool the run calls;
 * - a count every good run has.
 *
 * Each is judged by the engine's evaluator from what the recordings hold, as `judgeRecording` judges
 * a recording, nothing replayed and nothing sent; only the rule's own result counts, never the
 * run's exit status. Finding the good runs reads every run's record, so the dashboard asks this
 * beside its server, in a pooled read.
 */

/** At most this many suggestions are given. */
export const SUGGESTED_MAX = 3;
/** At most this many good runs are judged. */
export const GOOD_RUNS_MAX = 200;
/** At most this many candidates of each shape are judged, counted after those the builder holds and repeats are left out. */
export const CANDIDATES_PER_SHAPE = 15;

export type SuggestionShape = 'value' | 'when' | 'order' | 'count';

/** A rule as an expect object holding it alone. */
export interface SuggestedRule {
  tools?: Record<string, number>;
  calls?: Array<Record<string, unknown>>;
  when?: Array<Record<string, unknown>>;
}

export interface CheckSuggestion {
  shape: SuggestionShape;
  expect: SuggestedRule;
  /** Its label, the engine's (`checkLabels`). */
  label: string;
}

/** A run with its calls, read once for the candidates and for their judging. */
export interface RunCalls {
  run: RunRecord;
  calls: CallRecord[];
}

export interface SuggestChecksOptions {
  /** The number of the call the check is made from; null or left out when it is made from none (a fix's check). */
  at?: number | null;
  /** The labels of the checks the builder holds: a rule among them is left out. */
  have?: readonly string[];
  /** The fix whose good runs come first; left out, the fix the run fails in. */
  fix?: StoredFix | null;
  max?: number;
}

export interface Suggested {
  /** The good runs the suggestions pass, the fix's first. */
  goods: RunRecord[];
  suggestions: CheckSuggestion[];
}

/** The agent's tool calls: a person's answer the agent read and a judge's call are no tool of its own. */
export const agentToolCalls = (calls: readonly CallRecord[]): CallRecord[] => calls.filter((c) => c.kind === 'tool' && !isUserInput(c) && !isJudgeCall(c));

/** A result as an object its fields are read from: as recorded, or JSON held in a string, as a reference reads it (the engine's rule). */
function resultObject(value: unknown): Record<string, unknown> | null {
  const v = intoText(value);
  return isObject(v) ? v : null;
}

/** The number fields the calls' results recorded, the latest per tool and field, in the order first seen. Results that failed, were blocked or hold an error are left out. */
export function numberFields(calls: readonly CallRecord[], resultOf: (c: CallRecord) => unknown): RecordedField[] {
  const at = new Map<string, number>();
  const out: RecordedField[] = [];
  for (const c of calls) {
    if (c.origin === 'blocked') continue;
    const result = resultObject(resultOf(c));
    if (!result || 'error' in result) continue;
    for (const [field, value] of Object.entries(result)) {
      if (asNumber(value) === null) continue;
      const key = `${c.name}\n${field}`;
      const f = { tool: c.name, field, value: value as number | string, callNo: c.callNo };
      const i = at.get(key);
      if (i === undefined) at.set(key, out.push(f) - 1);
      else out[i] = f;
    }
  }
  return out;
}

/** A run no check can be judged on: still recording, or a partial recording that holds no tool calls. */
const unjudged = (r: RunRecord): boolean => r.status === 'running' || (r.meta?.covers?.length ? !r.meta.covers.includes('tool') : false);

/**
 * The good runs a failed recording is compared with: the good runs of its fix still in the store
 * (`fix` when given, else the fix it fails in), then the agent's finished recordings labelled
 * `good`, newest first, when the run has an agent (a run with no command has none). Never the run
 * itself, one still recording or a partial one that holds no tool calls; at most GOOD_RUNS_MAX. It
 * reads every run's record.
 */
export function goodRunsOf(store: Store, run: RunRecord, o: { fix?: StoredFix | null } = {}): RunRecord[] {
  const fix = o.fix === undefined ? fixOfRun(store, run.runId) : o.fix;
  const own = fix ? store.fixLinks(fix.fixId, 'good').map((l) => store.getRun(l.ref)) : [];
  const agent = agentOfRun(store, run);
  const labelled =
    agent === null
      ? []
      : store
          .allRuns()
          .filter((r) => r.mode === 'record' && !!r.meta?.labels?.includes(GOOD_LABEL) && agentOfRun(store, r) === agent)
          .sort((a, b) => b.startedAt - a.startedAt);
  const out = new Map<string, RunRecord>();
  for (const r of [...own, ...labelled]) {
    if (out.size >= GOOD_RUNS_MAX) break;
    if (r && r.runId !== run.runId && !unjudged(r) && !out.has(r.runId)) out.set(r.runId, r);
  }
  return [...out.values()];
}

/** What the candidates are made from: the run's tool calls and how to read them, the tools by their first call, its writes. */
interface Mined {
  calls: CallRecord[];
  argsOf: (c: CallRecord) => unknown;
  resultOf: (c: CallRecord) => unknown;
  /** Each tool the run calls by its first call, in the order first called. */
  firsts: Map<string, CallRecord>;
  /** The tools whose first call is a write, the focus first: the write the check is made from, else the run's first write. */
  writes: string[];
  /** The call the check is made from, when it is a write. */
  at: CallRecord | null;
}

function minedOf(store: Store, run: RunCalls, at: number | null): Mined {
  const stored = storedCalls(store);
  const calls = agentToolCalls(run.calls);
  const firsts = new Map<string, CallRecord>();
  for (const c of calls) if (!firsts.has(c.name)) firsts.set(c.name, c);
  const atCall = at === null ? null : (calls.find((c) => c.callNo === at && c.effect === 'write') ?? null);
  const writes = [...firsts.values()].filter((c) => c.effect === 'write').map((c) => c.name);
  if (atCall) writes.sort((a, b) => Number(b === atCall.name) - Number(a === atCall.name));
  return { calls, argsOf: (c) => stored.argsOf?.(c), resultOf: (c) => stored.resultOf?.(c), firsts, writes, at: atCall };
}

/**
 * A call's number against a value an earlier call returned: each write's number argument at most
 * each number another tool's result recorded before the call, the nearest first. The call is the one
 * the check is made from, when it is that write, else the write's first call.
 */
function* valueCandidates(m: Mined): Generator<SuggestedRule> {
  for (const t of m.writes) {
    const x = m.at?.name === t ? m.at : m.firsts.get(t)!;
    const args = m.argsOf(x);
    if (!isObject(args)) continue;
    const numeric = Object.keys(args).filter((a) => asNumber(args[a]) !== null);
    const fields = numberFields(
      m.calls.filter((c) => c.callNo < x.callNo && c.name !== t),
      m.resultOf,
    ).sort((a, b) => b.callNo - a.callNo);
    for (const f of fields) for (const a of numeric) yield { calls: [{ tool: t, args: { [a]: { '<=': referenceTo(f.tool, 'result', f.field) } } }] };
  }
}

/**
 * A condition on what a read returned, then the write it rules out: for the focus write, each number
 * a tool whose first call is no write recorded, above another value the run recorded below it, then
 * the write called 0 times. A number with no lower value recorded gives none.
 */
function* whenCandidates(m: Mined): Generator<SuggestedRule> {
  const t = m.writes[0];
  if (t === undefined) return;
  const all = numberFields(m.calls, m.resultOf);
  for (const f of all) {
    const lower = m.firsts.get(f.tool)?.effect === 'write' ? null : lowerRecorded(all, f);
    if (lower !== null) yield { when: [{ if: { tool: f.tool, result: { [f.field]: { '>': lower } } }, then: { tools: { [t]: 0 } } }] };
  }
}

/** An order the good runs keep: each write after each other tool the run calls, in the order first called. */
function* orderCandidates(m: Mined): Generator<SuggestedRule> {
  for (const t of m.writes) for (const u of m.firsts.keys()) if (u !== t) yield { calls: [{ tool: t, after: u }] };
}

/** How often each tool is called, by the agent's own tool calls, in the order first called. */
function toolCounts(calls: readonly CallRecord[]): Map<string, number> {
  const n = new Map<string, number>();
  for (const c of agentToolCalls(calls)) n.set(c.name, (n.get(c.name) ?? 0) + 1);
  return n;
}

/** How often a tool is called, as every good run calls it: each tool the run calls, then each a good run calls. */
function* countCandidates(m: Mined, goods: readonly RunCalls[]): Generator<SuggestedRule> {
  const counts = goods.map((g) => toolCounts(g.calls));
  const tools = new Set([...m.firsts.keys(), ...counts.flatMap((c) => [...c.keys()])]);
  for (const t of tools) {
    const ns = counts.map((c) => c.get(t) ?? 0);
    if (ns.length && ns.every((n) => n === ns[0])) yield { tools: { [t]: ns[0]! } };
  }
}

/** A rule's one label, the engine's; null for one the grammar refuses or that has several. */
function labelOf(rule: SuggestedRule): string | null {
  try {
    const labels = checkLabels(parseExpect(rule, 'expect'));
    return labels.length === 1 ? labels[0]! : null;
  } catch {
    return null;
  }
}

/**
 * The rules tried on a failed recording, in the order they are offered: each shape in turn, at most
 * CANDIDATES_PER_SHAPE of each, a rule whose label is in `have` or that came already left out.
 * `goods` are the good runs it is compared with, whose counts the count shape takes.
 */
export function checkCandidates(store: Store, run: RunCalls, goods: readonly RunCalls[], o: Pick<SuggestChecksOptions, 'at' | 'have'> = {}): CheckSuggestion[] {
  const m = minedOf(store, run, o.at ?? null);
  const seen = new Set(o.have ?? []);
  const out: CheckSuggestion[] = [];
  const shapes: Array<[SuggestionShape, Iterable<SuggestedRule>]> = [
    ['value', valueCandidates(m)],
    ['when', whenCandidates(m)],
    ['order', orderCandidates(m)],
    ['count', countCandidates(m, goods)],
  ];
  for (const [shape, rules] of shapes) {
    let n = 0;
    for (const expect of rules) {
      if (n >= CANDIDATES_PER_SHAPE) break;
      const label = labelOf(expect);
      if (label === null || seen.has(label)) continue;
      seen.add(label);
      out.push({ shape, expect, label });
      n++;
    }
  }
  return out;
}

/** The candidates as one expect object, to judge them in one pass; null should they not parse together. */
function mergedSpec(cands: readonly CheckSuggestion[]): TestSpec | null {
  const tools = Object.assign({}, ...cands.map((c) => c.expect.tools ?? {})) as Record<string, number>;
  const calls = cands.flatMap((c) => c.expect.calls ?? []);
  const when = cands.flatMap((c) => c.expect.when ?? []);
  try {
    return parseExpect({ ...(Object.keys(tools).length ? { tools } : {}), ...(calls.length ? { calls } : {}), ...(when.length ? { when } : {}) }, 'expect');
  } catch {
    return null;
  }
}

/** Each candidate's result on a run, by its label: all judged in one pass, else one by one. */
function resultsOn(store: Store, r: RunCalls, cands: readonly CheckSuggestion[]): Map<string, CheckStatus> {
  const merged = mergedSpec(cands);
  const specs = merged ? [merged] : cands.map((c) => parseExpect(c.expect, 'expect'));
  return new Map(specs.flatMap((spec) => judgeRecording(store, r.run, r.calls, spec).checks.map((c): [string, CheckStatus] => [c.label, c.status])));
}

/**
 * At most `max` rules that fail the recording and pass every good run it is compared with (a rule
 * that doesn't apply to a good run doesn't fail it, though it never counts as passed there), each
 * judged on its own result. None for a run that is no finished recording of a command, or that has
 * no good runs.
 */
export function suggestChecks(store: Store, run: RunRecord, o: SuggestChecksOptions = {}): Suggested {
  if (run.mode !== 'record' || unjudged(run) || !hasRecordedCommand(run)) return { goods: [], suggestions: [] };
  const goods = goodRunsOf(store, run, o.fix === undefined ? {} : { fix: o.fix });
  if (!goods.length) return { goods, suggestions: [] };
  const read = (r: RunRecord): RunCalls => ({ run: r, calls: store.getCalls(r.runId) });
  const mine = read(run);
  const theirs = goods.map(read);
  const cands = checkCandidates(store, mine, theirs, o);
  const onRun = cands.length ? resultsOn(store, mine, cands) : new Map<string, CheckStatus>();
  let left = cands.filter((c) => onRun.get(c.label) === 'failed');
  for (const g of theirs) {
    if (!left.length) break;
    const onGood = resultsOn(store, g, left);
    left = left.filter((c) => onGood.get(c.label) === 'passed' || onGood.get(c.label) === 'not-applicable');
  }
  return { goods, suggestions: left.slice(0, o.max ?? SUGGESTED_MAX) };
}
