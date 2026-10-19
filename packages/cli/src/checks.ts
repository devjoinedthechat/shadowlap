import { resolve } from 'node:path';
import { formatUsd, parseInjectionEntry, parseTaskFields, testsEntryFor, type CallRecord, type InjectionEntry } from '@shadowlap/engine';

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

export interface TestSpec {
  /** The recording may diverge: the replay goes live from the fork and passes on its checks. */
  fork: boolean;
  repeat: number;
  /** Attempts that must pass, out of `repeat`. */
  passes: number;
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
  /** The injection gate (`"injection"` beside `expect`): `shadowlap test` runs the golden's injection test after its replay passes. */
  injection?: InjectionEntry;
}

export interface TestEntry {
  /** As written in the config: a directory relative to it, with `*` allowed in the last part. */
  recording: string;
  spec: TestSpec;
}

export interface CheckResult {
  ok: boolean;
  /** What was expected, e.g. `send_email called 0 times`. */
  label: string;
  /** What happened, for a failed check. */
  detail: string | null;
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
  // `task` (where a model takes over, why, what it rewards) is read by `shadowlap tasks` (tasks.ts);
  // a mistake in it fails here too, as any other mistake under `tests` does.
  onlyKeys(raw, ['fork', 'repeat', 'passes', 'expect', 'task', 'injection'], where);
  parseTaskFields(raw.task, `${where}.task`);
  if (raw.fork !== undefined && typeof raw.fork !== 'boolean') throw new Error(`${where}.fork must be true or false`);
  const repeat = raw.repeat ?? 1;
  if (typeof repeat !== 'number' || !Number.isInteger(repeat) || repeat < 1 || repeat > 100) throw new Error(`${where}.repeat must be a whole number from 1 to 100`);
  const passes = raw.passes ?? repeat;
  if (typeof passes !== 'number' || !Number.isInteger(passes) || passes < 1 || passes > repeat) throw new Error(`${where}.passes must be a whole number from 1 to repeat (${repeat})`);
  const spec: TestSpec = { fork: raw.fork === true, repeat, passes, tools: [] };
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

function parseExpectInto(spec: TestSpec, expect: unknown, where: string): void {
  if (!isObject(expect)) throw new Error(`${where} must be an object`);
  onlyKeys(expect, ['tools', 'modelCalls', 'toolCalls', 'inputTokens', 'outputTokens', 'cost', 'output', 'answer'], where);
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
  /** The text of the last model response, or null without one. */
  answer: string | null;
  /** A model call's estimated cost in USD, or null when its model has no price. */
  costOf: (call: CallRecord) => number | null;
}

const inRange = (n: number, r: CountRange) => n >= r.min && n <= r.max;

function textChecks(check: TextCheck, text: string | null, what: string): CheckResult[] {
  const haystack = (text ?? '').toLowerCase();
  return [
    ...check.includes.map((s) => ({ ok: haystack.includes(s.toLowerCase()), label: `${what} includes "${s}"`, detail: text === null ? `there was no ${what}` : `not found in the ${what}` })),
    ...check.excludes.map((s) => ({ ok: !haystack.includes(s.toLowerCase()), label: `${what} doesn't include "${s}"`, detail: `found in the ${what}` })),
  ].map((r) => ({ ...r, detail: r.ok ? null : r.detail }));
}

export function evaluateChecks(spec: TestSpec, input: CheckInput): CheckResult[] {
  const results: CheckResult[] = [];
  const tools = input.calls.filter((c) => c.kind === 'tool');
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
    results.push({ ok: detail === null, label: `${t.name}${withArgs} called ${formatCount(t.count)}`, detail });
  }
  const counted = (range: CountRange | undefined, n: number, noun: string) => {
    if (range) results.push({ ok: inRange(n, range), label: `${formatCount(range, noun)}`, detail: inRange(n, range) ? null : `${formatCount({ min: n, max: n }, noun)}` });
  };
  counted(spec.modelCalls, input.calls.filter((c) => c.kind === 'api').length, 'model call');
  counted(spec.toolCalls, tools.length, 'tool call');

  // Budgets are measured over the run's model requests whatever their origin: a clean replay sends
  // the same requests it recorded, so this is what the run costs to run live, which is the number a
  // prompt change moves and the one worth failing a build over.
  const api = input.calls.filter((c) => c.kind === 'api');
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
      results.push({ ok: false, label, detail: `no price for ${models.join(', ')}; add it under "prices" in ${CONFIG}` });
    } else {
      const ok = inRange(total, spec.cost);
      results.push({ ok, label, detail: ok ? null : `cost \u2248 ${formatUsd(total)}` });
    }
  }

  if (spec.output) results.push(...textChecks(spec.output, input.output, 'output'));
  if (spec.answer) results.push(...textChecks(spec.answer, input.answer, 'final answer'));
  return results;
}

export function hasChecks(spec: TestSpec): boolean {
  return spec.tools.length > 0 || !!spec.modelCalls || !!spec.toolCalls || !!spec.inputTokens || !!spec.outputTokens || !!spec.cost || !!spec.output || !!spec.answer;
}
