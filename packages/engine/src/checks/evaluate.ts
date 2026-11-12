import { CONFIG_FILE } from '../config-file.js';
import { isObject } from '../is-object.js';
import { JUDGE_KEYS, judgeTarget, type JudgeProvider, type JudgeVerdict } from '../judge.js';
import { JUDGE_SCOPE } from '../judge-scope.js';
import { estimateCost, formatUsd, type Price } from '../prices.js';
import { finalAnswer } from '../responses.js';
import type { StoreOf } from '../store.js';
import type { CallRecord, JudgeOutcome } from '../types.js';
import { asNumber, hasWildcard, pathAt, type CallCondition, type CallRule, type CheckResult, type CountRange, type ExpectSpec, type JudgeCheck, type Matcher, type NamedPath, type Operand, type Reference, type TestSpec, type TextCheck, type WhenRule } from './grammar.js';
import { COUNT_NOUNS, JUDGE_SKIP_UNDONE, NEGATED, PHRASE, TEXT_NOUNS, callRuleLabel, costLabel, countLabel, formatCount, judgeLabel, orList, showValue, textLabel, toolCheckLabel, toolCountDetail, whenLabel, type CountKey, type TextKey } from './labels.js';

/**
 * A run judged by its checks: each check's status, what it expected and what happened, from the
 * run's calls and what the agent printed. Each result is labelled as labels.ts labels its check, in
 * the order `checkLabels` lists them. A judge check takes the verdict its caller passes
 * (`judgeVerdicts`), from a judge call the run recorded or one asked live; nothing here asks a judge
 * or reads a recorded verdict, so without one the check is inconclusive, never passed.
 */

/** The provider a judge's model belongs to, as `provider:model` names it, or as the model's name says; null when neither does. */
export function judgeProvider(model: string): JudgeProvider | null {
  return judgeTarget(model)?.provider ?? null;
}

/**
 * Why a judge check has no verdict, for its inconclusive result: no verdict recorded for it and,
 * when the environment holds no key for its provider, no key to ask it live with. A key that is
 * there is not named as missing.
 */
export function notJudgedWhy(j: JudgeCheck, env: NodeJS.ProcessEnv = process.env): string {
  const provider = judgeProvider(j.model);
  if (provider && !JUDGE_KEYS[provider].some((k) => env[k]?.trim())) return `not judged: no recorded verdict and no key for ${provider}`;
  return 'not judged: no recorded verdict';
}

// ---- Evaluation ---------------------------------------------------------------------------------

/** Every expected value is present: objects partially, anything else exactly. */
export function argsMatch(actual: unknown, expected: unknown): boolean {
  if (isObject(expected)) return isObject(actual) && Object.entries(expected).every(([k, v]) => argsMatch(actual[k], v));
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => argsMatch(actual[i], v));
  return actual === expected;
}

export interface CheckInput {
  calls: CallRecord[];
  /** What the agent printed. */
  output: string;
  /** A tool call's recorded arguments. */
  argsOf: (call: CallRecord) => unknown;
  /**
   * A tool call's recorded result, or undefined for one that has none: it failed, was blocked, or
   * never finished. An input without it reads every result as missing, which never passes and
   * never goes unsaid: a rule that reads a result fails, naming it, and a condition on one is
   * inconclusive, not quietly not applicable. Inputs that judge runs give it (`storedCheckInput`).
   */
  resultOf?: (call: CallRecord) => unknown;
  /** The text of the last model response, or null without one. */
  answer: string | null;
  /** A model call's estimated cost in USD, or null when its model has no price. */
  costOf: (call: CallRecord) => number | null;
}

/** An input that judges no run, for what a spec's checks are called: their labels depend on the checks alone. */
export const LABEL_INPUT: CheckInput = { calls: [], output: '', answer: null, argsOf: () => undefined, resultOf: () => undefined, costOf: () => 0 };

/**
 * A judge's verdict on a run (its answer and reason, `JudgeVerdict`), from its recorded call or one
 * asked live, by the judge's name, with what the judge run knows of it besides, for the result's
 * `judge`: what it cost (0 from the recording, null for a model with no price), how many redaction
 * rules applied to what it read, whether what it read had what replay matching masks masked, how
 * much of it was cut, its call. The CLI calls it `JudgeVerdict` too.
 */
export interface JudgeCheckVerdict extends JudgeVerdict {
  source: 'recording' | 'live';
  cost?: number | null;
  redactions?: number;
  normalized?: boolean;
  cut?: number;
  callNo?: number;
}

export interface EvaluateOptions {
  judgeVerdicts?: ReadonlyMap<string, JudgeCheckVerdict>;
  /** Why a judge has no verdict, for its inconclusive result. Default: `notJudgedWhy`, no recorded verdict and, when the environment has none, no key for its provider. */
  judgeMissing?: (judge: JudgeCheck) => string;
  /**
   * Why a judge with no verdict wasn't asked, or null where it was meant to be: such a judge is not
   * applicable, with that reason, beside a check that failed. With none failed, it is inconclusive.
   */
  judgeNotAsked?: (judge: JudgeCheck) => string | null;
}

const inRange = (n: number, r: CountRange) => n >= r.min && n <= r.max;

/** A result whose status `ok` says: passed or failed. */
const verdict = (ok: boolean, label: string, detail: string | null): CheckResult => ({ status: ok ? 'passed' : 'failed', ok, label, detail });

function textChecks(check: TextCheck, text: string | null, key: TextKey): CheckResult[] {
  const haystack = (text ?? '').toLowerCase();
  const what = TEXT_NOUNS[key];
  return [
    ...check.includes.map((s) => ({ ok: haystack.includes(s.toLowerCase()), label: textLabel(key, s, true), detail: text === null ? `there was no ${what}` : `not found in the ${what}` })),
    ...check.excludes.map((s) => ({ ok: !haystack.includes(s.toLowerCase()), label: textLabel(key, s, false), detail: `found in the ${what}` })),
  ].map((r) => verdict(r.ok, r.label, r.ok ? null : r.detail));
}

/**
 * A run's results on a spec's checks. A judge that wasn't asked because another check failed
 * (`judgeNotAsked`) is not applicable only where a check failed in these results too. Where none did
 * (what the agent printed after the judges were skipped can change a check), it is inconclusive
 * (`JUDGE_SKIP_UNDONE`), so the run never passes without its judge.
 */
export function evaluateChecks(spec: ExpectSpec | TestSpec, input: CheckInput, options: EvaluateOptions = {}): CheckResult[] {
  const results = checksOf(spec, input, options);
  const { judgeNotAsked, ...asked } = options;
  if (!judgeNotAsked || results.some((r) => r.status === 'failed') || !results.some((r) => r.judge && r.status === 'not-applicable')) return results;
  const missing = (j: JudgeCheck) => options.judgeMissing?.(j) ?? notJudgedWhy(j);
  return checksOf(spec, input, { ...asked, judgeMissing: (j) => (judgeNotAsked(j) === null ? missing(j) : JUDGE_SKIP_UNDONE) });
}

function checksOf(spec: ExpectSpec | TestSpec, input: CheckInput, options: EvaluateOptions): CheckResult[] {
  const results: CheckResult[] = [];
  // A judge's own model calls are the oracle's, not the agent's: no check counts them.
  const calls = input.calls.filter((c) => c.meta?.scope !== JUDGE_SCOPE);
  const tools = calls.filter((c) => c.kind === 'tool');
  for (const t of spec.tools) {
    const named = tools.filter((c) => c.name === t.name);
    const matching = t.args ? named.filter((c) => argsMatch(input.argsOf(c), t.args)) : named;
    const n = matching.length;
    let detail: string | null = null;
    if (!inRange(n, t.count)) {
      // Writes fenced after a fork count too, said exactly: `(2 blocked)`, `(1 stubbed)`, `(1 blocked, 1 stubbed)`.
      const blocked = matching.filter((c) => c.origin === 'blocked').length;
      const stubbed = matching.filter((c) => c.origin === 'stubbed').length;
      detail = toolCountDetail({ count: n, blocked, stubbed, named: named.length, args: Boolean(t.args), tools: [...new Set(tools.map((c) => c.name))] });
    }
    results.push(verdict(detail === null, toolCheckLabel(t), detail));
  }
  const counted = (key: CountKey, n: number) => {
    const range = spec[key];
    if (range) results.push(verdict(inRange(n, range), countLabel(key, range), inRange(n, range) ? null : formatCount({ min: n, max: n }, COUNT_NOUNS[key])));
  };
  counted('modelCalls', calls.filter((c) => c.kind === 'api').length);
  counted('toolCalls', tools.length);

  // Budgets are measured over the run's model requests whatever their origin: a clean replay sends
  // the same requests it recorded, so this is what the run costs to run live, which is the number a
  // prompt change moves and the one worth failing a build over.
  const api = calls.filter((c) => c.kind === 'api');
  const tokens = (pick: (u: NonNullable<CallRecord['end']>['meta']['usage']) => number | undefined) =>
    api.reduce((sum, c) => sum + (pick(c.end?.meta.usage) ?? 0), 0);
  counted('inputTokens', tokens((u) => (u ? u.inputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0) : 0)));
  counted('outputTokens', tokens((u) => u?.outputTokens));

  if (spec.cost) {
    const priced = api.map((c) => ({ call: c, usd: input.costOf(c) }));
    const unpriced = priced.filter((p) => p.usd === null && p.call.end?.meta.usage);
    const total = priced.reduce((sum, p) => sum + (p.usd ?? 0), 0);
    const label = costLabel(spec.cost);
    if (unpriced.length) {
      // Silently treating an unknown price as zero would let a budget pass on a model nobody costed.
      const models = [...new Set(unpriced.map((p) => p.call.end?.meta.model ?? p.call.meta.model ?? 'unknown'))];
      results.push(verdict(false, label, `no price for ${models.join(', ')}; add it under "prices" in ${CONFIG_FILE}`));
    } else {
      const ok = inRange(total, spec.cost);
      results.push(verdict(ok, label, ok ? null : `cost ≈ ${formatUsd(total)}`));
    }
  }

  if (spec.output) results.push(...textChecks(spec.output, input.output, 'output'));
  if (spec.answer) results.push(...textChecks(spec.answer, input.answer, 'answer'));

  const scope: Scope = { calls, input: calls === input.calls ? input : { ...input, calls } };
  for (const rule of spec.calls ?? []) results.push(callRuleResult(rule, scope));
  for (const rule of spec.when ?? []) results.push(...whenResults(rule, scope, options));
  for (const j of spec.judge ?? []) results.push(judgeResult(j, options));
  return results;
}

/** The run the rules read: its calls (the agent's own) and how to read each one. */
interface Scope {
  calls: CallRecord[];
  input: CheckInput;
}

/**
 * A matcher's verdict on a value: it holds, it is broken, or it can't be decided (a value or a
 * call it needs is missing, or a value of the wrong kind) — which never counts as holding, negated
 * or not. `why` states the relation as it stands, with the values involved. Verdicts combine as
 * three-valued logic does: several that must all hold are broken when one is, whatever the others
 * are, and can't be decided when none is broken but one can't be; negation swaps held and broken
 * and leaves the undecided undecided. So a pass never rests on a value that was not there.
 */
interface Match {
  state: 'held' | 'broken' | 'undecided';
  why: string;
}

interface MatchContext {
  scope: Scope;
  /** The call being checked: references read the most recent call of their tool before it. */
  at: CallRecord;
  /** Tools the rule has already said have no call before this one: a reference to one says nothing more. */
  quiet?: ReadonlySet<string>;
}

const held = (why: string): Match => ({ state: 'held', why });
const broken = (why: string): Match => ({ state: 'broken', why });
const undecided = (why: string): Match => ({ state: 'undecided', why });

/**
 * A tool call's result as the input reads it, and why it has none. `ended`: the call ended without
 * one, failed or blocked, so it is known to have returned nothing; otherwise the result is just not
 * there to read (the call never finished, or its response can't be read).
 */
function resultOf(c: CallRecord, input: CheckInput): { value: unknown } | { none: string; ended: boolean } {
  const value = input.resultOf?.(c);
  if (value !== undefined) return { value };
  const why = c.origin === 'blocked' ? 'it was blocked' : !c.end ? 'it never finished' : c.end.outcome === 'error' ? 'it failed' : null;
  return { none: why ? `has no result (${why})` : 'has no result', ended: c.origin === 'blocked' || c.end?.outcome === 'error' };
}

/** A JSON object or list held in a string, as tools often return one, read so a path can go into it. */
function intoText(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trimStart();
  if (t[0] !== '{' && t[0] !== '[') return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

/** Every value at a path: one, none, or with `*` as many as it reaches. */
function valuesAt(value: unknown, path: Reference['path']): unknown[] {
  let current: unknown[] = [value];
  for (const seg of path) {
    const next: unknown[] = [];
    for (const raw of current) {
      const v = intoText(raw);
      if (seg.type === 'key') {
        if (isObject(v) && Object.hasOwn(v, seg.key)) next.push(v[seg.key]);
      } else if (seg.type === 'index') {
        if (Array.isArray(v)) {
          const i = seg.index < 0 ? v.length + seg.index : seg.index;
          if (i >= 0 && i < v.length) next.push(v[i]);
        }
      } else if (Array.isArray(v)) next.push(...(v as unknown[]));
      else if (isObject(v)) next.push(...Object.values(v));
    }
    current = next.filter((x) => x !== undefined);
  }
  return current;
}

/** What a reference reads, and the call it read it from. */
function resolveReference(ref: Reference, ctx: MatchContext): { values: unknown[]; callNo: number } | Match {
  // The most recent by call number, whatever order the calls came in.
  let prior: CallRecord | undefined;
  for (const c of ctx.scope.calls) if (c.kind === 'tool' && c.name === ref.tool && c.callNo < ctx.at.callNo && (!prior || c.callNo > prior.callNo)) prior = c;
  if (!prior) return undecided(ctx.quiet?.has(ref.tool) ? '' : `no ${ref.tool} call before it`);
  let base: unknown;
  if (ref.part === 'args') {
    base = ctx.scope.input.argsOf(prior);
    if (base === undefined) return undecided(`${ref.tool} #${prior.callNo} has no arguments`);
  } else {
    const r = resultOf(prior, ctx.scope.input);
    if ('none' in r) return undecided(`${ref.tool} #${prior.callNo} ${r.none}`);
    base = r.value;
  }
  const values = valuesAt(base, ref.path);
  if (!values.length) return undecided(`${ref.tool} #${prior.callNo} has no ${ref.text.slice(ref.tool.length + 1)}`);
  return { values, callNo: prior.callNo };
}

/** An operand's value and how a detail names it: `180`, `lookup_order.result.total 180 (#5)`. */
function operandValue(o: Operand, ctx: MatchContext): { value: unknown; text: string } | Match {
  if ('value' in o) return { value: o.value, text: showValue(o.value) };
  const r = resolveReference(o.ref, ctx);
  if ('state' in r) return r;
  return { value: r.values[0], text: `${o.ref.text} ${showValue(r.values[0])} (#${r.callNo})` };
}

/**
 * Several matches that must all hold, as one: broken when any is, else undecided when any is, else
 * held. The why names every part that did not hold.
 */
function combine(matches: Match[]): Match {
  const not = matches.filter((m) => m.state !== 'held');
  const state = not.some((m) => m.state === 'broken') ? 'broken' : not.length ? 'undecided' : 'held';
  return { state, why: (not.length ? not : matches).map((m) => m.why).filter(Boolean).join('; ') };
}

/** A value's test, as the run recorded it: held, broken or undecided, with the values that say so. */
function match(m: Matcher, actual: unknown, path: string, ctx: MatchContext): Match {
  switch (m.op) {
    case 'object':
    case 'array':
    case 'all':
    case 'not':
      return matchShape(m, actual, path, ctx);
    default:
      break;
  }
  const subject = path || 'the value';
  if (actual === undefined) return undecided(`has no ${subject}`);
  const shown = `${subject} ${showValue(actual)}`;
  if (m.op === 'in') return matchIn(m, actual, shown, ctx);
  const o = operandValue(m.operand, ctx);
  if ('state' in o) return o;
  switch (m.op) {
    case '<':
    case '<=':
    case '>':
    case '>=':
      return compareNumbers(m.op, actual, shown, o);
    default:
      return compare(m.op, actual, shown, o);
  }
}

/** A literal object or list, matched key by key or item by item, and matchers that must all hold, or must not. */
function matchShape(m: Extract<Matcher, { op: 'object' | 'array' | 'all' | 'not' }>, actual: unknown, path: string, ctx: MatchContext): Match {
  const subject = path || 'the value';
  switch (m.op) {
    // A value of another kind than the literal written can't be matched key by key or item by item:
    // that is no answer either way, so negating it doesn't make it pass.
    case 'object':
      if (!isObject(actual)) return actual === undefined ? undecided(`has no ${path || 'arguments'}`) : undecided(`${subject} is ${showValue(actual)}, not an object`);
      return m.keys.length ? combine(m.keys.map((k) => match(k.matcher, actual[k.key], pathAt(path, k.key), ctx))) : held(`${subject} is an object`);
    case 'array':
      if (!Array.isArray(actual)) return actual === undefined ? undecided(`has no ${subject}`) : undecided(`${subject} is ${showValue(actual)}, not a list`);
      if (actual.length !== m.items.length) return broken(`${subject} has ${actual.length} item${actual.length === 1 ? '' : 's'}, not ${m.items.length}`);
      return m.items.length ? combine(m.items.map((item, i) => match(item, actual[i], pathAt(path, i), ctx))) : held(`${subject} is an empty list`);
    case 'all':
      return combine(m.matchers.map((x) => match(x, actual, path, ctx)));
    case 'not': {
      const inner = match(m.matcher, actual, path, ctx);
      return inner.state === 'undecided' ? inner : { ...inner, state: inner.state === 'held' ? 'broken' : 'held' };
    }
  }
}

/** `in`: the value is one of a list the rule writes, or of one an earlier call recorded. */
function matchIn(m: Extract<Matcher, { op: 'in' }>, actual: unknown, shown: string, ctx: MatchContext): Match {
  let list: unknown[];
  let text: string;
  if ('list' in m) {
    const r = resolveReference(m.list, ctx);
    if ('state' in r) return r;
    // A path with `*` reads its values; any other reads one list.
    if (hasWildcard(m.list)) list = r.values;
    else if (Array.isArray(r.values[0])) list = r.values[0] as unknown[];
    else return undecided(`${m.list.text} is ${showValue(r.values[0])} (#${r.callNo}), not a list`);
    text = `${m.list.text} ${showValue(list)} (#${r.callNo})`;
  } else {
    const items = m.items.map((o) => operandValue(o, ctx));
    const problem = items.find((x): x is Match => 'state' in x);
    if (problem) return problem;
    const values = items as Array<{ value: unknown; text: string }>;
    list = values.map((x) => x.value);
    text = `[${values.map((x) => x.text).join(', ')}]`;
  }
  return list.some((x) => argsMatch(actual, x)) ? held(`${shown} in ${text}`) : broken(`${shown} not in ${text}`);
}

/** `<`, `<=`, `>` and `>=`: a number, or one written plainly as text, on either side, else undecided. */
function compareNumbers(op: '<' | '<=' | '>' | '>=', actual: unknown, shown: string, o: { value: unknown; text: string }): Match {
  const a = asNumber(actual);
  const b = asNumber(o.value);
  if (a === null) return undecided(`${shown} is not a number`);
  if (b === null) return undecided(`${o.text} is not a number`);
  const ok = op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
  return (ok ? held : broken)(`${shown} ${(ok ? PHRASE : NEGATED)[op]} ${o.text}`);
}

/** `=` and `!=` as `tools` matches arguments, `includes` of text or a list, and how text starts or ends. */
function compare(op: '=' | '!=' | 'includes' | 'startsWith' | 'endsWith', actual: unknown, shown: string, o: { value: unknown; text: string }): Match {
  switch (op) {
    case '=':
    case '!=': {
      const equal = argsMatch(actual, o.value);
      const ok = op === '=' ? equal : !equal;
      return (ok ? held : broken)(`${shown} ${equal ? '=' : '!='} ${o.text}`);
    }
    case 'includes': {
      let found: boolean;
      if (typeof actual === 'string' && typeof o.value === 'string') found = actual.includes(o.value);
      else if (Array.isArray(actual)) found = actual.some((x) => argsMatch(x, o.value));
      else return undecided(typeof actual === 'string' ? `${o.text} is not text` : `${shown} is not text or a list`);
      return (found ? held : broken)(`${shown} ${found ? 'includes' : "doesn't include"} ${o.text}`);
    }
    case 'startsWith':
    case 'endsWith': {
      if (typeof actual !== 'string') return undecided(`${shown} is not text`);
      if (typeof o.value !== 'string') return undecided(`${o.text} is not text`);
      const ok = op === 'startsWith' ? actual.startsWith(o.value) : actual.endsWith(o.value);
      return (ok ? held : broken)(`${shown} ${(ok ? PHRASE : NEGATED)[op]} ${o.text}`);
    }
  }
}

/** Problems found in the calls a rule checked, as a detail names them: the first three, then how many more. */
function problemsDetail(problems: string[], noun: string): string {
  const more = problems.length - 3;
  return problems.slice(0, 3).join('; ') + (more > 0 ? `; ${more} more ${noun} call${more === 1 ? '' : 's'} too` : '');
}

/** A `calls` rule: each call of its tool, after its tools and with its arguments as asked. */
function callRuleResult(rule: CallRule, scope: Scope): CheckResult {
  const label = callRuleLabel(rule);
  const problems: string[] = [];
  for (const c of scope.calls) {
    if (c.kind !== 'tool' || c.name !== rule.tool) continue;
    const whys: string[] = [];
    const before = rule.after.filter((t) => !scope.calls.some((d) => d.kind === 'tool' && d.name === t && d.callNo < c.callNo));
    if (before.length) whys.push(`no ${orList(before)} call before it`);
    if (rule.args) {
      // A reference to a call `after` already found missing would only say so again.
      const r = match(rule.args, scope.input.argsOf(c), '', { scope, at: c, quiet: new Set(before) });
      if (r.state !== 'held' && r.why) whys.push(r.why);
    }
    if (whys.length) problems.push(`${rule.tool} #${c.callNo}: ${whys.join('; ')}`);
  }
  return verdict(problems.length === 0, label, problems.length ? problemsDetail(problems, rule.tool) : null);
}

/**
 * Whether a call meets a `when` condition, and the values that say so either way. A call that
 * failed or was blocked returned no result, so a condition on its result does not hold there; a
 * value that is missing from a result, or of another kind than the condition compares, or a
 * reference with nothing to read, leaves it undecided.
 */
function conditionAt(cond: CallCondition, c: CallRecord, scope: Scope): Match {
  const ctx = { scope, at: c };
  const parts: Match[] = [];
  if (cond.args) parts.push(match(cond.args, scope.input.argsOf(c), 'args', ctx));
  if (cond.result) {
    const r = resultOf(c, scope.input);
    parts.push('none' in r ? (r.ended ? broken(r.none) : undecided(r.none)) : match(cond.result, r.value, 'result', ctx));
  }
  return parts.length ? combine(parts) : held('');
}

/**
 * A `when` rule: its `then` checks, each reported under the condition. Applied when any call met
 * the condition. When none did, each is not applicable, with what the calls had instead; but when
 * one of them could not be read for it (a value the condition compares is missing, or of another
 * kind), whether the condition held can't be told, and each is inconclusive, saying what is
 * missing: "the condition never held" would claim more than was checked.
 */
function whenResults(rule: WhenRule, scope: Scope, options: EvaluateOptions): CheckResult[] {
  const cond = rule.if;
  const inner = checksOf(rule.then, scope.input, options);
  const tried = scope.calls.filter((c) => c.kind === 'tool' && c.name === cond.tool).map((c) => ({ c, m: conditionAt(cond, c, scope) }));
  const met = tried.find((t) => t.m.state === 'held');
  if (met) {
    const where = `the condition held at ${cond.tool} #${met.c.callNo}${met.m.why ? ` (${met.m.why})` : ''}`;
    return inner.map((r) => ({ ...r, label: whenLabel(cond, r.label), detail: r.detail === null ? null : `${r.detail}; ${where}` }));
  }
  const unread = tried.filter((t) => t.m.state === 'undecided');
  const calls = (ts: typeof tried) => problemsDetail(ts.map((t) => `${cond.tool} #${t.c.callNo}: ${t.m.why}`), cond.tool);
  if (unread.length) return inner.map((r) => ({ status: 'inconclusive' as const, ok: false, label: whenLabel(cond, r.label), detail: `could not tell whether the condition held: ${calls(unread)}` }));
  const seen = tried.length ? calls(tried) : `${cond.tool} was never called`;
  return inner.map((r) => ({ status: 'not-applicable' as const, ok: true, label: whenLabel(cond, r.label), detail: `the condition never held: ${seen}` }));
}

/**
 * A judge check: its verdict, or inconclusive with why it has none, or not applicable where it
 * wasn't asked (`judgeNotAsked`). It never passes unjudged. Its `judge` keeps how it came out, for the
 * reports: the verdict, where it came from and what it cost.
 */
function judgeResult(j: JudgeCheck, options: EvaluateOptions): CheckResult {
  const label = judgeLabel(j);
  const v = options.judgeVerdicts?.get(j.name);
  const judge: JudgeOutcome = {
    name: j.name,
    model: j.model,
    of: j.of,
    verdict: v?.verdict ?? null,
    source: v?.source ?? null,
    cost: v ? (v.cost !== undefined ? v.cost : v.source === 'recording' ? 0 : null) : null,
    redactions: v?.redactions ?? 0,
    normalized: v?.normalized ?? false,
    cut: v?.cut ?? 0,
    ...(v?.callNo !== undefined ? { callNo: v.callNo } : {}),
  };
  if (!v) {
    // Not asked, as no verdict could change how the run came out: it says nothing either way.
    const notAsked = options.judgeNotAsked?.(j) ?? null;
    if (notAsked !== null) return { status: 'not-applicable', ok: true, label, detail: notAsked, judge };
    return { status: 'inconclusive', ok: false, label, detail: options.judgeMissing?.(j) ?? notJudgedWhy(j), judge };
  }
  const ok = v.verdict === j.pass;
  return { status: ok ? 'passed' : 'failed', ok, label, detail: ok ? null : `the judge answered ${v.verdict}`, reason: v.reason || 'no reason given', source: v.source, judge };
}

/** Judge checks alone, as `evaluateChecks` judges them: for a run judged after it ended (`pack`, `test --update`). */
export function judgeResults(judges: readonly JudgeCheck[], options: EvaluateOptions = {}): CheckResult[] {
  return judges.map((j) => judgeResult(j, options));
}

// ---- What the checks read of a run --------------------------------------------------------------

/**
 * The input checks read from a run in the store: its calls in order, each tool call's arguments
 * and result (read once each), the last model response, and each model call's cost under `prices`.
 */
export function storedCheckInput(store: StoreOf<'recording'>, calls: CallRecord[], output: string, prices?: Record<string, Price>): CheckInput {
  return {
    calls,
    output,
    answer: finalAnswer(store, calls.filter((c) => c.meta?.scope !== JUDGE_SCOPE)),
    ...storedCalls(store),
    costOf: (c) => estimateCost(c.end?.meta.model ?? c.meta.model, c.end?.meta.usage, prices),
  };
}

/** How to read a run's tool calls in the store: each call's recorded arguments and result, read once each. */
export function storedCalls(store: StoreOf<'recording'>): Pick<CheckInput, 'argsOf' | 'resultOf'> {
  const args = new Map<string, unknown>();
  const results = new Map<string, unknown>();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names what the stored document is, as getJson's do
  const read = <T>(ref: string | null | undefined, pick: (doc: T) => unknown): unknown => {
    if (!ref) return undefined;
    try {
      const doc = store.getJson<T>(ref);
      return doc === null || doc === undefined ? undefined : pick(doc);
    } catch {
      return undefined;
    }
  };
  const key = (c: CallRecord) => `${c.runId} ${c.callNo}`;
  return {
    argsOf: (c) => {
      if (!args.has(key(c))) args.set(key(c), read<{ args?: unknown }>(c.requestRef, (d) => d.args));
      return args.get(key(c));
    },
    resultOf: (c) => {
      if (c.kind !== 'tool' || c.end?.outcome !== 'ok') return undefined;
      if (!results.has(key(c))) results.set(key(c), read<{ result?: unknown }>(c.end.responseRef, (d) => d.result));
      return results.get(key(c));
    },
  };
}

// ---- What a spec reads that the recordings don't have -------------------------------------------

/** The calls of a recording, and how to read each one's arguments and result. */
export interface RecordedCalls {
  calls: readonly CallRecord[];
  input: Pick<CheckInput, 'argsOf' | 'resultOf'>;
}

/** A value no recorded call of its tool has: how many calls were read for it, and the keys they have where it is missing. */
export interface UnreadPath extends NamedPath {
  calls: number;
  keys: string[];
}

/**
 * The values a spec reads that no recorded call of their tool has: most likely a misspelt key, and
 * a rule that reads one fails on every call, a condition on one can't be decided. A tool no
 * recording called is left out: the tool's name is what is wrong there. `keys` are the keys the
 * calls do have beside the missing one, to suggest the one meant.
 */
export function unreadPaths(paths: readonly NamedPath[], recordings: readonly RecordedCalls[]): UnreadPath[] {
  const out: UnreadPath[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const id = `${p.tool} ${p.text} ${p.at}`;
    if (seen.has(id)) continue;
    seen.add(id);
    let calls = 0;
    let found = false;
    const keys = new Set<string>();
    for (const r of recordings) {
      for (const c of r.calls) {
        if (c.kind !== 'tool' || c.name !== p.tool) continue;
        const base = p.part === 'args' ? r.input.argsOf(c) : r.input.resultOf?.(c);
        if (base === undefined) continue;
        calls++;
        if (valuesAt(base, p.path).length) {
          found = true;
          break;
        }
        for (const v of valuesAt(base, p.path.slice(0, -1))) {
          const o = intoText(v);
          if (isObject(o)) Object.keys(o).forEach((k) => keys.add(k));
        }
      }
      if (found) break;
    }
    if (!found && calls) out.push({ ...p, calls, keys: [...keys].sort() });
  }
  return out;
}

/** How many single-character edits turn one name into the other. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length]!;
}

/** The known name a misspelt one most likely meant: within a third of its length in edits, or null. */
export function closestName(name: string, known: Iterable<string>): string | null {
  let best: { name: string; d: number } | null = null;
  for (const k of known) {
    const d = editDistance(name.toLowerCase(), k.toLowerCase());
    if (d <= Math.max(1, Math.floor(name.length / 3)) && (!best || d < best.d)) best = { name: k, d };
  }
  return best?.name ?? null;
}
