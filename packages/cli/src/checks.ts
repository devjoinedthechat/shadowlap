import { resolve } from 'node:path';
import { JUDGE_SCOPE, aboutUsd, checkStatus, estimateCost, finalAnswer, formatUsd, judgeTarget, parseGate, parseInjectionEntry, parsePath, parseTaskFields, testsEntryFor, type CallRecord, type CheckStatus, type Gate, type InjectionEntry, type JudgeOutcome, type JudgeProvider, type Price, type Store, type StoredCheck } from '@shadowlap/engine';
import { parseChaosFields } from './chaos-config.js';

/**
 * Outcome checks for `shadowlap test`. A golden normally passes only when the replay is clean, which
 * makes an intended prompt change a failure. With checks, a recording can instead say what the
 * agent must do: call this tool, never attempt that write, stay under n model calls, print this. A
 * recording marked `fork` may diverge, goes live from the fork, and passes on its checks, so the
 * run that showed a bug becomes the test that the fix holds, and `repeat` asks it more than once.
 *
 * They live in shadowlap.config.json under `tests`, keyed by recording directory:
 *
 *   "tests": {
 *     "goldens/refund-request": {
 *       "fork": true,
 *       "repeat": 3,
 *       "expect": {
 *         "tools": { "send_email": 0, "issue_refund": { "count": ">= 1", "args": { "order_id": "A-1042" } } },
 *         "modelCalls": "<= 12",
 *         "output": { "includes": ["refund issued"] },
 *         "answer": { "excludes": ["cannot help"] }
 *       }
 *     }
 *   }
 *
 * Counts and text say how much the agent did. Three more keys say what it did, in what order and
 * on what condition, which is where most failures that matter are:
 *
 *   "calls": [{ "tool": "issue_refund", "after": "lookup_order", "args": { "amount": { "<=": "@lookup_order.result.total" } } }]
 *     every call of a tool meets the rule: the tools it comes after, and predicates on its arguments,
 *     which may read a value from the most recent call of another tool before it;
 *   "when": [{ "if": { "tool": "lookup_order", "result": { "total": { ">": 200 } } }, "then": { "tools": { "escalate": ">= 1" } } }]
 *     an ordinary expect that applies only once a call matched the condition; until then it is
 *     not applicable, which is never reported as passed;
 *   "judge": [{ "name": "explains-escalation", "question": "…", "of": "answer", "model": "claude-haiku-4-5", "pass": "yes" }]
 *     a question a model answers about the run. Its verdict comes from the call that asked it,
 *     recorded like any other (`judgeVerdicts`); without one the check is inconclusive, never passed.
 */

export interface CountRange {
  min: number;
  max: number;
}

export interface ToolCheck {
  name: string;
  count: CountRange;
  /** Counts only calls whose arguments contain these values. */
  args?: Record<string, unknown>;
}

export interface TextCheck {
  includes: string[];
  excludes: string[];
}

/** The comparisons a predicate may make, as the keys of an object such as `{ "<=": 100 }`. */
export const OPERATORS = ['=', '!=', '<', '<=', '>', '>=', 'in', 'includes', 'startsWith', 'endsWith', 'not'] as const;
export type Operator = (typeof OPERATORS)[number];

/**
 * Keys that read like an operator someone meant but are not one: another language's name for it
 * (`gt`, `contains`, `$in`) or an operator in another case (`endswith`). In a value to match they
 * would be a key the value must have, which a value almost never has: under `not` that passes
 * everything, in a condition it never holds. So they are refused, with the operator they meant.
 * Null stands for one with no operator to offer (there are no regular expressions).
 */
export const OPERATOR_ALIASES: Readonly<Record<string, Operator | null>> = {
  eq: '=',
  equals: '=',
  ne: '!=',
  neq: '!=',
  lt: '<',
  lte: '<=',
  le: '<=',
  gt: '>',
  gte: '>=',
  ge: '>=',
  contains: 'includes',
  nin: 'not',
  notin: 'not',
  not_in: 'not',
  matches: null,
  regex: null,
  like: null,
};

/** The operator a key that is not one most likely meant, or undefined for an ordinary key. Null: an operator that doesn't exist. */
export function aliasOf(key: string): Operator | null | undefined {
  const bare = key.startsWith('$') ? key.slice(1) : key;
  if (bare !== key && (OPERATORS as readonly string[]).includes(bare)) return bare as Operator;
  const lower = bare.toLowerCase();
  const op = OPERATORS.find((o) => o.toLowerCase() === lower);
  if (op && op !== key) return op;
  return Object.hasOwn(OPERATOR_ALIASES, lower) ? OPERATOR_ALIASES[lower] : undefined;
}

/**
 * `@lookup_order.result.total`, `@lookup_order.args.order_id`: a value from the most recent call of
 * a tool before the call being checked. `path` is what follows `result` or `args`, read as the
 * JSONPath subset normalizers use (`.total`, `.items[0].sku`, `.*`); `text` is how reports name it.
 */
export interface Reference {
  tool: string;
  part: 'result' | 'args';
  path: ReturnType<typeof parsePath>;
  /** `lookup_order.result.total`: the reference without its `@`. */
  text: string;
  /** Where it was written, for messages about it. */
  at: string;
}

/** A value a predicate compares with: one written in the config, or one read from an earlier call. */
export type Operand = { value: unknown } | { ref: Reference };

/**
 * A value's test, parsed. A literal keeps the meaning it has under `tools` (equal; an object
 * matches the keys it gives, a list must have its items), with predicates allowed at any key; an
 * object whose keys are all operators is a predicate, and several operators must all hold.
 */
export type Matcher =
  | { op: '=' | '!=' | '<' | '<=' | '>' | '>=' | 'includes' | 'startsWith' | 'endsWith'; operand: Operand }
  | { op: 'in'; items: Operand[] }
  | { op: 'in'; list: Reference }
  | { op: 'not'; matcher: Matcher }
  | { op: 'all'; matchers: Matcher[] }
  | { op: 'object'; keys: Array<{ key: string; matcher: Matcher }> }
  | { op: 'array'; items: Matcher[] };

/** `calls`: a rule every call of `tool` must meet. A tool never called meets it: pair it with `tools` when the call must happen. */
export interface CallRule {
  tool: string;
  /** Tools that each have a call before every call of `tool`. */
  after: string[];
  /** The call's arguments, by name. */
  args: Matcher | null;
  at: string;
}

/** `when.if`: holds once any call of `tool` matches its arguments and its result. */
export interface CallCondition {
  tool: string;
  args: Matcher | null;
  result: Matcher | null;
  at: string;
}

export interface WhenRule {
  if: CallCondition;
  then: ExpectSpec;
}

/** `judge`: a question a model answers about the run, `yes` or `no`, and the answer that passes. */
export interface JudgeCheck {
  name: string;
  question: string;
  /** What the judge reads: the last model response, what the agent printed, or the conversation and tool calls. */
  of: 'answer' | 'output' | 'run';
  /** The judge's model: `claude-haiku-4-5`, or with its provider, `openai:gpt-5.5`. */
  model: string;
  pass: 'yes' | 'no';
}

/** The providers a judge's model can belong to (the engine's, which builds each one's request). */
export type { JudgeProvider };

/** The environment variables a provider's key is read from. */
export const JUDGE_KEYS: Readonly<Record<JudgeProvider, readonly string[]>> = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};

/** What an `expect` object asks for: the checks alone. */
export interface ExpectSpec {
  tools: ToolCheck[];
  modelCalls?: CountRange;
  toolCalls?: CountRange;
  /** Tokens the run's model requests add up to, whatever their origin: what it costs to run live. */
  inputTokens?: CountRange;
  outputTokens?: CountRange;
  /** USD, from the price table. A model with no price fails the check rather than passing quietly. */
  cost?: CountRange;
  output?: TextCheck;
  answer?: TextCheck;
  calls?: CallRule[];
  when?: WhenRule[];
  judge?: JudgeCheck[];
}

export interface TestSpec extends ExpectSpec {
  /** The recording may diverge: the replay goes live from the fork and passes on its checks. */
  fork: boolean;
  repeat: number;
  /** Attempts that must pass, out of `repeat`. */
  passes: number;
  /**
   * Decides on the attempts as they come in, with stated error rates, instead of `repeat` and
   * `passes` (both 1 then): an SPRT gate or one against the golden's history (stats.ts).
   */
  gate?: Gate;
  /** The injection gate (`"injection"` beside `expect`): `shadowlap test` runs the golden's injection test after its replay passes. */
  injection?: InjectionEntry;
}

export interface TestEntry {
  /** As written in the config: a directory relative to it, with `*` allowed in the last part. */
  recording: string;
  spec: TestSpec;
}

export interface CheckResult {
  /** `passed`, `failed`, `inconclusive` (it could not be decided) or `not-applicable` (a `when` whose condition never held). */
  status: CheckStatus;
  /** True for passed and not applicable: what a result said before it had a status. */
  ok: boolean;
  /** What was expected, e.g. `send_email called 0 times`. */
  label: string;
  /** What happened, naming the values involved, for a check that did not pass; null for one that did. */
  detail: string | null;
  /** A judge's reason for its verdict. */
  reason?: string;
  /** Where a judge's verdict came from: the call recorded in the run, or one asked live. */
  source?: 'recording' | 'live';
  /** A judge check: its verdict, where it came from, what it read and what it cost. */
  judge?: JudgeOutcome;
}

const CONFIG = 'shadowlap.config.json';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function onlyKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new Error(`${where} has an unknown key "${key}" (expected ${allowed.map((k) => `"${k}"`).join(', ')})`);
  }
}

/** `3`, `">= 1"`, `"<= 12"`, `"> 0"`, `"< 5"`, `"2-4"`. */
export function parseCount(value: unknown, where: string): CountRange {
  const fail = () => new Error(`${where} must be a count such as 0, ">= 1", "<= 12" or "2-4"`);
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) throw fail();
    return { min: value, max: value };
  }
  if (typeof value !== 'string') throw fail();
  const s = value.trim();
  let m = /^(>=|<=|>|<|=)?\s*(\d+)$/.exec(s);
  if (m) {
    const n = Number(m[2]);
    switch (m[1]) {
      case '>=':
        return { min: n, max: Infinity };
      case '>':
        return { min: n + 1, max: Infinity };
      case '<=':
        return { min: 0, max: n };
      case '<':
        if (n === 0) throw fail();
        return { min: 0, max: n - 1 };
      default:
        return { min: n, max: n };
    }
  }
  m = /^(\d+)\s*-\s*(\d+)$/.exec(s);
  if (m && Number(m[1]) <= Number(m[2])) return { min: Number(m[1]), max: Number(m[2]) };
  throw fail();
}

/**
 * A budget in dollars. Same forms as a count, but fractional, because the useful assertion is
 * "this run must not cost more than fifty cents", not "not more than one dollar".
 */
export function parseAmount(value: unknown, where: string): CountRange {
  const fail = () => new Error(`${where} must be an amount such as 0.5, "<= 0.50" or "0.1-0.4"`);
  const num = (t: string) => {
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) throw fail();
    return n;
  };
  if (typeof value === 'number') return { min: num(String(value)), max: num(String(value)) };
  if (typeof value !== 'string') throw fail();
  const s = value.trim().replace(/\$/g, '');
  let m = /^(>=|<=|>|<|=)?\s*([0-9]*\.?[0-9]+)$/.exec(s);
  if (m) {
    const n = num(m[2]!);
    switch (m[1]) {
      case '>=':
      case '>':
        return { min: n, max: Infinity };
      case '<=':
      case '<':
        return { min: 0, max: n };
      default:
        return { min: n, max: n };
    }
  }
  m = /^([0-9]*\.?[0-9]+)\s*-\s*([0-9]*\.?[0-9]+)$/.exec(s);
  if (m && num(m[1]!) <= num(m[2]!)) return { min: num(m[1]!), max: num(m[2]!) };
  throw fail();
}

export function formatCount(r: CountRange, noun = 'time'): string {
  const plural = (n: number) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  if (r.min === r.max) return plural(r.min);
  if (r.max === Infinity) return `at least ${plural(r.min)}`;
  if (r.min === 0) return `at most ${plural(r.max)}`;
  return `${r.min} to ${plural(r.max)}`;
}

/**
 * A budget in a label, not a measurement. `formatUsd` carries sub-cent precision because a measured
 * cost needs it, which turns the `<= 0.50` someone wrote into `$0.500`. A threshold is a round
 * number a person chose, so it is echoed as they would have written it; the measured side that a
 * failure reports still goes through `formatUsd`.
 */
const threshold = (n: number) => (n === 0 ? '$0' : n < 0.01 ? formatUsd(n) : `$${n.toFixed(2)}`);

export function formatAmount(r: CountRange): string {
  if (r.min === r.max) return `exactly ${threshold(r.min)}`;
  if (r.max === Infinity) return `at least ${threshold(r.min)}`;
  if (r.min === 0) return `at most ${threshold(r.max)}`;
  return `${threshold(r.min)} to ${threshold(r.max)}`;
}

function parseText(value: unknown, where: string): TextCheck {
  if (!isObject(value)) throw new Error(`${where} must be an object with "includes" and/or "excludes"`);
  onlyKeys(value, ['includes', 'excludes'], where);
  const list = (key: 'includes' | 'excludes'): string[] => {
    const v = value[key];
    if (v === undefined) return [];
    const items = typeof v === 'string' ? [v] : v;
    if (!Array.isArray(items) || !items.every((x) => typeof x === 'string' && x.length > 0)) throw new Error(`${where}.${key} must be a string or a list of strings`);
    return items as string[];
  };
  return { includes: list('includes'), excludes: list('excludes') };
}

function parseSpec(raw: unknown, where: string): TestSpec {
  if (!isObject(raw)) throw new Error(`${where} must be an object`);
  // `task` (where a model takes over, why, what it rewards) is read by `shadowlap tasks` (tasks.ts),
  // and `chaos` (the error-path presets) by `test --chaos` (chaos-config.ts); a mistake in either
  // fails here too, as any other mistake under `tests` does.
  onlyKeys(raw, ['fork', 'repeat', 'passes', 'gate', 'expect', 'task', 'injection', 'chaos'], where);
  parseTaskFields(raw.task, `${where}.task`);
  parseChaosFields(raw.chaos, `${where}.chaos`, parseExpect);
  if (raw.fork !== undefined && typeof raw.fork !== 'boolean') throw new Error(`${where}.fork must be true or false`);
  // Statistical gating: the gate decides how many attempts run, so it stands in for repeat and passes.
  let gate: Gate | undefined;
  if (raw.gate !== undefined) {
    if (raw.repeat !== undefined || raw.passes !== undefined) throw new Error(`${where}: a gate decides how many attempts run and what passes; give the gate, or repeat and passes, not both`);
    if (raw.fork !== true) throw new Error(`${where}.gate needs "fork": true: only a golden that may fork runs live, where its attempts can come out differently`);
    gate = parseGate(raw.gate, `${where}.gate`);
  }
  const repeat = raw.repeat ?? 1;
  if (typeof repeat !== 'number' || !Number.isInteger(repeat) || repeat < 1 || repeat > 100) throw new Error(`${where}.repeat must be a whole number from 1 to 100`);
  const passes = raw.passes ?? repeat;
  if (typeof passes !== 'number' || !Number.isInteger(passes) || passes < 1 || passes > repeat) throw new Error(`${where}.passes must be a whole number from 1 to repeat (${repeat})`);
  const spec: TestSpec = { fork: raw.fork === true, repeat, passes, tools: [], ...(gate ? { gate } : {}) };
  if (raw.expect !== undefined) parseExpectInto(spec, raw.expect, `${where}.expect`);
  // Injection tests (injection.ts in the engine): the gate `shadowlap test` and `shadowlap injection` read.
  if (raw.injection !== undefined) spec.injection = parseInjectionEntry(raw.injection, `${where}.injection`);
  return spec;
}

/**
 * An `expect` object on its own, as `shadowlap blame --expect` takes it: the same checks a recording
 * can have under `tests`, judging one run. `where` names the source in error messages.
 */
export function parseExpect(raw: unknown, where: string): TestSpec {
  const spec: TestSpec = { fork: true, repeat: 1, passes: 1, tools: [] };
  parseExpectInto(spec, raw, where);
  return spec;
}

/** The keys an `expect` object may have, in the order its checks are reported. */
export const EXPECT_KEYS = ['tools', 'modelCalls', 'toolCalls', 'inputTokens', 'outputTokens', 'cost', 'output', 'answer', 'calls', 'when', 'judge'] as const;

/**
 * Reads an `expect` object into `spec`. `judges` holds the judge names seen so far, wherever in the
 * object (a `when`'s `then` included), since a verdict is kept under its judge's name.
 */
function parseExpectInto(spec: ExpectSpec, expect: unknown, where: string, judges = new Map<string, string>()): void {
  if (!isObject(expect)) throw new Error(`${where} must be an object`);
  onlyKeys(expect, [...EXPECT_KEYS], where);
  if (expect.tools !== undefined) {
    if (!isObject(expect.tools)) throw new Error(`${where}.tools must map tool names to counts`);
    for (const [name, v] of Object.entries(expect.tools)) {
      const at = `${where}.tools["${name}"]`;
      if (isObject(v)) {
        onlyKeys(v, ['count', 'args'], at);
        if (v.args !== undefined && !isObject(v.args)) throw new Error(`${at}.args must be an object of argument values`);
        spec.tools.push({ name, count: parseCount(v.count ?? '>= 1', `${at}.count`), ...(v.args ? { args: v.args as Record<string, unknown> } : {}) });
      } else {
        spec.tools.push({ name, count: parseCount(v, at) });
      }
    }
  }
  if (expect.modelCalls !== undefined) spec.modelCalls = parseCount(expect.modelCalls, `${where}.modelCalls`);
  if (expect.inputTokens !== undefined) spec.inputTokens = parseCount(expect.inputTokens, `${where}.inputTokens`);
  if (expect.outputTokens !== undefined) spec.outputTokens = parseCount(expect.outputTokens, `${where}.outputTokens`);
  if (expect.cost !== undefined) spec.cost = parseAmount(expect.cost, `${where}.cost`);
  if (expect.toolCalls !== undefined) spec.toolCalls = parseCount(expect.toolCalls, `${where}.toolCalls`);
  if (expect.output !== undefined) spec.output = parseText(expect.output, `${where}.output`);
  if (expect.answer !== undefined) spec.answer = parseText(expect.answer, `${where}.answer`);
  if (expect.calls !== undefined) spec.calls = listOf(expect.calls, `${where}.calls`, 'rules, such as [{ "tool": "issue_refund", "after": "lookup_order" }]').map(([raw, at]) => parseCallRule(raw, at));
  if (expect.when !== undefined) spec.when = listOf(expect.when, `${where}.when`, 'rules, each { "if": …, "then": … }').map(([raw, at]) => parseWhen(raw, at, judges));
  if (expect.judge !== undefined) {
    spec.judge = listOf(expect.judge, `${where}.judge`, 'questions, each { "name", "question", "model" }').map(([raw, at]) => {
      const j = parseJudge(raw, at);
      const first = judges.get(j.name);
      if (first !== undefined) throw new Error(`${at}.name "${j.name}" is already the name of ${first}: each judge needs a name of its own, which its verdict is kept under`);
      judges.set(j.name, at);
      return j;
    });
  }
}

/** A list under `where`, each item with its own `where`. */
function listOf(raw: unknown, where: string, what: string): Array<[unknown, string]> {
  if (!Array.isArray(raw)) throw new Error(`${where} must be a list of ${what}`);
  return raw.map((item, i) => [item, `${where}[${i}]`]);
}

function toolName(v: unknown, where: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${where} must name a tool`);
  return v;
}

/** `{ "tool": …, "after": "lookup_order" | [...], "args": { … } }`. */
export function parseCallRule(raw: unknown, where: string): CallRule {
  if (!isObject(raw)) throw new Error(`${where} must be an object with "tool"`);
  onlyKeys(raw, ['tool', 'after', 'args'], where);
  const tool = toolName(raw.tool, `${where}.tool`);
  let after: string[] = [];
  if (raw.after !== undefined) {
    const list = typeof raw.after === 'string' ? [raw.after] : raw.after;
    if (!Array.isArray(list) || !list.length) throw new Error(`${where}.after must be a tool name or a list of them`);
    after = list.map((t, i) => toolName(t, Array.isArray(raw.after) ? `${where}.after[${i}]` : `${where}.after`));
  }
  // Arguments with nothing to match check nothing, as no arguments do.
  const args = raw.args === undefined || (isObject(raw.args) && !Object.keys(raw.args).length) ? null : parseArgs(raw.args, `${where}.args`);
  if (!after.length && !args) throw new Error(`${where} checks nothing: give it "after", "args" or both (to require a call of ${tool}, use "tools")`);
  return { tool, after, args, at: where };
}

/** A call's arguments, by name: always an object of names, even one named like an operator. */
function parseArgs(raw: unknown, where: string): Matcher {
  if (!isObject(raw)) throw new Error(`${where} must be an object of argument names, each with a value or a predicate such as { "<=": 100 }`);
  return { op: 'object', keys: Object.entries(raw).map(([key, v]) => ({ key, matcher: parsePredicate(v, `${where}["${key}"]`) })) };
}

/** `{ "if": { "tool": …, "args": …, "result": … }, "then": { …an expect… } }`. */
export function parseWhen(raw: unknown, where: string, judges = new Map<string, string>()): WhenRule {
  if (!isObject(raw)) throw new Error(`${where} must be an object with "if" and "then"`);
  onlyKeys(raw, ['if', 'then'], where);
  if (raw.if === undefined || raw.then === undefined) throw new Error(`${where} needs both "if" and "then"`);
  const cond = raw.if;
  const at = `${where}.if`;
  if (!isObject(cond)) throw new Error(`${at} must be an object with "tool", and "args" or "result" to match`);
  onlyKeys(cond, ['tool', 'args', 'result'], at);
  const condition: CallCondition = {
    tool: toolName(cond.tool, `${at}.tool`),
    args: cond.args === undefined || (isObject(cond.args) && !Object.keys(cond.args).length) ? null : parseArgs(cond.args, `${at}.args`),
    result: cond.result === undefined ? null : parsePredicate(cond.result, `${at}.result`),
    at,
  };
  const then: ExpectSpec = { tools: [] };
  parseExpectInto(then, raw.then, `${where}.then`, judges);
  if (!hasChecks(then)) throw new Error(`${where}.then has no checks`);
  return { if: condition, then };
}

const JUDGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const JUDGE_OF = ['answer', 'output', 'run'] as const;
/**
 * A model a judge can be asked through: a Claude, OpenAI or Gemini model by its name (`claude-…`,
 * `gpt-…`, `chatgpt-…`, `o1`, `o3`, `o4-…`, `gemini-…`), or any name after its provider
 * (`openai:my-model` for an OpenAI-compatible server's own names). The schema holds the same.
 */
export const JUDGE_MODEL = /^(?:(?:anthropic|openai|gemini):\S{1,200}|(?:claude-|gpt-|chatgpt-|o\d|gemini-)\S{0,200})$/;

/**
 * One judge check: `{ "name", "question", "of": "answer" | "output" | "run", "model", "pass": "yes" | "no" }`.
 * `of` defaults to `answer` and `pass` to `yes`; `name` keys its verdict, so it is short and plain.
 */
export function parseJudge(raw: unknown, where: string): JudgeCheck {
  if (!isObject(raw)) throw new Error(`${where} must be an object with "name", "question" and "model"`);
  onlyKeys(raw, ['name', 'question', 'of', 'model', 'pass'], where);
  if (typeof raw.name !== 'string' || !JUDGE_NAME.test(raw.name)) throw new Error(`${where}.name must be a short name of letters, digits, ".", "_" or "-", such as "explains-escalation"`);
  if (typeof raw.question !== 'string' || !raw.question.trim() || raw.question.length > 2000) throw new Error(`${where}.question must be the question the judge answers yes or no, at most 2,000 characters`);
  const of = raw.of ?? 'answer';
  if (typeof of !== 'string' || !(JUDGE_OF as readonly string[]).includes(of)) throw new Error(`${where}.of must be "answer" (the last model response), "output" (what the agent printed) or "run" (the conversation and the tool calls)`);
  if (typeof raw.model !== 'string' || !JUDGE_MODEL.test(raw.model)) {
    throw new Error(`${where}.model must name a model a judge can be asked through: a Claude, OpenAI or Gemini model (claude-…, gpt-…, o3…, gemini-…), or any model with its provider before it, such as "openai:gpt-5.5"`);
  }
  const pass = raw.pass ?? 'yes';
  if (pass !== 'yes' && pass !== 'no') throw new Error(`${where}.pass must be "yes" or "no": the answer that passes`);
  return { name: raw.name, question: raw.question, of: of as JudgeCheck['of'], model: raw.model, pass };
}

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

// ---- Predicates ---------------------------------------------------------------------------------

const isOperator = (k: string): k is Operator => (OPERATORS as readonly string[]).includes(k);
const REFERENCE = /^@(.+?)\.(result|args)(?=$|[.[])(.*)$/s;
const hasWildcard = (r: Reference) => r.path.some((s) => s.type === 'wild');

/**
 * A string written as a reference, or null for any other value. `where` names it in errors. A
 * string that starts with `@@` is never one: it is text, with one `@` taken off (`"@@corp.args.io"`
 * is the text `@corp.args.io`).
 */
function referenceIn(value: unknown, where: string): Reference | null {
  if (typeof value !== 'string' || value.startsWith('@@')) return null;
  const m = REFERENCE.exec(value);
  if (!m) return null;
  let path: Reference['path'];
  try {
    path = parsePath(`$${m[3]}`);
  } catch (err) {
    throw new Error(`${where}: the reference ${value} has a path that can't be read (${(err as Error).message.replace(/: \$.*$/s, '')}); write it as @${m[1]}.${m[2]}.total or @${m[1]}.${m[2]}.items[0].sku, or as text, @${value}`);
  }
  return { tool: m[1]!, part: m[2] as Reference['part'], path, text: value.slice(1), at: where };
}

/** A value written in a rule as it is compared: `@@…` is text that starts with one `@`. */
const literal = (value: unknown): unknown => (typeof value === 'string' && value.startsWith('@@') ? value.slice(1) : value);

/** An operator's value: a reference or a literal. A reference with `*` names several values, which only `in` can take. */
function parseOperand(value: unknown, where: string, op: Operator): Operand {
  const ref = referenceIn(value, where);
  if (ref && hasWildcard(ref)) throw new Error(`${where}: ${value} names several values (it has *), which only "in" can compare with`);
  if (ref) return { ref };
  const v = literal(value);
  if (op === '<' || op === '<=' || op === '>' || op === '>=') {
    if (asNumber(v) === null) throw new Error(`${where} must be a number or a reference such as "@lookup_order.result.total"`);
  } else if ((op === 'startsWith' || op === 'endsWith') && typeof v !== 'string') {
    throw new Error(`${where} must be text or a reference such as "@lookup_customer.result.email"`);
  }
  return { value: v };
}

/**
 * A key of a value to match that reads like an operator someone meant (`gt`, `contains`, `$in`,
 * `endswith`) is refused, naming the one they meant: matched as a key, it would never be there.
 */
function refuseAliases(keys: readonly string[], raw: Record<string, unknown>, where: string): void {
  for (const key of keys) {
    const meant = aliasOf(key);
    if (meant === undefined) continue;
    const real = `to match a key named "${key}", write { "=": ${JSON.stringify({ [key]: raw[key] })} }`;
    if (meant === null) throw new Error(`${where} has the key "${key}", which is no operator: there are no regular expressions, so compare with "=", "in", "includes", "startsWith" or "endsWith" (${real})`);
    const how = meant === 'not' ? `{ "not": { "in": ${JSON.stringify(raw[key])} } }` : `{ "${meant}": ${JSON.stringify(raw[key])} }`;
    throw new Error(`${where} has the key "${key}", which would be matched as a key the value has, not compared: did you mean ${how}? (${real})`);
  }
}

/**
 * A value's test in a `calls` or `when` rule. An object whose keys are all operators is a
 * predicate (`{ "<=": "@lookup_order.result.total" }`, `{ ">": 0, "<": 500 }`); any other object,
 * a list and a plain value are literals, matched as `tools` matches arguments, with predicates
 * allowed inside them; a string written as a reference stands for the value it reads. A key named
 * like an operator it is not (`gt`, `contains`) is refused: see `OPERATOR_ALIASES`.
 */
export function parsePredicate(raw: unknown, where: string): Matcher {
  if (Array.isArray(raw)) return { op: 'array', items: raw.map((v, i) => parsePredicate(v, `${where}[${i}]`)) };
  if (!isObject(raw)) {
    const ref = referenceIn(raw, where);
    if (ref && hasWildcard(ref)) throw new Error(`${where}: ${String(raw)} names several values (it has *); compare with one, or use it with "in"`);
    return { op: '=', operand: ref ? { ref } : { value: literal(raw) } };
  }
  const keys = Object.keys(raw);
  const ops = keys.filter(isOperator);
  if (ops.length && ops.length < keys.length) {
    const others = keys.filter((k) => !isOperator(k));
    throw new Error(`${where} mixes predicates (${ops.map((k) => `"${k}"`).join(', ')}) with values to match (${others.map((k) => `"${k}"`).join(', ')}): an object is either a predicate such as { "<=": 100 } or the keys a value must have`);
  }
  if (!ops.length) {
    refuseAliases(keys, raw, where);
    return { op: 'object', keys: keys.map((key) => ({ key, matcher: parsePredicate(raw[key], `${where}["${key}"]`) })) };
  }
  const matchers = ops.map((op) => parseOperator(op, raw[op], `${where}["${op}"]`));
  return matchers.length === 1 ? matchers[0]! : { op: 'all', matchers };
}

function parseOperator(op: Operator, value: unknown, where: string): Matcher {
  if (op === 'not') {
    if (!isObject(value) && !Array.isArray(value)) throw new Error(`${where} must be a predicate to negate, such as { "in": "@lookup_customer.result.*" }`);
    return { op: 'not', matcher: parsePredicate(value, where) };
  }
  if (op === 'in') {
    const ref = referenceIn(value, where);
    if (ref) return { op: 'in', list: ref };
    if (!Array.isArray(value)) throw new Error(`${where} must be a list of values, or a reference to one such as "@lookup_customer.result.emails"`);
    return { op: 'in', items: value.map((v, i) => parseOperand(v, `${where}[${i}]`, 'in')) };
  }
  return { op, operand: parseOperand(value, where, op) };
}

// ---- Labels -------------------------------------------------------------------------------------

/**
 * A value in a label or a detail: JSON in one line, cut at 80 characters. Cut inside a quoted
 * string, it is closed after the mark (`"Replay works; forks…"`), so a detail's quotes stay paired
 * and what reads one (a fix's title, which takes its first problem) never takes a value's own '; '
 * for the one between problems.
 */
export function showValue(v: unknown): string {
  if (v === undefined) return 'nothing';
  const s = JSON.stringify(v) ?? String(v);
  if (s.length <= 80) return s;
  let cut = s.slice(0, 79);
  let quoted = false;
  let i = 0;
  while (i < cut.length) {
    if (cut[i] === '\\') i += 2;
    else {
      if (cut[i] === '"') quoted = !quoted;
      i++;
    }
  }
  // An escape cut in two loses its backslash, which would escape the closing quote.
  if (i > cut.length) cut = cut.slice(0, -1);
  return quoted ? `${cut}…"` : `${cut}…`;
}

/** A key or a position appended to a path as reports write it: `amount`, `customer.email`, `items[0]`, `["x y"]`. */
function pathAt(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  const plain = /^[A-Za-z_$][\w$-]*$/.test(key);
  if (!path) return plain ? key : `[${JSON.stringify(key)}]`;
  return plain ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

const operandText = (o: Operand) => ('ref' in o ? o.ref.text : showValue(o.value));
const PHRASE = { '=': '=', '!=': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=', includes: 'includes', startsWith: 'starts with', endsWith: 'ends with', in: 'in' } as const;
const NEGATED = { '=': '!=', '!=': '=', '<': '>=', '<=': '>', '>': '<=', '>=': '<', includes: "doesn't include", startsWith: "doesn't start with", endsWith: "doesn't end with", in: 'not in' } as const;

/** What a matcher asks of the value at `path`, as clauses: `amount <= lookup_order.result.total`. */
function clauses(m: Matcher, path: string): string[] {
  const subject = path || 'the value';
  switch (m.op) {
    case 'object':
      return m.keys.length ? m.keys.flatMap((k) => clauses(k.matcher, pathAt(path, k.key))) : [`${subject} is an object`];
    case 'array':
      return m.items.every((i) => i.op === '=' && 'value' in i.operand)
        ? [`${subject} = ${showValue(m.items.map((i) => ((i as { operand: { value: unknown } }).operand.value)))}`]
        : [`${subject} has ${m.items.length} item${m.items.length === 1 ? '' : 's'}`, ...m.items.flatMap((i, n) => clauses(i, pathAt(path, n)))];
    case 'all':
      return m.matchers.flatMap((x) => clauses(x, path));
    case 'not': {
      const inner = m.matcher;
      if (inner.op === 'in' || inner.op === 'includes' || inner.op === 'startsWith' || inner.op === 'endsWith' || inner.op === '=' || inner.op === '!=') return [clause(inner, subject, true)];
      return [`not (${clauses(inner, path).join(' and ')})`];
    }
    default:
      return [clause(m, subject, false)];
  }
}

function clause(m: Extract<Matcher, { op: keyof typeof PHRASE }>, subject: string, negated: boolean): string {
  const word = (negated ? NEGATED : PHRASE)[m.op];
  if (m.op === 'in') return `${subject} ${word} ${'list' in m ? m.list.text : `[${m.items.map(operandText).join(', ')}]`}`;
  return `${subject} ${word} ${operandText(m.operand)}`;
}

const andList = (items: readonly string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const orList = (items: readonly string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`);

/** `every issue_refund call: after lookup_order, amount <= lookup_order.result.total`. */
export function callRuleLabel(rule: CallRule): string {
  const parts = [...(rule.after.length ? [`after ${andList(rule.after)}`] : []), ...(rule.args ? clauses(rule.args, '') : [])];
  return `every ${rule.tool} call: ${parts.join(', ')}`;
}

/** `when lookup_order has result.total > 200`, `when escalate is called`. */
export function conditionLabel(c: CallCondition): string {
  const parts = [...(c.args ? clauses(c.args, 'args') : []), ...(c.result ? clauses(c.result, 'result') : [])];
  return parts.length ? `when ${c.tool} has ${parts.join(' and ')}` : `when ${c.tool} is called`;
}

/** `judge "explains-escalation" answers yes`. */
export const judgeLabel = (j: JudgeCheck): string => `judge "${j.name}" answers ${j.pass}`;

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
 * A judge's verdict on a run, from its recorded call or one asked live, by the judge's name, with
 * what the judge run knows of it besides, for the result's `judge`: what it cost (0 from the
 * recording, null for a model with no price), how many redaction rules applied to what it read,
 * whether what it read had what replay matching masks masked, how much of it was cut, its call.
 */
export interface JudgeVerdict {
  verdict: 'yes' | 'no';
  reason: string;
  source: 'recording' | 'live';
  cost?: number | null;
  redactions?: number;
  normalized?: boolean;
  cut?: number;
  callNo?: number;
}

export interface EvaluateOptions {
  judgeVerdicts?: ReadonlyMap<string, JudgeVerdict>;
  /** Why a judge has no verdict, for its inconclusive result. Default: `notJudgedWhy`, no recorded verdict and, when the environment has none, no key for its provider. */
  judgeMissing?: (judge: JudgeCheck) => string;
}

const inRange = (n: number, r: CountRange) => n >= r.min && n <= r.max;

/** A result whose status `ok` says: passed or failed. */
const verdict = (ok: boolean, label: string, detail: string | null): CheckResult => ({ status: ok ? 'passed' : 'failed', ok, label, detail });

function textChecks(check: TextCheck, text: string | null, what: string): CheckResult[] {
  const haystack = (text ?? '').toLowerCase();
  return [
    ...check.includes.map((s) => ({ ok: haystack.includes(s.toLowerCase()), label: `${what} includes "${s}"`, detail: text === null ? `there was no ${what}` : `not found in the ${what}` })),
    ...check.excludes.map((s) => ({ ok: !haystack.includes(s.toLowerCase()), label: `${what} doesn't include "${s}"`, detail: `found in the ${what}` })),
  ].map((r) => verdict(r.ok, r.label, r.ok ? null : r.detail));
}

export function evaluateChecks(spec: ExpectSpec | TestSpec, input: CheckInput, options: EvaluateOptions = {}): CheckResult[] {
  const results: CheckResult[] = [];
  // A judge's own model calls are the oracle's, not the agent's: no check counts them.
  const calls = input.calls.filter((c) => c.meta?.scope !== JUDGE_SCOPE);
  const tools = calls.filter((c) => c.kind === 'tool');
  for (const t of spec.tools) {
    const named = tools.filter((c) => c.name === t.name);
    const matching = t.args ? named.filter((c) => argsMatch(input.argsOf(c), t.args)) : named;
    const n = matching.length;
    const withArgs = t.args ? ` with ${JSON.stringify(t.args)}` : '';
    let detail: string | null = null;
    if (!inRange(n, t.count)) {
      const fenced = matching.filter((c) => c.origin === 'blocked' || c.origin === 'stubbed').length;
      detail = `called ${formatCount({ min: n, max: n })}${fenced ? ` (${fenced} blocked or stubbed)` : ''}`;
      if (t.args && named.length > n) detail += `; ${named.length} call${named.length === 1 ? '' : 's'} with other arguments`;
      if (named.length === 0 && tools.length) detail += `; tools called: ${[...new Set(tools.map((c) => c.name))].join(', ')}`;
    }
    results.push(verdict(detail === null, `${t.name}${withArgs} called ${formatCount(t.count)}`, detail));
  }
  const counted = (range: CountRange | undefined, n: number, noun: string) => {
    if (range) results.push(verdict(inRange(n, range), `${formatCount(range, noun)}`, inRange(n, range) ? null : `${formatCount({ min: n, max: n }, noun)}`));
  };
  counted(spec.modelCalls, calls.filter((c) => c.kind === 'api').length, 'model call');
  counted(spec.toolCalls, tools.length, 'tool call');

  // Budgets are measured over the run's model requests whatever their origin: a clean replay sends
  // the same requests it recorded, so this is what the run costs to run live, which is the number a
  // prompt change moves and the one worth failing a build over.
  const api = calls.filter((c) => c.kind === 'api');
  const tokens = (pick: (u: NonNullable<CallRecord['end']>['meta']['usage']) => number | undefined) =>
    api.reduce((sum, c) => sum + (pick(c.end?.meta.usage) ?? 0), 0);
  counted(spec.inputTokens, tokens((u) => (u ? u.inputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0) : 0)), 'input token');
  counted(spec.outputTokens, tokens((u) => u?.outputTokens), 'output token');

  if (spec.cost) {
    const priced = api.map((c) => ({ call: c, usd: input.costOf(c) }));
    const unpriced = priced.filter((p) => p.usd === null && p.call.end?.meta.usage);
    const total = priced.reduce((sum, p) => sum + (p.usd ?? 0), 0);
    const label = `cost ${formatAmount(spec.cost)}`;
    if (unpriced.length) {
      // Silently treating an unknown price as zero would let a budget pass on a model nobody costed.
      const models = [...new Set(unpriced.map((p) => p.call.end?.meta.model ?? p.call.meta.model ?? 'unknown'))];
      results.push(verdict(false, label, `no price for ${models.join(', ')}; add it under "prices" in ${CONFIG}`));
    } else {
      const ok = inRange(total, spec.cost);
      results.push(verdict(ok, label, ok ? null : `cost ≈ ${formatUsd(total)}`));
    }
  }

  if (spec.output) results.push(...textChecks(spec.output, input.output, 'output'));
  if (spec.answer) results.push(...textChecks(spec.answer, input.answer, 'final answer'));

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
      } else if (Array.isArray(v)) next.push(...v);
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

/** A number, or a string that is one written plainly (`"240"`, `"12.50"`); null for anything else. */
function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?([eE][+-]?\d+)?\s*$/.test(v)) return Number(v);
  return null;
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

function match(m: Matcher, actual: unknown, path: string, ctx: MatchContext): Match {
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
    default:
      break;
  }
  if (actual === undefined) return undecided(`has no ${subject}`);
  const shown = `${subject} ${showValue(actual)}`;
  if (m.op === 'in') {
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
  const o = operandValue(m.operand, ctx);
  if ('state' in o) return o;
  switch (m.op) {
    case '=':
    case '!=': {
      const equal = argsMatch(actual, o.value);
      const ok = m.op === '=' ? equal : !equal;
      return (ok ? held : broken)(`${shown} ${equal ? '=' : '!='} ${o.text}`);
    }
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const a = asNumber(actual);
      const b = asNumber(o.value);
      if (a === null) return undecided(`${shown} is not a number`);
      if (b === null) return undecided(`${o.text} is not a number`);
      const ok = m.op === '<' ? a < b : m.op === '<=' ? a <= b : m.op === '>' ? a > b : a >= b;
      return (ok ? held : broken)(`${shown} ${(ok ? PHRASE : NEGATED)[m.op]} ${o.text}`);
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
      const ok = m.op === 'startsWith' ? actual.startsWith(o.value) : actual.endsWith(o.value);
      return (ok ? held : broken)(`${shown} ${(ok ? PHRASE : NEGATED)[m.op]} ${o.text}`);
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
  const prefix = conditionLabel(cond);
  const inner = evaluateChecks(rule.then, scope.input, options);
  const tried = scope.calls.filter((c) => c.kind === 'tool' && c.name === cond.tool).map((c) => ({ c, m: conditionAt(cond, c, scope) }));
  const met = tried.find((t) => t.m.state === 'held');
  if (met) {
    const where = `the condition held at ${cond.tool} #${met.c.callNo}${met.m.why ? ` (${met.m.why})` : ''}`;
    return inner.map((r) => ({ ...r, label: `${prefix}: ${r.label}`, detail: r.detail === null ? null : `${r.detail}; ${where}` }));
  }
  const unread = tried.filter((t) => t.m.state === 'undecided');
  const calls = (ts: typeof tried) => problemsDetail(ts.map((t) => `${cond.tool} #${t.c.callNo}: ${t.m.why}`), cond.tool);
  if (unread.length) return inner.map((r) => ({ status: 'inconclusive' as const, ok: false, label: `${prefix}: ${r.label}`, detail: `could not tell whether the condition held: ${calls(unread)}` }));
  const seen = tried.length ? calls(tried) : `${cond.tool} was never called`;
  return inner.map((r) => ({ status: 'not-applicable' as const, ok: true, label: `${prefix}: ${r.label}`, detail: `the condition never held: ${seen}` }));
}

/**
 * A judge check: its verdict, or inconclusive with why it has none. It never passes unjudged. Its
 * `judge` keeps how it came out, for the reports: the verdict, where it came from and what it cost.
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
  if (!v) return { status: 'inconclusive', ok: false, label, detail: options.judgeMissing?.(j) ?? notJudgedWhy(j), judge };
  const ok = v.verdict === j.pass;
  return { status: ok ? 'passed' : 'failed', ok, label, detail: ok ? null : `the judge answered ${v.verdict}`, reason: v.reason || 'no reason given', source: v.source, judge };
}

/** Judge checks alone, as `evaluateChecks` judges them: for a run judged after it ended (`pack`, `test --update`). */
export function judgeResults(judges: readonly JudgeCheck[], options: EvaluateOptions = {}): CheckResult[] {
  return judges.map((j) => judgeResult(j, options));
}

// ---- Reports ------------------------------------------------------------------------------------

/** Each status's mark at the start of a report's line. */
export const CHECK_MARKS: Readonly<Record<CheckStatus, string>> = { passed: '✓', failed: '✗', inconclusive: '?', 'not-applicable': '–' };

/**
 * A check as one line of a report: `✓ label`, `✗ label: detail`, `? label: inconclusive · detail`,
 * `– label: not applicable · detail`, and a judge's reason after it. `join` is what comes between a
 * failed check's label and its detail (a replay's report writes `, but `). A result kept before
 * results had a status reads as `ok` says.
 */
export function checkLine(c: StoredCheck, join = ': '): string {
  return `${CHECK_MARKS[checkStatus(c)]} ${checkWords(c, join)}`;
}

/** The line `checkLine` writes, without its mark, for a report that draws the mark itself. A judge's verdict says where it came from. */
export function checkWords(c: StoredCheck, join = ': '): string {
  const source = c.judge ? judgeSource(c.judge) : null;
  const reason = `${c.reason ? ` · ${c.reason}` : ''}${source ? ` (${source})` : ''}`;
  switch (checkStatus(c)) {
    case 'passed':
      return `${c.label}${reason}`;
    case 'failed':
      return `${c.label}${join}${c.detail ?? ''}${reason}`;
    case 'inconclusive':
      return `${c.label}: inconclusive · ${c.detail ?? ''}`;
    case 'not-applicable':
      return `${c.label}: not applicable · ${c.detail ?? ''}`;
  }
}

/**
 * Where a judge check's verdict came from and what it cost, with what was done to what it read:
 * `judged from the recording, free`, `judged live, ≈$0.0004 · read with 1 redaction rule applied`.
 * Null for a check that was not judged.
 */
export function judgeSource(j: JudgeOutcome): string | null {
  if (!j.source) return null;
  const read = [
    j.redactions ? `read with ${j.redactions} redaction rule${j.redactions === 1 ? '' : 's'} applied` : null,
    j.normalized ? 'values that change every run masked' : null,
    j.cut ? `${j.cut.toLocaleString('en-US')} characters left out` : null,
  ].filter(Boolean);
  const how = j.source === 'recording' ? 'judged from the recording, free' : `judged live, ${j.cost === null ? `no price for ${j.model}` : aboutUsd(j.cost)}`;
  return [how, ...read].join(' · ');
}

// ---- What the checks read of a run --------------------------------------------------------------

/**
 * The input checks read from a run in the store: its calls in order, each tool call's arguments
 * and result (read once each), the last model response, and each model call's cost under `prices`.
 */
export function storedCheckInput(store: Store, calls: CallRecord[], output: string, prices?: Record<string, Price>): CheckInput {
  return {
    calls,
    output,
    answer: finalAnswer(store, calls.filter((c) => c.meta?.scope !== JUDGE_SCOPE)),
    ...storedCalls(store),
    costOf: (c) => estimateCost(c.end?.meta.model ?? c.meta.model, c.end?.meta.usage, prices),
  };
}

/** How to read a run's tool calls in the store: each call's recorded arguments and result, read once each. */
export function storedCalls(store: Store): Pick<CheckInput, 'argsOf' | 'resultOf'> {
  const args = new Map<string, unknown>();
  const results = new Map<string, unknown>();
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

// ---- About a spec -------------------------------------------------------------------------------

export function hasChecks(spec: ExpectSpec): boolean {
  return spec.tools.length > 0 || !!spec.modelCalls || !!spec.toolCalls || !!spec.inputTokens || !!spec.outputTokens || !!spec.cost || !!spec.output || !!spec.answer || !!spec.calls?.length || !!spec.when?.length || !!spec.judge?.length;
}

/** Whether any check reads what the agent printed, which a recording does not keep: `output`, or a judge of the output. */
export function readsOutput(spec: ExpectSpec): boolean {
  return !!spec.output || !!spec.judge?.some((j) => j.of === 'output') || !!spec.when?.some((w) => readsOutput(w.then));
}

/** The spec without its checks on the agent's output, wherever they are, for judging a recording. */
export function withoutOutput<S extends ExpectSpec>(spec: S): S {
  const { output: _unrecorded, ...rest } = spec;
  const out = { ...rest } as S;
  if (spec.when) out.when = spec.when.map((w) => ({ ...w, then: withoutOutput(w.then) })).filter((w) => hasChecks(w.then));
  return out;
}

/** Every judge check in a spec, those under a `when` included, each once. */
export function judgeChecksOf(spec: ExpectSpec): JudgeCheck[] {
  const out = [...(spec.judge ?? [])];
  for (const w of spec.when ?? []) for (const j of judgeChecksOf(w.then)) if (!out.some((x) => x.name === j.name)) out.push(j);
  return out;
}

/**
 * A tool a spec names, where, and what for: a count under `tools` (`zero`: one that allows none, a
 * "never" rule), the tool of a `calls` rule, a tool it must come after, the tool a reference reads,
 * or the tool of a `when` condition. `doctor` holds them against the tools recordings called.
 */
export interface NamedTool {
  tool: string;
  use: 'count' | 'rule' | 'after' | 'reference' | 'condition';
  at: string;
  zero?: boolean;
}

/** Every tool a spec names. `where` is how its `tools` counts are named (`tests["…"].expect`). */
export function toolsNamed(spec: ExpectSpec, where: string): NamedTool[] {
  const out: NamedTool[] = spec.tools.map((t) => ({ tool: t.name, use: 'count', at: `${where}.tools["${t.name}"]`, ...(t.count.min === 0 ? { zero: true } : {}) }));
  const refs = (m: Matcher | null): void => {
    if (!m) return;
    switch (m.op) {
      case 'object':
        return m.keys.forEach((k) => refs(k.matcher));
      case 'array':
        return m.items.forEach(refs);
      case 'all':
        return m.matchers.forEach(refs);
      case 'not':
        return refs(m.matcher);
      case 'in':
        if ('list' in m) out.push({ tool: m.list.tool, use: 'reference', at: m.list.at });
        else for (const o of m.items) if ('ref' in o) out.push({ tool: o.ref.tool, use: 'reference', at: o.ref.at });
        return;
      default:
        if ('ref' in m.operand) out.push({ tool: m.operand.ref.tool, use: 'reference', at: m.operand.ref.at });
    }
  };
  for (const r of spec.calls ?? []) {
    out.push({ tool: r.tool, use: 'rule', at: `${r.at}.tool` });
    r.after.forEach((t, i) => out.push({ tool: t, use: 'after', at: r.after.length > 1 ? `${r.at}.after[${i}]` : `${r.at}.after` }));
    refs(r.args);
  }
  for (const [i, w] of (spec.when ?? []).entries()) {
    out.push({ tool: w.if.tool, use: 'condition', at: `${w.if.at}.tool` });
    refs(w.if.args);
    refs(w.if.result);
    out.push(...toolsNamed(w.then, `${where}.when[${i}].then`));
  }
  return out;
}

/**
 * A value a spec reads from a tool's calls: an argument a `calls` rule or a condition matches, a
 * condition's result, or what a reference reads. `doctor` and `shadowlap check` hold them against
 * the calls recordings made, as `unreadPaths` does.
 */
export interface NamedPath {
  tool: string;
  part: 'args' | 'result';
  path: Reference['path'];
  /** `result.total`, `args.customer.email`. */
  text: string;
  /** What the spec reads it for: a `calls` rule's argument, a condition, or a reference. */
  use: 'rule' | 'condition' | 'reference';
  at: string;
}

/** A path as the reports write it: `result.total`, `args.items[0].sku`, `result.*`. */
function pathText(part: string, path: Reference['path']): string {
  return path.reduce((s: string, seg) => (seg.type === 'key' ? pathAt(s, seg.key) : seg.type === 'index' ? `${s}[${seg.index}]` : `${s}.*`), part);
}

/** Every value a spec reads from calls, nested `when`s included, with where it is. */
export function pathsNamed(spec: ExpectSpec): NamedPath[] {
  const out: NamedPath[] = [];
  const named = (tool: string, part: NamedPath['part'], path: Reference['path'], use: NamedPath['use'], at: string): void => {
    out.push({ tool, part, path, text: pathText(part, path), use, at });
  };
  // The keys a matcher goes into, down to the values it compares, and every reference it reads.
  const walk = (m: Matcher | null, tool: string, part: NamedPath['part'], path: Reference['path'], use: NamedPath['use'], at: string): void => {
    if (!m) return;
    switch (m.op) {
      case 'object':
        if (!m.keys.length) return named(tool, part, path, use, at);
        return m.keys.forEach((k) => walk(k.matcher, tool, part, [...path, { type: 'key', key: k.key }], use, `${at}["${k.key}"]`));
      case 'all':
        return m.matchers.forEach((x) => walk(x, tool, part, path, use, at));
      case 'not':
        return walk(m.matcher, tool, part, path, use, at);
      case 'array':
        named(tool, part, path, use, at);
        return m.items.forEach((x) => refs(x));
      default:
        named(tool, part, path, use, at);
        return refs(m);
    }
  };
  const refs = (m: Matcher): void => {
    const read = (r: Reference) => named(r.tool, r.part, r.path, 'reference', r.at);
    if (m.op === 'in') {
      if ('list' in m) read(m.list);
      else for (const o of m.items) if ('ref' in o) read(o.ref);
    } else if (m.op === 'object') m.keys.forEach((k) => refs(k.matcher));
    else if (m.op === 'array') m.items.forEach(refs);
    else if (m.op === 'all') m.matchers.forEach(refs);
    else if (m.op === 'not') refs(m.matcher);
    else if ('ref' in m.operand) read(m.operand.ref);
  };
  for (const r of spec.calls ?? []) walk(r.args, r.tool, 'args', [], 'rule', `${r.at}.args`);
  for (const w of spec.when ?? []) {
    walk(w.if.args, w.if.tool, 'args', [], 'condition', `${w.if.at}.args`);
    walk(w.if.result, w.if.tool, 'result', [], 'condition', `${w.if.at}.result`);
    out.push(...pathsNamed(w.then));
  }
  return out;
}

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

export function parseTests(raw: unknown): TestEntry[] {
  if (raw === undefined) return [];
  if (!isObject(raw)) throw new Error(`${CONFIG}: "tests" must map recording directories to their checks`);
  return Object.entries(raw).map(([recording, spec]) => ({ recording, spec: parseSpec(spec, `${CONFIG}: tests["${recording}"]`) }));
}

/**
 * The entry for a recording directory (relative to the current folder, or absolute). An exact path
 * wins over a pattern; `*` matches within the last part only. The engine's `testsEntryFor` decides,
 * so the dashboard finds a run's checks the same way.
 */
export function specFor(entries: TestEntry[], recordingDir: string, configDir: string): TestSpec | null {
  return testsEntryFor(entries, resolve(recordingDir), configDir)?.spec ?? null;
}
