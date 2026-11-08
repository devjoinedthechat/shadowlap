import { isObject } from '../is-object.js';
import { messageOf } from '../message-of.js';
import { NAME_MAX } from '../name-max.js';
import { parsePath } from '../normalize.js';
import { EXPECT_KEYS, JUDGE_MODEL, OPERATORS, aliasOf, asNumber, hasChecks, hasWildcard, type CallCondition, type CallRule, type CountRange, type ExpectSpec, type JudgeCheck, type Matcher, type Operand, type Operator, type Reference, type TestSpec, type TextCheck, type WhenRule } from './grammar.js';

/**
 * Checks as they are written, read and refused in the words the CLI prints: an `expect` object, as
 * `--expect` and a tests entry's `expect` give it, and each part of one. Nothing here needs Node, so
 * the dashboard's pages can refuse a check in the same words.
 */

export function onlyKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
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

/**
 * An `expect` object on its own, as `shadowlap blame --expect` takes it: the same checks a recording
 * can have under `tests`, judging one run. `where` names the source in error messages.
 */
export function parseExpect(raw: unknown, where: string): TestSpec {
  const spec: TestSpec = { fork: true, repeat: 1, passes: 1, tools: [] };
  parseExpectInto(spec, raw, where);
  return spec;
}

/**
 * Reads an `expect` object into `spec`. `judges` holds the judge names seen so far, wherever in the
 * object (a `when`'s `then` included), since a verdict is kept under its judge's name.
 */
export function parseExpectInto(spec: ExpectSpec, expect: unknown, where: string, judges = new Map<string, string>()): void {
  if (!isObject(expect)) throw new Error(`${where} must be an object`);
  onlyKeys(expect, [...EXPECT_KEYS], where);
  if (expect.tools !== undefined) {
    if (!isObject(expect.tools)) throw new Error(`${where}.tools must map tool names to counts`);
    for (const [name, v] of Object.entries(expect.tools)) {
      const at = `${where}.tools["${name}"]`;
      if (isObject(v)) {
        onlyKeys(v, ['count', 'args'], at);
        if (v.args !== undefined && !isObject(v.args)) throw new Error(`${at}.args must be an object of argument values`);
        spec.tools.push({ name, count: parseCount(v.count ?? '>= 1', `${at}.count`), ...(v.args ? { args: v.args } : {}) });
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

const JUDGE_NAME = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${NAME_MAX - 1}}$`);
const JUDGE_OF = ['answer', 'output', 'run'] as const;

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

// ---- Predicates ---------------------------------------------------------------------------------

const isOperator = (k: string): k is Operator => (OPERATORS as readonly string[]).includes(k);
const REFERENCE = /^@(.+?)\.(result|args)(?=$|[.[])(.*)$/s;

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
    path = parsePath(`$${m[3]!}`);
  } catch (err) {
    throw new Error(`${where}: the reference ${value} has a path that can't be read (${messageOf(err).replace(/: \$.*$/s, '')}); write it as @${m[1]!}.${m[2]!}.total or @${m[1]!}.${m[2]!}.items[0].sku, or as text, @${value}`, { cause: err });
  }
  return { tool: m[1]!, part: m[2] as Reference['part'], path, text: value.slice(1), at: where };
}

/** Whether a value written in a rule reads as a reference (`"@lookup_order.result.total"`), as the check builder tells its value chips from a number. */
export const isReference = (value: unknown): boolean => typeof value === 'string' && !value.startsWith('@@') && REFERENCE.test(value);

/** A value written in a rule as it is compared: `@@…` is text that starts with one `@`. */
const literal = (value: unknown): unknown => (typeof value === 'string' && value.startsWith('@@') ? value.slice(1) : value);

/** An operator's value: a reference or a literal. A reference with `*` names several values, which only `in` can take. */
function parseOperand(value: unknown, where: string, op: Operator): Operand {
  const ref = referenceIn(value, where);
  if (ref && hasWildcard(ref)) throw new Error(`${where}: @${ref.text} names several values (it has *), which only "in" can compare with`);
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
