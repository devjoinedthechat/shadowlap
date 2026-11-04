import type { InjectionEntry } from '../injection.js';
import type { parsePath } from '../normalize.js';
import type { Gate } from '../stats.js';
import type { CheckStatus, JudgeOutcome } from '../types.js';

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
 *
 * The engine keeps the grammar (this file), its parser (parse.ts), the words checks are reported in
 * (labels.ts), how a run is judged by them (evaluate.ts) and the tests entries that hold them
 * (tests-entry.ts), so the CLI, the dashboard's server and its pages can read checks one way. This
 * file, parse.ts and labels.ts import nothing of Node, so the dashboard's pages can bundle them.
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
  /** The gate's `max` was written in the config: a test session never sizes it (suite.ts). */
  gateMaxGiven?: boolean;
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

/** The keys an `expect` object may have, in the order its checks are reported. */
export const EXPECT_KEYS = ['tools', 'modelCalls', 'toolCalls', 'inputTokens', 'outputTokens', 'cost', 'output', 'answer', 'calls', 'when', 'judge'] as const;

/**
 * A model a judge can be asked through: a Claude, OpenAI or Gemini model by its name (`claude-…`,
 * `gpt-…`, `chatgpt-…`, `o1`, `o3`, `o4-…`, `gemini-…`), or any name after its provider
 * (`openai:my-model` for an OpenAI-compatible server's own names). The schema holds the same.
 */
export const JUDGE_MODEL = /^(?:(?:anthropic|openai|gemini):\S{1,200}|(?:claude-|gpt-|chatgpt-|o\d|gemini-)\S{0,200})$/;

/** Whether a reference reads several values: its path has a `*`. */
export const hasWildcard = (r: Reference) => r.path.some((s) => s.type === 'wild');

/** A number, or a string that is one written plainly (`"240"`, `"12.50"`); null for anything else. */
export function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?([eE][+-]?\d+)?\s*$/.test(v)) return Number(v);
  return null;
}

/** A key or a position appended to a path as reports write it: `amount`, `customer.email`, `items[0]`, `["x y"]`. */
export function pathAt(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  const plain = /^[A-Za-z_$][\w$-]*$/.test(key);
  if (!path) return plain ? key : `[${JSON.stringify(key)}]`;
  return plain ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
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
  const out = rest as S;
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
